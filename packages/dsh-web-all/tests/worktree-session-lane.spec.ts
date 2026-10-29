/**
 * Unit tests for session-lane orchestration: the two host-side phases.
 *
 * Phase 1 (`createLane`) ensures the branch's worktree and registers NOTHING —
 * a lane binds to a session, never to the workspace list. Phase 2
 * (`bindLaneSession`) records the binding and applies the preset.
 *
 * The git layer is stubbed on purpose — its own behavior is covered by
 * worktree-lane-create.spec.ts. This file owns the orchestration contract.
 */

import { describe, expect, it } from 'vitest'
import type { WorktreeManager } from '../src/host/services/worktree/manager.ts'
import {
  LANE_PERMISSION_PRESET, SessionLaneManager,
} from '../src/host/services/worktree/session-lane/manager.ts'

const LANE = {
  name: 'feature/x',
  branch: 'feature/x',
  path: '/repo/.dsh/workspaces/feature/x',
  head: 'deadbee',
  created: true,
}

/**
 * Structural WorktreeManager stub recording the orchestration order.
 *
 * `sessionLanePath` is what the session's own cwd resolves to; `recordedPath`
 * is what the manifest records for the requested branch; `recorded: false`
 * makes the manifest know no such lane. The bind must name a lane the manifest
 * records AND that the conversation is actually running in.
 */
function fakeWorktrees(options: {
  createFails?: boolean
  recorded?: boolean
  recordedPath?: string
  sessionLanePath?: string
} = {}) {
  const calls: string[] = []
  const expected = '/repo/.dsh/workspaces/feature/x'
  const worktrees = {
    ensureLane: async (input: { branch: string }) => {
      calls.push(`lane:${input.branch}`)
      if (options.createFails === true) throw new Error('lane already exists')
      return LANE
    },
    laneEntry: async () => (
      options.recorded === false ? null : { root: '/repo', path: options.recordedPath ?? expected }
    ),
    bindSession: async (
      _repo: string,
      name: string,
      sessionId: string,
      permissionPresetApplied: boolean,
    ) => {
      calls.push(`bind:${name}:${sessionId}:${permissionPresetApplied}`)
    },
    laneForPath: async () => ({
      name: 'feature/x',
      branch: 'feature/x',
      path: options.sessionLanePath ?? expected,
      repoPath: '/repo',
    } as never),
  } as unknown as WorktreeManager
  return { worktrees, calls }
}

function fakeCtx(options: { session?: unknown; presets?: unknown } = {}) {
  const services: Record<string, unknown> = {}
  if (options.session !== undefined) services['sessions'] = { get: () => options.session }
  if (options.presets !== undefined) services['permissionPresets'] = options.presets
  return {
    get: (name: string) => services[name],
    // The manager registers an optional inject for the preset service; these
    // tests supply it through ctx.get instead.
    inject: () => {},
  } as never
}

describe('SessionLaneManager.createLane', () => {
  it('creates the worktree + workspace and returns them, without a session', async () => {
    const { worktrees, calls } = fakeWorktrees()
    const lanes = new SessionLaneManager(fakeCtx(), worktrees)

    const result = await lanes.createLane({ repoPath: '/repo', branch: 'feature/x', base: 'origin/dev' })

    expect(calls).toEqual(['lane:feature/x'])
    expect(result).toEqual(LANE)
  })

  it('propagates a worktree failure', async () => {
    const { worktrees, calls } = fakeWorktrees({ createFails: true })
    const lanes = new SessionLaneManager(fakeCtx(), worktrees)

    await expect(lanes.createLane({ repoPath: '/repo', branch: 'feature/x' }))
      .rejects.toThrow('lane already exists')
    expect(calls).toEqual(['lane:feature/x'])
  })
})

