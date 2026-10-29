/**
 * Host worktree manager: owns the per-repo worktree list, the on-disk
 * manifest under `<repo>/.dsh/workspaces/`, and the workspace-registry
 * bookkeeping. All mutations go through this class so the HTTP layer only
 * knows how to translate envelopes and the browser half only ever sees the
 * stable `WorktreeProject` / `WorktreeView` shapes from `core/types.ts`.
 *
 * Persistence model
 *  - Each repo has its own manifest at `<repo>/.dsh/workspaces/manifest.json`
 *  - We never write the manifest from the browser; the host owns the file
 *  - The manifest records every worktree we ever created; a missing
 *    directory is the "orphan" state, not a hard error
 *
 * Concurrency
 *  - Per-repo lock prevents two `POST /worktree/create` calls from racing
 *    on the same repo (one would otherwise see the other's worktree
 *    directory and 409)
 *  - The lock is in-process only; out-of-process git contention is the
 *    user's responsibility (we do not lock across processes)
 *
 * Data flow
 *  - The host returns a worktree-only index (`WorktreeIndex`) on
 *    `GET /worktree/tree`. Session data lives in the official client
 *    service `ctx.sessions.list` and is never carried through the HTTP
 *    layer; the browser merges both sides.
 * @module dsh-client-ui-worktree/host/manager
 */

import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { subprocessRunner as sharedSubprocessRunner, type GitRunner, type GitRunResult } from './git-runner.ts'
import { WorktreeError, defaultMessage, isValidBranchName } from '../../../core/worktree/invariant.ts'
import {
  type CleanupWorktreeInput, type CreateLaneInput, type CreateWorktreeInput, type InitWorktreeInput,
  type LaneHandle, type LaneLookupInput, type LaneView,
  type PrCreateInput, type PrCreateResult, type RemoveWorktreeInput,
  type StatusInput, type WorktreeIndex, type WorktreeProject, type WorktreeStatusIndex,
  type WorktreeStatusView, type WorktreeView,
} from '../../../core/worktree/types.ts'
import {
  emptyManifest, parseManifest, type ParsedWorktreeManifest, type WorktreeManifestEntry, manifestPath,
} from '../../../core/worktree/manifest.ts'
import { WORKSPACE_DIR, githubCompareUrl, githubOwnerRepo, isInsidePath, samePath, worktreeDir, worktreeRoot } from '../../../core/worktree/paths.ts'
import {
  branchDeleteArgv, BRANCH_LIST_ARGV, checkIgnoreArgv, FETCH_PRUNE_ARGV, gitSpawnArgv, lsRemoteBranchArgv,
  mergeBaseIsAncestorArgv, parseBranchList, pushUpstreamArgv, REMOTE_HEAD_ARGV, REMOTE_LIST_ARGV,
  remoteGetUrlArgv, verifyRefArgv, verifyRemoteRefArgv, worktreeAddArgv, worktreeListPorcelain,
  worktreeRemoveArgv, WORKTREE_PRUNE_ARGV,
} from './git.ts'

/** Deadline for a git command that talks to the network (fetch / ls-remote / ancestor probe). */
const GIT_NETWORK_TIMEOUT_MS = 15_000
/** Deadline for a push; a large branch on a slow link still has to finish. */
const GIT_PUSH_TIMEOUT_MS = 180_000
/**
 * How long a status probe may be reused. The panel asks for status whenever it
 * opens and after every mutation, and one probe costs a `git fetch` plus an
 * `ls-remote`/ancestor check per lane. So the answer is cached, every write this
 * manager performs invalidates it, and the TTL only bounds what a user changes
 * outside the plugin (a commit, or a push from a terminal).
 */
const STATUS_CACHE_TTL_MS = 60_000
/**
 * How long the archive-driven lane retirement waits for the durable archive write
 * to land, and how many times it re-checks. The `workspace/session-activity`
 * waterfall runs BEFORE that write and cannot see its outcome.
 */
const LANE_RETIRE_POLL_MS = 200
const LANE_RETIRE_ATTEMPTS = 5

/** Optional knobs for the worktree manager (mainly test seams). */
export interface WorktreeManagerOptions {
  /** GitHub token env-var reference (credential-ref) for PR creation via the REST API. */
  tokenEnv?: string
  /** Runner override for tests; defaults to the shared subprocess runner. */
  runner?: GitRunner
  /** Deadlines (ms) for the network-touching git calls; a test seam narrows them. */
  timeouts?: { networkMs?: number; pushMs?: number }
  /** Status cache lifetime in ms (0 disables the cache). */
  statusTtlMs?: number
}

/** Structural workspace shape used by cleanup (registry returns a richer entity). */
interface WorkspaceLike {
  id: string
  path: string
  sessionIds?: readonly string[]
}

/** Public surface used by `routes.ts`. */
export class WorktreeManager {
  private readonly runner: GitRunner
  private readonly locks = new Map<string, Promise<void>>()
  /** Last status answer per repo root, invalidated by every manifest write. */
  private readonly statusCache = new Map<string, { index: WorktreeStatusIndex; at: number }>()

  /** Required services: the subprocess seam and the workspace registry. */
  constructor(private readonly ctx: Context, private readonly options: WorktreeManagerOptions = {}) {
    this.runner = options.runner ?? sharedSubprocessRunner(ctx, { spawnArgv: (argv) => gitSpawnArgv(process.platform, argv) })
  }

  /** Status cache lifetime for this manager (0 disables it). */
  private get statusTtlMs(): number {
    const configured = this.options.statusTtlMs
    return typeof configured === 'number' && configured >= 0 ? configured : STATUS_CACHE_TTL_MS
  }

  /** Network deadline for this manager (the options seam may narrow it). */
  private get networkTimeoutMs(): number {
    const configured = this.options.timeouts?.networkMs
    return typeof configured === 'number' && configured > 0 ? configured : GIT_NETWORK_TIMEOUT_MS
  }

  /** Push deadline for this manager (the options seam may narrow it). */
  private get pushTimeoutMs(): number {
    const configured = this.options.timeouts?.pushMs
    return typeof configured === 'number' && configured > 0 ? configured : GIT_PUSH_TIMEOUT_MS
  }

  /**
   * Return the host-side worktree index: every registered workspace that
   * lives under a git repo, plus the main worktree branch + dirty count
   * and every linked worktree under `<repo>/.dsh/workspaces/`.
   */
  async getIndex(): Promise<WorktreeIndex> {
    const registry = this.ctx.workspaceRegistry
    const workspaces = registry.list()
    const projects: WorktreeProject[] = []
    const seen = new Set<string>()
    for (const ws of workspaces) {
      const root = await this.repoRoot(ws.path)
      if (root === null || seen.has(root)) continue
      seen.add(root)
      const project = await this.buildProject(root)
      if (project === null) continue
      projects.push(project)
    }
    return {
      projects: projects.sort((a, b) => a.name.localeCompare(b.name)),
    }
  }

  /**
   * Create a linked worktree that cuts a NEW branch (`input.branch`) at
   * `input.base`, and register it as a DSH workspace. Registration is
   * best-effort here (a failure only surfaces as `workspaceId: null`);
   * `createForSession` is the variant that requires it.
   */
  async create(input: CreateWorktreeInput): Promise<WorktreeView> {
    if (!isValidBranchName(input.branch)) {
      throw new WorktreeError('invalid-branch', defaultMessage('invalid-branch'), { branch: input.branch })
    }
    const root = await this.repoRoot(input.repoPath)
    if (root === null) {
      throw new WorktreeError('not-a-repository', defaultMessage('not-a-repository'), { path: input.repoPath })
    }
    return this.withLock(root, async () => (await this.createLocked(root, input)).view)
  }

