/**
 * Session-bound lane orchestration: the two host-side halves of "start a
 * conversation on its own worktree".
 *
 * Why the host does NOT create the session
 *   The obvious host path is a direct store insert, but it is wrong on two
 *   counts:
 *     1. `ctx.sessions.create()` makes the session owned by the CALLING
 *        FIBER — disposing that fiber removes the session from the store. A
 *        session created by this plugin would then disappear on the next
 *        plugin reload, which is exactly when a developer expects their
 *        conversation to still be there.
 *     2. The retired session-isolation wrapper reached for a host gateway
 *        face (`apiProxy.sessions.create`); on a real deployment that face is
 *        absent — reproduced live: `POST /worktree/lane/create` answered
 *        `session-create-failed: the apiProxy sessions face is unavailable`.
 *   So creation stays with the platform: the browser asks the platform's own
 *   workspace navigation for the lane (`uiWorkspace.openWorkspace`, whose
 *   `beforeOpen` callback names the `ctx.sessions.create({ workspaceId })`
 *   session it connected) and binds that id to the lane. The lane's directory is
 *   a registered workspace because the platform accounts a session to a workspace
 *   only while its cwd equals that path; a lane session created with a bare cwd
 *   would render an inert composer.
 *
 * What the host owns
 *   `createLane`       — make the branch's worktree (attaching an existing
 *                        branch, cutting a missing one) and register its
 *                        directory as a workspace. The registration is what makes
 *                        the conversation in it usable; ownership still sits with
 *                        the session, and teardown removes the registration with
 *                        the directory.
 *   `bindLaneSession`  — after the platform created the session, record the
 *                        binding and apply the preset the lane requires.
 *
 * Why the lane needs `danger-full-access`
 *   A linked worktree keeps its git directory under
 *   `<repo>/.git/worktrees/<name>/`, i.e. OUTSIDE the session cwd (which is
 *   the lane directory). The sandbox grants writes only to the session cwd and
 *   its descendants, so under `workspace-write` git could not write its index,
 *   objects or refs and no commit would be possible. Reported as a boolean,
 *   never thrown: a lane whose preset could not be applied is still usable
 *   once the user switches the access mode manually, and the header chip says
 *   so.
 * @module dsh-client-ui-worktree/host/session-lane
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isValidBranchName, WorktreeError } from '../../../../core/worktree/invariant.ts'
import { samePath } from '../../../../core/worktree/paths.ts'
import type {
  BindLaneInput, BindLaneResult, CreateLaneInput, CreateLaneResult, LaneLookupInput, LaneView,
} from '../../../../core/worktree/types.ts'
import type { WorktreeManager } from '../manager.ts'

/**
 * The preset every lane session must run under. `danger-full-access` maps to
 * `{sandbox: 'danger-full-access', approval: 'never'}` in
 * `@deepseek-ai/dsh-permission-presets`.
 */
export const LANE_PERMISSION_PRESET = 'danger-full-access'

/** Structural face over the permission-preset service (needs a live session). */
interface PermissionPresetsFace {
  set(session: unknown, name: string): void
}

/** Structural face over the host session store (id -> live session). */
interface SessionsStoreFace {
  get(id: string): unknown
}

/** Test seams; production uses the ctx services. */
export interface SessionLaneManagerOptions {
  /** Preset applier override (tests). */
  setPermissionPreset?: (sessionId: string, preset: string) => void | Promise<void>
  /** Live-session lookup override (tests). */
  hasSession?: (sessionId: string) => boolean
}

export class SessionLaneManager {
  private readonly ctx: Context
  private readonly worktrees: WorktreeManager
  private readonly options: SessionLaneManagerOptions
  /**
   * Captured through an optional inject, so the preset service is picked up
   * whenever the deployment provides it and never blocks this plugin's mount
   * when it does not.
   */
  private presets: PermissionPresetsFace | undefined

  constructor(ctx: Context, worktrees: WorktreeManager, options: SessionLaneManagerOptions = {}) {
    this.ctx = ctx
    this.worktrees = worktrees
    this.options = options
    this.presets = ctx.get('permissionPresets') as PermissionPresetsFace | undefined
    ctx.inject(['permissionPresets'], (child) => {
      this.presets = child.get('permissionPresets') as PermissionPresetsFace | undefined
      child.effect(() => () => { this.presets = undefined })
    })
  }

  /** Phase 1: ensure the worktree behind the branch exists (no workspace). */
  async createLane(input: CreateLaneInput): Promise<CreateLaneResult> {
    return await this.worktrees.ensureLane(input)
  }

