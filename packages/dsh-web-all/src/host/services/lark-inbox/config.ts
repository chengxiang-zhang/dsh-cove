/**
 * Lark inbox settings schema and host-side path/credential resolution.
 *
 * Credentials moved to the shared `feishu` namespace when the reply path landed:
 * one Feishu application now serves the inbound bot, the outbound run-finished
 * push and the answers the agent writes, and three namespaces disagreeing about
 * which application that is was the bug. The three credential fields below stay
 * in the schema and stay readable so an installation configured before the move
 * keeps its bot, but they are deprecated: the setup wizard writes the shared
 * namespace (`feishu`) and nothing here writes these back.
 *
 * `resolveAppSecret` is kept as an export because other code and tests of the
 * pre-move shape still call it; it now delegates the `env:NAME` form to the
 * shared secret reader, so both spellings behave identically.
 */

import { join } from 'node:path'
import { registerFamilyNamespace } from '../family-config.ts'
import { readSecret } from '../feishu/credentials.ts'
import z from 'schemastery'

export const LARK_INBOX_SETTINGS_NAMESPACE = 'lark-inbox'
export const DEFAULT_QUEUE_DIR = ''
/** Ambient secret variable of the pre-move shape; the shared domain also reads it. */
export const LARK_APP_SECRET_ENV = 'LARK_APP_SECRET'
export const LARK_DOMAINS = ['feishu', 'lark'] as const

export interface LarkInboxConfig {
  enabled?: boolean
  announceToAgent?: boolean
  /** @deprecated read-only legacy field; the wizard writes the `feishu` namespace instead. */
  appId?: string
  /** @deprecated read-only legacy field; the wizard writes the `feishu` namespace instead. */
  appSecret?: string
  /** @deprecated read-only legacy field; the wizard writes the `feishu` namespace instead. */
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
  // Deprecated, kept for reading an installation configured before the shared
  // `feishu` namespace existed. The wizard no longer writes these.
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

/**
 * Resolve the legacy per-namespace secret.
 *
 * Kept for the pre-move shape and its callers; the shared reader decides what an
 * `env:NAME` reference means so both spellings cannot drift.
 * @param config - the `lark-inbox` namespace value.
 * @param env - the environment to read ambient variables from.
 * @returns the secret.
 * @throws when no secret can be resolved, because a bot without one cannot connect.
 */
export function resolveAppSecret(config: LarkInboxConfig | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const raw = (config?.appSecret ?? '').trim()
  const secret = raw === '' ? '' : readSecret(raw, env, 'dsh-lark-inbox')
  if (secret !== '') return secret
  const ambient = env[LARK_APP_SECRET_ENV]
  if (ambient !== undefined && ambient !== '') return ambient
  throw new Error('dsh-lark-inbox: 未配置 appSecret；请改用「飞书」设置页填写应用凭据、或填写 env:VARNAME 引用环境变量、或导出 LARK_APP_SECRET 环境变量')
}

export function resolveQueueDir(config: LarkInboxConfig | undefined, dshHomeDir: string): string {
  const raw = config?.queueDir ?? DEFAULT_QUEUE_DIR
  return raw.trim() === '' ? join(dshHomeDir, 'lark-inbox') : raw
}

export function effectiveConfig(config: LarkInboxConfig | undefined): Required<LarkInboxConfig> {
  return Config(config ?? {}) as Required<LarkInboxConfig>
}