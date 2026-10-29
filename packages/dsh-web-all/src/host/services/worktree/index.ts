/** Mature worktree service domain mounted inside the single web-all Cordis row. */
import type { Context } from '@deepseek-ai/cordis'
// Pull the cordis `Events` augmentations for `workspace/session-*`.
import type {} from '@deepseek-ai/dsh-workspace'
import { WorktreeManager } from './manager.ts'
import { registerResources } from '../resources.ts'
import { registerWorktreeRoutes } from './routes.ts'
import { SessionLaneManager } from './session-lane/manager.ts'
import { registerLaneTool } from './lane-tool.ts'
import { WorkspaceModelManager } from './workspace-model.ts'
import { registerWorkspaceModelRoutes } from './workspace-model-routes.ts'
import { installWorkspaceModelAgentOverride } from './model-override.ts'

export { API_PREFIX as WORKTREE_API_PREFIX } from './routes.ts'
export { WORKSPACE_MODEL_PREFIX } from './workspace-model-routes.ts'

export interface WorktreeServiceConfig {
  pr?: { tokenEnv?: string }
}

/** The retirement faces this domain needs from the manager (structural, for tests). */
export type LaneRetirementManager = Pick<WorktreeManager, 'retireArchivedLane' | 'reconcileLaneWorkspaces'>

/** Fire-and-forget retirement; a failure is logged, never thrown into the archive path. */
function retireLane(manager: LaneRetirementManager, sessionId: string): void {
  void manager.retireArchivedLane(sessionId).catch((error: unknown) => {
    console.warn('[dsh-worktree] lane workspace retirement failed:', error)
  })
}

/**
 * Keep a lane's workspace registration as short-lived as the platform allows.
 *
 * The registration itself is unavoidable while the lane's conversation runs (the
 * platform accounts a session to a workspace only when the session cwd equals
 * that workspace's path, and a blank conversation no workspace accounts for has
 * an inert composer), so the worktree's sidebar row is a platform requirement.
 * What this owns is its LIFETIME: archiving the lane's conversation retires the
 * registration, and a boot pass retires the rows an earlier build left behind.
 * The directory, the branch and the binding stay, so the lane can be picked up
 * again in one step.
 *
 * Both archive paths are covered: `workspace/session-activity` (the waterfall
 * that runs before a non-forced archive write) and `workspace/session-stop`
 * (dispatched once a forced archive is durable).
 * @param ctx - registrant context.
 * @param manager - the worktree manager owning the lanes.
 * @returns the dispose function.
 */
export function installLaneWorkspaceRetirement(ctx: Context, manager: LaneRetirementManager): () => void {
  return registerResources(own => {
  own(ctx.on('workspace/session-activity', async (request, next) => {
    const activity = await next()
    // The waterfall runs BEFORE the durable write: a request refused for running
    // work never lands, and the retirement polls the archive set to tell.
    if (activity.length === 0) retireLane(manager, request.sessionId)
    return activity
  }))
  own(ctx.on('workspace/session-stop', (request) => {
    // The archive set is durable by the time this dispatches.
    retireLane(manager, request.sessionId)
  }))
  // The workspace registry initializes asynchronously; the boot pass runs once it
  // is there. The injected fiber follows the ctx lifetime, like every other
  // service wait in this domain.
  const fiber = ctx.inject(['workspaceRegistry'], () => {
    void manager.reconcileLaneWorkspaces().catch((error: unknown) => {
      console.warn('[dsh-worktree] lane workspace reconciliation failed:', error)
    })
  })
  if (fiber) own(() => { void fiber.dispose() })
  })
}

/** Register the shipped worktree, session-lane and workspace-model lifecycles. */
export function register(ctx: Context, config: WorktreeServiceConfig = {}): () => void {
  return registerResources(own => {
    const manager = new WorktreeManager(ctx, { tokenEnv: config.pr?.tokenEnv })
    const modelManager = new WorkspaceModelManager(ctx)
    own(() => modelManager.dispose())
    const laneManager = new SessionLaneManager(ctx, manager)
    own(registerWorktreeRoutes(ctx, manager, laneManager))
    own(registerWorkspaceModelRoutes(ctx, modelManager))
    own(installWorkspaceModelAgentOverride(ctx, modelManager))
    own(registerLaneTool(ctx, manager))
    own(installLaneWorkspaceRetirement(ctx, manager))
  })
}

export { WorktreeManager } from './manager.ts'
export { SessionLaneManager, LANE_PERMISSION_PRESET } from './session-lane/manager.ts'
export { WorkspaceModelManager } from './workspace-model.ts'
