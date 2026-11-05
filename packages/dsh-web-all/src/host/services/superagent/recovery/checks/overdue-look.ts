/**
 * Check: an open debt that is past its look time.
 *
 * I1 is a table-level constraint at write time; this check is the read-time half.
 * It catches the shape the constraint cannot: an open row whose `next_look_at`
 * belonged to an agenda turn that never ran (a crashed clock, a hot-reload window).
 * Recovery does not move the look time itself - that is the agenda's repair - it
 * only makes the row visible in the round's findings.
 *
 * @module dsh-web-all/superagent/recovery/checks/overdue-look
 */

import { OPEN_STATES } from '../../protocol/objects.ts'
import { PHYSICAL } from '../../protocol/db.ts'
import type { Ledger } from '../../kernel/ledger.ts'
import type { Finding, RecoveryCheck } from './types.ts'

/** How overdue a look time must be before it is worth a finding. */
export const OVERDUE_GRACE_MS = 60 * 60_000

/**
 * Build the check.
 * @param ledger - read-only handle.
 * @returns the check.
 */
export function overdueLookCheck(ledger: Ledger): RecoveryCheck {
  return {
    name: 'overdue_look',
    async check(now: number): Promise<Finding[]> {
      const placeholders = OPEN_STATES.map(() => '?').join(', ')
      const rows = ledger.read.all<{ commitment_id: string; next_look_at: number | null }>(
        `SELECT commitment_id, next_look_at FROM ${PHYSICAL.commitment}
         WHERE state IN (${placeholders}) AND next_look_at IS NOT NULL AND next_look_at + ? < ?
         ORDER BY next_look_at, commitment_id`, ...OPEN_STATES, OVERDUE_GRACE_MS, now)
      return rows.map(row => ({
        code: 'overdue_look',
        subject: row.commitment_id,
        detail: { next_look_at: row.next_look_at, overdue_ms: now - (row.next_look_at ?? now) },
        severity: 'warn' as const,
      }))
    },
  }
}