/**
 * Desk tool-face self-check (11, T20), fail-closed.
 *
 * S1 made "visible set equals the nine desk tools" unreachable under a default
 * preset, so the judgement is (N3):
 * - every desk tool is visible;
 * - anything else visible belongs to the known, fixed agent-plane set;
 * - no non-desk tool call has executed successfully on this session.
 * Any miss: the turn does not run.
 */

import { DESK_TOOL_NAMES } from '../protocol/tools.ts'
import { AGENT_FACE_TOOLS } from './toolface.ts'

export interface SelfCheckResult { ok: boolean; missing: string[]; extra: string[]; violations: number }

export function selfCheck(visible: readonly string[], violations: number): SelfCheckResult {
  const seen = new Set(visible)
  const missing = DESK_TOOL_NAMES.filter(name => !seen.has(name))
  const desk = new Set<string>(DESK_TOOL_NAMES)
  const extra = [...seen].filter(name => !desk.has(name) && !AGENT_FACE_TOOLS.includes(name)).sort()
  return { ok: missing.length === 0 && extra.length === 0 && violations === 0, missing, extra, violations }
}

export const TOOLFACE_ALERT = '我这边工具面不对，已停'
export const TOOLFACE_ALERT_EVERY_MS = 3_600_000
