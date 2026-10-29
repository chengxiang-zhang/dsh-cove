/**
 * Unit tests for the worktree manager's PR lifecycle: prCreate (push +
 * compare URL / REST API), status (merged detection), and cleanup (busy /
 * not-merged guards, teardown order, session archive + workspace
 * unregister). Runs through injected fakes — no real git, no cordis
 * context, no network (the REST path stubs global fetch).
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeError } from '../src/core/worktree/invariant.ts'
import type { GitRunResult, GitRunner } from '../src/host/services/worktree/git-runner.ts'
import { WorktreeManager } from '../src/host/services/worktree/manager.ts'
import { worktreeDir } from '../src/core/worktree/paths.ts'
import { manifestPath } from '../src/core/worktree/manifest.ts'

const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

/** In-memory workspace registry faking the official registry surface. */
function fakeRegistry() {
  const workspaces = new Map<string, { id: string; path: string; sessionIds: string[] }>()
  let seq = 0
  const archived: string[] = []
  const deleted: string[] = []
  /** Whether each archive call asked the activity owners to stop (0.2 gate). */
  const archiveOptions_stopActivity: boolean[] = []
  const registry = {
    resolveByPath: async (path: string) => {
      for (const ws of workspaces.values()) if (ws.path === path) return ws
      return undefined
    },
    create: async (path: string, title?: string) => {
      const id = `ws-${++seq}`
      const ws = { id, path, sessionIds: [] as string[] }
      workspaces.set(id, ws)
      return { id, title: title ?? path }
    },
    delete: async (id: string) => { deleted.push(id); workspaces.delete(id) },
    archiveSession: async (sessionId: string, archiveOptions?: { stopActivity?: boolean }) => {
      archived.push(sessionId)
      archiveOptions_stopActivity.push(archiveOptions?.stopActivity === true)
    },
  }
  return { registry, workspaces, archived, deleted, archiveOptions_stopActivity }
}

/** Fake git runner with per-argv-pattern behaviors. */
function fakeRunner(options: {
  commonDir?: string | null
  remotes?: string
  remoteUrl?: string | null
  remoteHead?: string | null
  pushOk?: boolean
  porcelain?: string
  /** branch -> exit code for `rev-parse --verify refs/remotes/origin/<b>` */
  remoteRefs?: Record<string, number>
  /** branch -> exit code for `ls-remote --exit-code origin refs/heads/<b>` */
  lsRemote?: Record<string, number>
  /** Branch list output for `for-each-ref` (default: empty). */
  branches?: string
  mergeBaseOk?: boolean
  localBranchOk?: boolean
  removeOk?: boolean
  /** Local branch tip returned by `rev-parse refs/heads/<b>` (default SHA). */
  localBranchSha?: string
  /** `git branch -d|-D`: 0 keeps both ok, `'d-only'` refuses only `-d`, else the exit code. */
  branchDelete?: number | 'd-only'
  /** Run never resolves for `ls-remote` until the caller's signal aborts. */
  lsRemoteHangs?: boolean
} = {}) {
  const run = vi.fn(async (argv: readonly string[], _cwd: string, signal?: AbortSignal): Promise<GitRunResult> => {
    const joined = argv.join(' ')
    const ok = (stdout = ''): GitRunResult => ({ exitCode: 0, stdout, stderr: '' })
    const fail = (stderr = 'boom'): GitRunResult => ({ exitCode: 128, stdout: '', stderr })
    if (joined.includes('--git-common-dir')) {
      const root = options.commonDir ?? null
      return root === null ? fail('not a repo') : ok(root)
    }
    if (argv[0] === 'remote' && argv.length === 1) return ok(options.remotes ?? 'origin\n')
    if (joined.includes('remote get-url')) return options.remoteUrl === null ? fail() : ok(options.remoteUrl ?? 'git@github.com:chengxiang-zhang/dsh-cove.git')
    if (joined.includes('symbolic-ref refs/remotes/origin/HEAD')) {
      const ref = options.remoteHead ?? null
      return ref === null ? fail('no upstream') : ok(ref)
    }
    if (argv[0] === 'push') return options.pushOk === false ? fail('push rejected') : ok()
    if (joined.includes('worktree list')) return ok(options.porcelain ?? '')
    if (joined.includes('worktree remove')) return options.removeOk === false ? fail('dirty tree') : ok()
    if (joined.includes('worktree prune')) return ok()
    if (joined.includes('fetch origin --prune')) return ok()
    if (joined.includes('for-each-ref')) return ok(options.branches ?? '')
    if (joined.includes('rev-parse --verify --quiet refs/remotes/origin/')) {
      const branch = joined.split('refs/remotes/origin/')[1]?.trim()
      return (options.remoteRefs?.[branch] ?? 1) === 0 ? ok(SHA) : fail('no remote ref')
    }
    if (joined.includes('rev-parse --verify --quiet refs/heads/')) {
      return options.localBranchOk === false ? fail() : ok(options.localBranchSha ?? SHA)
    }
    if (joined.includes('ls-remote --exit-code origin')) {
      if (options.lsRemoteHangs === true) {
        return await new Promise<GitRunResult>((_resolve, reject) => {
          if (signal === undefined) return
          signal.addEventListener('abort', () => { reject(new DOMException('The operation was aborted', 'TimeoutError')) })
        })
      }
      const branch = joined.split('refs/heads/')[1]?.trim()
      return (options.lsRemote?.[branch] ?? 1) === 0 ? ok(SHA) : fail('gone')
    }
    if (joined.includes('merge-base --is-ancestor')) return options.mergeBaseOk === false ? fail('not ancestor') : ok()
    if (argv[0] === 'branch' && (argv[1] === '-d' || argv[1] === '-D')) {
      const mode = options.branchDelete ?? 0
      if (mode === 'd-only' && argv[1] === '-d') return fail('not fully merged')
      return typeof mode === 'number' && mode !== 0 ? fail('cannot delete the branch') : ok()
    }
    if (argv[0] === 'branch') return ok()
    return ok()
  })
  const runner = { run } as unknown as GitRunner
  return { runner, run }
}

