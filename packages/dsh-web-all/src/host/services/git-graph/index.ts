/** Register the workspace-gated Git graph host domain. */
import type { Context } from '@deepseek-ai/cordis'
import { registerGitRoutes } from './routes.ts'
import { createWorkspaceGate, GitService, subprocessRunner } from './service.ts'

export function register(ctx: Context): () => void {
  return registerGitRoutes(ctx, new GitService(subprocessRunner(ctx), createWorkspaceGate(ctx)))
}

export { GitService, createWorkspaceGate, subprocessRunner } from './service.ts'
export { registerGitRoutes } from './routes.ts'
