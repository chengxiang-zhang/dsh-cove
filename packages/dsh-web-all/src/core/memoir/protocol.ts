/**
 * memoir 跨半区 wire 契约（host 与 client 双 program 编译）。
 *
 * 常量 + 纯类型：/api/dsh-memoir 前缀、section 枚举、条目/设置 shape。
 * 不携带运行时身份。
 */

export const MEMOIR_API_PREFIX = '/api/dsh-memoir'

/** 记忆分区。 */
export type SectionKey = 'work' | 'lessons' | 'actions' | 'note'
export const SECTION_KEYS: readonly SectionKey[] = ['work', 'lessons', 'actions', 'note']

/** 条目状态。 */
export type MemoirStatus = 'active' | 'superseded' | 'archived'

/** 一个记忆条目（与路由/README 渲染契约一致）。 */
export interface MemoirEntry {
  id: string
  title: string
  content: string
  section: SectionKey
  status: MemoirStatus
  createdAt: number
  updatedAt: number
  pinned: boolean
  importance: number
  tags?: string[]
  supersedes?: string[]
}

/** 用户可调设置。 */
export interface MemoirSettings {
  enabled: boolean
  announceToAgent: boolean
  autoDistill: boolean
  autoDistillEvery: number
  autoDistillCooldownMin: number
  autoDistillMinTools: number
  hotMemoryTokens: number
  hotMemoryMaxTokens: number
  readDefaultLimit: number
  readMaxLimit: number
  sessionSnapshotMax: number
  queryCacheSize: number
}