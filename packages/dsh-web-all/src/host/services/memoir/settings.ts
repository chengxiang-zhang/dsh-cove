/**
 * memoir host 服务域 —— 设置（全新实现；行为契约参考旧包）。
 *
 * 用户可调项：announceToAgent / autoDistill 开关、token 预算、读取上限、
 * 查询缓存等；持久化 ~/.dsh/dsh-memoir.settings.json。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MemoirSettings } from '../../../core/memoir/protocol.ts'

export type { MemoirSettings } from '../../../core/memoir/protocol.ts'

export const DEFAULT_MEMOIR_SETTINGS: MemoirSettings = {
  enabled: true,
  announceToAgent: false,
  autoDistill: true,
  autoDistillEvery: 1,
  autoDistillCooldownMin: 0,
  autoDistillMinTools: 1,
  hotMemoryTokens: 900,
  hotMemoryMaxTokens: 1200,
  readDefaultLimit: 8,
  readMaxLimit: 30,
  sessionSnapshotMax: 128,
  queryCacheSize: 128,
}

export function defaultSettingsPath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-memoir.settings.json')
}

/** 合并不完整记录为完整设置（非法字段回落默认）。 */
export function resolveMemoirSettings(value: unknown, defaults: MemoirSettings = DEFAULT_MEMOIR_SETTINGS): MemoirSettings {
  const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const num = (key: string, fallback: number): number => typeof input[key] === 'number' ? input[key] as number : fallback
  const bool = (key: string, fallback: boolean): boolean => typeof input[key] === 'boolean' ? input[key] as boolean : fallback
  return {
    enabled: bool('enabled', defaults.enabled),
    announceToAgent: bool('announceToAgent', defaults.announceToAgent),
    autoDistill: bool('autoDistill', defaults.autoDistill),
    autoDistillEvery: num('autoDistillEvery', defaults.autoDistillEvery),
    autoDistillCooldownMin: num('autoDistillCooldownMin', defaults.autoDistillCooldownMin),
    autoDistillMinTools: num('autoDistillMinTools', defaults.autoDistillMinTools),
    hotMemoryTokens: num('hotMemoryTokens', defaults.hotMemoryTokens),
    hotMemoryMaxTokens: num('hotMemoryMaxTokens', defaults.hotMemoryMaxTokens),
    readDefaultLimit: num('readDefaultLimit', defaults.readDefaultLimit),
    readMaxLimit: num('readMaxLimit', defaults.readMaxLimit),
    sessionSnapshotMax: num('sessionSnapshotMax', defaults.sessionSnapshotMax),
    queryCacheSize: num('queryCacheSize', defaults.queryCacheSize),
  }
}

/** 数值型设置键（布尔键不参与范围校验）。 */
type NumericSettingKey = { [K in keyof MemoirSettings]: MemoirSettings[K] extends number ? K : never }[keyof MemoirSettings]

/**
 * 校验设置补丁（非法返回错误字符串）。
 *
 * 规则与设置界面允许的范围一致：计数类必须是不小于 1 的安全整数，冷却分钟数
 * 允许 0，合并后的上限不得小于对应下限。宿主是边界，界面里的夹取不算数。
 * @param payload - 调用方提交的补丁。
 * @param base - 当前设置（跨字段规则按合并结果判断）。
 * @returns 错误信息，或 undefined 表示合法。
 */
export function validateMemoirSettingsPatch(payload: unknown, base: MemoirSettings = DEFAULT_MEMOIR_SETTINGS): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return 'body must be a JSON object'
  const input = payload as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!(key in base)) return `unknown setting: ${key}`
  }
  for (const [key, value] of Object.entries(input)) {
    if (typeof base[key as keyof MemoirSettings] === 'boolean' && typeof value !== 'boolean') return `${key} must be a boolean`
    if (typeof base[key as keyof MemoirSettings] === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `${key} must be a finite number`
  }
  const merged = { ...base, ...input } as MemoirSettings
  const numericKeys = (Object.keys(base) as Array<keyof MemoirSettings>)
    .filter((key): key is NumericSettingKey => typeof base[key] === 'number')
  for (const key of numericKeys) {
    const value = merged[key]
    if (key === 'autoDistillCooldownMin') {
      if (!Number.isFinite(value) || value < 0) return `${key} must be zero or greater`
      continue
    }
    if (!Number.isSafeInteger(value) || value < 1) return `${key} must be a whole number of at least 1`
  }
  if (merged.hotMemoryMaxTokens < merged.hotMemoryTokens) return 'hotMemoryMaxTokens must be at least hotMemoryTokens'
  if (merged.readMaxLimit < merged.readDefaultLimit) return 'readMaxLimit must be at least readDefaultLimit'
  return undefined
}

/** 设置存储。 */
export class MemoirSettingsStore {
  private readonly listeners = new Set<(settings: MemoirSettings) => void>()

  constructor(private readonly file: string = defaultSettingsPath()) {}

  load(): MemoirSettings {
    if (!existsSync(this.file)) return { ...DEFAULT_MEMOIR_SETTINGS }
    try {
      return resolveMemoirSettings(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return { ...DEFAULT_MEMOIR_SETTINGS }
    }
  }

  save(settings: MemoirSettings): void {
    const dir = dirname(this.file)
    mkdirSync(dir, { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(settings, null, 2), 'utf8')
    renameSync(temp, this.file)
    for (const listener of this.listeners) listener(settings)
  }

  subscribe(listener: (settings: MemoirSettings) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}