  /**
   * Ensure the worktree behind one branch exists, and that its directory is a
   * DSH workspace.
   *
   * This is the single creation path for a session-bound lane, and it merges
   * what used to be two separate actions:
   *   - the branch already exists locally  -> ATTACH it (git checks that
   *     branch out in its own directory; no new branch is invented);
   *   - the branch does not exist yet      -> CUT it at `base` with `-b`.
   * Either way the caller gets a directory that is that branch's checkout.
   *
   * Idempotent: an existing lane directory is returned as-is, so "switch to
   * this branch" is safe to repeat and two sessions can share a branch.
   *
   * The workspace registration is not decoration and not ownership: the
   * platform accounts a session to a workspace only while its cwd equals that
   * workspace's path (`WorkspaceEntity.sessionIds`), and a blank conversation
   * that no workspace accounts for renders an inert composer. Teardown
   * unregisters the workspace with the directory, so the sidebar only carries
   * lanes that are still alive.
   */
  async ensureLane(input: CreateLaneInput): Promise<LaneHandle> {
    if (!isValidBranchName(input.branch)) {
      throw new WorktreeError('invalid-branch', defaultMessage('invalid-branch'), { branch: input.branch })
    }
    const root = await this.repoRoot(input.repoPath)
    if (root === null) {
      throw new WorktreeError('not-a-repository', defaultMessage('not-a-repository'), { path: input.repoPath })
    }
    const owner = root
    return this.withLock(owner, async () => {
      await this.ensureIgnored(owner)
      await this.ensureWorkspaceDir(owner)
      const dir = worktreeDir(owner, input.branch)
      const existing = await this.worktreeBranchAt(owner, dir)
      if (existing !== undefined) {
        // The lane is already on disk: make sure it is reachable as a workspace
        // too, because that is what lets a blank conversation move onto it.
        const workspaceId = await this.ensureLaneWorkspace(owner, input.branch, dir)
        return { ...existing, created: false, workspaceId }
      }
      const attach = await this.branchExists(owner, input.branch)
      const argv = attach
        // Existing local branch: check THAT branch out in the new directory.
        ? worktreeAddArgv(dir, input.branch, false)
        // New branch: `-b` is what makes the lane a usable work line. Without
        // it git checks out the base commit-ish itself, which for anything
        // that is not a branch name leaves a DETACHED HEAD — unpushable
        // (`push -u origin <branch>` needs a local branch) and unmatched by
        // `git worktree list --porcelain`.
        : worktreeAddArgv(dir, input.base ?? 'HEAD', false, input.branch)
      const result = await this.runner.run(argv, owner)
      if (result.exitCode !== 0) {
        throw new WorktreeError('git-failed', defaultMessage('git-failed'), {
          argv: [...argv], stderr: result.stderr,
        })
      }
      const head = (await this.runner.run(['rev-parse', 'HEAD'], dir)).stdout.trim()
      await this.appendManifestEntry(owner, {
        name: input.branch,
        path: dir,
        baseCommit: head,
        createdAt: new Date().toISOString(),
        detached: false,
      })
      return {
        name: input.branch,
        branch: input.branch,
        path: dir,
        head: head === '' ? null : await this.headShort(dir),
        created: true,
        // The lane's own DSH workspace. The platform accounts a session to a
        // workspace only while its cwd equals that workspace's path, and a blank
        // conversation no workspace accounts for renders its composer inert, so
        // the lane directory has to BE a workspace for the conversation in it to
        // be usable at all. Teardown removes it again.
        workspaceId: await this.ensureLaneWorkspace(owner, input.branch, dir),
      }
    })
  }

  /**
   * The lane's DSH workspace, registered once and reused afterwards.
   *
   * Required, not a taste: `WorkspaceEntity.sessionIds` only accounts sessions
   * whose cwd equals the workspace path, `attachSession` refuses any other cwd,
   * and a blank conversation that no workspace accounts for shows an inert
   * composer ("choose a workspace to start"). Registration failure is not fatal
   * here — the worktree is real, so the caller reports the lane without a
   * workspace and the browser declines to claim the conversation moved.
   */
  private async ensureLaneWorkspace(root: string, branch: string, dir: string): Promise<WorkspaceId | null> {
    const registered = await this.workspaceForPath(dir)
    if (registered !== null) return registered.id as WorkspaceId
    try {
      const created = await this.ctx.workspaceRegistry.create(dir, `${basename(root)} / ${branch}`)
      await this.updateManifestEntry(root, branch, { workspaceId: created.id as WorkspaceId })
      return created.id as WorkspaceId
    } catch (error) {
      console.warn('[dsh-worktree] lane workspace registration failed:', error)
      return null
    }
  }

  /** The lane already present at `dir`, when git reports one there. The
   *  workspace half is resolved by the caller (see ensureLane). */
  private async worktreeBranchAt(root: string, dir: string): Promise<Omit<LaneHandle, 'created' | 'workspaceId'> | undefined> {
    if (!existsSync(dir)) return undefined
    const list = await this.runner.run(worktreeListPorcelain(), root)
    if (list.exitCode !== 0) return undefined
    const hit = parsePorcelainWorktrees(list.stdout).find((candidate) => resolve(candidate.path) === resolve(dir))
    if (hit === undefined) return undefined
    const branch = hit.branch ?? deriveNameFromPath(hit.path)
    return {
      name: branch,
      branch,
      path: hit.path,
      head: await this.headShort(hit.path),
    }
  }

  /** Shared create body; the caller holds the per-repo lock. */
  private async createLocked(
    root: string,
    input: CreateWorktreeInput,
    options: { requireWorkspace?: boolean } = {},
  ): Promise<{ view: WorktreeView; workspaceId: WorkspaceId | null }> {
    await this.ensureIgnored(root)
    await this.ensureWorkspaceDir(root)
    const dir = worktreeDir(root, input.branch)
    if (existsSync(dir)) {
      throw new WorktreeError('worktree-exists', defaultMessage('worktree-exists'), { dir })
    }
    if (await this.branchExists(root, input.branch)) {
      throw new WorktreeError('worktree-exists', `A local branch named "${input.branch}" already exists; choose another branch name or delete that branch first.`, { branch: input.branch })
    }
    const base = input.base ?? 'HEAD'
    // `-b` is what makes the lane a usable work line. Without it git checks
    // out the base commit-ish itself, which for anything that is not a
    // branch name leaves a DETACHED HEAD: `git push -u origin <branch>`
    // then fails (no local branch) and `git worktree list --porcelain`
    // reports `detached`, so the lane never matches its own name.
    const argv = worktreeAddArgv(dir, base, false, input.branch)
    const result = await this.runner.run(argv, root)
    if (result.exitCode !== 0) {
      throw new WorktreeError('git-failed', defaultMessage('git-failed'), {
        argv: [...argv], stderr: result.stderr,
      })
    }
    const head = (await this.runner.run(['rev-parse', 'HEAD'], dir)).stdout.trim()
    const entry: WorktreeManifestEntry = {
      name: input.branch,
      path: dir,
      baseCommit: head,
      createdAt: new Date().toISOString(),
      detached: false,
    }
    await this.appendManifestEntry(root, entry)
    let workspaceId: WorkspaceId | null = null
    try {
      const created = await this.ctx.workspaceRegistry.create(dir, `${basename(root)} / ${input.branch}`)
      workspaceId = created.id
      await this.updateManifestEntry(root, input.branch, { workspaceId })
    } catch (error) {
      if (options.requireWorkspace === true) {
        await this.rollbackLocked(root, input.branch)
        throw new WorktreeError(
          'git-failed',
          `workspace registration failed for lane "${input.branch}": ${String(error)}`,
          { dir },
        )
      }
      console.warn('[dsh-worktree] workspace registration failed:', error)
    }
    return {
      view: {
        name: input.branch,
        path: dir,
        branch: input.branch,
        head: head === '' ? null : await this.headShort(dir),
        exists: true,
        workspaceId,
        sessionId: null,
      },
      workspaceId,
    }
  }

  /**
   * The manifest record for one lane: its directory when the repository's
   * manifest records that branch, null otherwise.
   *
   * The bind path reads this instead of trusting `laneForPath`, which
   * synthesizes a lane view for a directory the manifest does not know about —
   * so "the lane exists on disk" and "the host recorded this lane" are two
   * different answers, and only the second may authorize a binding.
   */
  async laneEntry(repoPath: string, name: string): Promise<{ root: string; path: string } | null> {
    if (!isValidBranchName(name)) {
      throw new WorktreeError('invalid-branch', defaultMessage('invalid-branch'), { name })
    }
    const root = await this.repoRoot(repoPath)
    if (root === null) return null
    const manifest = await this.readManifest(root)
    const entry = manifest.worktrees.find((candidate) => candidate.name === name)
    return entry === undefined ? null : { root, path: entry.path }
  }

