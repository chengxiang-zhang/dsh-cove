/**
 * The `session-activity` probe (10 "观察器").
 *
 * The target of a watch commitment is a session scope path such as
 * `netbird/pc-tower/session/s-88`; the probe reads that host's session through the
 * read-only inspect face and turns it into four numbers. It prefers the target
 * machine's own inspect interface; when no reader is wired for a target the read
 * fails, which the watcher counts (a probe is not allowed to invent a reading).
 *
 * Two fixed costs keep it cheap and harmless: only the tail `PROBE_TAIL` of the
 * event list is read (F2: inspect returns everything), and the whole call is under
 * the probe wall clock from `./index.ts`. Nothing here writes.
 */

import { contentText, parseSessionEvent } from '../events.ts'
import { PROBE_TAIL, type Probe, type Reading } from './index.ts'

/** Ten minutes is the repetition horizon for `tool_calls_10m` (10 "近两窗口"). */
export const ACTIVITY_WINDOW_MS = 10 * 60_000

/** The narrow read face: exactly what `SessionControllerFace.inspect` offers, and nothing else. */
export interface SessionReader {
  inspect(sessionId: string): Promise<{ meta?: { cwd?: unknown }; events?: readonly unknown[] }>
}

export interface SessionActivityDeps {
  inspect: SessionReader['inspect']
  now(): number
}

/** `netbird/pc-tower/session/s-88` -> `s-88`; a bare session id is returned unchanged. */
export function sessionIdOfTarget(target: string): string {
  const trimmed = target.trim().replace(/\/+$/, '')
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return last
}

/** Longest common subsequence length over code points; 0 for an empty side. */
function lcsLength(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0
  let previous = new Array<number>(right.length + 1).fill(0)
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array<number>(right.length + 1).fill(0)
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1])
    }
    previous = current
  }
  return previous[right.length]
}

/**
 * Similarity of the last two texts on a 0-1 scale: the shared subsequence over the
 * longer text. Two identical texts score 1; unrelated texts score near 0. Capped at
 * 2000 code points so one long message cannot make a probe expensive.
 */
export function textSimilarity(previous: string, last: string): number {
  const a = Array.from(previous.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 2000))
  const b = Array.from(last.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 2000))
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return 0
  return Math.round((lcsLength(a, b) / longest) * 100) / 100
}

export function createSessionActivityProbe(deps: SessionActivityDeps): Probe {
  return {
    name: 'session-activity',
    async probe(target: string): Promise<Reading[]> {
      const sessionId = sessionIdOfTarget(target)
      if (sessionId.length === 0) throw new Error(`session-activity: no session id in ${target}`)
      const result = await deps.inspect(sessionId)
      const events = (result.events ?? []).slice(-PROBE_TAIL)
      const parsed = events.map(parseSessionEvent).filter(event => event !== undefined)

      const toolCalls = parsed.filter(event => event.type === 'tool/call')
      const lastToolCall = toolCalls.at(-1)
      const texts = parsed
        .filter(event => event.type === 'assistant/message')
        .map(event => contentText(event.data))
        .filter(text => text.trim().length > 0)
      const windowStart = deps.now() - ACTIVITY_WINDOW_MS

      return [
        { name: 'event_count', value: events.length },
        { name: 'last_tool', value: lastToolCall === undefined ? '' : String(lastToolCall.data.name ?? '') },
        { name: 'tool_calls_10m', value: toolCalls.filter(event => (event.time ?? 0) >= windowStart).length },
        { name: 'last_text_similarity', value: textSimilarity(texts.at(-2) ?? '', texts.at(-1) ?? '') },
      ]
    },
  }
}