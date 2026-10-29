/**
 * Unit tests for lane creation: the `-b` branch cut, the ignore
 * precondition, the required-workspace variant with rollback, the
 * session binding, and the path -> lane lookup that feeds the conversation
 * header chip. Runs through injected fakes — no real git, no cordis
 * context, no network.
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeError } from '../src/core/worktree/invariant.ts'
import type { GitRunResult, GitRunner } from '../src/host/services/worktree/git-runner.ts'
import { WorktreeManager } from '../src/host/services/worktree/manager.ts'
import { worktreeAddArgv, checkIgnoreArgv } from '../src/host/services/worktree/git.ts'
import { worktreeDir, worktreeRoot } from '../src/core/worktree/paths.ts'
import { manifestPath } from '../src/core/worktree/manifest.ts'

const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

// ─── argv builders (pure) ────────────────────────────────────────────────────

describe('worktreeAddArgv', () => {
  it('cuts a new branch with -b placed before the path', () => {
    expect(worktreeAddArgv('/repo/.dsh/workspaces/feature/x', 'origin/dev', false, 'feature/x')).toEqual([
      'worktree', 'add', '-b', 'feature/x', '/repo/.dsh/workspaces/feature/x', 'origin/dev',
    ])
  })

  it('stays detached-capable when no branch is given', () => {
    expect(worktreeAddArgv('/lane', 'HEAD', true)).toEqual(['worktree', 'add', '--detach', '/lane', 'HEAD'])
  })

  it('rejects --detach together with -b instead of silently dropping one', () => {
    expect(() => worktreeAddArgv('/lane', 'HEAD', true, 'feature/x')).toThrow(/mutually exclusive/u)
  })

  it('builds the ignore probe argv', () => {
    expect(checkIgnoreArgv('/repo/.dsh/workspaces/probe')).toEqual(['check-ignore', '-q', '/repo/.dsh/workspaces/probe'])
  })
})

// ─── fakes ───────────────────────────────────────────────────────────────────

/** In-memory workspace registry; `create` can be forced to fail. */
function fakeRegistry(options: { createFails?: boolean } = {}) {
  const workspaces = new Map<string, { id: string; path: string; sessionIds: string[] }>()
  let seq = 0
  const deleted: string[] = []
  const archived: string[] = []
  /** Whether each archive call asked the activity owners to stop (0.2 gate). */
  const archiveOptions_stopActivity: boolean[] = []
  const registry = {
    resolveByPath: async (path: string) => {
      for (const ws of workspaces.values()) if (ws.path === path) return ws
      return undefined
    },
    // The manager's realpath fallback walks the registry list; a fake without it
    // logs a warning on every lane create.
    list: () => [...workspaces.values()],
    create: async (path: string, title?: string) => {
      if (options.createFails === true) throw new Error('registry refused')
      const id = `ws-${++seq}`
      workspaces.set(id, { id, path, sessionIds: [] })
      return { id, title: title ?? path }
    },
    delete: async (id: string) => { deleted.push(id); workspaces.delete(id) },
    archiveSession: async (id: string, archiveOptions?: { stopActivity?: boolean }) => {
      archived.push(id)
      archiveOptions_stopActivity.push(archiveOptions?.stopActivity === true)
    },
  }
  return { registry, workspaces, deleted, archived, archiveOptions_stopActivity }
}

/**
 * Stateful fake git runner. A `worktree add -b <branch>` call makes that
 * branch exist afterwards, which is what the pre-create guard and the
 * rollback branch delete both read.
 */
