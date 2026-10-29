/**
 * Domain types shared between the host half and the browser half. Anything
 * that crosses the HTTP boundary lands here first so the JSON contract is
 * one source of truth.
 *
 * The plugin deliberately mirrors the official `ctx.workspaces` /
 * `ctx.sessions` client-service shapes where it can — the browser side
 * mirrors the official `@deepseek-ai/dsh-workspace` / `@deepseek-ai/dsh-session` faces
 * (type-only) and aligns its derivation to the same `sessionIds` account
 * the official WorkspaceBrowser uses, so a single source of truth
 * governs session grouping and workspace display across both surfaces.
 * @module @dsh-cove/dsh-client-ui-worktree/core
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorktreeErrorCode } from './invariant.ts'

// Re-export the branded id types so host modules can import them from
// `core/types.ts` alongside the rest of the domain model.
export type { SessionId } from '@deepseek-ai/dsh-session/types'
export type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** One linked worktree entry as the browser renders it under a project row. */
export interface WorktreeView {
  /** Stable name (= worktree dir name under `.dsh/workspaces/`). */
  name: string
  /** Absolute filesystem path. */
  path: string
  /** The checked-out branch (or null when detached). */
  branch: string | null
  /** HEAD sha (short) when known. */
  head: string | null
  /** True when the worktree directory exists on disk. */
  exists: boolean
  /** DSH workspace id when registered; null when the path is not a workspace. */
  workspaceId: WorkspaceId | null
  /** Session bound to this lane (session-bound lanes only); null otherwise.
   *  This binding — not `workspaceId` — is what makes a lane a lane. */
  sessionId: SessionId | null
}

/** One git project (repo) in the host worktree index. */
export interface WorktreeProject {
  /** Canonical absolute path of the repository. */
  repoPath: string
  /** Absolute path of the main worktree (== repoPath on a normal repo). */
  mainPath: string
  /** DSH workspace id for the main worktree path, when registered. */
  mainWorkspaceId: WorkspaceId | null
  /** The repository's basename (e.g. `dsh-cove`). */
  name: string
  /** The main worktree's HEAD branch (or null when detached / unknown). */
  mainBranch: string | null
  /** Number of uncommitted files in the main working tree (>=0); null when not probed. */
  dirty: number | null
  /** Linked worktrees under `<repo>/.dsh/workspaces/`. The main worktree is NOT in this list. */
  worktrees: WorktreeView[]
}

/**
 * Host response: the per-repo worktree index for the management panel.
 * Sessions are never carried through the HTTP layer.
 */
export interface WorktreeIndex {
  /** Every registered workspace path that resolves to a git repository. */
  projects: WorktreeProject[]
}

/** Result shape for worktree mutations returned over HTTP. */
export interface MutationResult<T = void> {
  ok: true
  value: T
}

/** Domain error shape returned over HTTP (status >= 400). */
export interface WorktreeErrorView {
  ok: false
  code: WorktreeErrorCode
  message: string
}

/** Discriminated union for HTTP responses. */
export type WorktreeResponse<T = void> = MutationResult<T> | WorktreeErrorView

/** Parameters for `POST /worktree/create`. */
export interface CreateWorktreeInput {
  /** Repository root (must be a registered workspace). */
  repoPath: string
  /** Branch name (also used as the worktree dir name under `.dsh/workspaces/`).
   *  The branch is cut at `base` and checked out in the worktree. */
  branch: string
  /** Optional base commit-ish the new branch starts at; defaults to HEAD. */
  base?: string
}

/** Parameters for `POST /worktree/lane/create` — the worktree behind a branch. */
export interface CreateLaneInput {
  /** Repository root (any directory inside it resolves). */
  repoPath: string
  /** Branch the lane checks out. An existing local branch is ATTACHED (its own
   *  worktree is created); otherwise the branch is cut at `base`. */
  branch: string
  /** Base commit-ish for a branch that has to be created; defaults to HEAD. */
  base?: string
}

/**
 * A prepared lane: the branch's worktree, ready to host the conversation that
 * asked for it.
 *
 * The lane directory is registered as a DSH workspace, and that is a platform
 * requirement rather than a design taste: the registry accounts a session to a
 * workspace only while the session's cwd equals that workspace's path (its
 * `sessionIds` filters by the session's path, and `attachSession` refuses any
 * other cwd), `session.create` takes a workspace id XOR a bare cwd, and a blank
 * conversation that no workspace accounts for renders its composer inert
 * ("choose a workspace to start"). A lane session created with a bare cwd is
 * therefore a conversation the user cannot type into.
 *
 * Ownership still sits with the conversation: the lane is recorded against the
 * session that asked for it (`/worktree/lane/bind`), that binding is what the
 * teardown guards read, and the header chip — not the workspace row — is where
 * its lifecycle lives. Teardown unregisters the workspace with the directory, so
 * the sidebar only carries lanes that are still alive.
 */
export interface LaneHandle {
  /** Lane name == branch name. */
  name: string
  /** Checked-out branch. */
  branch: string
  /** Absolute worktree path — the directory a lane session runs in. */
  path: string
  /** Short HEAD of the lane. */
  head: string | null
  /** False when an existing worktree was reused instead of created. */
  created: boolean
  /** The lane's registered workspace, which is how a blank draft is moved onto
   *  it; null when the registry refused (the lane still exists on disk, but no
   *  conversation can be started in it). */
  workspaceId: WorkspaceId | null
}

/** Result of `POST /worktree/lane/create`. */
export type CreateLaneResult = LaneHandle

/** Parameters for `POST /worktree/lane/bind` — attach a created session to its lane. */
export interface BindLaneInput {
  /** Repository root owning the lane. */
  repoPath: string
  /** Branch the lane cuts (its manifest name). */
  branch: string
  /** Session the platform created on the lane workspace. */
  sessionId: string
}

