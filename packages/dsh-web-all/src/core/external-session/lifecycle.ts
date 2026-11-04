/**
 * The session state machine as pure transitions.
 *
 * Every rule the design states about status lives here once, so the engine only
 * sequences effects and the tests can drive all transitions without a process.
 *
 * The four statuses read as: `running` while a turn's child process is alive;
 * `idle` after a turn settled cleanly and after a cancellation; `failed` when
 * the last turn failed, which is a signal the caller may act on rather than a
 * gate, because the design keeps a failed session continuable; `closed` as the
 * terminal state that refuses further turns while the record stays readable.
 * @module dsh-web-all/core/external-session/lifecycle
 */
import { externalError, type ExternalError } from './errors.ts'
import type { ExternalSessionRecord, ExternalSessionStatus, ExternalTurnRecord, ExternalTurnStatus } from './types.ts'

/** Whether the caller is continuing an existing CLI conversation. */
export interface TurnIntent {
  /**
   * True when the turn carries a `session_id`, so it must continue the CLI
   * conversation instead of starting one. A session without a CLI conversation
   * id cannot honour that and is rejected before any process starts.
   */
  resume: boolean
}

/**
 * Whether this session may start a turn now.
 * @param session - the record as stored.
 * @param intent - whether this turn continues the CLI conversation.
 * @returns null when the turn may start, otherwise the code to report.
 */
export function checkTurnAllowed(session: ExternalSessionRecord, intent: TurnIntent): ExternalError | null {
  if (session.status === 'closed') return externalError('session-closed')
  if (session.status === 'running') return externalError('busy')
  if (intent.resume && (session.providerSessionId === undefined || session.providerSessionId === '')) {
    return externalError('session-unresumable')
  }
  return null
}

/** The turn number the next turn takes: one past the last settled one. */
export function nextTurnNumber(session: ExternalSessionRecord): number {
  return session.turns.length + 1
}

/**
 * Session status once a turn settles.
 *
 * A cancellation is not a fault of the session: the CLI conversation is intact
 * and the next turn continues it, so an aborted turn returns the session to
 * `idle`. A failure keeps that fact visible to the caller until a later turn
 * replaces it.
 * @param turnStatus - the terminal status of the turn that just settled.
 */
export function sessionStatusAfterTurn(turnStatus: ExternalTurnStatus): ExternalSessionStatus {
  return turnStatus === 'failed' ? 'failed' : 'idle'
}

/**
 * Apply a settled turn to its session, returning the next record.
 *
 * Pure: the engine persists the result. The turn must be the next in sequence,
 * which keeps `n` — the value the model sees back — identical to the panel's
 * ordering key.
 * @param session - the record as stored.
 * @param turn - the settled turn.
 * @returns the next record.
 * @throws when `turn.n` is not the next number, which is a programming error in the caller.
 */
export function applyTurn(session: ExternalSessionRecord, turn: ExternalTurnRecord): ExternalSessionRecord {
  const expected = nextTurnNumber(session)
  if (turn.n !== expected) throw new Error(`turn ${turn.n} cannot settle on a session whose next turn is ${expected}`)
  const lastTurnAt = turn.startedAt
  return {
    ...session,
    status: sessionStatusAfterTurn(turn.status),
    lastTurnAt,
    turns: [...session.turns, turn],
  }
}

/**
 * Mark a session as running a turn, returning the next record.
 * @param session - the record as stored.
 * @returns the next record.
 */
export function markRunning(session: ExternalSessionRecord): ExternalSessionRecord {
  return session.status === 'running' ? session : { ...session, status: 'running' }
}

/**
 * Close a session. `closed` is terminal; the record stays for the panel.
 * @param session - the record as stored.
 * @returns the next record.
 */
export function closeSession(session: ExternalSessionRecord): ExternalSessionRecord {
  return session.status === 'closed' ? session : { ...session, status: 'closed' }
}