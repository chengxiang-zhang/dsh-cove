/**
 * Degrade bookkeeping: one open row per (reason, scope) while the condition lasts.
 *
 * A degradation that nobody can read is indistinguishable from a bug, so the state
 * lives in the ledger rather than in a boolean somewhere: `status` and the brief
 * both read this table, and an operator can answer "what is it not doing, and
 * since when" with one query. The row is opened once per condition - calling
 * `degrade` again while it is still open returns the same id - so a condition
 * checked on every tick cannot flood the table.
 *
 * Recovery owns this table (02 object catalogue); every other write in this module
 * goes through the kernel's repair helpers, which is what keeps "recovery never
 * rewrites the ledger" true at the SQL level, not just by convention.
 *
 * @module dsh-web-all/superagent/recovery/degrade
 */

import type { Ledger } from '../kernel/ledger.ts'
import { PHYSICAL } from '../protocol/db.ts'

/** One open or closed degradation. */
export interface DegradeRow {
  degrade_id: string
  reason: string
  scope: string
  started_at: number
  ended_at: number | null
  created_at: number
  updated_at: number | null
}

export interface DegradeRegistry {
  /** Open a degradation, or return the id of the one already open. */
  degrade(reason: string, scope: string): string
  /** Close every open row for this condition. */
  recover(reason: string, scope: string): void
  /** The rows still open, oldest first - the `status` degrade section reads this. */
  open(): DegradeRow[]
}

const G = PHYSICAL.degrade_event

/**
 * Build the registry over one ledger.
 * @param ledger - the kernel ledger handle.
 * @returns the degrade/recover pair plus the open-row read.
 */
export function createDegrades(ledger: Ledger): DegradeRegistry {
  let seq = 0
  return {
    degrade(reason, scope) {
      const now = ledger.nowMs()
      return ledger.open(tx => {
        const existing = tx.get<{ degrade_id: string }>(
          `SELECT degrade_id FROM ${G} WHERE reason = ? AND scope = ? AND ended_at IS NULL`, reason, scope)
        if (existing !== undefined) return existing.degrade_id
        seq += 1
        const id = `deg-${now}-${seq}`
        tx.run(`INSERT INTO ${G} (degrade_id, reason, scope, started_at, ended_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?)`, id, reason, scope, now, now, now)
        return id
      }, { module: 'recovery' })
    },

    recover(reason, scope) {
      const now = ledger.nowMs()
      ledger.open(tx => {
        tx.run(`UPDATE ${G} SET ended_at = ?, updated_at = ? WHERE reason = ? AND scope = ? AND ended_at IS NULL`,
          now, now, reason, scope)
      }, { module: 'recovery' })
    },

    open() {
      return ledger.read.all<DegradeRow>(`SELECT * FROM ${G} WHERE ended_at IS NULL ORDER BY started_at, degrade_id`)
    },
  }
}