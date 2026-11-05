/**
 * Which moments the secretary may use, given what the turn actually did (02).
 *
 * `say` carries a moment because a message without one cannot be audited: the
 * seven-step chain reads first-ack timing, delivery evidence, and one text reply
 * per inbound event from the moment column. The rule that keeps those readings
 * meaningful is that a moment is a statement of fact about the turn, not a label
 * the model picks. "Delivered" is allowed only when the commitment is terminal,
 * "accepted" only right after a commit in the same turn, and a broken-down
 * request may say so only when it really broke down.
 *
 * The facts are supplied by the caller because they are ledger-shaped; this
 * module itself reads nothing.
 *
 * Pure module: no clock, no store, no channel.
 */

import type { OutboxMoment } from '../protocol/objects.ts'

/** What the turn really did, as the caller observed it. */
export interface MomentFacts {
  /** A commitment was created in this very turn. */
  committedInThisTurn: boolean
  /** The commitment the message is about is in a terminal state. */
  commitmentTerminal: boolean
  /** The disposition of this batch is `answer` or `check`. */
  dispositionIsAnswerOrCheck: boolean
  /** An asked assumption, or a route decision, is open on the desk. */
  hasAskedAssumptionOrRoute: boolean
  /** The commitment turned broken or at_risk, or the dispatch ended. */
  brokenOrAtRiskOrDispatchFailed: boolean
  /** This is an agenda turn and the host reported a signal. */
  isAgendaTurnWithSignal: boolean
  /** The host itself is the author (fallback acknowledgement, daily brief). */
  byHost: boolean
}

/**
 * Decide whether a moment is truthful for this turn.
 *
 * `pushback` is never allowed here: `02` says it is produced by the pushback tool
 * and never by `say`, so a proposal that claims it is refused outright.
 * @param moment - the moment the proposal wants to send.
 * @param facts - what the turn actually did.
 * @returns true when the moment matches the facts.
 */
export function momentAllowed(moment: OutboxMoment, facts: MomentFacts): boolean {
  switch (moment) {
    case 'ack':
      // The host may fall back to "收到，正在判断" within 60 seconds even when the
      // turn has not committed yet (`10`).
      return facts.committedInThisTurn || facts.byHost
    case 'deliver':
      return facts.commitmentTerminal
    case 'answer':
      return facts.dispositionIsAnswerOrCheck
    case 'ask':
      return facts.hasAskedAssumptionOrRoute
    case 'cannot':
      return facts.brokenOrAtRiskOrDispatchFailed
    case 'alert':
      return facts.isAgendaTurnWithSignal
    case 'brief':
      return facts.byHost
    case 'pushback':
      return false
    default:
      // A value outside the closed union is a protocol violation, not a moment.
      return false
  }
}