/**
 * Reconciliation: make the ledger agree with the world, every tick, without killing anything.
 *
 * Two histories shaped this file. The first is FMEA-4: reconciliation that only runs
 * at startup silently loses every `turn/end` that arrives during a hot-reload
 * window, and a lost end is a commitment stuck in `running` until a human looks.
 * So this runs off the clock, every round. The second is the mis-kill: a
 * reconciliation that ends an attempt whose session is merely slow destroys work
 * that was still happening. So it marks before it acts, and it re-inspects before
 * it re-dispatches - an attempt marked last round is only redone after the session
 * is confirmed gone a second time.
 *
 * The five steps are 11's, in 11's order:
 *
 * 1. running attempts whose last activity is old get `inspect`ed;
 * 2. a session that is gone -> the attempt ends `orphaned`; the next round re-checks
 *    and re-dispatches inside the attempt budget, or asks and parks the scene;
 * 3. a session that is there and finished its last turn -> closure runs;
 * 4. a session that is there and still working -> untouched;
 * 5. a desk pointing at a session that no longer exists -> rotated and rebuilt.
 *
 * A failed `inspect` is not proof of death. Only an answer that says the session does
 * not exist is; anything else is logged and skipped, because treating "the controller
 * sneezed" as "the work is lost" redoes work on a live attempt.
 *
 * @module dsh-web-all/superagent/recovery/reconcile
 */

import { OPEN_STATES, parseEndReason, type AttemptRow, type CommitmentRow, type DeskRow, type EndReason } from '../protocol/objects.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { Ledger } from '../kernel/ledger.ts'
import type { HostLog, SessionControllerFace } from '../host-ports.ts'
import { parseSessionEvent, turnEndKind } from '../executors/events.ts'
import type { Closure } from '../executors/closure.ts'
import type { Escalation } from '../executors/escalate.ts'
import type { Executors } from '../executors/attempts.ts'
import type { Presence } from '../desk/presence.ts'
import type { RecoverySpeech } from './speak.ts'

/** How quiet a running attempt has to be before its session is inspected. */
export const RECONCILE_STALE_MS = 10 * 60_000

/** Prefix of the one brief line a recovered orphan may produce. */
export const ORPHAN_IDEM_PREFIX = 'orphan:'

/** What one reconciliation pass did; the counters are the startup summary. */
export interface ReconcileResult {
  /** Attempts newly marked `orphaned`. */
  orphaned: number
  /** Attempts whose finished turn was closed. */
  closed: number
  /** Orphans repaired: re-dispatched, or their session came back. */
  healed: number
}

export interface ReconcileDeps {
  ledger: Ledger
  controller: () => SessionControllerFace
  executors: Pick<Executors, 'dispatch' | 'cancel'>
  closure: Pick<Closure, 'close'>
  escalation: Pick<Escalation, 'escalate'>
  presence: Pick<Presence, 'rotate'>
  log: HostLog
  /** One line through the outlet; returns whether it was written. */
  speak(speech: RecoverySpeech): boolean
}

export interface Reconciler {
  reconcile(now: number): Promise<ReconcileResult>
}

const C = PHYSICAL.commitment
const A = PHYSICAL.attempt
const D = PHYSICAL.desk
const OPEN = new Set<string>(OPEN_STATES)

/** What one `inspect` told us about a session. */
type SessionState = { kind: 'missing' } | { kind: 'unknown' } | { kind: 'ended'; reason: EndReason } | { kind: 'running' }

/** A rejection that means "there is no such session", as opposed to "the call failed". */
const MISSING_SESSION = /unknown session|not found|no such|does not exist|missing session/iu

/** The last turn of an event stream: its end reason, if the stream says a turn ended. */
function lastTurnOf(events: readonly unknown[]): { ended?: EndReason; open: boolean } {
  let ended: EndReason | undefined
  let open = false
  for (const raw of events) {
    const event = parseSessionEvent(raw)
    if (event === undefined) continue
    if (event.type === 'turn/start') { open = true; continue }
    if (event.type === 'turn/end') { ended = parseEndReason(turnEndKind(event.data)); open = false }
  }
  return ended === undefined ? { open } : { ended, open }
}

