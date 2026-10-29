/**
 * Lane-workspace lifetime: a lane's directory must be a registered workspace
 * while its conversation runs (the platform accounts a session to a workspace
 * only when the session cwd equals that workspace's path, and a blank
 * conversation no workspace accounts for has an inert composer), so the sidebar
 * row cannot be avoided. It must not outlive the conversation either.
 *
 * These tests pin both halves of that lifetime: the archive-driven retirement
 * (including the paths that must NOT retire), the boot reconciliation for rows an
 * earlier build left behind, and the event wiring that turns an archive into a
 * retirement. Runs through injected fakes — no real git, no cordis runtime.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WorktreeManager } from '../src/host/services/worktree/manager.ts'
import { installLaneWorkspaceRetirement, type LaneRetirementManager } from '../src/host/services/worktree/index.ts'
import type { GitRunResult, GitRunner } from '../src/host/services/worktree/git-runner.ts'
import { manifestPath } from '../src/core/worktree/manifest.ts'
import { worktreeDir, worktreeRoot } from '../src/core/worktree/paths.ts'

const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const LANE_SESSION = 'session-lane'
const OTHER_SESSION = 'session-other'

interface FakeWorkspace {
  id: string
  path: string
  sessionIds: string[]
}

const tempRoots: string[] = []
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wt-retire-'))
  tempRoots.push(root)
  return root
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Write the v2 manifest the manager reads for one repo root. */
async function writeLaneManifest(root: string, entries: Array<Record<string, unknown>>): Promise<void> {
  await mkdir(worktreeRoot(root), { recursive: true })
  await writeFile(manifestPath(root), JSON.stringify({
    version: 2,
    repoPath: root,
    worktrees: entries.map((entry) => ({
      baseCommit: SHA,
      createdAt: new Date(0).toISOString(),
      detached: false,
      ...entry,
    })),
  }), 'utf8')
}

async function readManifestEntries(root: string): Promise<Array<Record<string, unknown>>> {
  const parsed = JSON.parse(await readFile(manifestPath(root), 'utf8')) as { worktrees: Array<Record<string, unknown>> }
  return parsed.worktrees
}

