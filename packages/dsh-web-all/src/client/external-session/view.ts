/**
 * 面板与下拉分组的纯展示计算。
 *
 * 这里不放 React、不碰 DOM、不读时间源：输入视图、输出字符串/数组，便于在
 * jsdom 之外直接测。时间一律以调用方给的 `nowMs` 为准，避免测试依赖真实时钟。
 */
import {
  canContinueSession,
  type ExternalSessionView,
  type ExternalTurnView,
  type ExternalUsage,
} from './types.ts'

/** 会话的排序键：最近一轮优先，没有轮次时用创建时间，最后靠 id 保证稳定。 */
function sortKey(session: ExternalSessionView): string {
  const last = session.lastTurnAt ?? ''
  return last === '' ? (session.createdAt ?? '') : last
}

/** 最近有动静的会话排在前面；同一时刻按 id 稳定排序。 */
export function sortSessions(sessions: readonly ExternalSessionView[]): readonly ExternalSessionView[] {
  return [...sessions].sort((left, right) => {
    const l = sortKey(left)
    const r = sortKey(right)
    if (l !== r) return l < r ? 1 : -1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/** 面板打开时选中哪个会话：优先导航参数指定的，其次最近一轮。 */
export function pickSession(
  sessions: readonly ExternalSessionView[],
  preferredId: string | undefined,
): ExternalSessionView | undefined {
  if (preferredId !== undefined) {
    const hit = sessions.find(session => session.id === preferredId)
    if (hit !== undefined) return hit
  }
  return sortSessions(sessions)[0]
}

/** 单会话的轮次按轮次号升序（宿主顺序不可信）。 */
export function orderedTurns(session: ExternalSessionView | undefined): readonly ExternalTurnView[] {
  const turns = session?.turns ?? []
  return [...turns].sort((left, right) => left.n - right.n)
}

/** 摘要把换行压成单空格；超长截断并加省略号。 */
export function summarize(text: string | undefined, max = 80): string {
  if (text === undefined) return ''
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** 耗时：`420ms` / `42.0s` / `1m 02s` / `1h 05m`。 */
export function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  const totalSeconds = durationMs / 1_000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds - minutes * 60)
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes - hours * 60).padStart(2, '0')}m`
}

/** 计数：`987` / `1.2k` / `4.7M`。 */
export function formatCount(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** 用量行：输入与输出各自压缩；没有用量时不渲染。 */
export function formatUsage(usage: ExternalUsage | undefined): { input: string; output: string } | undefined {
  if (usage === undefined) return undefined
  const input = formatCount(usage.input)
  const output = formatCount(usage.output)
  if (input === undefined && output === undefined) return undefined
  return { input: input ?? '0', output: output ?? '0' }
}

/** CLI 自估价的显示值（`$0.03`）；0 与缺失区分开：0 也要显示，表示这一轮没花钱。 */
export function formatCost(costUsd: number | undefined): string | undefined {
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) return undefined
  if (costUsd === 0) return '$0'
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`
  return `$${costUsd.toFixed(2)}`
}

/** 列表行上的相对时间：`now` / `9m` / `4h` / `2d`；无法解析时给空串。 */
export function formatAge(iso: string | undefined, nowMs: number): string {
  if (iso === undefined) return ''
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const delta = Math.max(0, nowMs - at)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** 会话状态的中立色键：面板与下拉都按它选样式，不在 JSX 里散落判断。 */
export type SessionTone = 'running' | 'idle' | 'failed' | 'closed'

/** 会话是否还能接续（面板据此禁用追问并给出原因）。 */
export function continueAllowed(session: ExternalSessionView | undefined): boolean {
  return session === undefined ? false : canContinueSession(session)
}

/** 不能续轮的原因键；能续轮时为 undefined。 */
export function blockedReason(session: ExternalSessionView | undefined): 'closed' | 'unresumable' | undefined {
  if (session === undefined) return undefined
  if (continueAllowed(session)) return undefined
  return session.status === 'closed' ? 'closed' : 'unresumable'
}

/** 面板上「取消本轮」只在这一轮真在跑时出现。 */
export function turnInFlight(session: ExternalSessionView | undefined): boolean {
  if (session === undefined) return false
  if (session.status === 'running') return true
  return (session.turns ?? []).some(turn => turn.status === 'running')
}

/** 面板上「关闭会话」只对未关闭的会话出现。 */
export function closable(session: ExternalSessionView | undefined): boolean {
  return session !== undefined && session.status !== 'closed'
}