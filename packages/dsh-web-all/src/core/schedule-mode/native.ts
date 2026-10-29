/**
 * 原生 schedule 任务结构的**容忍解码**与归一化（host + client 共享）。
 *
 * 本层只依赖原生任务记录的公开字段（`kind` / `scheduledAt` / 各 selector 字段），
 * 不 import 原生包：原生 schedule bundle 是可选的实验 bundle，值导入会让
 * web-all 在没装它的 profile 里直接加载失败。记录形状来自
 * `@deepseek-ai/dsh-schedule` 的公开 `types.d.ts`。
 */
import type { ScheduleModeRule } from './types.ts'

/** 原生目录条目中本能力需要的最小事实。 */
export interface NativeTaskView {
  /** 任务绑定的会话（轮转后即运行会话）。 */
  readonly sessionId: string
  readonly id: string
  readonly status: 'active' | 'inactive'
  readonly title: string
  readonly prompt: string
  /** 已提交的下一次（或最后一次）时点。 */
  readonly scheduledAt: string
  readonly rule: ScheduleModeRule
  /** 最近一次确认投递；缺省表示尚未投递过。 */
  readonly lastDelivery?: { readonly scheduledAt: string; readonly deliveredAt: string }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 从一条原生任务记录解出计时规则；无法识别返回 undefined（调用方跳过该条）。 */
export function ruleFromRecord(record: unknown): ScheduleModeRule | undefined {
  if (record === null || typeof record !== 'object') return undefined
  const value = record as Record<string, unknown>
  const scheduledAt = str(value.scheduledAt)
  switch (value.kind) {
    case 'after': {
      const afterSeconds = num(value.afterSeconds)
      return afterSeconds === undefined ? undefined : { kind: 'after', afterSeconds }
    }
    case 'at':
      return scheduledAt === undefined ? undefined : { kind: 'at', at: scheduledAt }
    case 'every': {
      const everySeconds = num(value.everySeconds)
      return everySeconds === undefined ? undefined : { kind: 'every', everySeconds }
    }
    case 'daily': {
      const time = str(value.time)
      const timeZone = str(value.timeZone)
      return time === undefined || timeZone === undefined ? undefined : { kind: 'daily', time, timeZone }
    }
    case 'weekly': {
      const time = str(value.time)
      const timeZone = str(value.timeZone)
      const weekdays = Array.isArray(value.weekdays)
        ? value.weekdays.filter((day): day is number => typeof day === 'number' && Number.isInteger(day))
        : []
      return time === undefined || timeZone === undefined || weekdays.length === 0
        ? undefined
        : { kind: 'weekly', time, timeZone, weekdays }
    }
    case 'cron': {
      const expression = str(value.expression)
      const timeZone = str(value.timeZone)
      return expression === undefined || timeZone === undefined ? undefined : { kind: 'cron', expression, timeZone }
    }
    default:
      return undefined
  }
}

/**
 * 把原生 `catalog()` 条目解码成 `NativeTaskView`。
 * 结构不符的条目（例如未来新增的规则种类）返回 undefined，由调用方忽略，
 * 保证本能力不会因为原生形态演进整块失效。
 */
export function nativeTaskView(entry: unknown): NativeTaskView | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const value = entry as Record<string, unknown>
  const sessionId = str(value.sessionId)
  const id = str(value.id)
  const title = str(value.title)
  const prompt = str(value.prompt)
  const scheduledAt = str(value.scheduledAt)
  if (sessionId === undefined || id === undefined || title === undefined || prompt === undefined || scheduledAt === undefined) return undefined
  if (value.status !== 'active' && value.status !== 'inactive') throw new Error('native schedule catalog contains an unsupported task status')
  const rule = ruleFromRecord(value)
  if (rule === undefined) return undefined
  const delivery = value.lastDelivery
  const lastDelivery = delivery !== null && typeof delivery === 'object'
    ? (() => {
      const record = delivery as Record<string, unknown>
      const scheduled = str(record.scheduledAt)
      const delivered = str(record.deliveredAt)
      return scheduled === undefined || delivered === undefined ? undefined : { scheduledAt: scheduled, deliveredAt: delivered }
    })()
    : undefined
  return {
    sessionId, id, status: value.status, title, prompt, scheduledAt, rule,
    ...(lastDelivery === undefined ? {} : { lastDelivery }),
  }
}
