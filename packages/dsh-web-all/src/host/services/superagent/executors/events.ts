/**
 * Session event reading for executors (T19), per the W0 spike readings:
 *
 * - envelope `{ type, seq, time, data }`; a forwarded `{ event: {...} }` is unwrapped.
 * - `turn/start.data.turn`, `turn/end.data.turn` and `turn/end.data.reason.kind`.
 * - `user/message` has no turn: its turn is the open `turn/start ... turn/end` seq range.
 * - exit codes exist only as the text marker `[exit code: N]` in
 *   `tool/result.data.message.content[*].text`, appended only when non-zero; no
 *   marker means 0. `isError` stays false on a non-zero exit and is not a signal.
 * - guard refusals differ by version; only the content text is read.
 */

export interface SessionEventLike { type: string; seq: number; time?: number; data: Record<string, unknown> }

export function parseSessionEvent(raw: unknown): SessionEventLike | undefined {
  const value = isObject(raw) && isObject(raw.event) && typeof raw.type !== 'string' ? raw.event : raw
  if (!isObject(value) || typeof value.type !== 'string' || typeof value.seq !== 'number') return undefined
  return {
    type: value.type, seq: value.seq,
    ...(typeof value.time === 'number' ? { time: value.time } : {}),
    data: isObject(value.data) ? value.data : {},
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Concatenated text blocks of a message-like value (`{ content: [{ type:'text', text }] }`). */
export function contentText(message: unknown): string {
  if (!isObject(message) || !Array.isArray(message.content)) return ''
  return message.content.map(b => (isObject(b) && typeof b.text === 'string' ? b.text : '')).join('\n')
}

const EXIT_MARK = /\[exit code: (-?\d+)\]/g

/** Exit code of a `tool/result`: the last `[exit code: N]` marker, or 0 without one. */
export function exitCodeOf(toolResultData: Record<string, unknown>): number {
  const text = contentText(toolResultData.message)
  let code = 0
  for (const m of text.matchAll(EXIT_MARK)) code = Number(m[1])
  return code
}

/** `turn/end.data.reason.kind`, or undefined when absent. */
export function turnEndKind(data: Record<string, unknown>): string | undefined {
  return isObject(data.reason) && typeof data.reason.kind === 'string' ? data.reason.kind : undefined
}

/** The marker sendInput appends so a user/message can be tied to its request id. */
export const inputMarker = (requestId: string): string => `[sa-input:${requestId}]`
const INPUT_MARK = /\[sa-input:([^\]\s]+)\]/g

export function inputRequestIds(userMessageData: Record<string, unknown>): string[] {
  return [...contentText(userMessageData).matchAll(INPUT_MARK)].map(m => m[1])
}

/**
 * Repeat signature of a `tool/call`: name plus the command or path argument when the
 * raw `arguments` JSON carries one, else the raw string. Same signature 3 times = loop.
 */
export function callSignature(data: Record<string, unknown>): string {
  const name = typeof data.name === 'string' ? data.name : '?'
  const raw = typeof data.arguments === 'string' ? data.arguments : ''
  let key = raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isObject(parsed)) {
      const pick = parsed.command ?? parsed.cmd ?? parsed.path ?? parsed.file ?? parsed.file_path
      if (typeof pick === 'string') key = pick
    }
  } catch { /* raw arguments are kept as the key */ }
  return `${name}:${key}`.slice(0, 500)
}

/** Per-session turn ranges, so a message seq maps to the turn that consumed it. */
export class TurnRanges {
  private readonly ranges: { turn: number; start: number; end?: number }[] = []
  open(turn: number, seq: number): void { this.ranges.push({ turn, start: seq }) }
  close(turn: number, seq: number): void {
    const r = [...this.ranges].reverse().find(x => x.turn === turn && x.end === undefined)
    if (r) r.end = seq
  }
  turnOf(seq: number): number | undefined {
    return [...this.ranges].reverse().find(r => r.start < seq && (r.end === undefined || seq < r.end))?.turn
  }
  isOpen(): boolean { return this.ranges.some(r => r.end === undefined) }
  last(): number | undefined { return this.ranges.at(-1)?.turn }
}
