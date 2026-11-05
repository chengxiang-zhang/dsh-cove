/**
 * Probes: read-only observation for watch commitments (10 "观察器").
 *
 * A probe is a special case of a read-only oneshot executor: five minutes of wall
 * clock, inspect-class reads only, and a structured reading instead of prose. It
 * never writes code, never changes state and never retries forever — a read that
 * fails counts once, and three failures in a row turn the commitment broken with a
 * line in the brief. Probes do not touch the ledger: the caller that owns the
 * commitment row performs the transition in `onBroken`.
 *
 * The four readings are the ones `10` names: how many events the session has, the
 * last tool it called, how many tool calls happened in the last ten minutes, and
 * how similar the last two texts are (a repetition signal).
 */

/** F2: `inspect` returns the whole event list, so a probe only reads the tail. */
export const PROBE_TAIL = 200

/** Fixed wall clock for one probe run (10 "固定墙钟 5 分钟"). */
export const PROBE_WALL_MS = 5 * 60_000

/** Three failures in a row is where the probe stops trying and the commitment breaks. */
export const PROBE_FAIL_LIMIT = 3

export type ReadingName = 'event_count' | 'last_tool' | 'tool_calls_10m' | 'last_text_similarity'

export interface Reading {
  name: ReadingName
  value: number | string
}

export interface Probe {
  name: string
  probe(target: string, signal: AbortSignal): Promise<Reading[]>
}

export interface ProbeOutcome {
  ok: boolean
  readings: Reading[]
  failures: number
  broken: boolean
}

export interface ProbeWatcherDeps {
  /** Called once, on the third consecutive failure; the caller writes `broken`. */
  onBroken: (commitmentId: string, failures: number) => void
  failLimit?: number
  wallMs?: number
}

export interface ProbeWatcher {
  watch(probe: Probe, commitmentId: string, target: string): Promise<ProbeOutcome>
}

interface WatchState {
  failures: number
  broken: boolean
}

export function createProbeWatcher(deps: ProbeWatcherDeps): ProbeWatcher {
  const failLimit = deps.failLimit ?? PROBE_FAIL_LIMIT
  const wallMs = deps.wallMs ?? PROBE_WALL_MS
  const states = new Map<string, WatchState>()

  return {
    async watch(probe: Probe, commitmentId: string, target: string): Promise<ProbeOutcome> {
      const state = states.get(commitmentId) ?? { failures: 0, broken: false }
      states.set(commitmentId, state)
      // Broken is terminal for this watcher: no further probing, no more signals.
      if (state.broken) return { ok: false, readings: [], failures: state.failures, broken: true }
      try {
        const readings = await probe.probe(target, AbortSignal.timeout(wallMs))
        if (readings.length === 0) throw new Error('probe returned no reading')
        state.failures = 0
        return { ok: true, readings, failures: 0, broken: false }
      } catch {
        state.failures += 1
        if (state.failures >= failLimit) {
          state.broken = true
          deps.onBroken(commitmentId, state.failures)
        }
        return { ok: false, readings: [], failures: state.failures, broken: state.broken }
      }
    },
  }
}