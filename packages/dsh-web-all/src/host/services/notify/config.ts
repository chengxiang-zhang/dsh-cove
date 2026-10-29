/**
 * Notification settings schema and host-side credential resolution.
 *
 * The notification capability is the outbound half of the Lark integration the
 * `lark-inbox` domain owns the inbound half of: a run finishes, and the person
 * who started it is told. It therefore needs the same Feishu application
 * credentials, and it borrows them when it has none of its own — one bot,
 * configured once. That fallback is deliberate rather than implicit: a
 * deployment that only ever configured the inbox still gets notifications, and
 * one that wants a separate sender can say so by filling in these fields.
 */

import { registerFamilyNamespace } from '../family-config.ts'
import z from 'schemastery'
import {
  NOTIFY_DEFAULT_LIMIT,
  NOTIFY_MAX_LIMIT,
  type NotifyOutcome,
} from '../../../core/notify/contract.ts'
import { LARK_APP_SECRET_ENV, type LarkInboxConfig } from '../lark-inbox/config.ts'

/** Key this capability occupies inside the aggregated `web-all` entry. */
export const NOTIFY_SETTINGS_NAMESPACE = 'notify'

/** Ambient environment variable consulted when no secret is configured. */
export const NOTIFY_APP_SECRET_ENV = 'NOTIFY_FEISHU_APP_SECRET'

/** Feishu deployments the sender knows how to address. */
export const NOTIFY_DOMAINS = ['feishu', 'lark'] as const

/** When the push is delivered relative to a run's turns. */
export const NOTIFY_MODES = ['idle', 'each-turn'] as const

/** Outcomes a deployment may choose to be told about. */
export const NOTIFY_OUTCOMES = ['completed', 'failed', 'stopped'] as const

/** The notification capability's slice of the family settings document. */
export interface NotifyConfig {
  /** Whether the feed route and the subscribers run at all. */
  enabled?: boolean
  /**
   * Notices one feed read returns when the caller does not ask for a size.
   *
   * Retention is separate and fixed at the contract's maximum, so changing this
   * value never renumbers notices and a client's stored watermark stays valid.
   */
  feedLimit?: number
  /** Whether finished runs are pushed to Feishu. */
  feishuEnabled?: boolean
  /** Feishu/Lark application id; blank borrows the inbox's. */
  feishuAppId?: string
  /** Feishu/Lark application secret; `env:NAME` reads an environment variable. */
  feishuAppSecret?: string
  /** Which Feishu deployment to address. */
  feishuDomain?: 'feishu' | 'lark'
  /** Open ids (or chat ids) to notify. */
  feishuRecipients?: string[]
  /**
   * `idle` sends one message when the agent stops working, which is what a
   * notification is for; `each-turn` sends one per finished turn and is useful
   * for watching a long job step by step.
   */
  feishuMode?: 'idle' | 'each-turn'
  /** Outcomes worth interrupting someone for. */
  feishuOutcomes?: NotifyOutcome[]
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  feedLimit: z.number().step(1).min(1).max(NOTIFY_MAX_LIMIT).default(NOTIFY_DEFAULT_LIMIT),
  feishuEnabled: z.boolean().default(false),
  feishuAppId: z.string().default(''),
  feishuAppSecret: z.string().role('secret').default(''),
  feishuDomain: z.union(NOTIFY_DOMAINS).default('feishu'),
  feishuRecipients: z.array(z.string()).default([]),
  feishuMode: z.union(NOTIFY_MODES).default('idle'),
  feishuOutcomes: z.array(z.union(NOTIFY_OUTCOMES)).default(['completed', 'failed']),
}) as unknown as z<NotifyConfig>

registerFamilyNamespace(NOTIFY_SETTINGS_NAMESPACE, Config)

/**
 * Fill every absent field with its documented default.
 * @param config - the namespace value as stored, possibly partial.
 * @returns a complete configuration.
 */
export function effectiveConfig(config: NotifyConfig | undefined): Required<NotifyConfig> {
  return Config(config ?? {}) as Required<NotifyConfig>
}

/** Resolved credentials the sender can actually use. */
export interface FeishuCredentials {
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  /** Which namespace supplied them, for diagnostics. */
  source: 'notify' | 'lark-inbox'
}

/**
 * Read a secret field that may be a literal, an `env:NAME` reference, or blank.
 *
 * The ambient variable is only consulted for the inbox's own field name, so a
 * deployment that hard-codes a secret in `notify` never silently picks up an
 * unrelated environment value.
 *
 * @param raw - the configured value.
 * @param ambientVar - environment variable to consult when `raw` is blank.
 * @param env - the environment to read.
 * @returns the secret, or '' when nothing supplied one.
 * @throws when an `env:` reference names no variable or that variable is empty.
 */
export function resolveSecret(raw: string | undefined, ambientVar: string | undefined, env: NodeJS.ProcessEnv): string {
  const value = raw ?? ''
  if (value.startsWith('env:')) {
    const name = value.slice('env:'.length).trim()
    if (name === '') throw new Error('dsh-notify: 密钥的 env: 引用缺少变量名（例如 env:NOTIFY_FEISHU_APP_SECRET）')
    const resolved = env[name]
    if (resolved === undefined || resolved === '') {
      throw new Error(`dsh-notify: 密钥引用的环境变量 ${name} 未设置或为空`)
    }
    return resolved
  }
  if (value.trim() !== '') return value
  if (ambientVar === undefined) return ''
  const ambient = env[ambientVar]
  return ambient ?? ''
}

/**
 * Decide which Feishu application sends the notifications.
 *
 * `notify`'s own fields win; a blank `feishuAppId` borrows the inbox's
 * application, because both halves are the same bot. The ambient environment
 * variables are consulted per namespace (`NOTIFY_FEISHU_APP_SECRET` for this
 * capability, `LARK_APP_SECRET` for the inbox's).
 *
 * @param config - the notification namespace value.
 * @param inbox - the inbox namespace value, used only as a fallback.
 * @param env - the environment to read secrets from.
 * @returns the credentials, or null when no application is configured.
 * @throws when a configured secret reference cannot be resolved.
 */
export function resolveFeishuCredentials(
  config: NotifyConfig | undefined,
  inbox: LarkInboxConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FeishuCredentials | null {
  const own = effectiveConfig(config)
  const ownSecret = resolveSecret(own.feishuAppSecret, NOTIFY_APP_SECRET_ENV, env)
  if (own.feishuAppId.trim() !== '' && ownSecret !== '') {
    return { appId: own.feishuAppId.trim(), appSecret: ownSecret, domain: own.feishuDomain, source: 'notify' }
  }
  const borrowedSecret = resolveSecret(inbox?.appSecret, LARK_APP_SECRET_ENV, env)
  const borrowedId = (inbox?.appId ?? '').trim()
  if (borrowedId !== '' && borrowedSecret !== '') {
    return { appId: borrowedId, appSecret: borrowedSecret, domain: inbox?.domain ?? 'feishu', source: 'lark-inbox' }
  }
  return null
}

/**
 * Trim, de-duplicate and drop blanks from a recipient list.
 * @param recipients - the configured list, of unknown quality.
 * @returns the usable recipients in first-seen order.
 */
export function normalizeRecipients(recipients: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of recipients ?? []) {
    if (typeof entry !== 'string') continue
    const value = entry.trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}