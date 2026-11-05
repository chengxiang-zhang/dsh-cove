/**
 * Agenda source 2: a watched session that stopped moving (09 盯会话).
 *
 * A probe reads the target's event count and last tool name every ten minutes.
 * Two things can come back: the target is idle (the probe itself is due), or the
 * probe has failed three times running, which turns the commitment into a broken
 * delivery handled by the executor module rather than by speech.
 */

import type { Signal } from '../../kernel/ports.ts'
import type { AgendaSource } from './index.ts'

/** Minimum gap between probes (09: 探针每 10 分钟读一次). */
export const WATCH_PROBE_GAP_MS = 10 * 60_000
/** Consecutive failed probes before the commitment is reported broken. */
export const PROBE_FAILURE_MIN = 3

export const watch: AgendaSource = {
  name: 'watch',
  due(commitment, now, read) {
    if (commitment.kind !== 'watch') return null
    const probe = read.get<{ last_tool_at: number | null, repeat_count: number | null }>(
      'SELECT last_tool_at, repeat_count FROM sa_attempt WHERE commitment_id = ? ORDER BY n DESC LIMIT 1',
      commitment.commitment_id,
    )
    if (probe !== null && probe !== undefined) {
      if ((probe.repeat_count ?? 0) >= PROBE_FAILURE_MIN) {
        return { kind: 'probe_failed', detail: { failures: probe.repeat_count } } satisfies Signal
      }
      const last = probe.last_tool_at
      if (typeof last === 'number' && now - last < WATCH_PROBE_GAP_MS) return null
    }
    return { kind: 'watch', detail: { probe_due: true, target: commitment.target } } satisfies Signal
  },
}
