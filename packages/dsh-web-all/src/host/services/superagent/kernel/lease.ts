/**
 * Outlet lease (T14): one row, one voice (I4).
 *
 * Heartbeat every 15 seconds; a lease whose heartbeat is older than 60 seconds
 * may be taken over, and taking it over raises the epoch. Only the holder of the
 * current epoch may send.
 */

import { PHYSICAL } from '../protocol/db.ts'
import type { LeaseRow } from '../protocol/objects.ts'
import type { Ledger } from './ledger.ts'

export const LEASE_HEARTBEAT_MS = 15_000
export const LEASE_EXPIRY_MS = 60_000

export interface Lease {
  acquire(holder: string, now: number): { held: boolean; epoch: number; holder: string }
  heartbeat(holder: string, now: number): boolean
  current(): LeaseRow | undefined
}

const L = PHYSICAL.lease

/** True when `holder` holds an unexpired lease at `now`. */
export function holds(row: LeaseRow | undefined, holder: string, now: number): row is LeaseRow {
  return row !== undefined && row.holder === holder && row.heartbeat_at + LEASE_EXPIRY_MS >= now
}

export function createLease(ledger: Ledger): Lease {
  return {
    acquire(holder, now) {
      return ledger.open(tx => {
        const row = tx.get<LeaseRow>(`SELECT * FROM ${L} WHERE name = 'outlet'`)
        if (!row) {
          tx.run(`INSERT INTO ${L} (name, holder, epoch, heartbeat_at, expires_at, created_at, updated_at) VALUES ('outlet', ?, 1, ?, ?, ?, ?)`,
            holder, now, now + LEASE_EXPIRY_MS, now, now)
          return { held: true, epoch: 1, holder }
        }
        if (row.holder === holder) {
          tx.run(`UPDATE ${L} SET heartbeat_at = ?, expires_at = ?, updated_at = ? WHERE name = 'outlet'`, now, now + LEASE_EXPIRY_MS, now)
          return { held: true, epoch: row.epoch, holder }
        }
        if (row.heartbeat_at + LEASE_EXPIRY_MS < now) {
          const epoch = row.epoch + 1
          tx.run(`UPDATE ${L} SET holder = ?, epoch = ?, heartbeat_at = ?, expires_at = ?, updated_at = ? WHERE name = 'outlet'`,
            holder, epoch, now, now + LEASE_EXPIRY_MS, now)
          return { held: true, epoch, holder }
        }
        return { held: false, epoch: row.epoch, holder: row.holder }
      }, { module: 'kernel' })
    },
    heartbeat(holder, now) {
      return ledger.open(tx => tx.run(`UPDATE ${L} SET heartbeat_at = ?, expires_at = ?, updated_at = ? WHERE name = 'outlet' AND holder = ?`,
        now, now + LEASE_EXPIRY_MS, now, holder).changes > 0, { module: 'kernel' })
    },
    current() {
      return ledger.read.get<LeaseRow>(`SELECT * FROM ${L} WHERE name = 'outlet'`)
    },
  }
}
