/**
 * Which DSH sessions belong to the Feishu answer path.
 *
 * Two capabilities need the same fact for opposite reasons. `lark-inbox` drives
 * these sessions on behalf of a person talking to the bot, and `notify` must not
 * push a "run finished" notice for them: the answer itself already reaches that
 * person, so a second notification is a duplicate, not a feature.
 *
 * The fact lives here rather than in either of them because this domain is the
 * only one both already depend on. Putting it in `lark-inbox` would make `notify`
 * import the inbox, and the dependency direction is what keeps the three Feishu
 * capabilities from growing a second credential path.
 *
 * In memory on purpose: it is a routing hint, not state. A restarted process
 * loses it and the answer path re-registers its sessions on mount, while a stale
 * hint would only suppress a notice that a restart already made moot.
 */

const botSessions = new Set<string>()

/**
 * Record that a session answers a Feishu conversation.
 * @param sessionId - the engine session id.
 */
export function markBotSession(sessionId: string): void {
  const id = sessionId.trim()
  if (id !== '') botSessions.add(id)
}

/**
 * Whether a session belongs to the answer path.
 * @param sessionId - the engine session id.
 * @returns true when this session exists to answer a Feishu message.
 */
export function isBotSession(sessionId: string): boolean {
  return botSessions.has(sessionId.trim())
}

/**
 * Forget every registration.
 *
 * Used when the answer path tears down: a session whose bot is gone must go back
 * to being an ordinary session, or a later run in it would silently lose its
 * notice.
 */
export function clearBotSessions(): void {
  botSessions.clear()
}

/**
 * Drop one registration.
 * @param sessionId - the engine session id.
 */
export function unmarkBotSession(sessionId: string): void {
  botSessions.delete(sessionId.trim())
}
