/**
 * The single decision of which Feishu application this host uses.
 *
 * Three consumers ask this question — the inbound bot connection, the outbound
 * run-finished push, and the reply path — and before this module existed each
 * one answered it slightly differently: one threw when the secret was missing,
 * another returned an empty string and silently stopped sending. The rule is now
 * written once:
 *
 * - No application id anywhere: `null`. Nothing is configured; not an error.
 * - An application id with no resolvable secret: throw. A half-configured bot
 *   is an operator mistake, and guessing (running unauthenticated, or quietly
 *   borrowing another application) hides it.
 *
 * The legacy `lark-inbox` fields are still read so an installation configured
 * before the namespace moved keeps its bot; they are never written back.
 */

import {
  FEISHU_APP_SECRET_ENV,
  LEGACY_APP_SECRET_ENV,
  effectiveConfig,
  type FeishuConfig,
  type FeishuDomain,
} from './config.ts'

/** Resolved credentials a consumer can actually use. */
export interface FeishuCredentials {
  appId: string
  appSecret: string
  domain: FeishuDomain
  /** Signalled source of the application id. */
  source: 'feishu' | 'lark-inbox'
  /** Where the secret came from; `env` means an ambient variable supplied it. */
  secretSource: 'feishu' | 'lark-inbox' | 'env'
}

/** The pre-`feishu`-namespace shape, read-only from here on. */
export interface LegacyFeishuConfig {
  appId?: string
  appSecret?: string
  domain?: FeishuDomain
}

/** Everything the resolver consults, in priority order. */
export interface FeishuCredentialSources {
  /** `notify`'s own fields: per-field overrides of the shared namespace. */
  overrides?: FeishuConfig
  /** The shared `feishu` namespace. */
  feishu?: FeishuConfig
  /** The legacy `lark-inbox` fields, read for backward compatibility. */
  legacyInbox?: LegacyFeishuConfig
  env?: NodeJS.ProcessEnv
}

const LEGACY_ENV_ALIASES: readonly string[] = [FEISHU_APP_SECRET_ENV, LEGACY_APP_SECRET_ENV]

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed !== '') return trimmed
  }
  return ''
}

/**
 * Read one secret field that may be a literal, an `env:NAME` reference, or blank.
 *
 * @param raw - the configured value.
 * @param env - the environment to read.
 * @param label - namespace name used in error text.
 * @returns the secret, or '' when the field supplies nothing.
 * @throws when an `env:` reference names no variable or that variable is empty.
 */
export function readSecret(raw: string | undefined, env: NodeJS.ProcessEnv, label: string): string {
  const value = raw ?? ''
  if (!value.startsWith('env:')) return value.trim()
  const name = value.slice('env:'.length).trim()
  if (name === '') throw new Error(`${label}: 密钥的 env: 引用缺少变量名（例如 env:FEISHU_APP_SECRET）`)
  const resolved = env[name]
  if (resolved === undefined || resolved === '') {
    throw new Error(`${label}: 密钥引用的环境变量 ${name} 未设置或为空`)
  }
  return resolved
}

/**
 * Decide which Feishu application this host uses.
 *
 * @param sources - namespace values and the environment, in priority order.
 * @returns the usable credentials, or null when no application is configured.
 * @throws when an application id exists but no secret can be resolved, or when a
 *   configured `env:` reference points at nothing. Callers decide whether that
 *   disables the capability (inbound) or drops the sender (outbound); it must not
 *   become a silent no-op in either.
 */
export function resolveFeishuCredentials(sources: FeishuCredentialSources = {}): FeishuCredentials | null {
  const env = sources.env ?? process.env
  const shared = effectiveConfig(sources.feishu)
  const override = effectiveConfig(sources.overrides)
  const legacy = sources.legacyInbox ?? {}

  const overrideId = override.appId.trim() !== '' ? override.appId.trim() : ''
  const sharedId = shared.appId.trim()
  const legacyId = (legacy.appId ?? '').trim()

  let appId = firstNonEmpty(overrideId, sharedId, legacyId)
  if (appId === '') return null
  let source: FeishuCredentials['source'] = overrideId !== '' || sharedId !== '' ? 'feishu' : 'lark-inbox'

  let secret = ''
  let secretSource: FeishuCredentials['secretSource'] = 'feishu'
  const ownSecret = firstNonEmpty(override.appSecret, shared.appSecret)
  if (ownSecret !== '') {
    secret = readSecret(ownSecret, env, 'feishu')
    secretSource = 'feishu'
  } else if ((legacy.appSecret ?? '').trim() !== '') {
    secret = readSecret(legacy.appSecret, env, 'feishu')
    secretSource = 'lark-inbox'
    if (appId === legacyId) source = 'lark-inbox'
  } else {
    for (const name of LEGACY_ENV_ALIASES) {
      const ambient = env[name]
      if (ambient !== undefined && ambient !== '') { secret = ambient; secretSource = 'env'; break }
    }
  }

  if (secret === '') {
    throw new Error(`feishu: 已配置 appId（${appId}）但找不到 appSecret；请在「飞书」设置页填写，或用 env:VARNAME 引用环境变量，或导出 ${FEISHU_APP_SECRET_ENV}`)
  }

  const domain = source === 'lark-inbox'
    ? (legacy.domain ?? shared.domain)
    : (overrideId !== '' ? override.domain : shared.domain)

  return { appId, appSecret: secret, domain, source, secretSource }
}

/**
 * One-line description of where the credentials came from, for logs.
 * @param credentials - resolved credentials.
 * @returns a short label such as `feishu:cli_x (secret from env)`.
 */
export function describeFeishuCredentials(credentials: FeishuCredentials): string {
  const secret = credentials.secretSource === 'env' ? 'env' : credentials.secretSource
  return `${credentials.source}:${credentials.appId} (${credentials.domain}, secret from ${secret})`
}