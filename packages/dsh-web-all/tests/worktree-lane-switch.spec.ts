/**
 * Unit tests for one branch choice: create/attach the branch's lane (its
 * directory registered as a workspace), move the conversation onto it through
 * the platform's own workspace navigation, and record the binding the header
 * chip / teardown guards / permission preset read.
 *
 * Two things this cover pins down:
 *   - the move used to be read from a `conversation.input.dock` seat prop. DSH
 *     renders that seat with `{ session, input }` only (see ConversationContent),
 *     so the prop was always undefined and every branch choice silently created a
 *     directory and left the conversation in the old checkout;
 *   - the move requires the lane's workspace. A lane session created with a bare
 *     cwd exists but is accounted to no workspace, and a blank conversation no
 *     workspace accounts for renders an inert composer, so the lane is not
 *     reported as opened without one.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  openLaneForBranch, waitForLaneSession,
  type LaneOpenDeps, type LaneOpenNavigation, type LaneOpenSessionList,
} from '../src/client/conversation/worktree/lane-open.ts'
import type { BindLaneInput, CreateLaneInput, LaneHandle } from '../src/core/worktree/types.ts'

const LANE_PATH = '/repo/.dsh/workspaces/fea/mcpfiles'

/** One prepared lane as the host answers `/worktree/lane/create`. */
function laneHandle(overrides: Partial<LaneHandle> = {}): LaneHandle {
  return {
    name: 'fea/mcpfiles',
    branch: 'fea/mcpfiles',
    path: LANE_PATH,
    head: 'deadbee',
    created: true,
    workspaceId: 'ws-lane-1',
    ...overrides,
  }
}

/** Deps builder: every host call is a spy unless the test overrides it. */
function makeDeps(options: {
  lane?: LaneHandle
  createFails?: string
  navigation?: LaneOpenNavigation
  sessions?: LaneOpenSessionList
  bindFails?: string
} = {}) {
  const createLane = vi.fn(async (_input: CreateLaneInput) => {
    if (options.createFails !== undefined) throw new Error(options.createFails)
    return options.lane ?? laneHandle()
  })
  const bindLane = vi.fn(async (_input: BindLaneInput) => {
    if (options.bindFails !== undefined) throw new Error(options.bindFails)
    return { lane: null, permissionPresetApplied: true }
  })
  const warn = vi.fn()
  const deps: LaneOpenDeps = {
    createLane,
    bindLane,
    ...(options.navigation === undefined ? {} : { navigation: options.navigation }),
    listSessions: () => options.sessions ?? { byId: {}, ids: [] },
    timeoutMs: 0,
    warn,
  }
  return { deps, createLane, bindLane, warn }
}

const input = { sessionId: 'session-main', repoPath: '/repo', branch: 'fea/mcpfiles' }

