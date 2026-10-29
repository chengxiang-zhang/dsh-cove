/**
 * Recording which conversation a lane belongs to.
 *
 * A lane is a DSH workspace now, so a conversation can arrive on it from
 * anywhere: this plugin's branch picker, the shell's own workspace selector, or
 * a selection restored after a reload. Whenever a conversation's cwd is a lane,
 * the host has to know the pairing, because two things key off it:
 *
 *   - the lane's `danger-full-access` preset. A linked worktree keeps its git
 *     directory in `<repo>/.git/worktrees/<name>/`, outside the session cwd, so
 *     a confined sandbox cannot write the index, objects or refs — the agent
 *     could not commit at all;
 *   - the teardown guards, which refuse to delete the directory a running
 *     conversation works in.
 *
 * The binding is idempotent and attempted once per session per page load: a
 * refusal is reported (the chip warns that the lane may not be able to commit)
 * but never retried in a loop.
 * @module @dsh-cove/dsh-client-ui-worktree/client/lane-binding
 */

import type { BindLaneInput, BindLaneResult, LaneLookupInput, LaneView } from '../../../core/worktree/types.ts'

/** The outcome of resolving (and, when needed, recording) a session's lane. */
export interface LaneBinding {
  /** The lane this session runs in, or null when it runs outside one. */
  lane: LaneView | null
  /** The lane exists but the host refused to record this conversation on it. */
  bindFailed: boolean
}

/** Resolve the lane a session runs in, recording the pairing on first sight. */
export interface LaneBinder {
  /** @param sessionId - the conversation asking; undefined resolves to no lane. */
  bind(sessionId: string | undefined): Promise<LaneBinding>
}

/**
 * Build a binder over the two calls it needs.
 *
 * They are passed in rather than imported so each surface keeps its own
 * injected face (the header chip receives its lookup; the composer hands its
 * own), and so tests can drive the binder without a network.
 * @param faces - `/worktree/lane` and `/worktree/lane/bind`.
 */
export function createLaneBinder(faces: {
  lane: (input: LaneLookupInput) => Promise<LaneView | null>
  bindLane: (input: BindLaneInput) => Promise<BindLaneResult>
}): LaneBinder {
  const attempted = new Set<string>()
  return {
    bind: async (sessionId) => {
      if (sessionId === undefined) return { lane: null, bindFailed: false }
      let lane: LaneView | null
      try {
        lane = await faces.lane({ sessionId })
      } catch {
        return { lane: null, bindFailed: false }
      }
      if (lane === null || lane.sessionId === sessionId || attempted.has(sessionId)) {
        return { lane, bindFailed: false }
      }
      attempted.add(sessionId)
      try {
        const bound = await faces.bindLane({
          repoPath: lane.repoPath,
          branch: lane.branch ?? lane.name,
          sessionId,
        })
        return { lane: bound.lane ?? lane, bindFailed: false }
      } catch (error) {
        console.warn('[dsh-worktree] could not record this conversation on its lane:', error)
        return { lane, bindFailed: true }
      }
    },
  }
}