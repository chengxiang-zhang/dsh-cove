/**
 * 面板/Host 之间的 wire 视图（host 与 browser 共享）。
 *
 * 面板只读这一份形状：Host 把「原生任务」与「会话模式策略」合并成一条
 * 逻辑任务，客户端不接触原生 schedule 的目录细节。
 */
import type { ScheduleModeRule, ScheduleModeRun, ScheduleSessionMode } from './types.ts'

export type { ScheduleModeRule, ScheduleModeRun, ScheduleSessionMode } from './types.ts'

/** 一条逻辑任务的合并视图。 */
export interface ScheduleModeTaskView {
  /** 任务的原会话（原始对话）。 */
  readonly sessionId: string
  /** 稳定的逻辑任务 id（`new` 模式下与当前副本 id 不同）。 */
  readonly id: string
  /** 当前挂着的原生任务 id（`new` 模式下是轮转副本）。 */
  readonly activeTaskId?: string
  readonly title: string
  readonly prompt: string
  readonly mode: ScheduleSessionMode
  /** `inactive`：原生一次性任务已跑完；`ended`：策略已停止。 */
  readonly status: 'active' | 'inactive' | 'ended'
  readonly rule: ScheduleModeRule
  /** 下一次运行的计划时点（UTC）；已结束或不可知时缺省。 */
  readonly scheduledAt?: string
  /** 最近一次运行所在的会话（`new` 模式）。 */
  readonly runSessionId?: string
  readonly lastDeliveredAt?: string
  /** 运行记录，最新在后。 */
  readonly runs: readonly ScheduleModeRun[]
  /** Interrupted journal state; no exactly-once guarantee is implied. */
  readonly recovery?: { readonly phase: string; readonly reason?: string }
  readonly updatedAt: number
}

/** `GET /tasks` 的 value。 */
export interface ScheduleModeListValue {
  readonly tasks: readonly ScheduleModeTaskView[]
  /** 原生 schedule 服务是否可用；不可用时列表为空。 */
  readonly available: boolean
}

/** 路由前缀（面板 API）。 */
export const SCHEDULE_MODE_API_PREFIX = '/api/schedule-mode'