/** Build a manager wired to temp root + fakes (overridable). */
function makeManager(opts: {
  runner: GitRunner
  registry: ReturnType<typeof fakeRegistry>['registry']
  tokenEnv?: string
  credentials?: { resolve?: () => Promise<{ value?: string } | undefined> }
  liveSessions?: Set<string>
  timeouts?: { networkMs?: number; pushMs?: number }
  statusTtlMs?: number
}) {
  const ctx = {
    workspaceRegistry: opts.registry,
    credentials: opts.credentials,
    sessions: { get: (id: string) => opts.liveSessions?.has(id) ? { id } : undefined },
  }
  return new WorktreeManager(ctx as never, {
    tokenEnv: opts.tokenEnv,
    runner: opts.runner,
    ...(opts.timeouts === undefined ? {} : { timeouts: opts.timeouts }),
    ...(opts.statusTtlMs === undefined ? {} : { statusTtlMs: opts.statusTtlMs }),
  })
}

const tempRoots: string[] = []
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wt-pr-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
  vi.unstubAllGlobals()
})

/** Write a manifest with one entry for `branch` and create its worktree dir. */
async function seedWorktree(root: string, branch: string, options: { remoteBranch?: string; prUrl?: string; sessionId?: string } = {}): Promise<void> {
  const dir = worktreeDir(root, branch)
  await mkdir(dir, { recursive: true })
  const manifest = {
    version: 2,
    repoPath: root,
    worktrees: [{
      name: branch,
      path: dir,
      baseCommit: SHA,
      createdAt: new Date().toISOString(),
      detached: false,
      ...(options.remoteBranch === undefined ? {} : { remoteBranch: options.remoteBranch }),
      ...(options.prUrl === undefined ? {} : { prUrl: options.prUrl }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    }],
  }
  await writeFile(manifestPath(root), JSON.stringify(manifest, null, 2) + '\n')
}

describe('WorktreeManager.prCreate', () => {
  it('pushes and returns the compare URL when no token is configured', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { runner, run } = fakeRunner({ commonDir: root, remoteUrl: 'git@github.com:chengxiang-zhang/dsh-cove.git', remoteHead: 'refs/remotes/origin/dev' })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    const result = await manager.prCreate({ repoPath: root, name: 'feature/x' })

    expect(result.method).toBe('url')
    expect(result.prUrl).toBe('https://github.com/chengxiang-zhang/dsh-cove/compare/dev...feature%2Fx?expand=1')
    // push ran with upstream tracking from the worktree dir
    expect(run.mock.calls.some(([argv]) => argv[0] === 'push' && argv.includes('-u') && argv.includes('origin') && argv.includes('feature/x'))).toBe(true)
    // manifest entry records the PR metadata
    const manifest = JSON.parse(await readFile(manifestPath(root), 'utf8'))
    expect(manifest.baseBranch).toBe('dev')
    expect(manifest.worktrees[0].prUrl).toBe(result.prUrl)
    expect(manifest.worktrees[0].remoteBranch).toBe('origin')
    expect(manifest.worktrees[0].baseRef).toBe('dev')
  })

  it('throws no-remote when origin is missing', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { runner } = fakeRunner({ commonDir: root, remotes: '' })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    await expect(manager.prCreate({ repoPath: root, name: 'feature/x' })).rejects.toMatchObject({ code: 'no-remote' })
  })

  it('throws push-failed when the push is rejected', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { runner } = fakeRunner({ commonDir: root, pushOk: false })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    await expect(manager.prCreate({ repoPath: root, name: 'feature/x' })).rejects.toMatchObject({ code: 'push-failed' })
  })

  it('creates the PR via the REST API when a token is configured', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { runner } = fakeRunner({ commonDir: root, remoteUrl: 'https://github.com/chengxiang-zhang/dsh-cove.git' })
    const manager = makeManager({
      runner,
      registry: fakeRegistry().registry,
      tokenEnv: 'GITHUB_TOKEN',
      credentials: { resolve: async () => ({ value: 'tok-123' }) },
    })
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ html_url: 'https://github.com/chengxiang-zhang/dsh-cove/pull/42', number: 42 }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await manager.prCreate({ repoPath: root, name: 'feature/x', title: 'My feature' })

    expect(result.method).toBe('api')
    expect(result.prUrl).toBe('https://github.com/chengxiang-zhang/dsh-cove/pull/42')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/chengxiang-zhang/dsh-cove/pulls',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"head":"feature/x"') }),
    )
    const manifest = JSON.parse(await readFile(manifestPath(root), 'utf8'))
    expect(manifest.worktrees[0].prNumber).toBe(42)
  })

  it('falls back to the compare URL when the API call fails', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { runner } = fakeRunner({ commonDir: root, remoteUrl: 'https://github.com/chengxiang-zhang/dsh-cove.git' })
    const manager = makeManager({
      runner,
      registry: fakeRegistry().registry,
      tokenEnv: 'GITHUB_TOKEN',
      credentials: { resolve: async () => ({ value: 'tok-123' }) },
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })))

    const result = await manager.prCreate({ repoPath: root, name: 'feature/x' })

    expect(result.method).toBe('url')
    expect(result.prUrl).toContain('/compare/')
  })
})

