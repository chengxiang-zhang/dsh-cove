/**
 * Executor tool guard (10, T19). Pure: the composition root (T27) installs it on the
 * session through the same tool-surface mechanism as the desk (T20).
 */

import type { Profile } from './types.ts'

/** Denied on every executor session: the channel, worktree management. */
export const EXECUTOR_DENIED_TOOLS: readonly string[] = Object.freeze([
  'lark_inbox_ack', 'lark_inbox_peek', 'lark_inbox_pop', 'lark_inbox_reply',
  'worktree', 'worktree_lane', 'worktrees',
])

const DENIED_PREFIXES = ['lark_inbox', 'worktree']
/** Read-only surface for `tools: 'read'` profiles; anything else is treated as a write. */
const READ_ONLY = /^(read|list|ls|grep|glob|search|find|inspect|view|look|stat|cat|report)(_|$)/i
const SUBAGENT = /^(subagent|agent|task)$/i

/**
 * Returns a refusal string, or undefined when the call is allowed. `args` lets the
 * guard refuse a subagent call that names a preset.
 */
export function executorGuard(profile: Profile, toolName: string, args?: Record<string, unknown>): string | undefined {
  const name = toolName.trim()
  if (EXECUTOR_DENIED_TOOLS.includes(name) || DENIED_PREFIXES.some(p => name.startsWith(p))) {
    return `executor ${profile.id}: ${name} is not available to executors`
  }
  if (SUBAGENT.test(name) && args !== undefined && (args.preset !== undefined || args.agentPreset !== undefined)) {
    return `executor ${profile.id}: subagent calls with a preset are not allowed`
  }
  if (profile.tools === 'read' && !READ_ONLY.test(name)) {
    return `executor ${profile.id} is read-only: ${name} refused`
  }
  return undefined
}
