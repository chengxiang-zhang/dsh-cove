/**
 * Bind a conversation to its DSH session, adopting one that already exists.
 *
 * The answer path names its sessions deterministically so a restart reattaches to
 * the same context. That determinism has a sharp edge: a session id can only be
 * created once, and the engine refuses to create it again under a different
 * working directory. Without adoption, changing `autoReplyCwd` once would make
 * every later message in that conversation fail forever - the exact silent
 * breakage this feature exists to remove.
 *
 * Adoption is deliberately narrow: it only accepts a session the engine can
 * actually show us under the requested id. An error that leaves no such session
 * is re-thrown, because that is a real failure and retrying it is the caller's
 * decision, not this function's.
 *
 * Kept out of the service domain so the decision is testable with a fake face
 * rather than through a whole plugin mount.
 */

/** The slice of the engine's session controller that binding needs. */
export interface SessionBindingFace {
  create(request: { sessionId?: string; cwd?: string }): Promise<{ sessionId?: unknown }>
  inspect?(sessionId: string): Promise<{ meta?: { cwd?: unknown } }>
}

/** What the caller may want to know about how binding went. */
export interface SessionBindingOutcome {
  /** True when an existing session was adopted instead of created. */
  readonly adopted: boolean
  /** Working directory the adopted session actually has, when it could be read. */
  readonly cwd?: string
}

export interface SessionBindingInput {
  readonly sessionId: string
  /** Desired working directory; empty means "let the engine decide". */
  readonly cwd: string
}

/**
 * Ensure the session exists, adopting a conflicting one when the engine has it.
 *
 * @param face - the engine's session controller slice.
 * @param input - the session id to bind and the working directory to request.
 * @returns whether the session was adopted and, if so, its real directory.
 * @throws when the engine neither created the session nor can show it.
 */
export async function bindReplySession(
  face: SessionBindingFace,
  input: SessionBindingInput,
): Promise<SessionBindingOutcome> {
  const request = { sessionId: input.sessionId, ...(input.cwd.trim() === '' ? {} : { cwd: input.cwd.trim() }) }
  try {
    const created = await face.create(request)
    const returned = typeof created?.sessionId === 'string' ? created.sessionId : ''
    // An empty id is the engine saying "already yours": the id was supplied, so
    // there is nothing else it could have bound. Treating it as a failure would
    // break adoption on the one path that matters.
    if (returned === '' || returned === input.sessionId) return { adopted: false }
    throw new Error(`会话创建返回了意外的 id（期望 ${input.sessionId}，得到 ${returned}）`)
  } catch (error) {
    const existing = await inspectQuietly(face, input.sessionId)
    if (existing === undefined) throw error
    return {
      adopted: true,
      ...(existing.cwd === '' ? {} : { cwd: existing.cwd }),
    }
  }
}

/**
 * Read a session's metadata without turning a lookup failure into the error the
 * caller is about to report: the create failure is the interesting one.
 * @param face - the engine's session controller slice.
 * @param sessionId - the session to look for.
 * @returns the readable metadata, or undefined when the session is not there.
 */
async function inspectQuietly(
  face: SessionBindingFace,
  sessionId: string,
): Promise<{ cwd: string } | undefined> {
  if (face.inspect === undefined) return undefined
  try {
    const inspection = await face.inspect(sessionId)
    if (inspection === null || inspection === undefined) return undefined
    const cwd = typeof inspection.meta?.cwd === 'string' ? inspection.meta.cwd : ''
    return { cwd }
  } catch {
    return undefined
  }
}