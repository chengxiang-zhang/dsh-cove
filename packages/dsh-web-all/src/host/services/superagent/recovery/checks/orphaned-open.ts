/**
 * Check: a commitment in a terminal state must carry its closing time.
 *
 * 11's reading `SELECT count(*) FROM commitment WHERE state='orphaned' AND
 * closed_at IS NULL` must be zero. The ledger fills `closed_at` on every terminal
 * transition, so a non-zero count means a row was written by something that
 * bypassed the state machine - the one thing this check can see and the repairs
 * cannot.
 *
 * @module dsh-web-all/superagent/recovery/checks/orphaned-open
 */

import { TERMINAL_STATES } from '../../protocol/objects.ts'
import { PHYSICAL } from '../../protocol/db.ts'
import type { Ledger } from '../../kernel/ledger.ts'
import type { Finding, RecoveryCheck } from './types.ts'

/** Terminals whose rows must be closed; every terminal state qualifies. */
const TERMINAL = [...TERMINAL_STATES]

/**
 * Build the check.
 * @param ledger - read-only handle.
 * @returns the check.
 */
export function orphanedOpenCheck(ledger: Ledger): RecoveryCheck {
  return {
    name: 'terminal_without_close',
    async check(): Promise<Finding[]> {
      const placeholders = TERMINAL.map(() => '?').join(', ')
      const rows = ledger.read.all<{ commitment_id: string; state: string }>(
        `SELECT commitment_id, state FROM ${PHYSICAL.commitment}
         WHERE state IN (${placeholders}) AND closed_at IS NULL ORDER BY commitment_id`, ...TERMINAL)
      return rows.map(row => ({
        code: 'terminal_without_close',
        subject: row.commitment_id,
        detail: { state: row.state },
        severity: 'alert' as const,
      }))
    },
  }
}