function fakeRunner(options: {
  /** Value returned by `rev-parse --git-common-dir` (usually `<root>/.git`). */
  commonDir?: string
  ignored?: boolean
  porcelain?: string
  dirtyLines?: number
  remoteRefs?: Record<string, number>
  mergeBaseOk?: boolean
  addFails?: boolean
  /** Branches that already exist locally (the attach path reads this). */
  existingBranches?: string[]
} = {}) {
  let createdBranch: string | null = null
  const run = vi.fn(async (argv: readonly string[], _cwd: string): Promise<GitRunResult> => {
    const joined = argv.join(' ')
    const ok = (stdout = ''): GitRunResult => ({ exitCode: 0, stdout, stderr: '' })
    const fail = (stderr = 'boom'): GitRunResult => ({ exitCode: 128, stdout: '', stderr })
    if (joined.includes('--git-common-dir')) return ok(options.commonDir ?? '')
    if (argv[0] === 'check-ignore') return options.ignored === false ? fail() : ok()
    if (joined.startsWith('symbolic-ref refs/remotes/origin/HEAD')) return ok('refs/remotes/origin/dev')
    if (joined.startsWith('worktree add')) {
      if (options.addFails === true) return fail('fatal: already checked out')
      const branchIndex = argv.indexOf('-b')
      createdBranch = branchIndex < 0 ? null : argv[branchIndex + 1] ?? null
      // Be faithful: a real `worktree add` materializes the directory, which
      // is what the orphan/exists checks read afterwards.
      await mkdir(argv[argv.length - 2] as string, { recursive: true })
      return ok()
    }
    if (joined.includes('worktree list')) return ok(options.porcelain ?? '')
    if (joined.includes('worktree remove')) return ok()
    if (joined.includes('worktree prune')) return ok()
    if (joined.includes('rev-parse --verify --quiet refs/heads/')) {
      const branch = joined.split('refs/heads/')[1]?.trim()
      if (branch !== undefined && (options.existingBranches ?? []).includes(branch)) return ok(SHA)
      return createdBranch !== null && branch === createdBranch ? ok(SHA) : fail('no such branch')
    }
    if (joined.includes('rev-parse --verify --quiet refs/remotes/origin/')) {
      const branch = joined.split('refs/remotes/origin/')[1]?.trim()
      return (options.remoteRefs?.[branch] ?? 1) === 0 ? ok(SHA) : fail('no remote ref')
    }
    if (joined.startsWith('rev-parse --short')) return ok(SHA.slice(0, 7))
    if (joined.startsWith('rev-parse')) return ok(SHA)
    if (joined.startsWith('status --porcelain')) {
      const count = options.dirtyLines ?? 0
      return ok(count === 0 ? '' : Array.from({ length: count }, (_, i) => ` M file${i}.ts`).join('\n'))
    }
    if (joined.includes('merge-base --is-ancestor')) return options.mergeBaseOk === false ? fail('not ancestor') : ok()
    if (argv[0] === 'branch') return ok()
    return ok()
  })
  return { runner: { run } as unknown as GitRunner, run }
}

function makeManager(opts: {
  runner: GitRunner
  registry: ReturnType<typeof fakeRegistry>['registry']
  sessionCwd?: string
  /** Session ids the fake session store reports as live. */
  liveSessions?: string[]
}) {
  const ctx = {
    workspaceRegistry: opts.registry,
    sessions: {
      get: (id: string) => {
        if (id === 'session-lane-1' && opts.sessionCwd !== undefined) return { header: { cwd: opts.sessionCwd } }
        if ((opts.liveSessions ?? []).includes(id)) return { header: {} }
        return undefined
      },
    },
  }
  return new WorktreeManager(ctx as never, { runner: opts.runner })
}

const tempRoots: string[] = []
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wt-lane-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

async function readManifest(root: string) {
  return JSON.parse(await readFile(manifestPath(root), 'utf8')) as {
    worktrees: Array<Record<string, unknown>>
  }
}

// ─── create / ensureLane ─────────────────────────────────────────────────────