describe('WorktreeManager.status', () => {
  it('reports merged when the remote branch is gone after prune', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x', { remoteBranch: 'origin' })
    const { runner } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      porcelain: `worktree ${root}\nHEAD ${SHA}\nbranch refs/heads/dev\n\nworktree ${worktreeDir(root, 'feature/x')}\nHEAD ${SHA}\nbranch refs/heads/feature/x\n\n`,
      // tracking ref pruned (fetch --prune removed it) => rev-parse fails,
      // ls-remote confirms the remote branch is gone
      remoteRefs: { 'feature/x': 1 },
      lsRemote: { 'feature/x': 1 },
    })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    const index = await manager.status({ repoPath: root })

    expect(index.baseBranch).toBe('dev')
    expect(index.branches).toEqual([])
    const view = index.worktrees.find((w) => w.branch === 'feature/x')
    expect(view?.pushed).toBe(false)
    expect(view?.remoteBranchGone).toBe(true)
    expect(view?.merged).toBe(true)
  })

  it('exposes candidate branches for the dialogs, deduplicated', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { runner } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      porcelain: `worktree ${root}\nHEAD ${SHA}\nbranch refs/heads/dev\n\n`,
      branches: ['dev', 'main', 'origin/HEAD', 'origin/dev', 'origin/feature/x', 'origin/main'].join('\n'),
    })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    const index = await manager.status({ repoPath: root })

    expect(index.branches).toEqual(['dev', 'main', 'feature/x'])
  })

  it('reports merged when the branch tip is an ancestor of the base', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { runner } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      porcelain: `worktree ${root}\nHEAD ${SHA}\nbranch refs/heads/dev\n\nworktree ${worktreeDir(root, 'feature/x')}\nHEAD ${SHA}\nbranch refs/heads/feature/x\n\n`,
      remoteRefs: { 'feature/x': 0, dev: 0 },
      mergeBaseOk: true,
    })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    const index = await manager.status({ repoPath: root })

    const view = index.worktrees.find((w) => w.branch === 'feature/x')
    expect(view?.pushed).toBe(true)
    expect(view?.merged).toBe(true)
  })

  it('reports unmerged when the branch is pushed but not an ancestor', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { runner } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      porcelain: `worktree ${root}\nHEAD ${SHA}\nbranch refs/heads/dev\n\nworktree ${worktreeDir(root, 'feature/x')}\nHEAD ${SHA}\nbranch refs/heads/feature/x\n\n`,
      remoteRefs: { 'feature/x': 0, dev: 0 },
      mergeBaseOk: false,
    })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    const index = await manager.status({ repoPath: root })

    const view = index.worktrees.find((w) => w.branch === 'feature/x')
    expect(view?.pushed).toBe(true)
    expect(view?.merged).toBe(false)
  })
})