describe('openLaneForBranch', () => {
  it('creates the lane, moves onto its workspace, and binds the conversation the shell opened', async () => {
    const opened: string[] = []
    const openWorkspace = vi.fn(async (workspaceId: string, beforeOpen?: (sessionId: string) => void) => {
      opened.push(workspaceId)
      beforeOpen?.('session-lane')
    })
    const { deps, createLane, bindLane } = makeDeps({ navigation: { openWorkspace } })

    await expect(openLaneForBranch(deps, input)).resolves.toEqual({ ok: true, branch: 'fea/mcpfiles', opened: true })

    expect(createLane).toHaveBeenCalledWith({ repoPath: '/repo', branch: 'fea/mcpfiles' })
    // The move rides the platform service — the call behind the shell's own
    // workspace picker — and names the lane's registered workspace.
    expect(openWorkspace).toHaveBeenCalledTimes(1)
    expect(opened).toEqual(['ws-lane-1'])
    // The binding is recorded for the conversation that landed in the lane,
    // which is the one the navigation reported (not the one that asked).
    expect(bindLane).toHaveBeenCalledWith({
      repoPath: '/repo', branch: 'fea/mcpfiles', sessionId: 'session-lane',
    })
  })

  it('passes a base commit-ish through to the create call', async () => {
    const { deps, createLane } = makeDeps({ navigation: { openWorkspace: async () => {} } })

    await openLaneForBranch(deps, { ...input, base: 'origin/dev' })

    expect(createLane).toHaveBeenCalledWith({ repoPath: '/repo', branch: 'fea/mcpfiles', base: 'origin/dev' })
  })

  it('reports the lane as ready but unmoved when the shell has no navigation service', async () => {
    // No `uiWorkspace`: the worktree is real and reachable, but nothing may be
    // claimed about where this conversation runs.
    const { deps, createLane, bindLane } = makeDeps({})

    await expect(openLaneForBranch(deps, input)).resolves.toEqual({ ok: true, branch: 'fea/mcpfiles', opened: false })

    expect(createLane).toHaveBeenCalledTimes(1)
    expect(bindLane).not.toHaveBeenCalled()
  })

  it('does not bind a conversation that stayed in the old checkout', async () => {
    // A lane whose workspace registration failed has nowhere to move to, and a
    // session created with a bare cwd would have an inert composer.
    const openWorkspace = vi.fn()
    const { deps, bindLane } = makeDeps({
      lane: laneHandle({ workspaceId: null }),
      navigation: { openWorkspace },
    })

    await expect(openLaneForBranch(deps, input)).resolves.toEqual({ ok: true, branch: 'fea/mcpfiles', opened: false })

    expect(openWorkspace).not.toHaveBeenCalled()
    expect(bindLane).not.toHaveBeenCalled()
  })

  it('still creates the lane without a conversation to move', async () => {
    const openWorkspace = vi.fn()
    const { deps } = makeDeps({ navigation: { openWorkspace } })

    await expect(openLaneForBranch(deps, { ...input, sessionId: undefined }))
      .resolves.toEqual({ ok: true, branch: 'fea/mcpfiles', opened: false })

    expect(openWorkspace).not.toHaveBeenCalled()
  })

  it('keeps the moved conversation and only warns when the binding is refused', async () => {
    // The preset/binding is best-effort: the conversation IS in the lane, so the
    // picker must not tell the user the move failed.
    const { deps, warn } = makeDeps({
      bindFails: 'lane mismatch',
      navigation: { openWorkspace: async (_workspaceId, beforeOpen) => { beforeOpen?.('session-lane') } },
    })

    await expect(openLaneForBranch(deps, input)).resolves.toEqual({ ok: true, branch: 'fea/mcpfiles', opened: true })
    expect(warn).toHaveBeenCalledWith('[dsh-worktree] lane binding failed:', expect.any(Error))
  })

  it('finds the lane conversation in the session list when the navigation reports none', async () => {
    // Superseded navigation: `openWorkspace` resolved without naming the
    // conversation, but it may still have connected the workspace.
    const { deps, bindLane } = makeDeps({
      navigation: { openWorkspace: async () => {} },
      sessions: { byId: { 'session-lane': { cwd: LANE_PATH } }, ids: ['session-main', 'session-lane'] },
    })

    await expect(openLaneForBranch(deps, input)).resolves.toEqual({ ok: true, branch: 'fea/mcpfiles', opened: true })
    expect(bindLane).toHaveBeenCalledWith({
      repoPath: '/repo', branch: 'fea/mcpfiles', sessionId: 'session-lane',
    })
  })

  it('reports the lane as ready when the shell opened no conversation at all', async () => {
    const { deps, bindLane } = makeDeps({ navigation: { openWorkspace: async () => {} } })

    await expect(openLaneForBranch(deps, input)).resolves.toEqual({ ok: true, branch: 'fea/mcpfiles', opened: false })
    expect(bindLane).not.toHaveBeenCalled()
  })

  it('treats a failed navigation as ready-not-moved instead of losing the lane', async () => {
    const { deps, bindLane, warn } = makeDeps({
      navigation: { openWorkspace: async () => { throw new Error('no workspace') } },
    })

    await expect(openLaneForBranch(deps, input)).resolves.toEqual({ ok: true, branch: 'fea/mcpfiles', opened: false })
    expect(bindLane).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[dsh-worktree] could not open a conversation on the lane:', expect.any(Error))
  })

  it('surfaces a refused create as a failure without inventing a branch', async () => {
    const { deps, bindLane } = makeDeps({
      createFails: 'The repository does not ignore the worktree root',
      navigation: { openWorkspace: vi.fn() },
    })

    await expect(openLaneForBranch(deps, input)).resolves.toEqual({
      ok: false,
      message: 'The repository does not ignore the worktree root',
    })
    expect(bindLane).not.toHaveBeenCalled()
  })
})

describe('waitForLaneSession', () => {
  it('prefers the newest conversation in the lane directory', async () => {
    const { deps } = makeDeps({
      sessions: {
        byId: { old: { cwd: LANE_PATH }, other: { cwd: '/repo' }, fresh: { cwd: LANE_PATH } },
        ids: ['old', 'other', 'fresh'],
      },
    })

    await expect(waitForLaneSession(deps, LANE_PATH)).resolves.toBe('fresh')
  })

  it('gives up when no conversation lands in the lane within the wait', async () => {
    const { deps } = makeDeps({ sessions: { byId: { main: { cwd: '/repo' } }, ids: ['main'] } })

    await expect(waitForLaneSession(deps, LANE_PATH)).resolves.toBeUndefined()
  })
})