/**
 * schedule-mode 家族设置命名空间（`web-all` Config 的一个键）。
 *
 * 与其它能力域一致：schema 在模块顶层登记，装配器在所有服务域 import 求值
 * 完成后构建聚合 Config；读取走 `familyNamespace()`，因此改设置无需重挂插件。
 */
import { registerFamilyNamespace } from '../family-config.ts'
import z from 'schemastery'

export const SCHEDULE_MODE_SETTINGS_NAMESPACE = 'schedule-mode'

export interface ScheduleModeConfig {
  enabled?: boolean
  /** 给每条运行会话命名（`<任务名> · #N`）；关闭时使用运行时默认标题。 */
  nameRunSessions?: boolean
  /** 每个任务保留的运行记录条数。 */
  runHistoryLimit?: number
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  nameRunSessions: z.boolean().default(true),
  runHistoryLimit: z.number().step(1).min(1).default(50),
}) as unknown as z<ScheduleModeConfig>

registerFamilyNamespace(SCHEDULE_MODE_SETTINGS_NAMESPACE, Config)