  /**
   * Record the session bound to a lane. Called right after the session exists,
   * so the header chip and the teardown guards can resolve `sessionId -> lane`
   * without re-deriving it from the filesystem.
   * @param repoPath - repository root.
   * @param name - worktree (branch) name.
   * @param sessionId - the session to record.
   * @param permissionPresetApplied - whether the lane's access preset landed.
   */
  async bindSession(
    repoPath: string,
    name: string,
    sessionId: SessionId,
    permissionPresetApplied: boolean,
  ): Promise<void> {
    if (!isValidBranchName(name)) {
      throw new WorktreeError('invalid-branch', defaultMessage('invalid-branch'), { name })
    }
    const root = await this.repoRoot(repoPath)
    if (root === null) {
      throw new WorktreeError('not-a-repository', defaultMessage('not-a-repository'), { path: repoPath })
    }
    await this.withLock(root, async () => {
      await this.updateManifestEntry(root, name, { sessionId, permissionPresetApplied })
    })
  }

  /**
   * Undo a lane creation. Used when the lane exists but its session could
   * not be created, so a failed create never leaves half a lane behind:
   * worktree directory, local branch, admin records, manifest entry and the
   * registered workspace all go away.
   */
  async rollbackCreate(input: { repoPath: string; name: string }): Promise<void> {
    if (!isValidBranchName(input.name)) {
      throw new WorktreeError('invalid-branch', defaultMessage('invalid-branch'), { name: input.name })
    }
    const root = await this.repoRoot(input.repoPath)
    if (root === null) {
      throw new WorktreeError('not-a-repository', defaultMessage('not-a-repository'), { path: input.repoPath })
    }
    await this.withLock(root, async () => {
      // Rollback exists for a lane whose session never came up. A lane that has
      // a live session under it is not that case: deleting the directory and the
      // branch out from under a running conversation is exactly what remove and
      // cleanup refuse to do, so rollback must not be the way around them.
      const dir = worktreeDir(root, input.name)
      const workspace = await this.workspaceForPath(dir)
      const busySession = await this.liveSessionOnLane(root, dir, workspace)
      if (busySession !== undefined) {
        throw new WorktreeError('worktree-busy', defaultMessage('worktree-busy'), { sessionId: busySession })
      }
      await this.rollbackLocked(root, input.name)
    })
  }

  /**
   * Resolve the lane a path (or a session's cwd) belongs to. Returns null
   * for the main checkout and for any path outside `<repo>/.dsh/workspaces/`.
   *
   * Deliberately network-free: this feeds the conversation header chip, so
   * it must stay cheap. `merged` is therefore only the locally knowable
   * half (branch pushed AND its tip is an ancestor of the base); the
   * "remote branch deleted on merge" signal needs a `fetch --prune` and
   * stays with the panel's `POST /worktree/status` probe.
   */
  async laneForPath(input: LaneLookupInput): Promise<LaneView | null> {
    // 1. Cwd-based: the session is already inside a lane directory.
    const target = input.path ?? (input.sessionId === undefined ? undefined : this.sessionCwd(input.sessionId))
    if (target !== undefined && target !== '') {
      const root = await this.repoRoot(target)
      if (root !== null) {
        const laneRoot = resolve(worktreeRoot(root))
        const normalized = resolve(target)
        if (normalized !== laneRoot && normalized.startsWith(laneRoot + sep)) {
          const fromPath = await this.laneForDirectory(root, normalized)
          if (fromPath !== null) return fromPath
        }
      }
    }
    // 2. Binding-based: the conversation carries a lane recorded on the
    //    manifest even though its cwd is still the main checkout (an
    //    existing conversation cannot move). Without this a mid-conversation
    //    branch switch would be invisible to the header chip and the lane tool.
    if (input.sessionId !== undefined) {
      const cwd = this.sessionCwd(input.sessionId)
      if (cwd !== undefined) {
        const root = await this.repoRoot(cwd)
        if (root !== null) {
          const entry = await this.manifestEntryForSession(root, input.sessionId)
          if (entry !== undefined) return this.laneFromEntry(root, entry)
        }
      }
    }
    return null
  }

  /** One lane record for a directory git reports as a linked worktree. */
  private async laneForDirectory(root: string, dir: string): Promise<LaneView | null> {
    const listResult = await this.runner.run(worktreeListPorcelain(), root)
    if (listResult.exitCode !== 0) return null
    const wt = parsePorcelainWorktrees(listResult.stdout).find((candidate) => resolve(candidate.path) === dir)
    if (wt === undefined) return null
    const manifest = await this.readManifest(root)
    const name = wt.branch ?? deriveNameFromPath(wt.path)
    const entry = manifest.worktrees.find((e) => e.path === wt.path || e.name === name)
    return this.laneFromEntry(root, entry ?? { name, path: wt.path } as WorktreeManifestEntry, wt.branch, dir)
  }

  /** One lane record from a manifest entry, with the git state filled in. */
  private async laneFromEntry(
    root: string,
    entry: WorktreeManifestEntry,
    branchHint?: string | null,
    pathHint?: string,
  ): Promise<LaneView> {
    const path = pathHint ?? entry.path
    const name = entry.name
    const branch = branchHint ?? name
    const base = await this.remoteDefaultBranch(root) ?? 'main'
    // The lane view answers the same question the cleanup guard does, through
    // the same rule. Deriving "merged" here from `pushed` alone made the header
    // chip say "not pushed" for every branch GitHub deleted on merge — while
    // cleanup, which uses worktreeStatus, considered it merged and tore it down.
    const status = await this.worktreeStatus(root, name, base, entry)
    return {
      name,
      branch,
      path,
      repoPath: root,
      exists: existsSync(path),
      workspaceId: (entry.workspaceId as WorkspaceId | undefined) ?? null,
      sessionId: (entry.sessionId as SessionId | undefined) ?? null,
      permissionPresetApplied: entry.permissionPresetApplied ?? null,
      dirty: await this.dirtyCount(path),
      pushed: status.pushed,
      remoteBranchGone: status.remoteBranchGone,
      merged: status.merged,
      prUrl: entry.prUrl ?? null,
      prNumber: entry.prNumber ?? null,
    }
  }

  /** The manifest entry a session is bound to, within one repo. */
  private async manifestEntryForSession(root: string, sessionId: string): Promise<WorktreeManifestEntry | undefined> {
    const manifest = await this.readManifest(root)
    return manifest.worktrees.find((entry) => entry.sessionId === sessionId)
  }

  /**
   * Archive the session a lane was bound to, when one is recorded. Once the
   * lane directory is gone the conversation would otherwise keep pointing at
   * a deleted path; archiving hides the record instead of letting it dangle.
   * Best-effort — the workspace registry may be unavailable.
   *
   * DSH 0.2 refuses to archive a session that reports active work (a running
   * turn, a job, a subagent, an active schedule) unless `stopActivity` is
   * requested; the lane's own session is exactly the one this teardown is
   * allowed to take down, so the archive must write first and then ask the
   * activity owners to stop.
   */
  private async archiveBoundSession(root: string, name: string): Promise<void> {
    const manifest = await this.readManifest(root)
    const sessionId = manifest.worktrees.find((entry) => entry.name === name)?.sessionId
    if (sessionId === undefined) return
    try {
      await this.ctx.workspaceRegistry.archiveSession(sessionId as SessionId, { stopActivity: true })
    } catch (error) {
      console.warn(`[dsh-worktree] archive session ${sessionId} failed:`, error)
    }
  }

  /**
   * Refuse to create a lane when the repository does not ignore the lane
   * root. Without the ignore rule the lane directory shows up as untracked
   * in the main checkout, and a `git add -A` there would sweep an entire
   * lane into the trunk — exactly the trunk pollution that lanes exist to
   * prevent.
   */
  private async ensureIgnored(root: string): Promise<void> {
    // Probe a child path so a directory rule (`/.dsh/workspaces/`) matches.
    const probe = `${worktreeRoot(root)}/probe`
    const result = await this.runner.run(checkIgnoreArgv(probe), root)
    if (result.exitCode !== 0) {
      throw new WorktreeError(
        'worktree-not-ignored',
        `${defaultMessage('worktree-not-ignored')} Add "${WORKSPACE_DIR}/" to ${root}/.gitignore.`,
        {
          dir: worktreeRoot(root),
          hint: `add "${WORKSPACE_DIR}/" to ${root}/.gitignore`,
        },
      )
    }
  }

