/**
 * Retire the sidebar row of a lane whose conversations are all archived.
 *
 * Why a lane ever has a workspace row
 *   The platform accounts a session to a workspace only while the session's cwd
 *   equals that workspace's path (`WorkspaceEntity.sessionIds` filters by the
 *   session's path, and `attachSession` refuses any other cwd), and a blank
 *   conversation that no workspace accounts for renders an inert composer
 *   ("choose a workspace to start"). So the lane's directory must BE a workspace
 *   while a conversation runs in it — that part is a platform requirement, not a
 *   taste, and no plugin can avoid the row.
 *
 * What this owns
 *   The row's LIFETIME. Once every conversation the lane accounts for is
 *   archived, the registration is dead weight: the directory, the branch and the
 *   manifest binding stay, so picking that branch again re-registers the
 *   directory in one call. The host half retires the same way from archive
 *   events; this half runs where the archive set is visible to the browser, so it
 *   also cleans up rows an earlier build left behind — including on an
 *   installation whose host bundle predates that change.
 *
 * Safety rules
 *   - only paths that are this plugin's lane directories (`<repo>/.dsh/workspaces/<branch>`);
 *   - only workspaces that account for at least one conversation (a lane created
 *     moments ago has none yet, and must not be retired from under its setup);
 *   - only when every accounted conversation is archived. A lane with a live
 *     conversation keeps its workspace, or that conversation loses the workspace
 *     it runs in.
 * @module @dsh-cove/dsh-client-ui-worktree/client/lane-workspace-sweeper
 */

import { isLaneDirectory } from '../../../core/worktree/paths.ts'

/** The workspace-list slice the sweep reads (mirrors the client workspace snapshot). */
export interface LaneSweepSnapshot {
  /** `ready` once the host list has arrived; earlier phases carry no items. */
  phase?: string
  items?: readonly {
    workspaceId?: string
    path?: string
    sessionIds?: readonly string[]
  }[]
  /** Complete registry-global archive set. */
  archivedSessionIds?: readonly string[]
}

/** The client workspace face the sweep needs. */
export interface LaneSweeperWorkspaces {
  list?: {
    getSnapshot?: () => LaneSweepSnapshot
    subscribe?: (listener: () => void) => () => void
  }
  delete?: (workspaceId: string) => Promise<void>
}

/** Everything the sweep needs, injected so tests drive it without a browser. */
export interface LaneSweeperFaces {
  /** `ctx.workspaces` — the archived set and the delete command. */
  workspaces?: LaneSweeperWorkspaces | undefined
  /** Warning sink (test seam). */
  warn?(message: string, error: unknown): void
}

/**
 * The lane workspaces whose conversations are all archived, in snapshot order.
 * @param snapshot - the client workspace snapshot.
 * @returns workspace ids to retire.
 */
export function laneWorkspacesToRetire(snapshot: LaneSweepSnapshot | undefined): string[] {
  if (snapshot === undefined || snapshot.phase !== 'ready') return []
  const archived = new Set(snapshot.archivedSessionIds ?? [])
  const retiring: string[] = []
  for (const workspace of snapshot.items ?? []) {
    const id = workspace.workspaceId
    const path = workspace.path
    const sessionIds = workspace.sessionIds ?? []
    if (id === undefined || path === undefined) continue
    if (!isLaneDirectory(path)) continue
    // A lane created moments ago accounts for no conversation yet: its workspace
    // is being set up and must survive the sweep.
    if (sessionIds.length === 0) continue
    // A live conversation needs the workspace it runs in.
    if (!sessionIds.every((sessionId) => archived.has(sessionId))) continue
    retiring.push(id)
  }
  return retiring
}

/**
 * Sweep once: delete the registration of every lane whose conversations are all
 * archived. A failure is reported and does not stop the rest.
 * @param faces - the workspace face and the warning sink.
 * @returns the workspace ids that were retired.
 */
export async function sweepLaneWorkspaces(faces: LaneSweeperFaces): Promise<string[]> {
  const list = faces.workspaces?.list
  const remove = faces.workspaces?.delete
  if (list?.getSnapshot === undefined || remove === undefined) return []
  const candidates = laneWorkspacesToRetire(list.getSnapshot())
  const retired: string[] = []
  for (const workspaceId of candidates) {
    try {
      await remove.call(faces.workspaces, workspaceId)
      retired.push(workspaceId)
    } catch (error) {
      faces.warn?.('[dsh-worktree] could not retire a lane workspace:', error)
    }
  }
  return retired
}

/**
 * Sweep on mount and on every workspace-list change (an archive, a new lane, a
 * deletion). Sweeps never overlap: a change arriving mid-sweep queues one more
 * pass, so the pass always sees the list the changes produced.
 * @param faces - the workspace face and the warning sink.
 * @returns the disposer (unsubscribes).
 */
export function mountLaneWorkspaceSweeper(faces: LaneSweeperFaces): () => void {
  const list = faces.workspaces?.list
  if (list?.getSnapshot === undefined || list.subscribe === undefined) return () => {}
  let running = false
  let queued = false
  const run = (): void => {
    if (running) { queued = true; return }
    running = true
    void sweepLaneWorkspaces(faces).catch((error: unknown) => {
      faces.warn?.('[dsh-worktree] lane workspace sweep failed:', error)
    }).finally(() => {
      running = false
      if (queued) { queued = false; run() }
    })
  }
  run()
  return list.subscribe(run)
}