describe('WorktreeManager.cleanup', () => {
  it('refuses when a session is still live', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { registry, workspaces } = fakeRegistry()
    workspaces.set('ws-1', { id: 'ws-1', path: worktreeDir(root, 'feature/x'), sessionIds: ['session-live'] })
    const { runner } = fakeRunner({ commonDir: root })
    const manager = makeManager({ runner, registry, liveSessions: new Set(['session-live']) })

    await expect(manager.cleanup({ repoPath: root, name: 'feature/x' })).rejects.toMatchObject({ code: 'worktree-busy' })
  })

  it('lets the lane own conversation clean itself up and archives it', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x', { sessionId: 'session-self' })
    const { registry, archived } = fakeRegistry()
    const { runner, run } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      remoteRefs: { 'feature/x': 0 },
      mergeBaseOk: true,
    })
    const manager = makeManager({ runner, registry, liveSessions: new Set(['session-self']) })

    const result = await manager.cleanup({ repoPath: root, name: 'feature/x', sessionId: 'session-self' })

    expect(result.name).toBe('feature/x')
    expect(run.mock.calls.some(([argv]) => argv[0] === 'worktree' && argv[1] === 'remove')).toBe(true)
    // The teardown archives the conversation it was asked from.
    expect(archived).toContain('session-self')
  })

  it('ignores a self id the lane does not record', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x', { sessionId: 'session-bound' })
    const { registry } = fakeRegistry()
    const { runner } = fakeRunner({ commonDir: root })
    const manager = makeManager({ runner, registry, liveSessions: new Set(['session-bound']) })

    await expect(manager.cleanup({ repoPath: root, name: 'feature/x', sessionId: 'session-stranger' }))
      .rejects.toMatchObject({ code: 'worktree-busy' })
  })

  it('still refuses when another session of the lane is live', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x', { sessionId: 'session-self' })
    const { registry, workspaces } = fakeRegistry()
    workspaces.set('ws-1', { id: 'ws-1', path: worktreeDir(root, 'feature/x'), sessionIds: ['session-self', 'session-other'] })
    const { runner } = fakeRunner({ commonDir: root })
    const manager = makeManager({ runner, registry, liveSessions: new Set(['session-self', 'session-other']) })

    await expect(manager.cleanup({ repoPath: root, name: 'feature/x', sessionId: 'session-self' }))
      .rejects.toMatchObject({ code: 'worktree-busy', details: { sessionId: 'session-other' } })
  })

  it('refuses an unmerged branch without force', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { runner } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      remoteRefs: { 'feature/x': 0 },
      mergeBaseOk: false,
    })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    await expect(manager.cleanup({ repoPath: root, name: 'feature/x' })).rejects.toMatchObject({ code: 'not-merged' })
  })

  it('tears down a merged worktree: remove dir, delete branch, unregister, archive', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x', { remoteBranch: 'origin' })
    const { registry, workspaces, archived, deleted, archiveOptions_stopActivity } = fakeRegistry()
    workspaces.set('ws-1', { id: 'ws-1', path: worktreeDir(root, 'feature/x'), sessionIds: ['session-a', 'session-b'] })
    const { runner, run } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      remoteRefs: { 'feature/x': 1 },
      lsRemote: { 'feature/x': 1 },
    })
    const manager = makeManager({ runner, registry })

    const result = await manager.cleanup({ repoPath: root, name: 'feature/x' })

    expect(result.name).toBe('feature/x')
    // worktree dir removed (fake runner does not create one; existsSync already true)
    expect(run.mock.calls.some(([argv]) => argv[0] === 'worktree' && argv[1] === 'remove')).toBe(true)
    // local branch deleted
    expect(run.mock.calls.some(([argv]) => argv[0] === 'branch' && argv[1] === '-d')).toBe(true)
    // workspace unregistered + sessions archived
    expect(deleted).toContain('ws-1')
    expect(archived).toEqual(['session-a', 'session-b'])
    // 0.2 archives write first and then stop the sessions' work; without the
    // option an active session is refused and the record is left dangling.
    expect(archiveOptions_stopActivity).toEqual([true, true])
    // manifest entry removed
    const manifest = JSON.parse(await readFile(manifestPath(root), 'utf8'))
    expect(manifest.worktrees).toHaveLength(0)
  })

  it('force cleans up an unmerged branch', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { registry, workspaces } = fakeRegistry()
    workspaces.set('ws-1', { id: 'ws-1', path: worktreeDir(root, 'feature/x'), sessionIds: [] })
    const { runner, run } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      remoteRefs: { 'feature/x': 0 },
      mergeBaseOk: false,
    })
    const manager = makeManager({ runner, registry })

    const result = await manager.cleanup({ repoPath: root, name: 'feature/x', force: true })

    expect(result.name).toBe('feature/x')
    expect(run.mock.calls.some(([argv]) => argv[0] === 'worktree' && argv[1] === 'remove' && argv.includes('--force'))).toBe(true)
    expect(run.mock.calls.some(([argv]) => argv[0] === 'branch' && argv[1] === '-D')).toBe(true)
  })
})

