/**
 * 自动化任务「会话模式」纯逻辑（host + client 共享）。
 *
 * 背景：DSH 原生 `@deepseek-ai/dsh-schedule` 把任务绑定在创建它的会话上，
 * 到期后就地投递到该会话（`resolveAgent(sessionId)` + `followup`）。原生服务
 * 不提供「每次运行新建会话」的选择，也不允许跨会话投递。
 *
 * 本能力在原任务之上加一层**运行目标策略**，不复制原生调度引擎：
 *   - `original`（默认）：不建策略，完全走原生投递，行为零变化。
 *   - `new`：把原生任务「轮转」到一条运行会话上——策略保存原任务的规则，
 *     用原生 `schedule.create` 在一条新建的运行会话上挂一把同规则的运行副本，
 *     并删除原会话上的那行；每次副本投递完成后，再新建下一条运行会话并把
 *     副本轮转过去。原会话因此永远不再是投递目标，每次运行都落在一条全新会话。
 *
 * 轮转复用原生计时：副本自身按原规则推进 `scheduledAt`，到点由原生运行时投递，
 * 因此本层不需要自己实现 cron / 每日 / 每周的时点计算。
 *
 * 本文件只有类型与纯函数，两侧 program 共同编译。
 */

/** 任务的运行目标：绑定原会话，或每次运行新建会话。 */
export type ScheduleSessionMode = 'original' | 'new'

/**
 * 从原生任务记录归一化出来的计时规则；`timingArgs()` 可逆转回
 * `schedule.create` / `schedule.update` 的 selector 参数。
 */
export type ScheduleModeRule =
  | { readonly kind: 'after'; readonly afterSeconds: number }
  | { readonly kind: 'at'; readonly at: string }
  | { readonly kind: 'every'; readonly everySeconds: number }
  | { readonly kind: 'daily'; readonly time: string; readonly timeZone: string }
  | { readonly kind: 'weekly'; readonly time: string; readonly timeZone: string; readonly weekdays: readonly number[] }
  | { readonly kind: 'cron'; readonly expression: string; readonly timeZone: string }

/** 传给原生 `schedule.create` 的 selector 参数（恰好一个键）。 */
export type NativeTimingArgs =
  | { readonly after_seconds: number }
  | { readonly at: string }
  | { readonly every_seconds: number }
  | { readonly daily: { readonly time: string; readonly time_zone: string } }
  | { readonly weekly: { readonly time: string; readonly time_zone: string; readonly weekdays: readonly number[] } }
  | { readonly cron: { readonly expression: string; readonly time_zone: string } }

/** 原生 `schedule.create` 的最小请求面（prompt/title 由策略提供）。 */
export interface NativeCreateRequest {
  readonly prompt: string
  readonly title: string
  readonly selector: NativeTimingArgs
}

/** 一次「新会话运行」记录。 */
export interface ScheduleModeRun {
  /** 该次发生的计划时点（UTC RFC 3339）。 */
  readonly scheduledAt: string
  /** 原生确认投递的时间。 */
  readonly deliveredAt: string
  /** 承载该次运行的会话。 */
  readonly sessionId: string
  /** 该次运行使用的原生任务 id（轮转副本）。 */
  readonly taskId: string
}

/** A precise native row association; titles are never recovery identifiers. */
export interface ScheduleModeTaskRef {
  readonly sessionId: string
  readonly id: string
}

/**
 * Write-ahead transition journal. A persisted create intent without a returned ID
 * is ambiguous: the external port has no idempotency key or transactional lookup.
 * Recovery must stop rather than repeat that create.
 */
export interface ScheduleModeTransition {
  readonly kind: 'new' | 'original' | 'rotate' | 'stop' | 'delete' | 'complete'
  readonly phase: 'deleting' | 'prepare' | 'creating-session' | 'creating-task' | 'created' | 'recovery-required'
  readonly deleteTasks: readonly ScheduleModeTaskRef[]
  readonly sessionId?: string
  readonly created?: ScheduleModeTaskRef & { readonly scheduledAt: string }
  readonly reason?: string
}

/**
 * 「每次新建会话」策略。存在且 `active` 即表示该任务处于 `new` 模式；
 * 任务回到 `original` 后策略保留为历史（`active: false`）。
 */