  /** Whether a local branch of that name already exists. */
  private async branchExists(root: string, branch: string): Promise<boolean> {
    const result = await this.runner.run(verifyRefArgv(branch), root)
    return result.exitCode === 0
  }

  /** The cwd recorded on a live session header, when the host can see it. */
  private sessionCwd(sessionId: string): string | undefined {
    const sessions = optionalService<{ get?: (id: string) => { header?: { cwd?: string } } | undefined }>(this.ctx, 'sessions')
    const cwd = sessions?.get?.(sessionId)?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  }

  /** Patch one manifest entry in place; a missing entry is a no-op. */
  private async updateManifestEntry(
    repoPath: string,
    name: string,
    patch: Partial<WorktreeManifestEntry>,
  ): Promise<void> {
    const manifest = await this.readManifest(repoPath)
    let touched = false
    manifest.worktrees = manifest.worktrees.map((entry) => {
      if (entry.name !== name) return entry
      touched = true
      return { ...entry, ...patch }
    })
    if (touched) await this.writeManifest(repoPath, manifest)
  }

  /** Best-effort teardown of a lane that never became usable. */
  private async rollbackLocked(root: string, name: string): Promise<void> {
    const dir = worktreeDir(root, name)
    if (existsSync(dir)) {
      await this.runner.run(worktreeRemoveArgv(dir, true), root)
    }
    if (await this.branchExists(root, name)) {
      await this.runner.run(branchDeleteArgv(name, true), root)
    }
    await this.runner.run(WORKTREE_PRUNE_ARGV, root)
    await this.removeManifestEntry(root, name)
    const workspace = await this.workspaceForPath(dir)
    if (workspace !== null) {
      try {
        await this.ctx.workspaceRegistry.delete(workspace.id as WorkspaceId)
      } catch (error) {
        console.warn('[dsh-worktree] rollback workspace unregister failed:', error)
      }
    }
  }

  /**
   * Remove a worktree without silently discarding user state. A live session
   * always blocks removal; a dirty checkout requires the caller's explicit
   * force confirmation. Cleanup remains the preferred merged-aware flow.
   */
  async remove(input: RemoveWorktreeInput): Promise<{ name: string; path: string }> {
    if (!isValidBranchName(input.name)) {
      throw new WorktreeError('invalid-branch', defaultMessage('invalid-branch'), { name: input.name })
    }
    const root = await this.repoRoot(input.repoPath)
    if (root === null) {
      throw new WorktreeError('not-a-repository', defaultMessage('not-a-repository'), { path: input.repoPath })
    }
    return this.withLock(root, async () => {
      const dir = worktreeDir(root, input.name)
      if (!existsSync(dir)) {
        throw new WorktreeError('worktree-not-found', defaultMessage('worktree-not-found'), { dir })
      }
      const workspace = await this.workspaceForPath(dir)
      const busySession = await this.liveSessionOnLane(root, dir, workspace, input.sessionId)
      if (busySession !== undefined) {
        throw new WorktreeError('worktree-busy', defaultMessage('worktree-busy'), { sessionId: busySession })
      }
      const dirty = await this.runner.run(['status', '--porcelain'], dir)
      if (dirty.exitCode !== 0) {
        throw new WorktreeError('git-failed', defaultMessage('git-failed'), { stderr: dirty.stderr })
      }
      if (dirty.stdout.trim() !== '' && input.force !== true) {
        throw new WorktreeError('worktree-busy', 'The worktree has uncommitted changes; confirm force removal to discard them.', { dir, dirty: true })
      }
      const argv = worktreeRemoveArgv(dir, input.force === true)
      const result = await this.runner.run(argv, root)
      if (result.exitCode !== 0) {
        throw new WorktreeError('git-failed', defaultMessage('git-failed'), {
          argv: [...argv], stderr: result.stderr,
        })
      }
      await this.runner.run(WORKTREE_PRUNE_ARGV, root)
      await this.archiveBoundSession(root, input.name)
      await this.removeManifestEntry(root, input.name)
      // Unregister the workspace resolved BEFORE the directory went away: a
      // lookup by a deleted path finds nothing, and the sidebar would keep a
      // stale row for a directory that is gone (and offer to start a session in
      // it). Cleanup already resolved it up front for the same reason.
      if (workspace !== null) {
        try {
          await this.ctx.workspaceRegistry.delete(workspace.id as WorkspaceId)
        } catch (error) {
          console.warn('[dsh-worktree] workspace unregister failed:', error)
        }
      }
      return { name: input.name, path: dir }
    })
  }

  /**
   * `git init -b <initialBranch>` on a directory that is not yet a git
   * repository; idempotent (a no-op if the directory is already a repo).
   * The host-side caller is the browser dialog that asks "convert this
   * workspace into a git project so I can use worktrees on it".
   */
  async init(input: InitWorktreeInput): Promise<{ repoPath: string; initialBranch: string }> {
    const path = resolve(input.repoPath)
    if (!existsSync(path)) {
      throw new WorktreeError('workspace-unknown', defaultMessage('workspace-unknown'), { path })
    }
    const existing = await this.repoRoot(path)
    if (existing !== null) {
      return { repoPath: existing, initialBranch: input.initialBranch ?? 'main' }
    }
    // Converting a directory into a repository mutates that directory, so it is
    // limited to a workspace the user actually registered with the host. Without
    // this the route is a `git init` anywhere on the machine.
    const workspace = await this.workspaceForPath(path)
    if (workspace === null || !samePath(workspace.path, path)) {
      throw new WorktreeError('workspace-unknown', defaultMessage('workspace-unknown'), { path })
    }
    const branch = input.initialBranch ?? 'main'
    if (!isValidBranchName(branch)) {
      throw new WorktreeError('invalid-branch', defaultMessage('invalid-branch'), { branch })
    }
    const argv = gitSpawnArgv(process.platform, ['init', '-b', branch])
    const result = await this.runner.run(argv, path)
    if (result.exitCode !== 0) {
      throw new WorktreeError('git-failed', defaultMessage('git-failed'), { stderr: result.stderr })
    }
    await this.ensureWorkspaceDir(path)
    return { repoPath: path, initialBranch: branch }
  }

  // ─── PR lifecycle: create / status / cleanup ─────────────────────────────

  /**
   * Push the worktree branch and open (or create) a pull request. Always
   * pushes to `origin`; a PR page is then produced either through the
   * GitHub compare URL (default, no credentials) or through the GitHub
   * REST API when a `tokenEnv` credential is configured. The resulting
   * URL and metadata are recorded in the manifest so the panel can resume
   * the PR later.
   */
  async prCreate(input: PrCreateInput): Promise<PrCreateResult> {
    if (!isValidBranchName(input.name)) {
      throw new WorktreeError('invalid-branch', defaultMessage('invalid-branch'), { name: input.name })
    }
    const root = await this.repoRoot(input.repoPath)
    if (root === null) {
      throw new WorktreeError('not-a-repository', defaultMessage('not-a-repository'), { path: input.repoPath })
    }
    const dir = worktreeDir(root, input.name)
    if (!existsSync(dir)) {
      throw new WorktreeError('worktree-not-found', defaultMessage('worktree-not-found'), { dir })
    }
    const remoteUrl = await this.originRemoteUrl(root)
    if (remoteUrl === null) {
      throw new WorktreeError('no-remote', defaultMessage('no-remote'), { repoPath: root })
    }
    return this.withLock(root, async () => {
      // Push the branch with upstream tracking, from the worktree itself.
      const push = await this.runBounded(pushUpstreamArgv(input.name), dir, this.pushTimeoutMs)
      if (push.exitCode !== 0) {
        throw new WorktreeError('push-failed', defaultMessage('push-failed'), {
          branch: input.name, stderr: push.stderr,
        })
      }
      const manifest = await this.readManifest(root)
      const baseRef = input.baseRef ?? manifest.baseBranch ?? await this.remoteDefaultBranch(root) ?? 'main'
      const title = input.title?.trim() !== '' && input.title !== undefined ? input.title!.trim() : input.name
      // Preferred: REST API PR creation when a token is configured.
      const viaApi = await this.createPullRequestViaApi(remoteUrl, input.name, baseRef, title)
      let prUrl: string | null
      let prNumber: number | undefined
      let method: PrCreateResult['method']
      if (viaApi !== null) {
        prUrl = viaApi.htmlUrl
        prNumber = viaApi.number
        method = 'api'
      } else {
        prUrl = githubCompareUrl(remoteUrl, baseRef, input.name)
        if (prUrl === null) {
          throw new WorktreeError('unsupported-remote', defaultMessage('unsupported-remote'), { remoteUrl })
        }
        method = 'url'
      }
      const entry = manifest.worktrees.find((e) => e.name === input.name)
      if (entry === undefined) {
        throw new WorktreeError('worktree-not-found', defaultMessage('worktree-not-found'), { name: input.name })
      }
      entry.prUrl = prUrl
      if (prNumber !== undefined) entry.prNumber = prNumber
      entry.remoteBranch = 'origin'
      entry.baseRef = baseRef
      entry.updatedAt = new Date().toISOString()
      if (manifest.baseBranch === undefined) manifest.baseBranch = baseRef
      await this.writeManifest(root, manifest)
      return { prUrl, method }
    })
  }

