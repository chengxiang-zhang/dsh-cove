/**
 * Recovery of work the owner asked for that was parked as a proposal.
 *
 * Product rule: what the owner says is done without asking the owner to approve it.
 * Before `commit` read an owner's draft mandate as allow, such requests were written
 * as `proposed` with the ball on the owner and no attempt, and nothing would ever
 * move them (the owner had already said it). This step lifts those rows: open, a
 * pending attempt on the executor the desk chose in the brief, then dispatch.
 *
 * The selector is positive, not "looks like an owner row". A row qualifies only when
 * `commit` wrote it: its journal carries a brief with a `mandate` and an `executor`.
 * A `propose` sub-proposal has the same creditor, ball and state but no brief, an
 * `origin_ref` of `prop:...` and a goal as parent; those are the owner's to approve
 * and are never lifted. A colleague's proposal and a host goal are excluded by creditor
 * and kind. Rows that cannot be recognised are skipped quietly: this runs every round.
 *
 * Only the holder of the outlet lease lifts and dispatches (the same predicate
 * startup uses); a process that does not hold it only judges.
 *
 * @module dsh-web-all/superagent/recovery/owner-ball
 */

import { recordPendingAttempt, type Executors } from '../executors/attempts.ts'
import type { ProfileRegistry } from '../executors/profiles/index.ts'
import type { HostLog } from '../host-ports.ts'
import { holds, type Lease } from '../kernel/lease.ts'
import type { Ledger } from '../kernel/ledger.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { CommitmentRow } from '../protocol/objects.ts'

export interface OwnerBallDeps {
  ledger: Ledger
  profiles: ProfileRegistry
  executors: Pick<Executors, 'dispatch'>
  log: HostLog
  /** The outlet lease; only its holder lifts and dispatches. */
  lease: Pick<Lease, 'current'>
  /** This process's identity on the lease row. */
  holder: string
  /** The owner's union id; empty means no owner is configured and nothing qualifies. */
  owner: () => string
}

const C = PHYSICAL.commitment
const A = PHYSICAL.attempt
const J = PHYSICAL.journal
const DAY = 86_400_000

/** Rows already reported as unrecognisable, so a row that stays parked is mentioned once per process. */
const reported = new WeakMap<HostLog, Set<string>>()

function reportOnce(log: HostLog, id: string, message: string): void {
  let seen = reported.get(log)
  if (seen === undefined) { seen = new Set(); reported.set(log, seen) }
  if (seen.has(id)) return
  seen.add(id)
  log.info(message)
}

/**
 * The executor the desk chose, as written by `commit`: the first brief entry, and only
 * when it carries both `mandate` and `executor`. Anything else is not a commit brief.
 */
function briefExecutor(ledger: Ledger, commitmentId: string): string | undefined {
  const row = ledger.read.get<{ body_json: string }>(
    `SELECT body_json FROM ${J} WHERE commitment_id = ? AND kind = 'brief' ORDER BY seq LIMIT 1`, commitmentId)
  if (row === undefined) return undefined
  try {
    const body = JSON.parse(row.body_json) as { executor?: unknown; mandate?: unknown }
    if (typeof body.mandate !== 'string' || typeof body.executor !== 'string' || body.executor === '') return undefined
    return body.executor
  } catch {
    return undefined
  }
}

/**
 * Lift the owner's own parked proposals to open work.
 * @param deps - ledger, profile registry, dispatch port, lease and the owner id.
 * @param now - epoch milliseconds of this round.
 * @returns the commitment ids that were lifted and handed to dispatch.
 */
export async function promoteOwnerProposals(deps: OwnerBallDeps, now: number): Promise<string[]> {
  const { ledger, log } = deps
  const owner = deps.owner()
  if (owner === '') return []
  if (!holds(deps.lease.current(), deps.holder, now)) return []
  const parked = ledger.read.all<CommitmentRow>(
    `SELECT * FROM ${C} WHERE state = 'proposed' AND kind = 'deliver' AND creditor = ? AND ball = ? AND origin_kind = 'event'
       AND origin_ref NOT LIKE 'prop:%'
       AND (parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM ${C} p WHERE p.commitment_id = ${C}.parent_id AND p.kind = 'goal'))
       AND NOT EXISTS (SELECT 1 FROM ${A} WHERE ${A}.commitment_id = ${C}.commitment_id) ORDER BY n`, owner, owner)
  const lifted: string[] = []
  for (const row of parked) {
    try {
      const executor = briefExecutor(ledger, row.commitment_id)
      if (executor === undefined) continue
      const profile = deps.profiles.get(executor)
      if (profile === undefined) {
        reportOnce(log, row.commitment_id, `superagent/recovery: ${row.commitment_id} is the owner's own request but its executor ${executor} is not registered; left proposed`)
        continue
      }
      // Opening a proposal and subscribing its thread is judgment's act (the fast-path
      // approve writes the same rows under that module); recovery only decides the moment.
      const opened = ledger.open(tx => {
        // Re-confirm inside the transaction: the owner may have approved or withdrawn it
        // since the read above, and a lifted row must not get a second attempt.
        const current = tx.get<CommitmentRow>(`SELECT * FROM ${C} WHERE commitment_id = ?`, row.commitment_id)
        if (current === undefined || current.state !== 'proposed') return false
        if (tx.get(`SELECT 1 FROM ${A} WHERE commitment_id = ?`, row.commitment_id) !== undefined) return false
        // The clock of a proposal started when it was written; the work starts now.
        const model = current.eta_model_min
        const etaAt = typeof model === 'number' && model > 0 ? tx.now + Math.round(model * (current.eta_factor ?? 1) * 60_000) : undefined
        tx.transition(row.commitment_id, 'open', {
          ball: 'me',
          ...(etaAt === undefined ? {} : { eta_at: etaAt }),
          next_look_at: etaAt === undefined ? tx.now + DAY : Math.min(etaAt, tx.now + DAY),
        })
        const attempt = recordPendingAttempt(tx, row.commitment_id, profile, 'owner request recovered from proposed')
        if (current.thread_key) {
          tx.run(`INSERT OR IGNORE INTO ${PHYSICAL.subscription} (thread_key, commitment_id, attempt_id, input_seq, created_at, updated_at)
            VALUES (?, ?, ?, 0, ?, ?)`, current.thread_key, row.commitment_id, attempt.attempt_id, tx.now, tx.now)
        }
        tx.append(row.commitment_id, { actor: 'recovery', kind: 'state', body: { owner_request_lifted: 'proposed->open', executor: profile.id } })
        return true
      }, { module: 'judgment' })
      if (!opened) continue
      const dispatched = await deps.executors.dispatch(row.commitment_id)
      if ('failed' in dispatched) log.warn(`superagent/recovery: ${row.commitment_id} lifted to open but dispatch did not start: ${dispatched.failed}`)
      else log.info(`superagent/recovery: ${row.commitment_id} was the owner's own request parked as proposed; now running as ${dispatched.attemptId}`)
      lifted.push(row.commitment_id)
    } catch (error) {
      log.warn(`superagent/recovery: lifting ${row.commitment_id} failed, left as it was: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return lifted
}