/** Porcelain fixture: the main checkout plus one linked lane. */
function porcelainWithLane(root: string, branch: string): string {
  const dir = worktreeDir(root, branch)
  return `worktree ${root}\nHEAD ${SHA}\nbranch refs/heads/main\n\n`
    + `worktree ${dir}\nHEAD ${SHA}\nbranch refs/heads/${branch}\n\n`
}

describe('WorktreeManager lane view', () => {
  it('reads a branch GitHub deleted on merge as merged, exactly like cleanup', async () => {
    // Regression: the lane view derived "merged" from "pushed" alone, so a
    // branch deleted on merge (GitHub's default) reached the header chip as
    // "not pushed" while cleanup — which uses the two-half rule — tore it down.
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x', { remoteBranch: 'origin', prUrl: 'https://github.com/o/r/pull/3' })
    const { runner } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      porcelain: porcelainWithLane(root, 'feature/x'),
      // The tracking ref is pruned and the remote branch is gone: the merge.
      remoteRefs: { 'feature/x': 1 },
      lsRemote: { 'feature/x': 1 },
    })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    const lane = await manager.laneForPath({ path: worktreeDir(root, 'feature/x') })

    expect(lane).toMatchObject({
      pushed: false,
      remoteBranchGone: true,
      merged: true,
      prUrl: 'https://github.com/o/r/pull/3',
    })
  })

  it('does not call a never-pushed lane merged', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { runner } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      porcelain: porcelainWithLane(root, 'feature/x'),
      remoteRefs: { 'feature/x': 1 },
      lsRemote: { 'feature/x': 1 },
    })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    const lane = await manager.laneForPath({ path: worktreeDir(root, 'feature/x') })

    expect(lane).toMatchObject({ pushed: false, remoteBranchGone: false, merged: false })
  })
})

