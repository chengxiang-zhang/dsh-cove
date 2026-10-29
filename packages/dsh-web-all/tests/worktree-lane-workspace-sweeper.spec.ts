/**
 * Browser-half tests for the lane-workspace sweep: a lane's workspace row is a
 * platform requirement while its conversation runs, and this is what stops it
 * from outliving that conversation.
 *
 * The rules under test are the ones that decide whose row it is: only this
 * plugin's lane directories, only workspaces that already account for a
 * conversation, and only when every one of those conversations is archived.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  laneWorkspacesToRetire, mountLaneWorkspaceSweeper, sweepLaneWorkspaces,
  type LaneSweepSnapshot, type LaneSweeperFaces,
} from '../src/client/conversation/worktree/lane-workspace-sweeper.ts'
import { isLaneDirectory } from '../src/core/worktree/paths.ts'

/** One client workspace snapshot. */
function snapshot(overrides: Partial<LaneSweepSnapshot> = {}): LaneSweepSnapshot {
  return { phase: 'ready', items: [], archivedSessionIds: [], ...overrides }
}

/** Faces over a mutable snapshot, recording deletions. */
function faces(initial: LaneSweepSnapshot) {
  let current = initial
  const deleted: string[] = []
  const listeners = new Set<() => void>()
  const failures = new Map<string, Error>()
  const face: LaneSweeperFaces = {
    workspaces: {
      list: {
        getSnapshot: () => current,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
      delete: async (workspaceId) => {
        const failure = failures.get(workspaceId)
        if (failure !== undefined) throw failure
        deleted.push(workspaceId)
        current = { ...current, items: (current.items ?? []).filter((item) => item.workspaceId !== workspaceId) }
        for (const listener of listeners) listener()
      },
    },
  }
  return {
    face,
    deleted,
    failures,
    listeners,
    publish: (next: LaneSweepSnapshot) => { current = next; for (const listener of listeners) listener() },
    current: () => current,
  }
}

const LANE = (path: string, sessionIds: string[], workspaceId = 'ws-lane') =>
  ({ workspaceId, path, sessionIds })

describe('isLaneDirectory', () => {
  it('recognizes this plugin\u2019s lane directories and nothing else', () => {
    expect(isLaneDirectory('/repo/.dsh/workspaces/fea/x')).toBe(true)
    expect(isLaneDirectory('C:\\repo\\.dsh\\workspaces\\fea\\x')).toBe(true)
    expect(isLaneDirectory('/repo')).toBe(false)
    expect(isLaneDirectory('/repo/.dsh')).toBe(false)
    expect(isLaneDirectory('/repo/.dsh/workspaces')).toBe(false)
    expect(isLaneDirectory('/repo/sub/.dsh/workspaces/fea/x')).toBe(true)
  })
})

describe('laneWorkspacesToRetire', () => {
  it('picks a lane whose conversations are all archived', () => {
    expect(laneWorkspacesToRetire(snapshot({
      items: [LANE('/repo/.dsh/workspaces/fea/x', ['s1', 's2'])],
      archivedSessionIds: ['s1', 's2'],
    }))).toEqual(['ws-lane'])
  })

  it('keeps a lane with a live conversation', () => {
    expect(laneWorkspacesToRetire(snapshot({
      items: [LANE('/repo/.dsh/workspaces/fea/x', ['s1', 's2'])],
      archivedSessionIds: ['s1'],
    }))).toEqual([])
  })

  it('keeps a lane that accounts for no conversation yet', () => {
    // A lane created moments ago has no session attached; its workspace is being
    // set up and must survive the sweep.
    expect(laneWorkspacesToRetire(snapshot({
      items: [LANE('/repo/.dsh/workspaces/fea/x', [])],
      archivedSessionIds: ['s1'],
    }))).toEqual([])
  })

  it('leaves a workspace the user registered themselves alone', () => {
    expect(laneWorkspacesToRetire(snapshot({
      items: [
        { workspaceId: 'ws-project', path: '/repo', sessionIds: ['s1'] },
        { workspaceId: 'ws-other', path: '/other/repo', sessionIds: ['s2'] },
      ],
      archivedSessionIds: ['s1', 's2'],
    }))).toEqual([])
  })

  it('waits for the host list before deciding', () => {
    expect(laneWorkspacesToRetire(snapshot({
      phase: 'pending',
      items: [LANE('/repo/.dsh/workspaces/fea/x', ['s1'])],
      archivedSessionIds: ['s1'],
    }))).toEqual([])
    expect(laneWorkspacesToRetire(undefined)).toEqual([])
  })
})

describe('sweepLaneWorkspaces', () => {
  it('deletes exactly the dead lanes and reports them', async () => {
    const live = faces(snapshot({
      items: [
        LANE('/repo/.dsh/workspaces/fea/dead', ['s1'], 'ws-dead'),
        LANE('/repo/.dsh/workspaces/fea/live', ['s2'], 'ws-live'),
        { workspaceId: 'ws-project', path: '/repo', sessionIds: ['s3'] },
      ],
      archivedSessionIds: ['s1', 's3'],
    }))

    await expect(sweepLaneWorkspaces(live.face)).resolves.toEqual(['ws-dead'])
    expect(live.deleted).toEqual(['ws-dead'])
    expect(live.current().items?.map((item) => item.workspaceId)).toEqual(['ws-live', 'ws-project'])
  })

  it('does nothing without a workspace service', async () => {
    await expect(sweepLaneWorkspaces({})).resolves.toEqual([])
  })

  it('reports one refused deletion and still retires the rest', async () => {
    const warn = vi.fn()
    const both = faces(snapshot({
      items: [
        LANE('/repo/.dsh/workspaces/fea/one', ['s1'], 'ws-one'),
        LANE('/repo/.dsh/workspaces/fea/two', ['s2'], 'ws-two'),
      ],
      archivedSessionIds: ['s1', 's2'],
    }))
    both.failures.set('ws-one', new Error('host refused'))

    await expect(sweepLaneWorkspaces({ ...both.face, warn })).resolves.toEqual(['ws-two'])
    expect(warn).toHaveBeenCalledWith('[dsh-worktree] could not retire a lane workspace:', expect.any(Error))
    expect(both.deleted).toEqual(['ws-two'])
  })
})

describe('mountLaneWorkspaceSweeper', () => {
  it('sweeps on mount and on every workspace-list change', async () => {
    const state = faces(snapshot({
      items: [LANE('/repo/.dsh/workspaces/fea/live', ['s1'], 'ws-live')],
      archivedSessionIds: [],
    }))
    const off = mountLaneWorkspaceSweeper(state.face)
    await Promise.resolve()
    expect(state.deleted).toEqual([])

    // The conversation is archived: the row goes.
    state.publish(snapshot({
      items: [LANE('/repo/.dsh/workspaces/fea/live', ['s1'], 'ws-live')],
      archivedSessionIds: ['s1'],
    }))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(state.deleted).toEqual(['ws-live'])

    off()
    expect(state.listeners.size).toBe(0)
  })

  it('never overlaps two sweeps', async () => {
    const state = faces(snapshot({
      items: [LANE('/repo/.dsh/workspaces/fea/live', ['s1'], 'ws-live')],
      archivedSessionIds: ['s1'],
    }))
    const deleteSpy = vi.fn(async (workspaceId: string) => {
      // A change landing mid-sweep must queue one more pass instead of starting a
      // second concurrent one.
      state.publish(snapshot({ items: [], archivedSessionIds: [] }))
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(deleteSpy).toHaveBeenCalledTimes(1)
    })
    const off = mountLaneWorkspaceSweeper({
      workspaces: { list: state.face.workspaces?.list, delete: deleteSpy },
    })
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(deleteSpy).toHaveBeenCalledTimes(1)
    off()
  })

  it('is inert without the workspace service', () => {
    expect(() => { mountLaneWorkspaceSweeper({})() }).not.toThrow()
  })
})