export interface ScheduleModePolicy {
  /** 稳定键：`<原会话 id>\u0000<逻辑任务 id>`。 */
  readonly key: string
  /** 原会话（任务的创建会话）。 */
  readonly sourceSessionId: string
  /** 逻辑任务 id：用户最初创建的那条原生任务 id，轮转不改变它。 */
  readonly logicalId: string
  readonly title: string
  readonly prompt: string
  /** 原任务的计时规则；轮转始终按它重建副本。 */
  readonly rule: ScheduleModeRule
  /** 原会话的 cwd / preset，用于新建运行会话时继承。 */
  readonly cwd?: string
  readonly agentPreset?: string
  /** 当前挂着的轮转副本（原生任务 id）。 */
  readonly armedTaskId?: string
  /** 最近一次运行所在的会话。 */
  readonly runSessionId?: string
  /** 下一次运行的计划时点（用于展示与缺失副本时的重建）。 */
  readonly nextScheduledAt?: string
  /** 最近一次已记录运行的原生投递时间（幂等水位）。 */
  readonly lastDeliveredAt?: string
  readonly runs: readonly ScheduleModeRun[]
  /** 策略是否仍在生效。 */
  readonly active: boolean
  /**
   * 一次任务结束原因：`completed`（一次性任务已跑完）/ `ended`（用户切回原会话或被归档停止）/
   * `deleted`（用户在原生自动化页删掉了轮转副本，策略随之退役且不再重建）。
   */
  readonly endedReason?: 'completed' | 'ended' | 'deleted'
  /**
   * Legacy v1 interrupted rotation marker, retained for decoding compatibility.
   * It lacks create-result association and requested direction; recovery must
   * mark it recovery-required rather than recreate an unidentifiable task.
   */
  readonly rotationInFlight?: boolean
  readonly transition?: ScheduleModeTransition
  readonly createdAt: number
  readonly updatedAt: number
}

/** 每次运行新建会话标题前缀的最大长度（原生标题上限 120）。 */
export const RUN_TITLE_MAX = 120

/** 默认保留的运行记录条数。 */
export const DEFAULT_RUN_HISTORY_LIMIT = 50

/** 稳定策略键。 */
export function policyKey(sourceSessionId: string, logicalId: string): string {
  return `${sourceSessionId}\u0000${logicalId}`
}

/** 周期重复的规则种类。 */
export type RecurringScheduleModeRule = Extract<ScheduleModeRule, { kind: 'every' | 'daily' | 'weekly' | 'cron' }>

/** 规则是否周期重复（一次性规则跑完即结束）。 */
export function isRecurringRule(rule: ScheduleModeRule): rule is RecurringScheduleModeRule {
  return rule.kind === 'every' || rule.kind === 'daily' || rule.kind === 'weekly' || rule.kind === 'cron'
}

/** 规则到原生 selector 参数的映射。 */
export function timingArgs(rule: ScheduleModeRule): NativeTimingArgs {
  switch (rule.kind) {
    case 'after': return { after_seconds: rule.afterSeconds }
    case 'at': return { at: rule.at }
    case 'every': return { every_seconds: rule.everySeconds }
    case 'daily': return { daily: { time: rule.time, time_zone: rule.timeZone } }
    case 'weekly': return { weekly: { time: rule.time, time_zone: rule.timeZone, weekdays: [...rule.weekdays] } }
    case 'cron': return { cron: { expression: rule.expression, time_zone: rule.timeZone } }
  }
}

/**
 * 一次性规则在给定时刻之后是否还有目标。
 * 周期规则总是可重建（相位按原生 `create` 语义从保存时刻起算）。
 */
export function ruleCanArm(rule: ScheduleModeRule, now: number): boolean {
  if (isRecurringRule(rule)) return true
  if (rule.kind === 'after') return true
  return Number.isFinite(Date.parse(rule.at)) && Date.parse(rule.at) > now
}

/** 新运行会话的标题：`<任务名> · 第 N 次运行`，裁剪到原生上限。 */
export function runSessionTitle(title: string, runNumber: number): string {
  const suffix = ` · #${runNumber}`
  const room = RUN_TITLE_MAX - suffix.length
  const base = title.length > room ? title.slice(0, Math.max(0, room)) : title
  return `${base}${suffix}`
}

/** 追加一条运行记录并按上限裁剪（新记录优先保留）。 */
export function appendRun(runs: readonly ScheduleModeRun[], run: ScheduleModeRun, limit = DEFAULT_RUN_HISTORY_LIMIT): ScheduleModeRun[] {
  const budget = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_RUN_HISTORY_LIMIT
  return [...runs, run].slice(-budget)
}