describe('lane create', () => {
  it('cuts the branch, records detached=false and a real head', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })

    const view = await manager.create({ repoPath: root, branch: 'feature/x', base: 'origin/dev' })

    expect(view.branch).toBe('feature/x')
    expect(view.exists).toBe(true)
    const addCall = faux.run.mock.calls.find(([argv]) => argv.join(' ').startsWith('worktree add'))
    expect(addCall?.[0]).toEqual([
      'worktree', 'add', '-b', 'feature/x', worktreeDir(root, 'feature/x'), 'origin/dev',
    ])
    const manifest = await readManifest(root)
    expect(manifest.worktrees).toHaveLength(1)
    expect(manifest.worktrees[0]?.['detached']).toBe(false)
    expect(manifest.worktrees[0]?.['baseCommit']).toBe(SHA)
  })

  it('refuses when the branch already exists', async () => {
    const root = await makeRoot()
    // Pre-existing branch: the guard must fire before any `worktree add`.
    const run = vi.fn(async (argv: readonly string[]): Promise<GitRunResult> => {
      const joined = argv.join(' ')
      if (joined.includes('--git-common-dir')) return { exitCode: 0, stdout: join(root, '.git'), stderr: '' }
      if (argv[0] === 'check-ignore') return { exitCode: 0, stdout: '', stderr: '' }
      if (joined.includes('rev-parse --verify --quiet refs/heads/')) return { exitCode: 0, stdout: SHA, stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: { run } as unknown as GitRunner, registry })

    await expect(manager.create({ repoPath: root, branch: 'dev' }))
      .rejects.toMatchObject({ code: 'worktree-exists' })
    expect(run.mock.calls.some(([argv]) => argv.join(' ').startsWith('worktree add'))).toBe(false)
  })

  it('refuses when the lane root is not ignored', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git'), ignored: false })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })

    await expect(manager.create({ repoPath: root, branch: 'feature/x' }))
      .rejects.toMatchObject({ code: 'worktree-not-ignored' })
    expect(faux.run.mock.calls.some(([argv]) => argv.join(' ').startsWith('worktree add'))).toBe(false)
  })

  it('ensureLane cuts a new branch and registers its workspace', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry, workspaces } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })

    const lane = await manager.ensureLane({ repoPath: root, branch: 'feature/x' })

    expect(lane).toMatchObject({ name: 'feature/x', branch: 'feature/x', created: true })
    expect(lane.path).toBe(worktreeDir(root, 'feature/x'))
    // The platform accounts a session to a workspace only while its cwd equals
    // that workspace's path, and a blank conversation no workspace accounts for
    // renders its composer inert: the lane directory has to be a workspace.
    expect(lane.workspaceId).not.toBeNull()
    expect(workspaces.get(String(lane.workspaceId))?.path).toBe(worktreeDir(root, 'feature/x'))
    const manifest = await readManifest(root)
    expect(manifest.worktrees).toHaveLength(1)
    expect(manifest.worktrees[0]?.['workspaceId']).toBe(lane.workspaceId)
  })

  it('reuses the lane workspace instead of registering a second one', async () => {
    const root = await makeRoot()
    const lane = worktreeDir(root, 'feature/x')
    await mkdir(lane, { recursive: true })
    const faux = fakeRunner({
      commonDir: join(root, '.git'),
      porcelain: `worktree ${root}\nHEAD ${SHA}\nbranch refs/heads/dev\n\nworktree ${lane}\nHEAD ${SHA}\nbranch refs/heads/feature/x\n\n`,
    })
    const { registry, workspaces } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })

    const first = await manager.ensureLane({ repoPath: root, branch: 'feature/x' })
    const again = await manager.ensureLane({ repoPath: root, branch: 'feature/x' })

    expect(first.created).toBe(false)
    expect(again.created).toBe(false)
    expect(again.workspaceId).toBe(first.workspaceId)
    expect(workspaces.size).toBe(1)
  })

  it('reports a lane without a workspace when the registry refuses', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry({ createFails: true })
    const manager = makeManager({ runner: faux.runner, registry })

    const lane = await manager.ensureLane({ repoPath: root, branch: 'feature/x' })

    // The worktree is real; only the "move the conversation here" half is
    // missing, and the browser refuses to claim it moved.
    expect(lane.workspaceId).toBeNull()
    expect(lane.path).toBe(worktreeDir(root, 'feature/x'))
  })

  it('ensureLane ATTACHES an existing branch instead of inventing a new one', async () => {
    const root = await makeRoot()
    // The branch already exists: git must check it out, not `-b` it again.
    const faux = fakeRunner({ commonDir: join(root, '.git'), existingBranches: ['dev'] })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })

    const lane = await manager.ensureLane({ repoPath: root, branch: 'dev' })

    const addCall = faux.run.mock.calls.find(([argv]) => argv.join(' ').startsWith('worktree add'))
    expect(addCall?.[0]).toEqual(['worktree', 'add', worktreeDir(root, 'dev'), 'dev'])
    expect(lane.branch).toBe('dev')
  })

  it('ensureLane is idempotent and reuses a lane that already exists', async () => {
    const root = await makeRoot()
    const lane = worktreeDir(root, 'feature/x')
    const faux = fakeRunner({
      commonDir: join(root, '.git'),
      porcelain: `worktree ${root}\nHEAD ${SHA}\nbranch refs/heads/dev\n\nworktree ${lane}\nHEAD ${SHA}\nbranch refs/heads/feature/x\n\n`,
    })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })
    await mkdir(lane, { recursive: true })

    const again = await manager.ensureLane({ repoPath: root, branch: 'feature/x' })

    expect(again).toMatchObject({ branch: 'feature/x', created: false })
    expect(faux.run.mock.calls.some(([argv]) => argv.join(' ').startsWith('worktree add'))).toBe(false)
  })

  it('rollbackCreate removes the lane and leaves no manifest entry', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })
    await manager.ensureLane({ repoPath: root, branch: 'feature/x' })

    await manager.rollbackCreate({ repoPath: root, name: 'feature/x' })

    const joined = faux.run.mock.calls.map(([argv]) => argv.join(' '))
    expect(joined.some((line) => line.startsWith('worktree remove'))).toBe(true)
    expect(joined.some((line) => line.startsWith('branch -D'))).toBe(true)
    expect(joined.some((line) => line.includes('worktree prune'))).toBe(true)
    const manifest = await readManifest(root)
    expect(manifest.worktrees).toHaveLength(0)
  })

  it('rollbackCreate is idempotent on an already-clean repo', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })

    await expect(manager.rollbackCreate({ repoPath: root, name: 'feature/x' })).resolves.toBeUndefined()
  })

  it('unregisters the lane workspace when a lane is removed', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry, workspaces, deleted } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry, liveSessions: [] })
    const lane = await manager.ensureLane({ repoPath: root, branch: 'feature/x' })

    await manager.remove({ repoPath: root, name: 'feature/x' })

    // The lookup has to happen before the directory is deleted, or the sidebar
    // keeps a row for a path that no longer exists.
    expect(deleted).toEqual([lane.workspaceId])
    expect(workspaces.size).toBe(0)
  })

  it('lets the lane own conversation remove itself and archives it', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry, archived, archiveOptions_stopActivity } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry, liveSessions: ['session-lane-1'] })
    await manager.ensureLane({ repoPath: root, branch: 'feature/x' })
    await manager.bindSession(root, 'feature/x', 'session-lane-1' as never, true)

    // The header chip is the only surface left once the conversation is gone,
    // so the conversation sitting on the lane may tear its own lane down.
    await expect(manager.remove({ repoPath: root, name: 'feature/x', sessionId: 'session-lane-1' }))
      .resolves.toMatchObject({ name: 'feature/x' })
    expect(archived).toEqual(['session-lane-1'])
    // DSH 0.2 refuses to archive a session that reports active work unless the
    // caller asks the activity owners to stop; the teardown must do that.
    expect(archiveOptions_stopActivity).toEqual([true])
  })

  it('refuses to remove a lane whose bound session is still live', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry, liveSessions: ['session-lane-1'] })
    await manager.ensureLane({ repoPath: root, branch: 'feature/x' })
    await manager.bindSession(root, 'feature/x', 'session-lane-1' as never, true)

    // The lane registers no workspace, so the manifest binding is the only
    // thing standing between a running conversation and a deleted directory.
    await expect(manager.remove({ repoPath: root, name: 'feature/x' }))
      .rejects.toMatchObject({ code: 'worktree-busy' })
  })

  it('refuses to clean up a lane whose bound session is still live', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry, liveSessions: ['session-lane-1'] })
    await manager.ensureLane({ repoPath: root, branch: 'feature/x' })
    await manager.bindSession(root, 'feature/x', 'session-lane-1' as never, true)

    await expect(manager.cleanup({ repoPath: root, name: 'feature/x', force: true }))
      .rejects.toMatchObject({ code: 'worktree-busy' })
  })

  it('archives a lane\'s bound session when the lane is removed', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry, archived } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry, liveSessions: [] })
    await manager.ensureLane({ repoPath: root, branch: 'feature/x' })
    await manager.bindSession(root, 'feature/x', 'session-lane-1' as never, true)

    await manager.remove({ repoPath: root, name: 'feature/x' })

    // The conversation must not keep pointing at a deleted directory.
    expect(archived).toEqual(['session-lane-1'])
  })

  it('removes a lane once its bound session is gone', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry, liveSessions: [] })
    await manager.ensureLane({ repoPath: root, branch: 'feature/x' })
    await manager.bindSession(root, 'feature/x', 'session-lane-1' as never, true)

    await expect(manager.remove({ repoPath: root, name: 'feature/x' }))
      .resolves.toMatchObject({ name: 'feature/x' })
  })

  it('bindSession records the session on the lane entry', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })

    await manager.ensureLane({ repoPath: root, branch: 'feature/x' })
    await manager.bindSession(root, 'feature/x', 'session-lane-1' as never, true)

    const manifest = await readManifest(root)
    expect(manifest.worktrees[0]?.['sessionId']).toBe('session-lane-1')
    expect(manifest.worktrees[0]?.['permissionPresetApplied']).toBe(true)
  })

  it('laneEntry answers only for a lane the manifest records', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })

    // A directory that exists but that the manifest does not know about is not a
    // lane the host recorded, so it must not authorize a binding.
    await mkdir(worktreeDir(root, 'ghost/x'), { recursive: true })
    expect(await manager.laneEntry(root, 'ghost/x')).toBeNull()

    await manager.ensureLane({ repoPath: root, branch: 'feature/x' })
    expect(await manager.laneEntry(root, 'feature/x')).toMatchObject({ path: worktreeDir(root, 'feature/x') })

    // A name that could climb out of the lane root never resolves at all.
    await expect(manager.laneEntry(root, '../escape')).rejects.toMatchObject({ code: 'invalid-branch' })
  })
})

