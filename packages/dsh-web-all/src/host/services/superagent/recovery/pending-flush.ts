/**
 * Recovery of work stalled with a pending attempt and no live seat.
 *
 * `onDispatchFailure`'s second failure writes a fresh pending attempt "queued for
 * agenda retry" and returns, but nothing in the agenda dispatches a pending attempt:
 * the four agenda sources (09) only turn a due commitment into a speech signal, never
 * into a seat. So a durable deliver whose two dispatches failed - and any commitment
 * whose latest attempt is pending after a reorg that lost the in-flight dispatch -
 * sits `open` forever, and for a durable also keeps holding the single slot behind
 * every other durable.
 *
 * This step is the one place that picks a pending attempt back up. It finds the
 * open/at_risk commitments whose latest attempt is `pending` with no `running`
 * attempt and hands each to `executors.dispatch`, which re-reads the pending row,
 * re-claims the slot through `claimSlot`, and seats it - or returns `SLOT_FULL` and
 * leaves it pending for the next round, which is the fair wait behind a durable that
 * is already seated. Only the holder of the outlet lease dispatches (the same
 * predicate `promoteOwnerProposals` uses): a process that does not speak does not act.
 *
 * @module dsh-web-all/superagent/recovery/pending-flush
 */

import type { Executors } from '../executors/attempts.ts'
import type { HostLog } from '../host-ports.ts'
import { holds, type Lease } from '../kernel/lease.ts'
import type { Ledger } from '../kernel/ledger.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { CommitmentRow } from '../protocol/objects.ts'

const C = PHYSICAL.commitment
const A = PHYSICAL.attempt

export interface PendingFlushDeps {
  ledger: Ledger
  executors: Pick<Executors, 'dispatch'>
  log: HostLog
  /** The outlet lease; only its holder dispatches. */
  lease: Pick<Lease, 'current'>
  /** This process's identity on the lease row. */
  holder: string
}

/**
 * Dispatch every open/at_risk commitment whose latest attempt is pending with no
 * live seat.
 * @param deps - ledger, dispatch port, lease and this holder's identity.
 * @param now - epoch milliseconds of this round (for the lease predicate).
 * @returns the commitment ids that were handed to dispatch and seated.
 */
export async function flushPendingDispatch(deps: PendingFlushDeps, now: number): Promise<string[]> {
  const { ledger, log } = deps
  if (!holds(deps.lease.current(), deps.holder, now)) return []
  // The latest attempt is pending and nothing is running: a seat is owed but none
  // is live. A running attempt (even on an older n) means the work is already under
  // way, so that commitment is left alone.
  const stuck = ledger.read.all<CommitmentRow>(
    `SELECT * FROM ${C} c
       WHERE c.state IN ('open', 'at_risk')
         AND EXISTS (SELECT 1 FROM ${A} p WHERE p.commitment_id = c.commitment_id AND p.state = 'pending'
           AND p.n = (SELECT max(n) FROM ${A} m WHERE m.commitment_id = c.commitment_id))
         AND NOT EXISTS (SELECT 1 FROM ${A} r WHERE r.commitment_id = c.commitment_id AND r.state = 'running')
       ORDER BY c.n`)
  const dispatched: string[] = []
  for (const row of stuck) {
    try {
      const result = await deps.executors.dispatch(row.commitment_id)
      if ('failed' in result) {
        // SLOT_FULL or a fresh dispatch failure: the pending row stays, the next round
        // retries. onDispatchFailure already counts and breaks a commitment that keeps failing.
        log.info(`superagent/recovery: ${row.commitment_id} had a pending attempt but did not seat this round: ${result.failed}`)
        continue
      }
      log.info(`superagent/recovery: ${row.commitment_id} had a pending attempt with no seat; dispatched as ${result.attemptId}`)
      dispatched.push(row.commitment_id)
    } catch (error) {
      log.warn(`superagent/recovery: flushing pending ${row.commitment_id} failed, left as it was: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return dispatched
}