/** Where an answer to this commitment goes. */
function chatOf(commitment: CommitmentRow): string {
  const desk = commitment.desk_id ?? ''
  if (desk.includes(':')) return desk.slice(desk.indexOf(':') + 1)
  if (desk !== '') return desk
  const parts = (commitment.thread_key ?? '').split(':')
  return parts.length >= 3 ? parts[1] ?? '' : ''
}

/**
 * Build the reconciler.
 * @param deps - ledger, the read face and the repair ports.
 * @returns the pass the clock calls every round.
 */
export function createReconciler(deps: ReconcileDeps): Reconciler {
  const { ledger, log } = deps

  const inspectSession = async (sessionId: string | null): Promise<SessionState> => {
    if (sessionId === null || sessionId === '') return { kind: 'missing' }
    let events: readonly unknown[]
    try {
      const snapshot = await deps.controller().inspect(sessionId)
      events = snapshot.events ?? []
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (MISSING_SESSION.test(message)) return { kind: 'missing' }
      log.warn(`superagent/recovery: inspect of ${sessionId} failed, nothing is decided: ${message}`)
      return { kind: 'unknown' }
    }
    const last = lastTurnOf(events)
    if (last.ended !== undefined && !last.open) return { kind: 'ended', reason: last.ended }
    // No events at all is not evidence of an ended turn: leave it alone.
    return { kind: 'running' }
  }

  const markOrphaned = (attempt: AttemptRow, now: number): void => {
    ledger.open(tx => {
      tx.updateAttempt(attempt.attempt_id, { state: 'ended', end_reason: 'orphaned', cancel_origin: 'reconcile', ended_at: now, turn_open: 0 })
      tx.append(attempt.commitment_id, { actor: 'recovery', kind: 'state',
        body: { orphaned: attempt.attempt_id, session: attempt.session_id, at: now } })
    }, { module: 'recovery' })
  }

  const orphanBrief = (commitment: CommitmentRow, attemptId: string): void => {
    const chatId = chatOf(commitment)
    if (chatId === '') {
      log.warn(`superagent/recovery: ${commitment.commitment_id} was redone but has no chat to report to`)
      return
    }
    deps.speak({
      moment: 'brief',
      chatId,
      commitmentId: commitment.commitment_id,
      text: `${commitment.commitment_id} 在执行途中丢过一次（重启或会话丢失），已经重新开始。`,
      idemKey: `${ORPHAN_IDEM_PREFIX}${commitment.commitment_id}:${attemptId}`,
      audience: 'owner',
    })
  }

  /** One attempt already marked orphaned: re-check the session, then repair or ask. */
  const revisitOrphan = async (attempt: AttemptRow, now: number): Promise<boolean> => {
    const commitment = ledger.read.get<CommitmentRow>(`SELECT * FROM ${C} WHERE commitment_id = ?`, attempt.commitment_id)
    if (commitment === undefined || !OPEN.has(commitment.state)) return false
    const session = await inspectSession(attempt.session_id)
    if (session.kind === 'unknown') return false
    if (session.kind !== 'missing') {
      // The session came back: whatever was lost is not lost.
      ledger.open(tx => tx.append(commitment.commitment_id, { actor: 'recovery', kind: 'state',
        body: { healed: attempt.attempt_id, session: attempt.session_id, at: now } }), { module: 'recovery' })
      return true
    }
    if (attempt.lifetime === 'durable') {
      // A durable seat holds a work tree, so re-dispatching could overwrite work that
      // was never committed. Asking is the only safe direction, and the default keeps
      // the scene rather than redoing it.
      deps.escalation.escalate(commitment.commitment_id, 'interrupted', {
        question: `${commitment.commitment_id} 的执行会话已经不存在。重派会覆盖工作目录里未提交的改动。`,
        fallback: '保留工作目录现场，不重派',
      })
      ledger.open(tx => tx.transition(commitment.commitment_id, 'orphaned', { ball: 'me' }), { module: 'recovery' })
      log.warn(`superagent/recovery: ${commitment.commitment_id} orphaned with a work tree; asked the owner, keeping the scene`)
      return false
    }
    const result = deps.escalation.escalate(commitment.commitment_id, 'interrupted')
    if (result.action !== 'retry' && result.action !== 'upgrade') {
      // `ask` or `broken`: escalation already wrote whichever line applies.
      return false
    }
    const dispatched = await deps.executors.dispatch(commitment.commitment_id)
    if ('failed' in dispatched) {
      log.warn(`superagent/recovery: re-dispatch of ${commitment.commitment_id} did not start: ${dispatched.failed}`)
      return false
    }
    orphanBrief(commitment, attempt.attempt_id)
    log.info(`superagent/recovery: ${attempt.attempt_id} lost its session; redone as ${dispatched.attemptId}`)
    return true
  }

  return {
    async reconcile(now: number): Promise<ReconcileResult> {
      const result: ReconcileResult = { orphaned: 0, closed: 0, healed: 0 }

      // Step 2's second half, run first: an attempt marked last round is re-checked
      // and repaired before this round can mark new ones. That ordering is what makes
      // "mark, then look again" hold inside one call as well as across two.
      const revisits = ledger.read.all<AttemptRow>(`SELECT * FROM ${A}
        WHERE state = 'ended' AND end_reason = 'orphaned' AND cancel_origin = 'reconcile'
          AND n = (SELECT max(n) FROM ${A} inner_a WHERE inner_a.commitment_id = ${A}.commitment_id)
        ORDER BY n`)
      for (const attempt of revisits) if (await revisitOrphan(attempt, now)) result.healed += 1

      // Step 1: only attempts quiet for a while are inspected at all.
      const quiet = ledger.read.all<AttemptRow>(`SELECT * FROM ${A}
        WHERE state = 'running' AND coalesce(last_tool_at, started_at, created_at) + ? <= ?
        ORDER BY started_at, n`, RECONCILE_STALE_MS, now)
      for (const attempt of quiet) {
        const session = await inspectSession(attempt.session_id)
        if (session.kind === 'unknown' || session.kind === 'running') continue
        if (session.kind === 'missing') {
          markOrphaned(attempt, now)
          result.orphaned += 1
          continue
        }
        const commitment = ledger.read.get<CommitmentRow>(`SELECT * FROM ${C} WHERE commitment_id = ?`, attempt.commitment_id)
        if (commitment === undefined || !OPEN.has(commitment.state)) continue
        deps.closure.close(attempt.attempt_id, { reason: session.reason })
        result.closed += 1
      }

      // Step 5: a desk whose session is gone cannot be repaired in place.
      for (const desk of ledger.read.all<DeskRow>(`SELECT * FROM ${D} WHERE session_id IS NOT NULL`)) {
        const session = await inspectSession(desk.session_id)
        if (session.kind !== 'missing') continue
        deps.presence.rotate(desk.desk_id, 'manual')
        log.warn(`superagent/recovery: desk ${desk.desk_id} pointed at a missing session; rotated`)
      }

      return result
    },
  }
}