// ─── mutation guards ─────────────────────────────────────────────────────────

/**
 * Adversarial pass over the mutations that can destroy work. Each one was
 * reachable with arguments the UI never sends; each must refuse before it runs
 * a single destructive git step.
 */
describe('mutation guards', () => {
  it('rollback refuses while a live session still works in the lane', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry, liveSessions: ['session-lane-1'] })
    await manager.ensureLane({ repoPath: root, branch: 'feature/x' })
    await manager.bindSession(root, 'feature/x', 'session-lane-1' as never, true)
    faux.run.mockClear()

    await expect(manager.rollbackCreate({ repoPath: root, name: 'feature/x' }))
      .rejects.toMatchObject({ code: 'worktree-busy' })

    const ran = faux.run.mock.calls.map((call) => (call[0] as string[]).join(' '))
    expect(ran.filter((line) => line.includes('worktree remove') || line.startsWith('branch'))).toEqual([])
    expect((await readManifest(root)).worktrees).toHaveLength(1)
  })

  it('cleanup refuses a branch the manifest does not record', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git'), existingBranches: ['ghost'] })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })
    faux.run.mockClear()

    await expect(manager.cleanup({ repoPath: root, name: 'ghost', force: true }))
      .rejects.toMatchObject({ code: 'worktree-not-found' })

    const ran = faux.run.mock.calls.map((call) => (call[0] as string[]).join(' '))
    expect(ran.filter((line) => line.startsWith('branch'))).toEqual([])
  })

  it('still tears down a recorded lane whose directory was deleted', async () => {
    // The orphan case the missing-directory tolerance exists for: the host
    // recorded the lane, someone removed the directory by hand.
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })
    await manager.ensureLane({ repoPath: root, branch: 'feature/x' })
    await rm(worktreeDir(root, 'feature/x'), { recursive: true, force: true })

    await expect(manager.cleanup({ repoPath: root, name: 'feature/x', force: true }))
      .resolves.toMatchObject({ name: 'feature/x' })
    expect((await readManifest(root)).worktrees).toHaveLength(0)
  })

  it('init refuses a directory that is not a registered workspace', async () => {
    const root = await makeRoot()
    const faux = fakeRunner()
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })

    await expect(manager.init({ repoPath: root })).rejects.toMatchObject({ code: 'workspace-unknown' })

    const ran = faux.run.mock.calls.map((call) => (call[0] as string[]).join(' '))
    expect(ran.filter((line) => line.startsWith('init'))).toEqual([])
  })

  it('still converts a registered workspace', async () => {
    const root = await makeRoot()
    const faux = fakeRunner()
    const { registry } = fakeRegistry()
    await registry.create(root)
    const manager = makeManager({ runner: faux.runner, registry })

    await expect(manager.init({ repoPath: root })).resolves.toMatchObject({ repoPath: root })
  })
})

