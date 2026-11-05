/**
 * Who a session belongs to, as a function instead of a process-local set.
 *
 * The host already answers one third of this question: `feishu/bot-sessions.ts`
 * keeps the set of sessions the reply bot opened, and that read stays where it is
 * (F20) - this module only calls it. The other two thirds are the desk and the
 * executor, and both are recoverable from the ledger, which is the point: after a
 * restart the same session id has to resolve to the same role without any state
 * that lived in the previous process (I5).
 *
 * A session that resolves to nothing is not an error. It is the answer to "this is
 * not ours", and the caller cancels it (I3) or ignores it.
 *
 * @module dsh-web-all/superagent/recovery/roles
 */

import type { Executors } from '../executors/attempts.ts'
import type { Presence } from '../desk/presence.ts'

/** The three kinds of session this host runs. */
export type Role = 'bot' | `desk:${string}` | `executor:${string}`

/** The three sources of truth, narrowed so a caller can hand over the real objects. */
export interface RoleSources {
  /** F20's set, read through the existing function; never reimplemented here. */
  isBotSession(sessionId: string): boolean
  desk: Pick<Presence, 'roleOf'>
  executors: Pick<Executors, 'roleOf'>
}

/**
 * Resolve one session id to the role that owns it.
 *
 * Order matters: the bot check is first because the reply bot's sessions are named
 * by the platform conversation, and a desk must never adopt one.
 * @param sessionId - the session to classify.
 * @param sources - the three resolvers.
 * @returns the role, or undefined when the session is not ours.
 */
export function resolveRole(sessionId: string, sources: RoleSources): Role | undefined {
  const id = sessionId.trim()
  if (id === '') return undefined
  if (sources.isBotSession(id)) return 'bot'
  const desk = sources.desk.roleOf(id)
  if (desk !== undefined) return desk
  return sources.executors.roleOf(id)
}