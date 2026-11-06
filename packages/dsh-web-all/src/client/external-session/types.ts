/**
 * 外援会话的客户端视图面 —— 真源是 `src/core/external-session/types.ts`
 * （宿主与面板共用同一组类型，两边不会漂）。
 *
 * 本文件只做两件事：
 * 1. 把 core 的类型与判定函数原样转出，客户端不另立一套；
 * 2. 提供**宽容的 JSON 读取**：宿主路由回的是 JSON，坏条目该被丢掉而不是让面板
 *    白屏，所以 `readSessionList` / `readSessionView` 在这里把 unknown 收窄。
 *    这层只做形状校验与缺省，不新增字段语义。
 * @module dsh-web-all/client/external-session/types
 */

export type {
  ExternalProvider,
  ExternalSessionList,
  ExternalSessionStatus,
  ExternalSessionView,
  ExternalTurnProgress,
  ExternalTurnStatus,
  ExternalTurnView,
  ExternalTurnViewStatus,
  ExternalUsage,
} from '../../core/external-session/types.ts'

export {
  EXTERNAL_PROVIDERS,
  EXTERNAL_SESSION_STATUSES,
  EXTERNAL_TURN_STATUSES,
  isExternalProvider,
  isExternalSessionStatus,
  isExternalTurnStatus,
} from '../../core/external-session/types.ts'

import {
  isExternalProvider,
  isExternalSessionStatus,
  isExternalTurnStatus,
  type ExternalSessionView,
  type ExternalTurnProgress,
  type ExternalTurnView,
  type ExternalTurnViewStatus,
  type ExternalUsage,
} from '../../core/external-session/types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readUsage(value: unknown): ExternalUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = asNumber(value.input)
  const output = asNumber(value.output)
  if (input === undefined || output === undefined) return undefined
  return { input, output }
}

/** 运行中那一轮的进度；缺一个数就整体不认，避免半截读数误导。 */
export function readTurnProgress(value: unknown): ExternalTurnProgress | undefined {
  if (!isRecord(value)) return undefined
  const elapsed = asNumber(value.elapsed_ms)
  const idle = asNumber(value.idle_ms)
  const frames = asNumber(value.frames)
  const toolCalls = asNumber(value.tool_calls)
  const chars = asNumber(value.chars)
  if (elapsed === undefined || idle === undefined || frames === undefined
    || toolCalls === undefined || chars === undefined) return undefined
  return {
    elapsed_ms: elapsed,
    idle_ms: idle,
    frames,
    tool_calls: toolCalls,
    chars,
    tail: typeof value.tail === 'string' ? value.tail : '',
  }
}

/**
 * 一轮记录。运行中的那一轮没有结果与耗时（宿主给的就是这样），因此这两个字段
 * 一律可缺省；只有 `n` 与已知状态是硬要求。
 */
export function readTurnView(value: unknown): ExternalTurnView | undefined {
  if (!isRecord(value)) return undefined
  const n = asNumber(value.n)
  if (n === undefined) return undefined
  const status = isExternalTurnStatus(value.status)
    ? value.status
    : value.status === 'running'
      ? 'running' as ExternalTurnViewStatus
      : undefined
  if (status === undefined) return undefined
  const startedAt = asText(value.startedAt)
  const durationMs = asNumber(value.durationMs)
  const costUsd = asNumber(value.costUsd)
  const result = typeof value.result === 'string' ? value.result : undefined
  const usage = readUsage(value.usage)
  const turn: ExternalTurnView = { n, prompt: typeof value.prompt === 'string' ? value.prompt : '', status }
  if (startedAt !== undefined) turn.startedAt = startedAt
  if (durationMs !== undefined) turn.durationMs = durationMs
  if (usage !== undefined) turn.usage = usage
  if (costUsd !== undefined) turn.costUsd = costUsd
  if (result !== undefined) turn.result = result
  const progress = readTurnProgress(value.progress)
  if (progress !== undefined) turn.progress = progress
  if (value.partial === true) turn.partial = true
  return turn
}

/**
 * 一个会话。`id` 与 `status` 缺失就丢弃（没有它们面板无法选中、无法给状态）；
 * 其余字段给安全缺省，避免宿主版本差异直接打空白屏。
 */
export function readSessionView(value: unknown): ExternalSessionView | undefined {
  if (!isRecord(value)) return undefined
  const id = asText(value.id)
  if (id === undefined || !isExternalSessionStatus(value.status)) return undefined
  const turns = Array.isArray(value.turns)
    ? value.turns.flatMap(entry => { const turn = readTurnView(entry); return turn === undefined ? [] : [turn] })
    : []
  return {
    id,
    provider: isExternalProvider(value.provider) ? value.provider : 'claude',
    title: asText(value.title) ?? id,
    status: value.status,
    cwd: asText(value.cwd) ?? '',
    createdAt: asText(value.createdAt) ?? '',
    lastTurnAt: asText(value.lastTurnAt) ?? '',
    // 宿主一定给 canContinue；万一缺了，按「未关闭即可续」兜底。
    canContinue: typeof value.canContinue === 'boolean' ? value.canContinue : value.status !== 'closed',
    ...typeof value.originSessionId === 'string' && value.originSessionId !== ''
      ? { originSessionId: value.originSessionId }
      : {},
    turns,
  }
}

/**
 * 把宿主返回的列表载荷读成会话数组。接受数组、`{sessions}` 与 `{items}` 三种
 * 最外层包装，坏条目丢弃而不是整体失败。
 */
export function readSessionList(payload: unknown): readonly ExternalSessionView[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.sessions)
      ? payload.sessions
      : isRecord(payload) && Array.isArray(payload.items)
        ? payload.items
        : []
  return list.flatMap(entry => { const session = readSessionView(entry); return session === undefined ? [] : [session] })
}

/** 能否接续下一轮：宿主说不能、或已经关闭，都不能续。 */
export function canContinueSession(session: ExternalSessionView): boolean {
  return session.canContinue && session.status !== 'closed'
}