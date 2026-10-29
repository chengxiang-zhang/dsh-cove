/**
 * `worktree_lane` — the one agent-facing surface of the lane model.
 *
 * A conversation can carry a lane even when its cwd is not the lane directory:
 * a blank conversation is moved onto the lane at creation (cwd IS the lane),
 * while a conversation that already has turns keeps its cwd and merely carries
 * the lane. Tools do not see the header chip, so the agent must be able to ask
 * where its lane is before running git commands — otherwise it would operate on
 * the main checkout while the branch lives in a linked worktree.
 *
 * Resolution is exactly the host's `laneForPath({ sessionId })`, which first
 * checks the session cwd and then falls back to the manifest binding.
 * @module dsh-client-ui-worktree/host/lane-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools'
import type { WorktreeManager } from './manager.ts'

/** Structural slice of the tool execution context the lane resolution needs. */
interface LaneToolSessionContext {
  agent?: { session?: { header?: { cwd?: string; id?: string } } }
}

export const LANE_TOOL_NAME = 'worktree_lane'

/** The agent-facing tool definition (registered via `ctx.tools.register`). */
export function makeLaneTool(worktrees: WorktreeManager) {
  return defineTool({
    name: LANE_TOOL_NAME,
    description:
      'Report the worktree lane bound to this conversation: the branch and the '
      + 'directory it checks out. When a repository isolates branches into '
      + 'linked worktrees (under `<repo>/.dsh/workspaces/<branch>`), the reported '
      + 'directory is where this conversation\u2019s git work must happen. Returns '
      + 'lane:null when the conversation works on the main checkout.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lane: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  branch: { type: 'string', required: true },
                  path: { type: 'string', required: true },
                  repoPath: { type: 'string', required: true },
                },
              },
              { type: 'null' },
            ],
          },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const session = (exec as unknown as LaneToolSessionContext).agent?.session?.header
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || sessionId === '') {
        return {
          lane: null,
          note: 'no session context; call this tool from a conversation',
        }
      }
      const lane = await worktrees.laneForPath({ sessionId })
      if (lane === null) {
        return {
          lane: null,
          note: 'this conversation works on the main checkout of its repository',
        }
      }
      return {
        lane: {
          branch: lane.branch ?? lane.name,
          path: lane.path,
          repoPath: lane.repoPath,
        },
      }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: 'Worktree lane lookup', kind: 'read', rawInput: args }
    },
  })
}

/** Register the lane tool, degrading silently when the tools service is absent. */
export function registerLaneTool(ctx: Context, worktrees: WorktreeManager): () => void {
  try {
    const dispose = ctx.tools.register(makeLaneTool(worktrees))
    return () => { try { dispose() } catch { /* tolerant */ } }
  } catch {
    return () => {}
  }
}
