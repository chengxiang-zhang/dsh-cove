/**
 * Agenda source 1: a deliver commitment that is late, stalled, or going in circles
 * (09 交付预警).
 *
 * The three outcomes are deliberately different kinds, because they go to
 * different places:
 *
 * - `late` is news for the owner: the first time a delivery passes its calibrated
 *   ETA while the owner is waiting. It belongs in the brief, not in an interrupt.
 * - `self_heal` is news for the executor: no tool call for two probe windows, or
 *   the same failure three times, is a reason to re-dispatch or switch tier. It
 *   never asks for speech, which is what keeps a stuck job from interrupting the
 *   owner (G9: 空跑与卡死是系统故障，自愈、不打扰).
 */

import type { Signal } from '../../kernel/ports.ts'
import type { AgendaSource } from './index.ts'

/** One probe window; two windows of silence mean the attempt is stalled. */
export const PROBE_WINDOW_MS = 5 * 60_000
/** Two windows without a tool call: the attempt is stalled (09: 两窗口 10 分钟). */
export const STALL_AFTER_MS = 2 * PROBE_WINDOW_MS
/** Three repeats of the same failure signature: the attempt is looping. */
export const LOOP_REPEAT_MIN = 3

export const deliverWarning: AgendaSource = {
  name: 'deliver-warning',
  due(commitment, now, read) {
    if (commitment.kind !== 'deliver') return null
    const attempt = read.get<{ last_tool_at: number | null, repeat_count: number | null, state: string | null }>(
      'SELECT last_tool_at, repeat_count, state FROM sa_attempt WHERE commitment_id = ? ORDER BY n DESC LIMIT 1',
      commitment.commitment_id,
    )
    if (attempt !== null && attempt !== undefined) {
      if ((attempt.repeat_count ?? 0) >= LOOP_REPEAT_MIN) {
        return { kind: 'self_heal', detail: { reason: 'loop', repeat_count: attempt.repeat_count } } satisfies Signal
      }
      const last = attempt.last_tool_at
      if (typeof last === 'number' && now - last >= STALL_AFTER_MS) {
        return { kind: 'self_heal', detail: { reason: 'stall', idle_ms: now - last } } satisfies Signal
      }
    }
    // The first crossing of the calibrated ETA is a brief line, not an interrupt:
    // `attention.tier` decides the rest, and the caller maps `late` to `brief`.
    if (typeof commitment.eta_at === 'number' && now > commitment.eta_at) {
      const overdueMs = now - commitment.eta_at
      return { kind: 'late', detail: { overdue_ms: overdueMs, eta_at: commitment.eta_at } } satisfies Signal
    }
    return null
  },
}
