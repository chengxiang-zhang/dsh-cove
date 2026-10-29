/**
 * Agent/request override that applies a workspace's model preset. Registered
 * at plugin boot (before any session/agent exists), so this `agent/request`
 * waterfall handler runs BEFORE the official per-agent model-selection
 * handler and therefore wins: when a workspace has a preset, the preset's
 * provider/model/effort override whatever the session would otherwise have
 * resolved (its logged route or the global default); when a workspace has no
 * preset, the request passes through untouched and behavior is unchanged.
 * @module dsh-client-ui-worktree/host/model-override
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
// Pull the cordis `Events` augmentation (`agent/request` waterfall signature).
import type {} from '@deepseek-ai/dsh-agent'
import type { WorkspaceModelManager } from './workspace-model.ts'

/**
 * Install the workspace-preset override for the `agent/request` waterfall.
 * Returns the dispose function.
 * @param ctx - registrant context (listeners unwind with the plugin).
 * @param manager - the workspace-model manager whose presets are applied.
 */
export function installWorkspaceModelAgentOverride(
  ctx: Context,
  manager: WorkspaceModelManager,
): () => void {
  const dispose = ctx.on<'agent/request'>('agent/request', async (payload, next) => {
    // Let the prior chain resolve first so we only adjust the final config.
    const resolved = await next()
    const cwd = payload.agent.session.header.cwd
    if (cwd === undefined || cwd === '') return resolved
    const preset = manager.get(cwd)
    if (preset === undefined) return resolved
    return {
      ...resolved,
      provider: preset.provider,
      model: preset.model,
      ...(preset.reasoningEffort === undefined ? {} : { reasoningEffort: preset.reasoningEffort }),
    } as LlmCallConfig
  })
  return dispose
}