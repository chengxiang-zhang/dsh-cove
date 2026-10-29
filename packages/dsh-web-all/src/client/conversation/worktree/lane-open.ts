/**
 * "Choosing a branch means moving onto its lane": the browser half that turns a
 * branch choice into (1) the branch's worktree on the host, (2) the conversation
 * actually running in it, and (3) the binding the header chip, the teardown
 * guards and the lane's permission preset all key off.
 *
 * Why the lane MUST be a registered DSH workspace
 *   The platform accounts a session to a workspace only while the session's cwd
 *   equals that workspace's path: `WorkspaceEntity.sessionIds` filters by
 *   `sessionPath(id) === record.path` and `attachSession` refuses a cwd that
 *   resolves anywhere else (`dsh-workspace`), and `session.create` takes either
 *   a workspace id (cwd := the workspace path) or a bare cwd, never both. A blank
 *   conversation that no workspace accounts for renders its composer inert
 *   ("choose a workspace to start"), so a lane session created with a bare
 *   `cwd` is a conversation the user cannot type into. Hence one workspace per
 *   lane, created with the lane directory as its path; teardown removes it
 *   again, so the sidebar only carries lanes that are still alive.
 *
 * Where the move comes from
 *   The `conversation.input.dock` seat is rendered with `{ session, input }`
 *   only (DSH's ConversationContent calls
 *   `renderSlot('conversation.input.dock', { session, input })`), so no seat prop
 *   can carry a workspace switch: a prop-based move is dead code that silently
 *   degrades to "the worktree is ready, pick it in the workspace selector".
 *   The platform keeps that call on a client service instead — the shell's own
 *   workspace picker performs `uiWorkspace.openWorkspace(workspaceId,
 *   migrateDraft)` — so calling the same service is the platform's navigation
 *   policy rather than a second implementation of it, and it is reachable from a
 *   plugin. It also reuses an existing blank conversation in that workspace
 *   instead of piling up a second one.
 *
 *   `openWorkspace` reports the conversation it connected through the
 *   `beforeOpen` callback, which is the only moment that identity exists on this
 *   side. When the callback never fires (a later navigation superseded this one)
 *   the session list is polled for the conversation whose cwd is the lane, so the
 *   lane still gets its binding.
 *
 * The draft
 *   `openWorkspace` moves the *view*, not the composer text: the shell migrates
 *   draft text and attachments inside its own `beforeOpen`, and that half is not
 *   plugin-reachable (`ctx.conversation.input.for(actx)` needs a retained
 *   session scope). A prompt typed before the switch therefore stays in the
 *   conversation it was typed in — persisted, and not silently dropped in
 *   transit.
 * @module @dsh-cove/dsh-client-ui-worktree/client/lane-open
 */

import type { BindLaneInput, BindLaneResult, CreateLaneInput, CreateLaneResult } from '../../../core/worktree/types.ts'

/** The platform workspace navigation face (the call behind the shell's own workspace picker). */
export interface LaneOpenNavigation {
  /**
   * Connect a workspace and show its conversation.
   * @param workspaceId - the lane's registered workspace.
   * @param beforeOpen - receives the conversation being shown, synchronously.
   */
  openWorkspace?: (workspaceId: string, beforeOpen?: (sessionId: string) => void) => Promise<void>
}

/** The session-list slice the fallback lookup reads. */
export interface LaneOpenSessionList {
  byId?: Record<string, { cwd?: string } | undefined>
  ids?: readonly string[]
}

/** Everything one branch choice needs, injected so tests drive it without a network. */
export interface LaneOpenDeps {
  /** `POST /worktree/lane/create` — the worktree behind the branch. */
  createLane(input: CreateLaneInput): Promise<CreateLaneResult>
  /** `POST /worktree/lane/bind` — record the conversation and apply the lane preset. */
  bindLane(input: BindLaneInput): Promise<BindLaneResult>
  /** Platform navigation; absent on a shell that does not provide the service. */
  navigation?: LaneOpenNavigation | undefined
  /** Current session-list snapshot, used only for the superseded-navigation fallback. */
  listSessions(): LaneOpenSessionList
  /** Bounded-poll knobs for that fallback (test seam). */
  timeoutMs?: number
  pollMs?: number
  /** Warning sink (test seam). */
  warn?(message: string, error: unknown): void
}