/** Result of `POST /worktree/lane/bind`. */
export interface BindLaneResult {
  /** The lane after binding (null when it cannot be resolved). */
  lane: LaneView | null
  /** Whether the lane's required permission preset is now applied. */
  permissionPresetApplied: boolean
}

/** Parameters for `POST /worktree/lane` — resolve the lane a path/session belongs to. */
export interface LaneLookupInput {
  /** Absolute path inside the lane (usually the session cwd). */
  path?: string
  /** Session id; the host resolves its cwd when `path` is absent. */
  sessionId?: string
}

/**
 * One lane as the conversation header chip and the panel render it.
 * `name`/`branch` identify the lane; the status fields mirror
 * `WorktreeStatusView` so a single host probe serves both surfaces.
 */
export interface LaneView {
  /** Lane name == branch name. */
  name: string
  /** Checked-out branch (null when detached). */
  branch: string | null
  /** Absolute lane path. */
  path: string
  /** Repository root owning the lane. */
  repoPath: string
  /** True when the lane directory exists on disk. */
  exists: boolean
  /** DSH workspace id when registered. */
  workspaceId: WorkspaceId | null
  /** Session recorded as bound to this lane, when one was created through us. */
  sessionId: SessionId | null
  /** Whether the required lane preset applied; null for older/non-session lanes. */
  permissionPresetApplied: boolean | null
  /** Uncommitted file count (null when the directory is gone). */
  dirty: number | null
  /** Remote-tracking ref for the branch exists after fetch. */
  pushed: boolean
  /** Branch gone from the remote after having been pushed (merged signal). */
  remoteBranchGone: boolean
  /** Branch is merged into its base. */
  merged: boolean
  /** Recorded PR url, when one was created through this plugin. */
  prUrl: string | null
  /** Recorded GitHub PR number. */
  prNumber: number | null
}

/** Parameters for `POST /worktree/remove`. */
export interface RemoveWorktreeInput {
  /** Repository root. */
  repoPath: string
  /** Worktree directory name under `.dsh/workspaces/`. */
  name: string
  /** Pass --force to git so uncommitted changes are dropped. */
  force?: boolean
  /**
   * The conversation asking for the teardown, when it is the lane's own
   * conversation. A live session blocks removal so a running conversation never
   * loses its directory; that interlock must not make a lane the conversation
   * itself sits on unremovable, so the lane's own recorded session may excuse
   * itself (and is archived by the teardown like any other). Any other id —
   * including one the lane does not record — excuses nothing.
   */
  sessionId?: string
}

/** Parameters for `POST /worktree/init`. */
export interface InitWorktreeInput {
  /** Repository root. */
  repoPath: string
  /** Create the first branch on HEAD (default: `main`). */
  initialBranch?: string
}

/** Parameters for `POST /worktree/pr-create`. */
export interface PrCreateInput {
  /** Repository root (must be a registered workspace). */
  repoPath: string
  /** Worktree name == branch name. */
  name: string
  /** PR target base branch; defaults to the repo's resolved base (manifest
   *  `baseBranch`, else the remote default branch, else `main`). */
  baseRef?: string
  /** Optional PR title; defaults to the branch name. */
  title?: string
}

/** Result of `POST /worktree/pr-create`. */
export interface PrCreateResult {
  /** The PR page URL (compare URL when created via 'url', html_url when 'api'). */
  prUrl: string
  /** How the PR was created: compare URL opened in the browser, or the
   *  GitHub REST API (requires the `pr.tokenEnv` credential). */
  method: 'url' | 'api'
}

/** Parameters for `POST /worktree/status`. */
export interface StatusInput {
  /** Repository root. */
  repoPath: string
  /** Status for one named worktree only; omit for every linked worktree. */
  name?: string
  /**
   * Probe the remote again instead of answering from the host cache. The
   * explicit "refresh status" action sets it; opening the panel does not,
   * because a status probe runs `git fetch` and `ls-remote` per lane.
   */
  force?: boolean
}

/** Per-worktree PR/merge status as the panel renders it. */
export interface WorktreeStatusView {
  /** Worktree name (== branch name). */
  name: string
  /** Absolute worktree path. */
  path: string
  /** Checked-out branch (null when detached). */
  branch: string | null
  /** True when the remote-tracking ref for the branch exists after fetch. */
  pushed: boolean
  /** True when the branch was pushed before but the remote branch is now gone. */
  remoteBranchGone: boolean
  /** True when the branch is merged into the base (branch gone on remote, or
   *  the branch tip is an ancestor of the base tip). */
  merged: boolean
  /** The recorded PR url, when one was created through this plugin. */
  prUrl: string | null
}

/** Host response: per-repo PR/merge status index. */
export interface WorktreeStatusIndex {
  /** Base branch every status was resolved against. */
  baseBranch: string
  worktrees: WorktreeStatusView[]
  /**
   * Candidate branches for dialogs: local branch short names, then remote
   * `origin/*` names with the `origin/` prefix stripped, deduplicated in
   * that order. Serves base-ref / base-commit dropdowns without another
   * round trip (the panel probes one status per repo on open).
   */
  branches: string[]
}

/** Parameters for `POST /worktree/cleanup`. */
export interface CleanupWorktreeInput {
  /** Repository root. */
  repoPath: string
  /** Worktree directory name under `.dsh/workspaces/`. */
  name: string
  /** Force cleanup even when the branch is not merged (abandons the branch
   *  and drops uncommitted changes). */
  force?: boolean
  /** The conversation asking for the teardown, when it is the lane's own
   *  conversation; see {@link RemoveWorktreeInput.sessionId}. */
  sessionId?: string
}
