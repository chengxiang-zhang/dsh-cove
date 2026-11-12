/**
 * Bind one attempt to its executor session, healing a cwd conflict (T19 addendum).
 *
 * Executor session ids are deterministic (`sa-x-<commitment>-a<n>`), so a redispatch,
 * a reorg or a stale seat can leave the id already taken on the host. The engine then
 * refuses `create` with a message of the shape
 * `session "<id>" belongs to "<oldCwd>", not "<newCwd>"`, and a bare `create` turns
 * that into a dispatch failure even though the right repair is mechanical.
 *
 * So the create is wrapped once: when it fails, inspect the id. A session that does
 * not exist means the failure is real and is rethrown unchanged. A session that
 * already sits at this attempt's directory (or does not report one, as a remote host
 * may not) is this attempt's own seat and is reattached. Only a session at a
 * different directory is a stale holder of the id: cancel it, then create exactly
 * once. A second failure is not a conflict and rethrows, so the heal can never loop.
 *
 * @module dsh-web-all/superagent/executors/transport/bind-executor-session
 */

import { normalize } from 'node:path'
import type { ExecutorCreateRequest, ExecutorCreateResult, ExecutorSnapshot, ExecutorTransport } from './types.ts'

/** Compare two absolute seat directories by their normalized form (trailing slashes ignored). */
function samePath(a: string, b: string): boolean {
  const canon = (p: string): string => normalize(p).replace(/[/\\]+$/, '')
  return canon(a) === canon(b)
}

/**
 * The engine's cwd-conflict rejection. Capturing the named directories lets the
 * HTTP transport heal even when its snapshot does not yet surface `cwd`.
 */
const BELONGS_TO = /session\s+"([^"]+)"\s+belongs to\s+"([^"]+)",\s*not\s+"([^"]+)"/iu

/** True when the create failure itself names a different working directory. */
function cwdConflictFromError(error: unknown, sessionId: string, wanted: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const match = BELONGS_TO.exec(message)
  if (match === null) return false
  const [, id, oldCwd, newCwd] = match
  if (id !== sessionId) return false
  if (typeof oldCwd !== 'string' || typeof newCwd !== 'string') return false
  // Engine already said the directories differ; still refuse to cancel when the
  // "not" side is not the cwd we asked for (a different kind of create failure).
  return samePath(newCwd, wanted) && !samePath(oldCwd, wanted)
}

/**
 * Create the attempt's session, reattaching or recreating when the id already exists.
 * @param transport - the transport that owns the host the session lands on.
 * @param req - the attempt-scoped create request (deterministic id and its cwd).
 * @returns the create result, or the reattached id when the existing seat is this one.
 */
export async function ensureExecutorSession(
  transport: ExecutorTransport,
  req: ExecutorCreateRequest,
): Promise<ExecutorCreateResult> {
  try {
    return await transport.create(req)
  } catch (error) {
    // Prefer the engine's own cwd-conflict text: HTTP snapshots may omit `cwd`, and
    // treating "exists, cwd unknown" as reattach would keep the wrong seat.
    if (cwdConflictFromError(error, req.sessionId, req.cwd)) {
      await transport.cancel(req.sessionId)
      return await transport.create(req)
    }
    let snapshot: ExecutorSnapshot
    try {
      snapshot = await transport.snapshot(req.sessionId)
    } catch {
      // A host that cannot even be inspected is not a cwd conflict: the create failure stands.
      throw error
    }
    if (!snapshot.exists) throw error
    const existing = snapshot.cwd
    if (existing === undefined || existing.trim() === '' || samePath(existing, req.cwd)) {
      // The id already seats this attempt at this directory (or the host does not report
      // one and the error was not a cwd conflict): reattach rather than recreate.
      return { sessionId: req.sessionId }
    }
    // A different directory means an older life still holds the id. Cancel it once, then
    // create exactly once at the correct directory; a second failure is real and rethrows.
    await transport.cancel(req.sessionId)
    return await transport.create(req)
  }
}