// ─── laneForPath ─────────────────────────────────────────────────────────────

describe('laneForPath', () => {
  /** Porcelain fixture: main checkout + one linked lane. */
  function porcelain(root: string, lanePath: string): string {
    return `worktree ${root}\nHEAD ${SHA}\nbranch refs/heads/dev\n\n`
      + `worktree ${lanePath}\nHEAD ${SHA}\nbranch refs/heads/feature/x\n\n`
  }

  it('returns null for the main checkout', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })

    expect(await manager.laneForPath({ path: root })).toBeNull()
  })

  it('returns null for a path outside the lane root', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })

    expect(await manager.laneForPath({ path: join(root, 'packages') })).toBeNull()
  })

  it('resolves a lane by path with dirty count and cheap status', async () => {
    const root = await makeRoot()
    const lane = worktreeDir(root, 'feature/x')
    const faux = fakeRunner({
      commonDir: join(root, '.git'),
      porcelain: porcelain(root, lane),
      dirtyLines: 3,
      remoteRefs: { 'feature/x': 0 },
      mergeBaseOk: true,
    })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })
    await manager.ensureLane({ repoPath: root, branch: 'feature/x' })
    await manager.bindSession(root, 'feature/x', 'session-lane-1' as never, true)

    const view = await manager.laneForPath({ path: lane })

    expect(view).toMatchObject({
      name: 'feature/x',
      branch: 'feature/x',
      path: lane,
      repoPath: root,
      exists: true,
      sessionId: 'session-lane-1',
      permissionPresetApplied: true,
      dirty: 3,
      pushed: true,
      merged: true,
      // Network-free by design: the deleted-remote-branch signal stays with the panel probe.
      remoteBranchGone: false,
    })
  })

  it('resolves the lane a conversation carries while its cwd is the main checkout', async () => {
    // A conversation with history cannot move its cwd: it binds the lane on
    // the manifest instead. laneForPath must find it by the binding, so the
    // header chip and the lane tool still see it.
    const root = await makeRoot()
    const lane = worktreeDir(root, 'feature/x')
    const faux = fakeRunner({ commonDir: join(root, '.git'), porcelain: porcelain(root, lane) })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry, sessionCwd: root })
    await manager.ensureLane({ repoPath: root, branch: 'feature/x' })
    await manager.bindSession(root, 'feature/x', 'session-lane-1' as never, true)

    const view = await manager.laneForPath({ sessionId: 'session-lane-1' })

    expect(view?.path).toBe(lane)
    expect(view?.branch).toBe('feature/x')
    expect(view?.sessionId).toBe('session-lane-1')
  })

  it('resolves a lane from a session id when no path is given', async () => {
    const root = await makeRoot()
    const lane = worktreeDir(root, 'feature/x')
    const faux = fakeRunner({ commonDir: join(root, '.git'), porcelain: porcelain(root, lane) })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry, sessionCwd: lane })
    await mkdir(lane, { recursive: true })

    const view = await manager.laneForPath({ sessionId: 'session-lane-1' })

    expect(view?.path).toBe(lane)
    expect(view?.pushed).toBe(false)
    expect(view?.merged).toBe(false)
  })

  it('returns null for a session the host cannot resolve', async () => {
    const root = await makeRoot()
    const faux = fakeRunner({ commonDir: join(root, '.git') })
    const { registry } = fakeRegistry()
    const manager = makeManager({ runner: faux.runner, registry })

    expect(await manager.laneForPath({ sessionId: 'session-unknown' })).toBeNull()
  })
})