  /**
   * PR / merge status for one repo (or one named worktree of it): whether
   * the branch was pushed, whether the remote branch is gone, and whether
   * it is merged into the base. Runs a best-effort `git fetch origin
   * --prune` first so a merged-and-deleted remote branch reads as merged.
   *
   * A full-repo answer is cached: this endpoint is polled whenever the panel
   * opens, while every mutation this manager performs invalidates the entry, so
   * a poll is a memory read in the normal flow. `force` (the explicit refresh
   * action) and a name-filtered probe always go to git.
   */
  async status(input: StatusInput): Promise<WorktreeStatusIndex> {
    const root = await this.repoRoot(input.repoPath)
    if (root === null) {
      throw new WorktreeError('not-a-repository', defaultMessage('not-a-repository'), { path: input.repoPath })
    }
    if (input.name !== undefined) return await this.probeStatus(root, input.name)
    if (input.force !== true) {
      const cached = this.cachedStatus(root)
      if (cached !== undefined) return cached
    }
    const index = await this.probeStatus(root, undefined)
    this.statusCache.set(root, { index, at: Date.now() })
    return index
  }

  /** The cached status for a repo, or undefined when absent or past its TTL. */
  private cachedStatus(root: string): WorktreeStatusIndex | undefined {
    const ttl = this.statusTtlMs
    if (ttl <= 0) return undefined
    const hit = this.statusCache.get(root)
    if (hit === undefined) return undefined
    if (Date.now() - hit.at >= ttl) {
      this.statusCache.delete(root)
      return undefined
    }
    return hit.index
  }

  /** Drop the cached status for a repo; every manifest write calls this. */
  private invalidateStatus(root: string): void {
    this.statusCache.delete(root)
  }

  /** One uncached probe of the repository. */
  private async probeStatus(root: string, name: string | undefined): Promise<WorktreeStatusIndex> {
    const baseBranch = await this.remoteDefaultBranch(root) ?? 'main'
    const manifest = await this.readManifest(root)
    const effectiveBase = manifest.baseBranch ?? baseBranch
    await this.fetchPruneBestEffort(root)
    const listResult = await this.runner.run(worktreeListPorcelain(), root)
    const parsed = listResult.exitCode === 0 ? parsePorcelainWorktrees(listResult.stdout) : []
    const worktrees: WorktreeStatusView[] = []
    for (const wt of parsed) {
      if (wt.path === root) continue
      if (!wt.path.startsWith(worktreeRoot(root) + '/') && !wt.path.startsWith(worktreeRoot(root) + '\\')) continue
      if (name !== undefined && wt.branch !== name) continue
      const entry = manifest.worktrees.find((e) => e.path === wt.path)
      const branch = wt.branch
      if (branch === null) {
        worktrees.push({
          name: entry?.name ?? deriveNameFromPath(wt.path),
          path: wt.path,
          branch: null,
          pushed: false,
          remoteBranchGone: false,
          merged: false,
          prUrl: entry?.prUrl ?? null,
        })
        continue
      }
      const statusView = await this.worktreeStatus(root, branch, effectiveBase, entry)
      worktrees.push({
        name: entry?.name ?? deriveNameFromPath(wt.path),
        path: wt.path,
        branch,
        ...statusView,
        prUrl: entry?.prUrl ?? null,
      })
    }
    const branchResult = await this.runner.run(BRANCH_LIST_ARGV, root)
    const branches = branchResult.exitCode === 0 ? parseBranchList(branchResult.stdout) : []
    return { baseBranch: effectiveBase, worktrees, branches }
  }

  /**
   * Clean up a merged worktree: validate no sessions are running, verify
   * the branch is merged (or the user forced), remove the worktree
   * directory, delete the local branch, unregister the workspace, and
   * archive its sessions. `force` abandons an unmerged branch and drops
   * uncommitted changes.
   */
  async cleanup(input: CleanupWorktreeInput): Promise<{ name: string; path: string }> {
    if (!isValidBranchName(input.name)) {
      throw new WorktreeError('invalid-branch', defaultMessage('invalid-branch'), { name: input.name })
    }
    const root = await this.repoRoot(input.repoPath)
    if (root === null) {
      throw new WorktreeError('not-a-repository', defaultMessage('not-a-repository'), { path: input.repoPath })
    }
    const dir = worktreeDir(root, input.name)
    const dirExists = existsSync(dir)
    // A missing directory is an orphan: skip the worktree-remove step and
    // still delete the branch / manifest entry / workspace below.
    return this.withLock(root, async () => {
      // Never clean up a worktree a live session is bound to — except the
      // conversation that is itself asking (see liveSessionOnLane).
      const workspace = await this.workspaceForPath(dir)
      const busySession = await this.liveSessionOnLane(root, dir, workspace, input.sessionId)
      if (busySession !== undefined) {
        throw new WorktreeError('worktree-busy', defaultMessage('worktree-busy'), { sessionId: busySession })
      }
      const baseBranch = await this.remoteDefaultBranch(root) ?? 'main'
      const manifest = await this.readManifest(root)
      const effectiveBase = manifest.baseBranch ?? baseBranch
      const entry = manifest.worktrees.find((e) => e.name === input.name)
      // Deleting the local branch is this flow's job, so it requires the host's
      // own record of the lane. Without it, any name that happens to be a local
      // branch - a directory nobody recorded, or a branch with no lane at all -
      // would be deleted here with nothing tying it to this plugin. The directory
      // may be gone (an orphan lane) as long as the record survives.
      if (entry === undefined) {
        throw new WorktreeError('worktree-not-found', defaultMessage('worktree-not-found'), { name: input.name })
      }
      await this.fetchPruneBestEffort(root)
      // Always probe. The merged decision must not depend on whether THIS
      // plugin created the PR: a branch pushed from the lane terminal has to
      // reach the same answer, or the panel offers a cleanup the host refuses.
      const status = await this.worktreeStatus(root, input.name, effectiveBase, entry)
      const merged = status.merged || input.force === true
      if (!merged) {
        throw new WorktreeError('not-merged', defaultMessage('not-merged'), { branch: input.name, base: effectiveBase })
      }
      if (dirExists) {
        const remove = await this.runner.run(worktreeRemoveArgv(dir, input.force === true), root)
        if (remove.exitCode !== 0) {
          throw new WorktreeError('git-failed', defaultMessage('git-failed'), {
            argv: [...worktreeRemoveArgv(dir, input.force === true)], stderr: remove.stderr,
          })
        }
        await this.runner.run(WORKTREE_PRUNE_ARGV, root)
      }
      // Delete the local branch only when the branch exists (detached worktrees skip).
      const verify = await this.runner.run(['rev-parse', '--verify', '--quiet', `refs/heads/${input.name}`], root)
      if (verify.exitCode === 0) {
        const deleteArgv = branchDeleteArgv(input.name, input.force === true)
        const deleted = await this.runner.run(deleteArgv, root)
        if (deleted.exitCode !== 0) {
          // `-d` also refuses a branch merged into the PR base but not into the
          // main worktree's current HEAD. The merge state is verified above, so
          // escalate instead of reporting success with the branch left behind.
          const forced = input.force === true ? deleted : await this.runner.run(branchDeleteArgv(input.name, true), root)
          if (forced.exitCode !== 0) {
            throw new WorktreeError('git-failed', defaultMessage('git-failed'), {
              argv: [...deleteArgv], stderr: forced.stderr,
            })
          }
        }
      }
      await this.archiveBoundSession(root, input.name)
      await this.removeManifestEntry(root, input.name)
      if (workspace !== null) {
        await this.archiveAndDeleteWorkspace(workspace)
      }
      return { name: input.name, path: dir }
    })
  }

