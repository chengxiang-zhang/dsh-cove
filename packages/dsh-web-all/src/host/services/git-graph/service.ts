/** Workspace-gated Git reads and guarded mutations. */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  checkRefFormatArgv, cherryPickArgv, classifySwitchFailure, commitArgv, commitDiffArgv,
  createBranchArgv, diffArgv, discardFileArgv, forEachRefArgv, gitPathArgv, graphLogArgv,
  headBranchArgv, headShortArgv, operationMarkersArgv, OPERATION_MARKERS, revertArgv,
  stageArgv, statusPorcelainArgv, switchArgv, topLevelArgv, unmergedArgv, unstageArgv,
  validateBranchName, validateObjectId, validateRepoRelativePath, verifyCommitArgv,
  verifyRefArgv, verifyTrackedPathArgv, worktreeListArgv,
} from '../../../core/git-graph/commands.ts'
import {
  parseBranches, parseGraph, parsePorcelain, parseWorktreeBranches,
  type BranchesView, type CommitDiffView, type GitError, type GitMutationResponse,
  type GraphView, type RepoStatus, type SwitchResult,
} from '../../../core/git-graph/protocol.ts'

export interface GitRunResult { exitCode: number | null; stdout: string; stderr: string }
export interface GitRunner { run(argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitRunResult> }
export type WorkspaceVerdict = { ok: true; canonical: string } | { ok: false; error: GitError }
export type WorkspaceGate = (path: string) => Promise<WorkspaceVerdict>

const OUTPUT_CAP_BYTES = 1 << 20
const UNKNOWN_WORKSPACE: GitError = { code: 'workspace-unknown', message: 'path is not a registered workspace' }

export function gitSpawnArgv(platform: NodeJS.Platform, argv: readonly string[]): readonly string[] {
  return [platform === 'win32' ? 'git.exe' : 'git', ...argv]
}

export function subprocessRunner(ctx: Context): GitRunner {
  return {
    async run(argv, cwd, signal) {
      signal?.throwIfAborted()
      const processHandle = ctx.subprocess.spawn({
        argv: gitSpawnArgv(process.platform, argv),
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_CAP_BYTES }, stderr: { maxBytes: OUTPUT_CAP_BYTES } },
        graceMs: 10_000,
        signal,
      })
      const result = await processHandle.done
      signal?.throwIfAborted()
      return {
        exitCode: result.exitCode,
        stdout: processHandle.collected.stdout?.readFrom(0).text ?? '',
        stderr: processHandle.collected.stderr?.readFrom(0).text ?? '',
      }
    },
  }
}

export class GitService {
  private readonly statusFlights = new Map<string, Promise<RepoStatus | null>>()

  constructor(private readonly runner: GitRunner, private readonly gate: WorkspaceGate) {}

  status(path: string, signal?: AbortSignal): Promise<RepoStatus | null> {
    const existing = this.statusFlights.get(path)
    if (existing !== undefined) return existing
    const flight = this.statusFresh(path, signal)
    this.statusFlights.set(path, flight)
    const clear = (): void => { if (this.statusFlights.get(path) === flight) this.statusFlights.delete(path) }
    void flight.then(clear, clear)
    return flight
  }

  private async statusFresh(path: string, signal?: AbortSignal): Promise<RepoStatus | null> {
    const snapshot = await this.snapshot(path, signal)
    if (snapshot === null) return null
    const head = await this.runner.run(headShortArgv(), snapshot.root, signal)
    return { ...snapshot, head: head.stdout.trim() }
  }

  async branches(path: string): Promise<BranchesView | null> {
    const snapshot = await this.snapshot(path)
    if (snapshot === null) return null
    const refs = await this.runner.run(forEachRefArgv(), snapshot.root)
    return { ...snapshot, branches: parseBranches(refs.stdout) }
  }

  async switchBranch(path: string, branch: string): Promise<SwitchResult> {
    const gated = await this.gate(path)
    if (!gated.ok) return { ok: false, error: UNKNOWN_WORKSPACE }
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return { ok: false, error: { code: 'internal', message: 'not a git repository' } }
    const valid = await this.runner.run(checkRefFormatArgv(branch), root)
    if (valid.exitCode !== 0) return { ok: false, error: { code: 'invalid-branch-name', message: valid.stderr.trim() || 'invalid branch name' } }
    const exists = await this.runner.run(verifyRefArgv(branch), root)
    if (exists.exitCode !== 0) return { ok: false, error: { code: 'target-branch-not-found', message: `branch "${branch}" does not exist locally` } }
    const current = await this.runner.run(headBranchArgv(), root)
    if (current.stdout.trim() === branch) return { ok: true, branch, opened: true }
    const guarded = await this.mutationGuard(root, branch)
    if (guarded !== null) return { ok: false, error: guarded }
    const switched = await this.runner.run(switchArgv(branch), root)
    return switched.exitCode === 0 ? { ok: true, branch, opened: true } : { ok: false, error: classifySwitchFailure(switched.stderr) }
  }