/** One branch choice: the conversation asking, the repo, and the branch. */
export interface LaneOpenInput {
  /** The conversation that asked; undefined cannot be moved anywhere. */
  sessionId: string | undefined
  /** Repository root (any directory inside it resolves on the host). */
  repoPath: string
  /** Branch to check out in the lane; created at `base` when it does not exist. */
  branch: string
  /** Base commit-ish for a branch that has to be created. */
  base?: string
}

/** The outcome of one branch choice, in worktree terms (the picker maps it to its own wire type). */
export type LaneOpenResult =
  | {
    ok: true
    /** The lane's branch. */
    branch: string
    /** True only when this conversation now runs in the lane's directory. */
    opened: boolean
  }
  | {
    ok: false
    /** The host's message for the failure. */
    message: string
  }

/** How often the fallback looks for the lane's conversation. */
const LANE_SESSION_POLL_MS = 100
/** How long the fallback waits for the shell to publish that conversation. */
const LANE_SESSION_TIMEOUT_MS = 8_000

/**
 * Create (or attach) the branch's lane, move this conversation onto it, and
 * record the binding.
 *
 * The lane is created first and never rolled back here: the worktree is a real
 * place the user asked for, so a navigation that does not happen reports
 * `opened: false` (the picker then says where to find it) instead of discarding
 * the directory. A binding failure is reported and swallowed for the same
 * reason — the conversation is in the lane either way, and the composer's own
 * binder retries the record on its next status read.
 * @param deps - the host calls, the navigation service and the session list.
 * @param input - the conversation, repository and branch.
 * @returns whether the conversation now runs in the lane.
 */
export async function openLaneForBranch(deps: LaneOpenDeps, input: LaneOpenInput): Promise<LaneOpenResult> {
  let lane: CreateLaneResult
  try {
    lane = await deps.createLane({
      repoPath: input.repoPath,
      branch: input.branch,
      ...(input.base === undefined ? {} : { base: input.base }),
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }

  const opened = await moveOntoLane(deps, input.sessionId, lane)
  if (opened === undefined) return { ok: true, branch: lane.branch, opened: false }

  try {
    await deps.bindLane({ repoPath: input.repoPath, branch: lane.branch, sessionId: opened })
  } catch (error) {
    deps.warn?.('[dsh-worktree] lane binding failed:', error)
  }
  return { ok: true, branch: lane.branch, opened: true }
}

/**
 * Show the conversation that runs in `lane`, when the shell can be asked at all.
 * @returns the conversation now in the lane, or undefined when nothing moved.
 */
async function moveOntoLane(
  deps: LaneOpenDeps,
  sessionId: string | undefined,
  lane: CreateLaneResult,
): Promise<string | undefined> {
  // Without a conversation to move, a workspace to connect, or a navigation
  // service to ask there is nothing to do: the caller reports the lane as ready
  // and says where to pick it up.
  if (sessionId === undefined || lane.workspaceId === null) return undefined
  const navigation = deps.navigation
  if (navigation?.openWorkspace === undefined) return undefined

  let opened: string | undefined
  try {
    await navigation.openWorkspace(lane.workspaceId, (sessionId) => { opened = sessionId })
  } catch (error) {
    deps.warn?.('[dsh-worktree] could not open a conversation on the lane:', error)
    return undefined
  }
  if (opened !== undefined) return opened
  // Superseded before it reported: the workspace may still have been connected,
  // and the session list is then the only witness of the new conversation.
  return await waitForLaneSession(deps, lane.path)
}

/**
 * The conversation whose cwd is the lane directory, newest first, within the
 * bounded wait. Used only when the navigation did not name it.
 * @param deps - session list and the poll knobs.
 * @param lanePath - the lane directory the conversation must run in.
 * @returns the session id, or undefined when none appeared in time.
 */
export async function waitForLaneSession(deps: LaneOpenDeps, lanePath: string): Promise<string | undefined> {
  const pollMs = deps.pollMs ?? LANE_SESSION_POLL_MS
  const timeoutMs = deps.timeoutMs ?? LANE_SESSION_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = deps.listSessions()
    const byId = snapshot.byId ?? {}
    const ids = snapshot.ids ?? Object.keys(byId)
    // Newest first: the shell's freshly connected draft is the one we want, and
    // a lane with several conversations must not hand back an old one.
    for (const id of [...ids].reverse()) {
      if (byId[id]?.cwd === lanePath) return id
    }
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => { setTimeout(resolve, pollMs) })
  }
}