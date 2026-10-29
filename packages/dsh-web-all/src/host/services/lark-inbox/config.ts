/** Lark inbox settings schema and host-side credential/path resolution. */

import { join } from 'node:path'
import { registerFamilyNamespace } from '../family-config.ts'
import z from 'schemastery'

export const LARK_INBOX_SETTINGS_NAMESPACE = 'lark-inbox'
export const DEFAULT_QUEUE_DIR = ''
export const LARK_APP_SECRET_ENV = 'LARK_APP_SECRET'
export const LARK_DOMAINS = ['feishu', 'lark'] as const

export interface LarkInboxConfig {
  enabled?: boolean
  announceToAgent?: boolean
  appId?: string
  appSecret?: string
  domain?: 'feishu' | 'lark'
  requireMentionInGroup?: boolean
  allowedOpenIds?: string[]
  dropAppMessages?: boolean
  queueDir?: string
  maxAttempts?: number
  staleTimeoutMs?: number
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(false),
  appId: z.string().default(''),
  appSecret: z.string().role('secret').default(''),
  domain: z.union(LARK_DOMAINS).default('feishu'),
  requireMentionInGroup: z.boolean().default(true),
  allowedOpenIds: z.array(z.string()).default([]),
  dropAppMessages: z.boolean().default(true),
  queueDir: z.string().default(DEFAULT_QUEUE_DIR),
  maxAttempts: z.number().step(1).min(1).default(5),
  staleTimeoutMs: z.number().step(1).min(1).default(300_000),
}) as unknown as z<LarkInboxConfig>

registerFamilyNamespace(LARK_INBOX_SETTINGS_NAMESPACE, Config)

export function resolveAppSecret(config: LarkInboxConfig | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const raw = config?.appSecret ?? ''
  if (raw.startsWith('env:')) {
    const name = raw.slice('env:'.length).trim()
    if (name === '') throw new Error('dsh-lark-inbox: appSecret 的 env: 引用缺少变量名（例如 env:LARK_APP_SECRET）')
    const value = env[name]
    if (value === undefined || value === '') {
      throw new Error(`dsh-lark-inbox: appSecret 引用的环境变量 ${name} 未设置或为空；请在设置里填写 appSecret、或使用 env:VARNAME 引用、或导出 ${name}`)
    }
    return value
  }
  if (raw.trim() !== '') return raw
  const ambient = env[LARK_APP_SECRET_ENV]
  if (ambient !== undefined && ambient !== '') return ambient
  throw new Error('dsh-lark-inbox: 未配置 appSecret；需要在设置里填写 appSecret、或填写 env:VARNAME 引用环境变量、或导出 LARK_APP_SECRET 环境变量')
}

export function resolveQueueDir(config: LarkInboxConfig | undefined, dshHomeDir: string): string {
  const raw = config?.queueDir ?? DEFAULT_QUEUE_DIR
  return raw.trim() === '' ? join(dshHomeDir, 'lark-inbox') : raw
}

export function effectiveConfig(config: LarkInboxConfig | undefined): Required<LarkInboxConfig> {
  return Config(config ?? {}) as Required<LarkInboxConfig>
}
