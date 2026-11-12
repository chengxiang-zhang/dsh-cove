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

import { LATE_WARNED_KEY } from '../../kernel/clock.ts'
import type { Signal } from '../../kernel/ports.ts'
import { PHYSICAL } from '../../protocol/db.ts'
import type { AgendaSource } from './index.ts'

/** One probe window; two windows of silence mean the attempt is stalled. */
export const PROBE_WINDOW_MS = 5 * 60_000
/** Two windows without a tool call: the attempt is stalled (09: 两窗口 10 分钟). */
export const STALL_AFTER_MS = 2 * PROBE_WINDOW_MS
/** Three repeats of the same failure signature: the attempt is looping. */
export const LOOP_REPEAT_MIN = 3

/**
 * Whether a `late` warning was already raised for this commitment. "Once" is read
 * from the journal, like the reminder: the clock appends a note carrying
 * `LATE_WARNED_KEY` in the same transaction that requests the warning turn.
 */
function alreadyWarned(read: Parameters<AgendaSource['due']>[2], commitmentId: string): boolean {
  const rows = read.all<{ body_json: string | null }>(
    `SELECT body_json FROM ${PHYSICAL.journal} WHERE commitment_id = ? AND kind = 'note'`,
    commitmentId,
  )
  return rows.some(row => typeof row.body_json === 'string' && row.body_json.includes(`"${LATE_WARNED_KEY}"`))
}

export const deliverWarning: AgendaSource = {
  name: 'deliver-warning',
  due(commitment, now, read) {
    if (commitment.kind !== 'deliver') return null
    const attempt = read.get<{ last_tool_at: number | null, repeat_count: number | null, state: string | null }>(
      'SELECT last_tool_at, repeat_count, state FROM sa_attempt WHERE commitment_id = ? ORDER BY n DESC LIMIT 1',
      commitment.commitment_id,
    )
    const hasAttempt = attempt !== null && attempt !== undefined
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
    // Only work that is actually under way can be late. A `proposed` commitment is
    // waiting for the owner's approval, so its ETA passing is not the executor's lag,
    // and warning about it every round is the storm this guard exists to stop.
    if (typeof commitment.eta_at === 'number' && now > commitment.eta_at) {
      const executing = hasAttempt || ((commitment.state === 'open' || commitment.state === 'at_risk') && commitment.ball === 'me')
      if (!executing) return null
      if (alreadyWarned(read, commitment.commitment_id)) return null
      const overdueMs = now - commitment.eta_at
      return { kind: 'late', detail: { overdue_ms: overdueMs, eta_at: commitment.eta_at } } satisfies Signal
    }
    return null
  },
}