  /**
   * Phase 2: bind the platform-created session to its lane and apply the preset.
   *
   * Fail closed, in this order: every check that can reject the request runs
   * BEFORE the session is elevated, and the request has to name the directory
   * the conversation actually runs in. Without that, this route could record —
   * and hand `danger-full-access` to — a conversation living somewhere else,
   * and a later teardown would archive a session that never used the lane.
   * Both halves were reproduced before this check existed: a bind resolved for a
   * session whose cwd was a different directory, and the elevation happened on
   * the way to a manifest write that then failed.
   *
   * The preset outcome is recorded with the binding, so a lane whose preset
   * failed still resolves for the header chip.
   */
  async bindLaneSession(input: BindLaneInput): Promise<BindLaneResult> {
    if (!this.hasSession(input.sessionId)) {
      throw new WorktreeError(
        'session-unknown',
        `session ${input.sessionId} is not live on the host, so it cannot be bound to a lane`,
        { sessionId: input.sessionId },
      )
    }
    if (!isValidBranchName(input.branch)) {
      throw new WorktreeError(
        'invalid-branch',
        `branch ${JSON.stringify(input.branch)} is not a valid git ref`,
        { branch: input.branch },
      )
    }
    // Only a lane the host actually records may be bound; `laneForPath`
    // synthesizes a view for a directory the manifest does not know about.
    const recorded = await this.worktrees.laneEntry(input.repoPath, input.branch)
    if (recorded === null) {
      throw new WorktreeError(
        'worktree-not-found',
        `no manifest entry records the lane ${JSON.stringify(input.branch)}`,
        { branch: input.branch },
      )
    }
    // The conversation has to be in that directory already: the bind is a
    // record of where it runs, never a way to move it.
    const lane = await this.worktrees.laneForPath({ sessionId: input.sessionId })
    if (lane === null || !samePath(lane.path, recorded.path)) {
      throw new WorktreeError(
        'lane-mismatch',
        `session ${input.sessionId} runs in ${lane === null ? 'no lane' : lane.path}, not ${recorded.path}`,
        { sessionId: input.sessionId, branch: input.branch, expected: recorded.path, actual: lane?.path ?? null },
      )
    }
    const permissionPresetApplied = await this.applyPreset(input.sessionId)
    await this.worktrees.bindSession(
      input.repoPath,
      input.branch,
      input.sessionId as SessionId,
      permissionPresetApplied,
    )
    return { lane, permissionPresetApplied }
  }

  /** Resolve the lane a path or session belongs to (delegates to the git layer). */
  async laneForPath(input: LaneLookupInput): Promise<LaneView | null> {
    return this.worktrees.laneForPath(input)
  }

  /**
   * Undo a lane whose session never came up (the platform's create failed, or
   * the user cancelled before it landed). Removes the worktree directory, the
   * local branch, the git admin records, the manifest entry and the registered
   * workspace, so a failed start leaves no stray lane behind.
   */
  async rollbackLane(input: { repoPath: string; branch: string }): Promise<void> {
    await this.worktrees.rollbackCreate({ repoPath: input.repoPath, name: input.branch })
  }

  /** Whether the host can see that session. */
  private hasSession(sessionId: string): boolean {
    if (this.options.hasSession !== undefined) return this.options.hasSession(sessionId)
    const store = this.ctx.get('sessions') as SessionsStoreFace | undefined
    return store?.get?.(sessionId) !== undefined
  }

  /** Apply the lane preset; a failure is reported, not thrown. */
  private async applyPreset(sessionId: string): Promise<boolean> {
    if (this.options.setPermissionPreset !== undefined) {
      try {
        await this.options.setPermissionPreset(sessionId, LANE_PERMISSION_PRESET)
        return true
      } catch (error) {
        this.warnPreset(error)
        return false
      }
    }
    const presets = this.presets
    if (presets === undefined) {
      this.warnPreset(new Error('the permissionPresets service is unavailable in this deployment'))
      return false
    }
    const store = this.ctx.get('sessions') as SessionsStoreFace | undefined
    const session = store?.get?.(sessionId)
    if (session === undefined) {
      this.warnPreset(new Error(`session ${sessionId} is not in the session store`))
      return false
    }
    try {
      presets.set(session, LANE_PERMISSION_PRESET)
      return true
    } catch (error) {
      this.warnPreset(error)
      return false
    }
  }

  private warnPreset(error: unknown): void {
    console.warn(
      `[dsh-worktree] could not apply the "${LANE_PERMISSION_PRESET}" preset; `
      + 'the lane session will need its access mode switched manually before it can commit:',
      error,
    )
  }
}