describe('SessionLaneManager.bindLaneSession', () => {
  it('binds the platform-created session and records that the preset applied', async () => {
    const { worktrees, calls } = fakeWorktrees()
    const applied: Array<[string, string]> = []
    const lanes = new SessionLaneManager(fakeCtx(), worktrees, {
      hasSession: () => true,
      setPermissionPreset: (sessionId, preset) => { applied.push([sessionId, preset]) },
    })

    const result = await lanes.bindLaneSession({
      repoPath: '/repo', branch: 'feature/x', sessionId: 'session-1',
    })

    expect(applied).toEqual([['session-1', LANE_PERMISSION_PRESET]])
    expect(calls).toEqual(['bind:feature/x:session-1:true'])
    expect(result.permissionPresetApplied).toBe(true)
  })

  it('refuses a conversation that is not running in the directory it names', async () => {
    const { worktrees, calls } = fakeWorktrees({ sessionLanePath: '/repo/.dsh/workspaces/other' })
    const applied: Array<[string, string]> = []
    const lanes = new SessionLaneManager(fakeCtx(), worktrees, {
      hasSession: () => true,
      setPermissionPreset: (sessionId, preset) => { applied.push([sessionId, preset]) },
    })

    await expect(lanes.bindLaneSession({ repoPath: '/repo', branch: 'feature/x', sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'lane-mismatch' })
    // Nothing may happen to a conversation the request does not describe: no
    // manifest entry, and above all no access elevation.
    expect(applied).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses a lane the manifest does not record, before elevating anything', async () => {
    const { worktrees, calls } = fakeWorktrees({ recorded: false })
    const applied: Array<[string, string]> = []
    const lanes = new SessionLaneManager(fakeCtx(), worktrees, {
      hasSession: () => true,
      setPermissionPreset: (sessionId, preset) => { applied.push([sessionId, preset]) },
    })

    await expect(lanes.bindLaneSession({ repoPath: '/repo', branch: 'feature/x', sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'worktree-not-found' })
    // A lane that only exists on disk is not a lane the host recorded, so no
    // elevation and no write may follow from the request.
    expect(applied).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses an invalid branch before touching the session', async () => {
    const { worktrees, calls } = fakeWorktrees()
    const applied: Array<[string, string]> = []
    const lanes = new SessionLaneManager(fakeCtx(), worktrees, {
      hasSession: () => true,
      setPermissionPreset: (sessionId, preset) => { applied.push([sessionId, preset]) },
    })

    await expect(lanes.bindLaneSession({ repoPath: '/repo', branch: '../escape', sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'invalid-branch' })
    expect(applied).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses a session the host cannot see', async () => {
    const { worktrees, calls } = fakeWorktrees()
    const lanes = new SessionLaneManager(fakeCtx(), worktrees, { hasSession: () => false })

    await expect(lanes.bindLaneSession({ repoPath: '/repo', branch: 'feature/x', sessionId: 'ghost' }))
      .rejects.toMatchObject({ code: 'session-unknown' })
    expect(calls).toEqual([])
  })

  it('still binds, and reports false, when the preset cannot be applied', async () => {
    const { worktrees, calls } = fakeWorktrees()
    const lanes = new SessionLaneManager(fakeCtx(), worktrees, {
      hasSession: () => true,
      setPermissionPreset: () => { throw new Error('session not in store') },
    })

    const result = await lanes.bindLaneSession({
      repoPath: '/repo', branch: 'feature/x', sessionId: 'session-1',
    })

    // The lane stays usable and the chip can say the access mode is missing.
    expect(result.permissionPresetApplied).toBe(false)
    expect(calls).toEqual(['bind:feature/x:session-1:false'])
  })

  it('reports false when the deployment has no preset service at all', async () => {
    const { worktrees } = fakeWorktrees()
    const lanes = new SessionLaneManager(fakeCtx({ session: { id: 'session-1' } }), worktrees, {
      hasSession: () => true,
    })

    const result = await lanes.bindLaneSession({
      repoPath: '/repo', branch: 'feature/x', sessionId: 'session-1',
    })

    expect(result.permissionPresetApplied).toBe(false)
  })

  it('applies the preset through the live session object and the preset service', async () => {
    const { worktrees } = fakeWorktrees()
    const session = { header: { cwd: LANE.path } }
    const applied: Array<[unknown, string]> = []
    const lanes = new SessionLaneManager(
      fakeCtx({ session, presets: { set: (target: unknown, name: string) => { applied.push([target, name]) } } }),
      worktrees,
      { hasSession: () => true },
    )

    const result = await lanes.bindLaneSession({
      repoPath: '/repo', branch: 'feature/x', sessionId: 'session-1',
    })

    expect(applied).toEqual([[session, LANE_PERMISSION_PRESET]])
    expect(result.permissionPresetApplied).toBe(true)
  })
})