describe('WorktreeManager guards', () => {
  it('throws not-a-repository when the path is outside any repo', async () => {
    const { runner } = fakeRunner({ commonDir: null })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })
    await expect(manager.prCreate({ repoPath: '/nowhere', name: 'x' })).rejects.toMatchObject({ code: 'not-a-repository' })
  })

  it('rejects an invalid branch name before touching git', async () => {
    const root = await makeRoot()
    const { runner, run } = fakeRunner({ commonDir: root })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })
    await expect(manager.cleanup({ repoPath: root, name: '..' })).rejects.toMatchObject({ code: 'invalid-branch' })
    await expect(manager.prCreate({ repoPath: root, name: '..' })).rejects.toMatchObject({ code: 'invalid-branch' })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('WorktreeManager merge signal and git deadlines', () => {
  const MOVED_SHA = 'cafebabecafebabecafebabecafebabecafebabe'

  it('cleans up a branch pushed outside the plugin after its remote branch was deleted on merge', async () => {
    // The manifest only records a push this plugin made, so `remoteBranch` is
    // absent for `git push -u origin <branch>` from the lane terminal. The
    // branch is still merged: it moved past its creation commit and its tip is
    // now in the base. Refusing here was the "panel says Merged, cleanup says
    // not merged, and there is no force checkbox" dead end.
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { runner, run } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      remoteRefs: { 'feature/x': 1 },
      lsRemote: { 'feature/x': 1 },
      mergeBaseOk: true,
      localBranchSha: MOVED_SHA,
    })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    await expect(manager.cleanup({ repoPath: root, name: 'feature/x' })).resolves.toMatchObject({ name: 'feature/x' })
    expect(run.mock.calls.some(([argv]) => argv[0] === 'worktree' && argv[1] === 'remove')).toBe(true)
    expect(run.mock.calls.some(([argv]) => argv[0] === 'branch' && argv[1] === '-d')).toBe(true)
  })

  it('still refuses a moved branch whose tip never reached the base', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { runner, run } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      remoteRefs: { 'feature/x': 1 },
      lsRemote: { 'feature/x': 1 },
      mergeBaseOk: false,
      localBranchSha: MOVED_SHA,
    })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    await expect(manager.cleanup({ repoPath: root, name: 'feature/x' })).rejects.toMatchObject({ code: 'not-merged' })
    expect(run.mock.calls.some(([argv]) => argv[0] === 'worktree' && argv[1] === 'remove')).toBe(false)
  })

  it('refuses a lane that never moved past its creation commit', async () => {
    // A lane cut from the base and never committed is an ancestor of the base
    // too, so the ancestor test alone would call it merged and delete a lane
    // that is still the user's work line.
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x')
    const { runner, run } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      remoteRefs: { 'feature/x': 1 },
      mergeBaseOk: true,
      localBranchSha: SHA,
    })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    await expect(manager.cleanup({ repoPath: root, name: 'feature/x' })).rejects.toMatchObject({ code: 'not-merged' })
    expect(run.mock.calls.some(([argv]) => argv[0] === 'worktree' && argv[1] === 'remove')).toBe(false)
  })

  it('escalates to -D when -d refuses a branch the manifest says is merged', async () => {
    // `-d` also refuses a branch merged into the PR base but not into the main
    // worktree's current HEAD; the old code ignored the exit code and reported
    // success with the branch left behind.
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x', { remoteBranch: 'origin' })
    const { runner, run } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      remoteRefs: { 'feature/x': 1 },
      lsRemote: { 'feature/x': 1 },
      branchDelete: 'd-only',
    })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    await expect(manager.cleanup({ repoPath: root, name: 'feature/x' })).resolves.toMatchObject({ name: 'feature/x' })
    expect(run.mock.calls.some(([argv]) => argv[0] === 'branch' && argv[1] === '-D')).toBe(true)
  })

  it('reports a branch it cannot delete instead of claiming success', async () => {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x', { remoteBranch: 'origin' })
    const { runner } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      remoteRefs: { 'feature/x': 1 },
      lsRemote: { 'feature/x': 1 },
      branchDelete: 128,
    })
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    await expect(manager.cleanup({ repoPath: root, name: 'feature/x' })).rejects.toMatchObject({ code: 'git-failed' })
  })

  it('does not read an unanswered remote probe as a merge', async () => {
    // `remoteBranchGone` feeds the merged signal: a stalled `ls-remote` must
    // fail closed (keep the lane) and must not hold the call forever.
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x', { remoteBranch: 'origin' })
    const { runner, run } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      remoteRefs: { 'feature/x': 1 },
      lsRemoteHangs: true,
    })
    const manager = makeManager({ runner, registry: fakeRegistry().registry, timeouts: { networkMs: 20 } })

    await expect(manager.cleanup({ repoPath: root, name: 'feature/x' })).rejects.toMatchObject({ code: 'not-merged' })
    expect(run.mock.calls.some(([argv]) => argv[0] === 'worktree' && argv[1] === 'remove')).toBe(false)
  })
})