  // ─── lane workspace lifecycle ─────────────────────────────────────────────

  /**
   * Retire the workspace registration of a lane whose conversation was archived.
   *
   * A lane's directory must be a registered workspace while its conversation
   * runs — the platform accounts a session to a workspace only when the session
   * cwd equals that workspace's path, and a blank conversation no workspace
   * accounts for renders an inert composer — so the sidebar row is unavoidable
   * while the lane is alive. It does not have to outlive the conversation:
   * archiving retires the registration, which keeps the worktree, the branch and
   * the binding, so picking that branch again re-registers the directory in one
   * call and nothing the user did is discarded.
   *
   * The `workspace/session-activity` waterfall runs BEFORE the durable archive
   * write, so this waits for the archive set to show the session instead of
   * assuming the write lands: an archive refused for running work retires
   * nothing. A lane that still has an unarchived conversation keeps its
   * workspace, or that conversation would lose the workspace it runs in.
   * @param sessionId - the conversation that was archived.
   * @param options - bounded-poll knobs (test seam).
   * @returns whether a lane workspace was retired.
   */
  async retireArchivedLane(sessionId: string, options: { attempts?: number; pollMs?: number } = {}): Promise<boolean> {
    const attempts = Math.max(1, options.attempts ?? LANE_RETIRE_ATTEMPTS)
    const pollMs = options.pollMs ?? LANE_RETIRE_POLL_MS
    for (let attempt = 1; ; attempt += 1) {
      if (this.isArchivedSession(sessionId)) return await this.retireLaneWorkspaceOf(sessionId)
      if (attempt >= attempts) return false
      await new Promise((resolve) => { setTimeout(resolve, pollMs) })
    }
  }

  /**
   * Retire every lane workspace whose recorded conversation is archived.
   *
   * Rows left behind by an earlier build, or by an archive that happened while
   * this plugin was absent, must not survive a restart; this walks the registered
   * workspaces once and drops exactly those lanes. Anything else is left alone: a
   * workspace outside `<repo>/.dsh/workspaces/`, a lane whose manifest records no
   * conversation, a lane whose recorded conversation is still live, and a lane
   * that still has an unarchived conversation.
   * @returns how many lane workspaces were retired.
   */
  async reconcileLaneWorkspaces(): Promise<number> {
    let workspaces: readonly WorkspaceLike[]
    try {
      workspaces = this.ctx.workspaceRegistry.list() as readonly WorkspaceLike[]
    } catch (error) {
      console.warn('[dsh-worktree] lane workspace reconciliation skipped:', error)
      return 0
    }
    let retired = 0
    for (const workspace of workspaces) {
      if (typeof workspace.path !== 'string' || workspace.path === '') continue
      const root = await this.repoRoot(workspace.path)
      if (root === null) continue
      if (!isInsidePath(worktreeRoot(root), workspace.path)) continue
      const manifest = await this.readManifest(root)
      const entry = manifest.worktrees.find((candidate) => samePath(candidate.path, workspace.path))
      if (entry?.sessionId === undefined || !this.isArchivedSession(entry.sessionId)) continue
      if (!this.hasNoLiveConversation(workspace)) continue
      if (await this.retireLaneWorkspace(root, entry)) retired += 1
    }
    return retired
  }

  // ─── private helpers ──────────────────────────────────────────────────────