/** Manager plus the registry face it retires through. */
function harness(options: {
  root: string
  workspaces?: FakeWorkspace[]
  archived?: string[]
  /** cwd the fake session store reports for `LANE_SESSION`. */
  laneCwd?: string
}) {
  const { root } = options
  const archived = new Set(options.archived ?? [])
  const workspaces = new Map((options.workspaces ?? []).map((ws) => [ws.id, ws]))
  const deleted: string[] = []
  const registry = {
    list: () => [...workspaces.values()],
    resolveByPath: async (path: string) => [...workspaces.values()].find((ws) => ws.path === path),
    delete: async (id: string) => { deleted.push(id); workspaces.delete(id); return true },
    get archivedSessionIds(): string[] { return [...archived] },
  }
  const ctx = {
    workspaceRegistry: registry,
    sessions: {
      get: (id: string) => (id === LANE_SESSION && options.laneCwd !== undefined
        ? { header: { cwd: options.laneCwd } }
        : undefined),
    },
  }
  const run = vi.fn(async (argv: readonly string[], cwd: string): Promise<GitRunResult> => {
    if (argv.join(' ').includes('--git-common-dir')) {
      // Only a path inside the repo resolves, so a workspace elsewhere stays
      // outside this repo's lane root.
      return cwd.startsWith(root)
        ? { exitCode: 0, stdout: join(root, '.git'), stderr: '' }
        : { exitCode: 128, stdout: '', stderr: 'not a repository' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  })
  const manager = new WorktreeManager(ctx as never, { runner: { run } as unknown as GitRunner })
  return { manager, registry, archived, workspaces, deleted }
}

describe('retireArchivedLane', () => {
  it('retires the lane workspace of an archived conversation and keeps the lane itself', async () => {
    const root = await makeRoot()
    const lane = worktreeDir(root, 'feature/x')
    await mkdir(lane, { recursive: true })
    await writeLaneManifest(root, [{ name: 'feature/x', path: lane, sessionId: LANE_SESSION, workspaceId: 'ws-lane' }])
    const h = harness({
      root,
      laneCwd: lane,
      archived: [LANE_SESSION],
      workspaces: [{ id: 'ws-lane', path: lane, sessionIds: [LANE_SESSION] }],
    })

    await expect(h.manager.retireArchivedLane(LANE_SESSION, { attempts: 1 })).resolves.toBe(true)

    // The registration is gone (so the sidebar row is gone)…
    expect(h.deleted).toEqual(['ws-lane'])
    expect(h.workspaces.size).toBe(0)
    // …while everything the user made survives: the directory, the manifest
    // entry, the branch record and the session binding.
    const [entry] = await readManifestEntries(root)
    expect(entry?.['path']).toBe(lane)
    expect(entry?.['sessionId']).toBe(LANE_SESSION)
    expect(entry?.['workspaceId']).toBeUndefined()
  })

  it('leaves the row while the conversation is still live', async () => {
    const root = await makeRoot()
    const lane = worktreeDir(root, 'feature/x')
    await mkdir(lane, { recursive: true })
    await writeLaneManifest(root, [{ name: 'feature/x', path: lane, sessionId: LANE_SESSION, workspaceId: 'ws-lane' }])
    const h = harness({
      root,
      laneCwd: lane,
      workspaces: [{ id: 'ws-lane', path: lane, sessionIds: [LANE_SESSION] }],
    })

    await expect(h.manager.retireArchivedLane(LANE_SESSION, { attempts: 1 })).resolves.toBe(false)

    expect(h.deleted).toEqual([])
    expect(h.workspaces.size).toBe(1)
  })

  it('keeps the row while another conversation in the same lane is live', async () => {
    const root = await makeRoot()
    const lane = worktreeDir(root, 'feature/x')
    await mkdir(lane, { recursive: true })
    await writeLaneManifest(root, [{ name: 'feature/x', path: lane, sessionId: LANE_SESSION, workspaceId: 'ws-lane' }])
    const h = harness({
      root,
      laneCwd: lane,
      archived: [LANE_SESSION],
      workspaces: [{ id: 'ws-lane', path: lane, sessionIds: [LANE_SESSION, OTHER_SESSION] }],
    })

    // Retiring the workspace under a live conversation would take its composer
    // away (a blank session with no workspace is inert), so the row stays.
    await expect(h.manager.retireArchivedLane(LANE_SESSION, { attempts: 1 })).resolves.toBe(false)
    expect(h.deleted).toEqual([])
  })

  it('ignores an archived conversation that no lane records', async () => {
    const root = await makeRoot()
    const lane = worktreeDir(root, 'feature/x')
    await mkdir(lane, { recursive: true })
    await writeLaneManifest(root, [{ name: 'feature/x', path: lane, sessionId: OTHER_SESSION, workspaceId: 'ws-lane' }])
    const h = harness({
      root,
      laneCwd: lane,
      archived: [LANE_SESSION],
      workspaces: [{ id: 'ws-lane', path: lane, sessionIds: [OTHER_SESSION] }],
    })

    await expect(h.manager.retireArchivedLane(LANE_SESSION, { attempts: 1 })).resolves.toBe(false)
    expect(h.deleted).toEqual([])
  })

  it('is a no-op for a lane whose directory is no longer a workspace', async () => {
    const root = await makeRoot()
    const lane = worktreeDir(root, 'feature/x')
    await mkdir(lane, { recursive: true })
    await writeLaneManifest(root, [{ name: 'feature/x', path: lane, sessionId: LANE_SESSION, workspaceId: 'ws-gone' }])
    const h = harness({ root, laneCwd: lane, archived: [LANE_SESSION] })

    await expect(h.manager.retireArchivedLane(LANE_SESSION, { attempts: 1 })).resolves.toBe(false)
    expect(h.deleted).toEqual([])
  })

  it('waits for the archive set to show the session before retiring', async () => {
    // The activity waterfall runs BEFORE the durable archive write, so the
    // retirement polls: the archive lands on the second look.
    const root = await makeRoot()
    const lane = worktreeDir(root, 'feature/x')
    await mkdir(lane, { recursive: true })
    await writeLaneManifest(root, [{ name: 'feature/x', path: lane, sessionId: LANE_SESSION, workspaceId: 'ws-lane' }])
    const h = harness({
      root,
      laneCwd: lane,
      workspaces: [{ id: 'ws-lane', path: lane, sessionIds: [LANE_SESSION] }],
    })
    setTimeout(() => { h.archived.add(LANE_SESSION) }, 10)

    await expect(h.manager.retireArchivedLane(LANE_SESSION, { attempts: 20, pollMs: 10 })).resolves.toBe(true)
    expect(h.deleted).toEqual(['ws-lane'])
  })
})

describe('reconcileLaneWorkspaces', () => {
  it('retires archived lanes left behind and keeps every other workspace', async () => {
    const root = await makeRoot()
    const staleLane = worktreeDir(root, 'feature/stale')
    const liveLane = worktreeDir(root, 'feature/live')
    const unrecordedLane = worktreeDir(root, 'feature/unrecorded')
    for (const dir of [staleLane, liveLane, unrecordedLane]) await mkdir(dir, { recursive: true })
    await writeLaneManifest(root, [
      { name: 'feature/stale', path: staleLane, sessionId: LANE_SESSION, workspaceId: 'ws-stale' },
      { name: 'feature/live', path: liveLane, sessionId: OTHER_SESSION, workspaceId: 'ws-live' },
      { name: 'feature/unrecorded', path: unrecordedLane, workspaceId: 'ws-unrecorded' },
    ])
    const h = harness({
      root,
      laneCwd: staleLane,
      archived: [LANE_SESSION],
      workspaces: [
        // The repo itself: a real workspace that is not a lane.
        { id: 'ws-repo', path: root, sessionIds: [] },
        // A lane whose conversation was archived while the plugin was absent.
        { id: 'ws-stale', path: staleLane, sessionIds: [LANE_SESSION] },
        // A lane with a live conversation.
        { id: 'ws-live', path: liveLane, sessionIds: [OTHER_SESSION] },
        // A lane the manifest does not record a conversation for.
        { id: 'ws-unrecorded', path: unrecordedLane, sessionIds: [] },
      ],
    })

    await expect(h.manager.reconcileLaneWorkspaces()).resolves.toBe(1)

    expect(h.deleted).toEqual(['ws-stale'])
    expect([...h.workspaces.keys()].sort()).toEqual(['ws-live', 'ws-repo', 'ws-unrecorded'])
  })

  it('leaves a workspace outside the lane root alone', async () => {
    const root = await makeRoot()
    const elsewhere = await makeRoot()
    const h = harness({
      root,
      archived: [LANE_SESSION],
      workspaces: [{ id: 'ws-other', path: elsewhere, sessionIds: [LANE_SESSION] }],
    })

    await expect(h.manager.reconcileLaneWorkspaces()).resolves.toBe(0)
    expect(h.deleted).toEqual([])
  })
})

describe('lane retirement wiring', () => {
  /** Context capturing the event listeners and the injected boot pass. */
  function wiring() {
    const listeners = new Map<string, (...args: never[]) => unknown>()
    const offs: string[] = []
    const injected: Array<() => unknown> = []
    const ctx = {
      on: (name: string, listener: (...args: never[]) => unknown) => {
        listeners.set(name, listener)
        return () => { offs.push(name) }
      },
      inject: (_deps: readonly string[], callback: () => unknown) => { injected.push(callback) },
    } as unknown as Context
    return { ctx, listeners, offs, injected }
  }

  function fakeManager(overrides: Partial<LaneRetirementManager> = {}): LaneRetirementManager {
    return {
      retireArchivedLane: vi.fn(async () => true),
      reconcileLaneWorkspaces: vi.fn(async () => 0),
      ...overrides,
    }
  }

  it('retires on both archive paths, and only when the archive can land', async () => {
    const wire = wiring()
    const manager = fakeManager()
    const dispose = installLaneWorkspaceRetirement(wire.ctx, manager)

    const activity = wire.listeners.get('workspace/session-activity') as unknown as (
      request: { sessionId: string },
      next: () => Promise<readonly unknown[]>,
    ) => Promise<readonly unknown[]>
    // Nothing running: the archive will land, so the lane is retired.
    await expect(activity({ sessionId: LANE_SESSION }, async () => [])).resolves.toEqual([])
    expect(manager.retireArchivedLane).toHaveBeenCalledWith(LANE_SESSION)
    // Running work: the archive is refused, and nothing is retired.
    vi.mocked(manager.retireArchivedLane).mockClear()
    await expect(activity({ sessionId: OTHER_SESSION }, async () => [{ kind: 'turn' }]))
      .resolves.toEqual([{ kind: 'turn' }])
    expect(manager.retireArchivedLane).not.toHaveBeenCalled()

    // A forced archive dispatches `workspace/session-stop` once it is durable.
    const stop = wire.listeners.get('workspace/session-stop') as unknown as (request: { sessionId: string }) => void
    stop({ sessionId: OTHER_SESSION })
    expect(manager.retireArchivedLane).toHaveBeenCalledWith(OTHER_SESSION)

    dispose()
    expect(wire.offs.sort()).toEqual(['workspace/session-activity', 'workspace/session-stop'])
  })

  it('never throws into the archive path when a retirement fails', async () => {
    const wire = wiring()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const manager = fakeManager({ retireArchivedLane: vi.fn(async () => { throw new Error('boom') }) })
    installLaneWorkspaceRetirement(wire.ctx, manager)

    const stop = wire.listeners.get('workspace/session-stop') as unknown as (request: { sessionId: string }) => void
    expect(() => { stop({ sessionId: LANE_SESSION }) }).not.toThrow()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(warn).toHaveBeenCalledWith('[dsh-worktree] lane workspace retirement failed:', expect.any(Error))
  })

  it('reconciles the rows an earlier build left behind once the registry exists', async () => {
    const wire = wiring()
    const manager = fakeManager()
    installLaneWorkspaceRetirement(wire.ctx, manager)

    expect(manager.reconcileLaneWorkspaces).not.toHaveBeenCalled()
    for (const callback of wire.injected) callback()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(manager.reconcileLaneWorkspaces).toHaveBeenCalledTimes(1)
  })
})