  async createBranch(path: string, branch: string): Promise<SwitchResult> {
    const reason = validateBranchName(branch)
    if (reason !== null) return { ok: false, error: { code: 'invalid-branch-name', message: `invalid branch name: ${reason}` } }
    const gated = await this.gate(path)
    if (!gated.ok) return { ok: false, error: UNKNOWN_WORKSPACE }
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return { ok: false, error: { code: 'internal', message: 'not a git repository' } }
    const valid = await this.runner.run(checkRefFormatArgv(branch), root)
    if (valid.exitCode !== 0) return { ok: false, error: { code: 'invalid-branch-name', message: valid.stderr.trim() || 'invalid branch name' } }
    if ((await this.runner.run(verifyRefArgv(branch), root)).exitCode === 0) {
      return { ok: false, error: { code: 'branch-already-exists', message: `branch "${branch}" already exists` } }
    }
    const guarded = await this.mutationGuard(root)
    if (guarded !== null) return { ok: false, error: guarded }
    const created = await this.runner.run(createBranchArgv(branch), root)
    return created.exitCode === 0 ? { ok: true, branch, opened: true } : { ok: false, error: classifySwitchFailure(created.stderr) }
  }

  async diff(path: string, file?: string, staged = false): Promise<string | null> {
    const root = await this.gatedRoot(path)
    if (root === null) return null
    const result = await this.runner.run(diffArgv(file, staged), root)
    return result.exitCode === 0 ? result.stdout : null
  }

  async stage(path: string, file?: string): Promise<boolean> { return this.mutate(path, stageArgv(file)) }
  async unstage(path: string, file?: string): Promise<boolean> { return this.mutate(path, unstageArgv(file)) }
  async commit(path: string, message: string): Promise<boolean> {
    if (message.trim() === '' || message.length > 10_000 || message.includes('\0')) return false
    return this.mutate(path, commitArgv(message))
  }