  /**
   * Run one git command under a deadline. An aborted command surfaces as
   * exitCode 124 with the reason on stderr, so every caller keeps its existing
   * exitCode check as the single failure path. Without this a stalled
   * `git fetch` held the per-repo lock forever and left the panel loading.
   */
  private async runBounded(argv: readonly string[], cwd: string, timeoutMs: number): Promise<GitRunResult> {
    try {
      return await this.runner.run(argv, cwd, AbortSignal.timeout(timeoutMs))
    } catch (error) {
      return {
        exitCode: 124,
        stdout: '',
        stderr: `git timed out after ${String(timeoutMs)}ms: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /** Acquire the per-repo lock for the duration of `fn`. */
  private async withLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(repoRoot) ?? Promise.resolve()
    let release: (() => void) | undefined
    const next = new Promise<void>((resolve) => { release = resolve })
    this.locks.set(repoRoot, previous.then(() => next))
    await previous
    try {
      return await fn()
    } finally {
      release!()
      if (this.locks.get(repoRoot) === next) this.locks.delete(repoRoot)
    }
  }

  /**
   * Resolve the canonical git common-dir for `path`, or null when `path`
   * is not inside a git working tree. We do this with `git rev-parse
   * --path-format=absolute --git-common-dir` so the result follows
   * `git`'s notion of canonicalization (worktrees resolve to the main
   * repo), not `realpath`'s.
   */
  private async repoRoot(path: string): Promise<string | null> {
    if (path === '' || !existsSync(path)) return null
    const result = await this.runner.run(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      path,
    )
    if (result.exitCode !== 0) return null
    const trimmed = result.stdout.trim()
    if (trimmed === '') return null
    return trimmed.endsWith('/.git') || trimmed.endsWith('\\.git')
      ? dirname(trimmed)
      : trimmed.replace(/[\\/]+$/, '')
  }

  // ─── PR lifecycle helpers ────────────────────────────────────────────────

  /** Resolve the `origin` remote URL, or null when no remote is configured. */
  private async originRemoteUrl(root: string): Promise<string | null> {
    const list = await this.runner.run(REMOTE_LIST_ARGV, root)
    if (list.exitCode !== 0) return null
    if (!list.stdout.split('\n').map((line) => line.trim()).includes('origin')) return null
    const url = await this.runner.run(remoteGetUrlArgv('origin'), root)
    if (url.exitCode !== 0) return null
    const trimmed = url.stdout.trim()
    return trimmed === '' ? null : trimmed
  }

  /** Remote default branch (`refs/remotes/origin/HEAD`), or null when unset. */
  private async remoteDefaultBranch(root: string): Promise<string | null> {
    const result = await this.runner.run(REMOTE_HEAD_ARGV, root)
    if (result.exitCode !== 0) return null
    const ref = result.stdout.trim()
    if (ref === '') return null
    return ref.startsWith('refs/remotes/origin/') ? ref.slice('refs/remotes/origin/'.length) : ref
  }

  /** Best-effort `git fetch origin --prune`; a failure (offline) is ignored. */
  private async fetchPruneBestEffort(root: string): Promise<void> {
    try {
      await this.runBounded(FETCH_PRUNE_ARGV, root, this.networkTimeoutMs)
    } catch {
      // offline / no network — keep stale refs and report from what we have
    }
  }

  /** Whether `refs/remotes/origin/<branch>` exists after the last fetch. */
  private async remoteBranchPushed(root: string, branch: string): Promise<boolean> {
    const result = await this.runner.run(verifyRemoteRefArgv(branch), root)
    return result.exitCode === 0
  }

  /** Whether the remote branch is gone (ls-remote --exit-code non-zero). */
  private async remoteBranchGone(root: string, branch: string): Promise<boolean> {
    const result = await this.runBounded(lsRemoteBranchArgv(branch), root, this.networkTimeoutMs)
    // A deadline is not evidence: an unanswered probe must not read as "gone",
    // because "gone" is a merged signal that lets a cleanup delete the lane.
    if (result.exitCode === 124) return false
    return result.exitCode !== 0
  }

  /** Whether `origin/<branch>` is an ancestor of `origin/<base>` (or local `<base>`). */
  private async isAncestorOfBase(root: string, branch: string, base: string): Promise<boolean> {
    const originBase = await this.runner.run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], root)
    const baseRef = originBase.exitCode === 0 ? `refs/remotes/origin/${base}` : base
    const result = await this.runBounded(mergeBaseIsAncestorArgv(`refs/remotes/origin/${branch}`, baseRef), root, this.networkTimeoutMs)
    return result.exitCode === 0
  }

  /**
   * Whether the LOCAL branch tip is an ancestor of the base. Used when the
   * tracking ref is already pruned: the remote signal is gone, but the local
   * branch still answers whether its work landed in the base.
   */
  private async isLocalAncestorOfBase(root: string, branch: string, base: string): Promise<boolean> {
    const originBase = await this.runner.run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], root)
    const baseRef = originBase.exitCode === 0 ? `refs/remotes/origin/${base}` : base
    const result = await this.runBounded(mergeBaseIsAncestorArgv(`refs/heads/${branch}`, baseRef), root, this.networkTimeoutMs)
    return result.exitCode === 0
  }

  /**
   * Whether the local branch moved past the commit the lane was cut from. A
   * lane that never committed is an ancestor of its base too, so this is what
   * separates "merged work" from "no work yet".
   */
  private async branchTipMoved(root: string, branch: string, baseCommit: string): Promise<boolean> {
    if (baseCommit === '') return false
    const result = await this.runner.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)
    if (result.exitCode !== 0) return false
    const tip = result.stdout.trim()
    return tip !== '' && tip !== baseCommit
  }

  /**
   * The merged signal for one branch, in two independent halves:
   *
   * 1. the remote branch still exists -> merged when its tip is an ancestor of
   *    the base tip;
   * 2. the tracking ref is pruned -> either the branch was never pushed, or it
   *    was deleted on merge ("delete branch on merge" is GitHub's default).
   *    `remoteBranch` on the manifest only records a push this plugin made, so
   *    a manually pushed branch would read as unmerged forever; the manifest's
   *    `baseCommit` plus the local tip answer the same question without it.
   */
  private async worktreeStatus(
    root: string,
    branch: string,
    base: string,
    entry: WorktreeManifestEntry | undefined,
  ): Promise<{ pushed: boolean; remoteBranchGone: boolean; merged: boolean }> {
    const pushed = await this.remoteBranchPushed(root, branch)
    if (!pushed) {
      // tracking ref pruned: either never pushed, or pushed then deleted on merge
      const wasPushedBefore = entry?.remoteBranch === 'origin'
      const gone = wasPushedBefore && await this.remoteBranchGone(root, branch)
      const moved = entry?.baseCommit !== undefined && await this.branchTipMoved(root, branch, entry.baseCommit)
      const merged = gone || (moved && await this.isLocalAncestorOfBase(root, branch, base))
      return { pushed: false, remoteBranchGone: gone, merged }
    }
    const merged = await this.isAncestorOfBase(root, branch, base)
    return { pushed: true, remoteBranchGone: false, merged }
  }

  /**
   * Create the PR through the GitHub REST API when a token is configured
   * and the remote is GitHub. Returns null to fall back to the compare URL
   * when no token is configured, the remote is not GitHub, or the API call
   * fails (the compare URL remains the zero-credential default).
   */
  private async createPullRequestViaApi(
    remoteUrl: string,
    branch: string,
    baseRef: string,
    title: string,
  ): Promise<{ htmlUrl: string; number: number } | null> {
    const parsed = githubOwnerRepo(remoteUrl)
    if (parsed === null) return null
    const tokenEnv = this.options.tokenEnv
    if (tokenEnv === undefined || tokenEnv === '') return null
    const credentials = (this.ctx as unknown as { credentials?: { resolve?: (ref: string) => Promise<{ value?: string } | undefined> } }).credentials
    if (credentials?.resolve === undefined) return null
    const credential = await credentials.resolve(tokenEnv)
    const token = credential?.value
    if (token === undefined || token === '') return null
    try {
      const response = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title, head: branch, base: baseRef }),
      })
      if (!response.ok) {
        console.warn(`[dsh-worktree] GitHub PR create failed with status ${response.status}; falling back to compare URL`)
        return null
      }
      const payload = await response.json() as { html_url?: string; number?: number }
      if (typeof payload.html_url !== 'string' || typeof payload.number !== 'number') return null
      return { htmlUrl: payload.html_url, number: payload.number }
    } catch (error) {
      console.warn('[dsh-worktree] GitHub API unreachable; falling back to compare URL:', error)
      return null
    }
  }

  /** Resolve the DSH workspace registered for a worktree directory, or null. */
  private async workspaceForPath(dir: string): Promise<WorkspaceLike | null> {
    try {
      const ws = await this.ctx.workspaceRegistry.resolveByPath(dir)
      return ws === undefined || ws === null ? null : ws
    } catch (error) {
      console.warn('[dsh-worktree] resolveByPath failed:', error)
      return null
    }
  }

  /** Whether the registry's durable archive set holds this session. */
  private isArchivedSession(sessionId: string): boolean {
    try {
      const registry = this.ctx.workspaceRegistry as unknown as { archivedSessionIds?: readonly string[] }
      return (registry.archivedSessionIds ?? []).includes(sessionId)
    } catch (error) {
      console.warn('[dsh-worktree] could not read the workspace archive set:', error)
      return false
    }
  }

  /** Whether every conversation a workspace accounts for has been archived. */
  private hasNoLiveConversation(workspace: WorkspaceLike): boolean {
    return this.sessionIdsOf(workspace).every((sessionId) => this.isArchivedSession(sessionId))
  }

  /** Retire the workspace of the lane that records this conversation. */
  private async retireLaneWorkspaceOf(sessionId: string): Promise<boolean> {
    const cwd = this.sessionCwd(sessionId)
    if (cwd === undefined) return false
    const root = await this.repoRoot(cwd)
    if (root === null) return false
    const manifest = await this.readManifest(root)
    const entry = manifest.worktrees.find((candidate) => candidate.sessionId === sessionId)
    if (entry === undefined) return false
    return await this.retireLaneWorkspace(root, entry)
  }

  /**
   * Drop one lane's workspace registration and the id recorded for it. The
   * directory, the worktree record, the branch and the session binding survive,
   * so picking that branch again re-registers the directory in one call.
   */
  private async retireLaneWorkspace(root: string, entry: WorktreeManifestEntry): Promise<boolean> {
    return this.withLock(root, async () => {
      const workspace = await this.workspaceForPath(entry.path)
      if (workspace === null) return false
      // A lane can host more than one conversation (two sessions on the same
      // branch). Retiring the workspace under a live one would take its composer
      // away, so the row stays until every conversation there is archived.
      if (!this.hasNoLiveConversation(workspace)) return false
      try {
        await this.ctx.workspaceRegistry.delete(workspace.id as WorkspaceId)
      } catch (error) {
        console.warn('[dsh-worktree] lane workspace retirement failed:', error)
        return false
      }
      await this.updateManifestEntry(root, entry.name, { workspaceId: undefined })
      return true
    })
  }

  /** Session ids recorded on a workspace (structural — avoids registry type churn). */
  private sessionIdsOf(workspace: WorkspaceLike): readonly string[] {
    return workspace.sessionIds ?? []
  }

  /** Whether a session id is currently live in the session store. */
  private isLiveSession(sessionId: string): boolean {
    const sessions = optionalService<{ get?: (id: string) => unknown }>(this.ctx, 'sessions')
    return sessions?.get?.(sessionId) !== undefined
  }

  /**
   * The live session still using this lane, if any.
   *
   * Two sources: the lane's workspace accounts for the sessions whose cwd is that
   * directory, and the manifest entry records the session this plugin created
   * there. The manifest half is what stops `cleanup`/`remove` from deleting the
   * directory a running conversation is working in.
   *
   * `self` is the conversation asking for the teardown through its own lane
   * chip. It may excuse itself — otherwise the interlock would make a lane the
   * conversation sits on impossible to ever tear down (the chip is the only
   * surface left once the conversation is gone), and the teardown archives that
   * session anyway. The excusal is not a bypass: the lane has to actually
   * record the id (as its bound session, or as a session of its workspace), so
   * an unrecorded or foreign id excuses nothing.
   */
  private async liveSessionOnLane(
    root: string,
    dir: string,
    workspace: WorkspaceLike | null,
    self?: string,
  ): Promise<string | undefined> {
    const recorded = new Set<string>()
    if (workspace !== null) for (const sessionId of this.sessionIdsOf(workspace)) recorded.add(sessionId)
    const manifest = await this.readManifest(root)
    const entry = manifest.worktrees.find((candidate) => candidate.path === dir)
    if (entry?.sessionId !== undefined) recorded.add(entry.sessionId)
    const excused = self !== undefined && recorded.has(self) ? self : undefined
    for (const sessionId of recorded) {
      if (sessionId !== excused && this.isLiveSession(sessionId)) return sessionId
    }
    return undefined
  }

  /** Archive every session of a worktree workspace, then unregister it. */
  private async archiveAndDeleteWorkspace(workspace: WorkspaceLike): Promise<void> {
    for (const sessionId of this.sessionIdsOf(workspace)) {
      try {
        // See archiveBoundSession: 0.2 archives write first, then stop the
        // session's running work, instead of refusing an active session.
        await this.ctx.workspaceRegistry.archiveSession(sessionId as SessionId, { stopActivity: true })
      } catch (error) {
        console.warn(`[dsh-worktree] archive session ${sessionId} failed:`, error)
      }
    }
    try {
      await this.ctx.workspaceRegistry.delete(workspace.id as WorkspaceId)
    } catch (error) {
      console.warn(`[dsh-worktree] workspace unregister failed for ${workspace.id}:`, error)
    }
  }

  /**
   * Resolve the DSH workspace registered for a path. `resolveByPath` compares
   * the literal string, but git reports canonicalized paths (`/private/tmp/...`
   * on macOS while the registry holds `/tmp/...`), so a miss falls back to
   * comparing realpaths. Without this the main row's Open / New session buttons
   * stay disabled for every workspace behind a symlinked path.
   */
  private async workspaceIdFor(path: string): Promise<WorkspaceId | null> {
    try {
      const direct = await this.ctx.workspaceRegistry.resolveByPath(path)
      if (direct !== undefined && direct !== null) return direct.id
    } catch (error) {
      console.warn('[dsh-worktree] resolveByPath failed:', error)
    }
    const wanted = canonicalPath(path)
    if (wanted === null) return null
    try {
      const listed = this.ctx.workspaceRegistry.list() as readonly { id: string; path?: unknown }[]
      for (const workspace of listed) {
        if (typeof workspace.path !== 'string') continue
        if (canonicalPath(workspace.path) === wanted) return workspace.id as WorkspaceId
      }
    } catch (error) {
      console.warn('[dsh-worktree] workspace list failed:', error)
    }
    return null
  }

  /**
   * Build the per-repo project view: main + linked worktrees under
   * `<repo>/.dsh/workspaces/`. The `git worktree list --porcelain`
   * output is parsed by hand because it is the only stable format and
   * we want zero dependencies.
   */
  private async buildProject(repoPath: string): Promise<WorktreeProject | null> {
    const listResult = await this.runner.run(worktreeListPorcelain(), repoPath)
    const parsed = listResult.exitCode === 0 ? parsePorcelainWorktrees(listResult.stdout) : []
    const [mainBranch, mainDirty] = await Promise.all([
      this.headBranch(repoPath),
      this.dirtyCount(repoPath),
    ])
    const manifest = await this.readManifest(repoPath)
    const worktrees: WorktreeView[] = []
    const mainWorkspaceId = await this.workspaceIdFor(repoPath)
    for (const wt of parsed) {
      if (wt.path === repoPath) continue
      // Only include worktrees that live under `<repo>/.dsh/workspaces/`.
      if (!wt.path.startsWith(worktreeRoot(repoPath) + '/') && !wt.path.startsWith(worktreeRoot(repoPath) + '\\')) continue
      const entry = manifest.worktrees.find((e) => e.path === wt.path || e.name === (wt.branch ?? deriveNameFromPath(wt.path)))
      const workspaceId = await this.workspaceIdFor(wt.path)
      worktrees.push({
        name: entry?.name ?? deriveNameFromPath(wt.path),
        path: wt.path,
        branch: wt.branch,
        head: await this.headShort(wt.path),
        exists: existsSync(wt.path),
        workspaceId,
        // The manifest is the only binding a session-bound lane has; it is what
        // lets the panel open the conversation instead of a (nonexistent) workspace.
        sessionId: (entry?.sessionId as SessionId | undefined) ?? null,
      })
    }
    return {
      repoPath,
      mainPath: repoPath,
      mainWorkspaceId,
      name: basename(repoPath),
      mainBranch,
      dirty: mainDirty,
      worktrees,
    }
  }

  /** Read the manifest from disk; return an empty manifest when missing. */
  private async readManifest(repoPath: string): Promise<ParsedWorktreeManifest> {    const file = manifestPath(repoPath)
    try {
      const text = await readFile(file, 'utf8')
      return parseManifest(text)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest(repoPath)
      throw new WorktreeError('manifest-corrupt', defaultMessage('manifest-corrupt'), { file, cause: String(error) })
    }
  }

  private async writeManifest(repoPath: string, manifest: ParsedWorktreeManifest): Promise<void> {
    const file = manifestPath(repoPath)
    await mkdir(dirname(file), { recursive: true })
    await writeFileAtomic(file, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 })
    // Every plugin mutation lands here, so the status cache can never serve a
    // pre-mutation answer for a lane the user just created, bound or removed.
    this.invalidateStatus(repoPath)
  }

  private async appendManifestEntry(repoPath: string, entry: WorktreeManifestEntry): Promise<void> {
    const manifest = await this.readManifest(repoPath)
    if (manifest.worktrees.some((e) => e.name === entry.name)) {
      throw new WorktreeError('worktree-exists', defaultMessage('worktree-exists'), { name: entry.name })
    }
    manifest.worktrees.push(entry)
    await this.writeManifest(repoPath, manifest)
  }

  private async removeManifestEntry(repoPath: string, name: string): Promise<void> {
    const manifest = await this.readManifest(repoPath)
    manifest.worktrees = manifest.worktrees.filter((e) => e.name !== name)
    await this.writeManifest(repoPath, manifest)
  }

  private async ensureWorkspaceDir(repoPath: string): Promise<void> {
    await mkdir(worktreeRoot(repoPath), { recursive: true })
  }

  private async headBranch(cwd: string): Promise<string | null> {
    const r = await this.runner.run(['symbolic-ref', '-q', '--short', 'HEAD'], cwd)
    if (r.exitCode !== 0) return null
    const trimmed = r.stdout.trim()
    return trimmed === '' ? null : trimmed
  }

  private async headShort(cwd: string): Promise<string | null> {
    const r = await this.runner.run(['rev-parse', '--short', 'HEAD'], cwd)
    if (r.exitCode !== 0) return null
    const trimmed = r.stdout.trim()
    return trimmed === '' ? null : trimmed
  }

  private async dirtyCount(cwd: string): Promise<number | null> {
    if (!existsSync(cwd)) return null
    const r = await this.runner.run(['status', '--porcelain'], cwd)
    if (r.exitCode !== 0) return null
    return r.stdout.split('\n').filter((line) => line.trim() !== '').length
  }
}

// ─── module-level helpers ────────────────────────────────────────────────────

interface ParsedWorktree {
  path: string
  branch: string | null
  head: string | null
}

/** Parse the `git worktree list --porcelain` output. */
function parsePorcelainWorktrees(stdout: string): ParsedWorktree[] {
  const out: ParsedWorktree[] = []
  let current: ParsedWorktree | null = null
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('worktree ')) {
      if (current !== null) out.push(current)
      current = { path: line.slice('worktree '.length).trim(), branch: null, head: null }
    } else if (current !== null && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim() || null
    } else if (current !== null && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (current !== null && line === 'detached') {
      current.branch = null
    }
  }
  if (current !== null) out.push(current)
  return out
}

function basename(path: string): string {
  const segments = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}

function deriveNameFromPath(path: string): string {
  return basename(path)
}

/**
 * Look a service up the way cordis exposes it (`ctx.get(name, false)`) and fall
 * back to the property alias. Both shapes exist across DSH versions, and a
 * silent miss here means the header chip and the lane tool report "no lane"
 * while the panel shows the lane from the manifest.
 */
function optionalService<T>(ctx: Context, name: string): T | undefined {
  const get = (ctx as { get?: (id: string, strict?: boolean) => unknown }).get
  if (typeof get === 'function') {
    try {
      const found = get.call(ctx, name, false) as T | undefined
      if (found !== undefined && found !== null) return found
    } catch {
      // fall through to the property alias
    }
  }
  return (ctx as unknown as Record<string, T | undefined>)[name]
}

/** The real path when it exists; the trimmed path otherwise (never ''). */
function canonicalPath(path: string): string | null {
  if (path === '') return null
  try {
    return realpathSync.native(path)
  } catch {
    const trimmed = path.replace(/[\\/]+$/, '')
    return trimmed === '' ? null : trimmed
  }
}

// Re-export for callers/tests.
export { WORKSPACE_DIR, worktreeDir, worktreeRoot }