export interface SweepDeps {
  ledger: Ledger
  controller: () => SessionControllerFace
  log: HostLog
}

/**
 * I3: an executor session this ledger does not know is not ours to run.
 *
 * The host can only enumerate sessions it has seen events for, so the caller passes
 * what it observed; anything named like an executor session without an attempt row
 * is cancelled. Ending an attempt is the executors' job (they own the row); this
 * only stops work that has no row to end.
 * @param deps - ledger, controller and log.
 * @param sessionIds - session ids observed this round.
 * @param now - epoch milliseconds, for the log line.
 * @returns the ids that were cancelled.
 */
export async function sweepUnownedSessions(
  deps: SweepDeps,
  sessionIds: readonly string[],
  now: number,
): Promise<string[]> {
  const cancelled: string[] = []
  for (const sessionId of sessionIds) {
    if (!sessionId.startsWith('sa-x-')) continue
    const known = deps.ledger.read.get(`SELECT 1 FROM ${A} WHERE session_id = ?`, sessionId)
    if (known !== undefined) continue
    try {
      deps.controller().cancel({ sessionId })
      cancelled.push(sessionId)
    } catch (error) {
      deps.log.warn(`superagent/recovery: cancelling unowned session ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    deps.log.warn(`superagent/recovery: cancelled unowned executor session ${sessionId} (I3) at ${now}`)
  }
  return cancelled
}