  async graph(path: string, limit = 50, cursor?: string): Promise<GraphView | null> {
    const offset = cursor === undefined ? 0 : Number(cursor)
    if (!Number.isSafeInteger(offset) || offset < 0) return null
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical)
    if (root === null) return null
    const [log, branch] = await Promise.all([
      this.runner.run(graphLogArgv(limit + 1, offset), root),
      this.runner.run(headBranchArgv(), root),
    ])
    if (log.exitCode !== 0) return null
    const commits = parseGraph(log.stdout)
    const hasMore = commits.length > limit
    return {
      root,
      branch: branch.stdout.trim() === 'HEAD' ? '' : branch.stdout.trim(),
      commits: commits.slice(0, limit),
      hasMore,
      ...(hasMore ? { nextCursor: String(offset + limit) } : {}),
    }
  }

  async commitDiff(path: string, oid: string): Promise<CommitDiffView | GitError> {
    const target = await this.commitTarget(path, oid)
    if (!target.ok) return target.error
    const result = await this.runner.run(commitDiffArgv(oid), target.root)
    return result.exitCode === 0
      ? { root: target.root, oid, diff: result.stdout }
      : { code: 'internal', message: firstError(result.stderr, 'git show failed') }
  }

  async discardFile(path: string, file: string): Promise<GitMutationResponse> {
    const pathError = validateRepoRelativePath(file)
    if (pathError !== null) return mutationError('invalid-file-path', `invalid repository path: ${pathError}`)
    const root = await this.gatedRoot(path)
    if (root === null) return mutationError('workspace-unknown', UNKNOWN_WORKSPACE.message)
    const guarded = await this.mutationGuard(root)
    if (guarded !== null) return { ok: false, error: guarded }
    const tracked = await this.runner.run(verifyTrackedPathArgv(file), root)
    if (tracked.exitCode !== 0) return mutationError('file-not-tracked', `file is not tracked: ${file}`)
    const result = await this.runner.run(discardFileArgv(file), root)
    if (result.exitCode !== 0) return mutationError('internal', firstError(result.stderr, 'git restore failed'))
    return { ok: true, value: { changed: true, kind: 'discard', head: await this.readHead(root) } }
  }

  async revert(path: string, oid: string): Promise<GitMutationResponse> {
    return this.applyCommit(path, oid, 'revert')
  }

  async cherryPick(path: string, oid: string): Promise<GitMutationResponse> {
    return this.applyCommit(path, oid, 'cherry-pick')
  }

  private async commitTarget(path: string, oid: string): Promise<{ ok: true; root: string } | { ok: false; error: GitError }> {
    const invalid = validateObjectId(oid)
    if (invalid !== null) return { ok: false, error: { code: 'invalid-object-id', message: `invalid commit id: ${invalid}` } }
    const root = await this.gatedRoot(path)
    if (root === null) return { ok: false, error: UNKNOWN_WORKSPACE }
    const verified = await this.runner.run(verifyCommitArgv(oid), root)
    return verified.exitCode === 0
      ? { ok: true, root }
      : { ok: false, error: { code: 'commit-not-found', message: `commit was not found: ${oid}` } }
  }

  private async applyCommit(path: string, oid: string, kind: 'revert' | 'cherry-pick'): Promise<GitMutationResponse> {
    const target = await this.commitTarget(path, oid)
    if (!target.ok) return target
    const guarded = await this.mutationGuard(target.root, undefined, true)
    if (guarded !== null) return { ok: false, error: guarded }
    const result = await this.runner.run(kind === 'revert' ? revertArgv(oid) : cherryPickArgv(oid), target.root)
    if (result.exitCode !== 0) return { ok: false, error: classifyApplyFailure(result.stderr) }
    return { ok: true, value: { changed: true, kind, head: await this.readHead(target.root) } }
  }

  private async readHead(root: string): Promise<string> {
    const result = await this.runner.run(headShortArgv(), root)
    return result.exitCode === 0 ? result.stdout.trim() : ''
  }

  private async gatedRoot(path: string): Promise<string | null> {
    const gated = await this.gate(path)
    return gated.ok ? this.repoRoot(gated.canonical) : null
  }

  private async mutate(path: string, argv: string[]): Promise<boolean> {
    const root = await this.gatedRoot(path)
    if (root === null || await this.mutationGuard(root) !== null) return false
    return (await this.runner.run(argv, root)).exitCode === 0
  }

  private async snapshot(path: string, signal?: AbortSignal): Promise<Omit<RepoStatus, 'head'> | null> {
    const gated = await this.gate(path)
    if (!gated.ok) return null
    const root = await this.repoRoot(gated.canonical, signal)
    if (root === null) return null
    const [branch, porcelain, operationInProgress] = await Promise.all([
      this.runner.run(headBranchArgv(), root, signal),
      this.runner.run(statusPorcelainArgv(), root, signal),
      this.operationInProgress(root, signal),
    ])
    const current = branch.stdout.trim()
    return { root, branch: current === 'HEAD' ? '' : current, ...parsePorcelain(porcelain.stdout), operationInProgress }
  }

  private async repoRoot(path: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.runner.run(topLevelArgv(), path, signal)
    const root = result.stdout.trim()
    return result.exitCode === 0 && root !== '' ? root : null
  }

  private async operationInProgress(root: string, signal?: AbortSignal): Promise<boolean> {
    const combined = await this.runner.run(operationMarkersArgv(), root, signal)
    if (combined.exitCode === 0) {
      return combined.stdout.split('\n').some((path) => path.trim() !== '' && existsSync(resolve(root, path.trim())))
    }
    for (const marker of OPERATION_MARKERS) {
      const single = await this.runner.run(gitPathArgv(marker), root, signal)
      if (single.stdout.trim() !== '' && existsSync(resolve(root, single.stdout.trim()))) return true
    }
    return false
  }

  private async mutationGuard(root: string, target?: string, requireClean = false): Promise<GitError | null> {
    const [conflicts, operationInProgress, worktrees, porcelain] = await Promise.all([
      this.runner.run(unmergedArgv(), root),
      this.operationInProgress(root),
      target === undefined ? Promise.resolve(null) : this.runner.run(worktreeListArgv(), root),
      requireClean ? this.runner.run(statusPorcelainArgv(), root) : Promise.resolve(null),
    ])
    const conflictCount = conflicts.stdout.split('\n').filter(Boolean).length
    if (conflictCount > 0) return { code: 'conflicts-present', message: `repository has ${conflictCount} unresolved conflict(s)` }
    if (operationInProgress) return { code: 'operation-in-progress', message: 'a git operation is in progress' }
    if (porcelain !== null && porcelain.stdout.trim() !== '') return { code: 'dirty-worktree', message: 'revert and cherry-pick require a clean worktree' }
    if (target !== undefined && worktrees !== null && parseWorktreeBranches(worktrees.stdout).includes(target)) {
      return { code: 'branch-in-other-worktree', message: `branch "${target}" is checked out in another worktree` }
    }
    return null
  }
}

function mutationError(code: GitError['code'], message: string): GitMutationResponse {
  return { ok: false, error: { code, message } }
}

function firstError(stderr: string, fallback: string): string {
  return stderr.trim().split('\n')[0] || fallback
}

export function classifyApplyFailure(stderr: string): GitError {
  const message = firstError(stderr, 'git operation failed')
  if (/nothing to commit|nothing to apply|previous cherry-pick is now empty|patch is empty/i.test(stderr)) {
    return { code: 'nothing-to-apply', message }
  }
  if (/CONFLICT|could not (?:apply|revert)|after resolving the conflicts/i.test(stderr)) {
    return { code: 'apply-conflict', message }
  }
  return { code: 'internal', message }
}

export function createWorkspaceGate(ctx: Context): WorkspaceGate {
  return async (path) => {
    try {
      const { realpath } = await import('node:fs/promises')
      const canonical = await realpath(path)
      return ctx.workspaceRegistry.list().some((workspace) => workspace.path === canonical)
        ? { ok: true, canonical }
        : { ok: false, error: UNKNOWN_WORKSPACE }
    } catch {
      return { ok: false, error: { code: 'workspace-unknown', message: 'path does not resolve on disk' } }
    }
  }
}
