/**
 * Desk tool-face self-check (11, T20), fail-closed.
 *
 * Reading (FREEZE N3, degraded after S1 and the 2026-11-06 live turn): "visible set
 * equals the nine desk tools" is unreachable, because tools an agent plane registers
 * in the agent's own layer (`subagent`, the Agent Team set) are not inherited and
 * `restrict` cannot remove them. What is enforced is execution:
 * - every desk tool is visible (`missing` empty);
 * - no non-desk tool call has executed successfully on this session (`violations` 0);
 * - no host-privileged tool is visible at all (`denied_visible` empty).
 * Anything else visible is recorded as `extra` and does not fail the check: the
 * desk guard refuses its execution, and a successful execution is a violation.
 */

import { DESK_TOOL_NAMES } from '../protocol/tools.ts'

export interface SelfCheckResult {
  ok: boolean
  missing: string[]
  /** Visible non-desk tools of the agent plane: recorded, refused at execution. */
  extra: string[]
  extra_count: number
  /** Visible host-privileged tools: the host-plane restrict failed, a real incident. */
  denied_visible: string[]
  violations: number
}

/**
 * Host-plane privileged tools that must never be visible on a desk session.
 *
 * Why these differ from agent-plane extras: they are registered on the host's global
 * layer, which `restrict({ allow: [] })` hides from the desk scope. Seeing one means
 * the restriction did not apply, so the desk would have shell, remote, worktree or
 * inbox reach if its guard ever failed; the turn does not run. Live reading
 * (temp instance, 2026-11-06): restrict hides bash, write, edit and job_* from the
 * desk while the Agent Team set and subagent stay visible. Agent-plane tools
 * (`subagent`, Agent Team) live in the agent's own layer, cannot be restricted and
 * are only ever refused at execution.
 */
export const DENIED_VISIBLE_NAMES: readonly string[] = Object.freeze(['bash', 'exec', 'shell', 'terminal', 'write', 'edit'])
export const DENIED_VISIBLE_PREFIXES: readonly string[] = Object.freeze(['ssh_', 'worktree_', 'lark_inbox_', 'terminal_', 'job_'])

export const isDeniedVisible = (name: string): boolean =>
  DENIED_VISIBLE_NAMES.includes(name) || DENIED_VISIBLE_PREFIXES.some(prefix => name.startsWith(prefix))

export function selfCheck(visible: readonly string[], violations: number): SelfCheckResult {
  const seen = new Set(visible)
  const desk = new Set<string>(DESK_TOOL_NAMES)
  const missing = DESK_TOOL_NAMES.filter(name => !seen.has(name))
  const others = [...seen].filter(name => !desk.has(name)).sort()
  const deniedVisible = others.filter(isDeniedVisible)
  const extra = others.filter(name => !isDeniedVisible(name))
  return {
    ok: missing.length === 0 && violations === 0 && deniedVisible.length === 0,
    missing, extra, extra_count: extra.length, denied_visible: deniedVisible, violations,
  }
}

export const TOOLFACE_ALERT = '我这边工具面不对，已停'
export const TOOLFACE_ALERT_EVERY_MS = 3_600_000