describe('WorktreeManager status cache', () => {
  /** How many times a probe actually ran the network fetch. */
  const fetches = (run: ReturnType<typeof fakeRunner>['run']): number =>
    run.mock.calls.filter(([argv]) => argv.join(' ').includes('fetch origin --prune')).length

  /** A repo with one pushed-and-merged lane, wired to the fakes. */
  async function seed(): Promise<{ root: string; run: ReturnType<typeof fakeRunner>['run']; runner: GitRunner }> {
    const root = await makeRoot()
    await seedWorktree(root, 'feature/x', { remoteBranch: 'origin' })
    const { runner, run } = fakeRunner({
      commonDir: root,
      remoteHead: 'refs/remotes/origin/dev',
      remoteRefs: { 'feature/x': 0 },
      mergeBaseOk: true,
    })
    return { root, run, runner }
  }

  it('answers a repeated probe from the cache instead of fetching again', async () => {
    const { root, run, runner } = await seed()
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    const first = await manager.status({ repoPath: root })
    expect(fetches(run)).toBe(1)
    const second = await manager.status({ repoPath: root })
    expect(fetches(run)).toBe(1)
    expect(second).toEqual(first)
  })

  it('probes again when the caller forces a refresh', async () => {
    const { root, run, runner } = await seed()
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    await manager.status({ repoPath: root })
    await manager.status({ repoPath: root, force: true })
    expect(fetches(run)).toBe(2)
  })

  it('drops the cached answer when this plugin writes the manifest', async () => {
    const { root, run, runner } = await seed()
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    await manager.status({ repoPath: root })
    await manager.bindSession(root, 'feature/x', 'session-1' as never, true)
    await manager.status({ repoPath: root })
    expect(fetches(run)).toBe(2)
  })

  it('lets the entry expire after its TTL', async () => {
    const { root, run, runner } = await seed()
    const manager = makeManager({ runner, registry: fakeRegistry().registry, statusTtlMs: 10 })

    await manager.status({ repoPath: root })
    await new Promise((resolve) => setTimeout(resolve, 25))
    await manager.status({ repoPath: root })
    expect(fetches(run)).toBe(2)
  })

  it('can be disabled entirely', async () => {
    const { root, run, runner } = await seed()
    const manager = makeManager({ runner, registry: fakeRegistry().registry, statusTtlMs: 0 })

    await manager.status({ repoPath: root })
    await manager.status({ repoPath: root })
    expect(fetches(run)).toBe(2)
  })

  it('keeps a name-filtered probe out of the cache', async () => {
    const { root, run, runner } = await seed()
    const manager = makeManager({ runner, registry: fakeRegistry().registry })

    await manager.status({ repoPath: root, name: 'feature/x' })
    await manager.status({ repoPath: root, name: 'feature/x' })
    expect(fetches(run)).toBe(2)
  })
})