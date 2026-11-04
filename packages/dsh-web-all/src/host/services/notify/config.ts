/**
 * Notification settings schema and host-side credential resolution.
 *
 * The notification capability is the outbound half of the Feishu integration the
 * `lark-inbox` domain owns the inbound half of: a run finishes, and the person
 * who started it is told. Both halves, and the reply path, address one Feishu
 * application, and the decision of which application that is now belongs to the
 * shared `feishu` credential domain (`services/feishu/credentials.ts`). This
 * module only contributes the outbound half's own fields to that decision and
 * stays a plain module with no Cordis dependency, so it can be read and tested
 * on its own; the namespace reads that need the family bridge live in
 * `notify/index.ts`.
 *
 * Two rules differ from the bare shared decision, and both exist so a
 * half-configured push cannot quietly go out under the wrong bot:
 *
 * - A filled `feishuAppId` is an explicit choice of application. Its secret must
 *   therefore belong to that same application: this capability's own
 *   `feishuAppSecret`, or the shared namespace's secret when it names the same
 *   application id. A blank secret is an error rather than an invitation to
 *   borrow the inbound bot's secret.
 * - With no `feishuAppId` the shared `feishu` namespace, then the legacy
 *   `lark-inbox` fields, decide: one bot, configured once, still the default.
 */

import { registerFamilyNamespace } from '../family-config.ts'
import z from 'schemastery'
import {
  NOTIFY_DEFAULT_LIMIT,
  NOTIFY_MAX_LIMIT,
  type NotifyOutcome,
} from '../../../core/notify/contract.ts'
import { FEISHU_APP_SECRET_ENV, type FeishuConfig } from '../feishu/config.ts'
import {
  readSecret,
  resolveFeishuCredentials as resolveSharedFeishuCredentials,
  type FeishuCredentials,
  type LegacyFeishuConfig,
} from '../feishu/credentials.ts'

/** Key this capability occupies inside the aggregated `web-all` entry. */
export const NOTIFY_SETTINGS_NAMESPACE = 'notify'

/**
 * Ambient environment variable this capability used to own.
 *
 * Kept as an export and still honored, mapped onto the shared
 * `FEISHU_APP_SECRET` variable: a deployment that exported it before the
 * credentials moved into a shared namespace keeps sending without an edit.
 *
 * @deprecated configure the application in the shared `feishu` namespace, or
 *   export `FEISHU_APP_SECRET`.
 */
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
  /**
   * Feishu/Lark application id; blank reuses the shared `feishu` application.
   *
   * Filling it is a promise that this capability sends as that application, so
   * a filled id without its own secret is reported as a configuration error
   * instead of falling back to another bot.
   */
  feishuAppId?: string
  /** Feishu/Lark application secret; `env:NAME` reads an environment variable. */
  feishuAppSecret?: string
  /** Which Feishu deployment to address. */
  feishuDomain?: 'feishu' | 'lark'
  /** Open ids (`ou_…`) or chat ids (`oc_…`) to notify. */
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

// The credentials type is the shared domain's, re-exported so consumers of this
// module keep one import and cannot drift into a local shape.
export type { FeishuCredentials } from '../feishu/credentials.ts'

/**
 * Fill every absent field with its documented default.
 * @param config - the namespace value as stored, possibly partial.
 * @returns a complete configuration.
 */
export function effectiveConfig(config: NotifyConfig | undefined): Required<NotifyConfig> {
  return Config(config ?? {}) as Required<NotifyConfig>
}

/** Everything the outbound credential decision consults, highest priority first. */
export interface NotifyCredentialSources {
  /** This capability's own fields: an explicit choice of application. */
  notify?: NotifyConfig
  /** The shared `feishu` namespace, the deployment's default application. */
  feishu?: FeishuConfig
  /** The legacy `lark-inbox` fields, read for backward compatibility. */
  legacyInbox?: LegacyFeishuConfig
  /** Environment the `env:` references and ambient variables are read from. */
  env?: NodeJS.ProcessEnv
}

/**
 * Read a secret field that may be a literal, an `env:NAME` reference, or blank.
 *
 * The parsing itself is the credential domain's `readSecret`: two
 * implementations of `env:` were exactly the drift this migration removes. The
 * ambient fallback stays here because it is a per-capability policy — which
 * variable an unconfigured deployment may rely on — rather than a property of
 * the shared application.
 *
 * @param raw - the configured value.
 * @param ambientVar - environment variable to consult when `raw` is blank.
 * @param env - the environment to read.
 * @returns the secret, or '' when nothing supplied one.
 * @throws when an `env:` reference names no variable or that variable is empty.
 */
export function resolveSecret(raw: string | undefined, ambientVar: string | undefined, env: NodeJS.ProcessEnv): string {
  if ((raw ?? '').trim() === '') return ambientVar === undefined ? '' : env[ambientVar] ?? ''
  return readSecret(raw, env, 'dsh-notify')
}

/**
 * Let the capability's historical ambient variable reach the shared resolver.
 *
 * It is mapped onto the shared variable instead of being read separately so the
 * legacy name cannot answer a question the shared domain did not ask. An
 * explicitly set shared variable always wins, and the caller's environment is
 * never mutated.
 *
 * @param env - the environment to read.
 * @returns the same object, or a copy carrying the mapped alias.
 */
function withLegacyAmbient(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const legacy = env[NOTIFY_APP_SECRET_ENV]
  if (legacy === undefined || legacy === '' || env[FEISHU_APP_SECRET_ENV] !== undefined) return env
  return { ...env, [FEISHU_APP_SECRET_ENV]: legacy }
}

/**
 * Credentials for the application this capability names explicitly.
 *
 * The secret is only read from a source that belongs to the same application:
 * this capability's own field, or the shared namespace when it carries the same
 * application id. The inbound bot's fields are deliberately unreachable from
 * here, because borrowing them is what turned "I forgot the secret" into
 * "notifications were sent by a bot I did not choose".
 *
 * @param own - this capability's complete configuration.
 * @param ownId - its non-empty application id.
 * @param feishu - the shared namespace, used only for a same-application secret.
 * @param env - the environment `env:` references are read from.
 * @returns the credentials for that application.
 * @throws when that application's secret cannot be resolved.
 */
function ownApplication(
  own: Required<NotifyConfig>,
  ownId: string,
  feishu: FeishuConfig | undefined,
  env: NodeJS.ProcessEnv,
): FeishuCredentials {
  const sharedId = (feishu?.appId ?? '').trim()
  const sharedSecret = feishu?.appSecret ?? ''
  let secret = ''
  if ((own.feishuAppSecret ?? '').trim() !== '') {
    secret = readSecret(own.feishuAppSecret, env, 'dsh-notify')
  } else if (sharedId === ownId && sharedSecret.trim() !== '') {
    // Same application, configured once: the shared secret is this bot's own.
    secret = readSecret(sharedSecret, env, 'feishu')
  }
  if (secret === '') {
    throw new Error(`dsh-notify: 已填写 feishuAppId（${ownId}）但找不到该应用的 feishuAppSecret；请在「通知」页填写，或用 env:VARNAME 引用环境变量，或清空 feishuAppId 以沿用共享的「飞书」应用`)
  }
  return { appId: ownId, appSecret: secret, domain: own.feishuDomain, source: 'feishu', secretSource: 'feishu' }
}

/**
 * Decide which Feishu application sends the notifications.
 *
 * @param sources - the three namespaces and the environment, in priority order.
 * @returns the credentials, or null when no application is configured at all.
 * @throws when an application id exists but no secret belonging to it can be
 *   resolved. The caller drops the sender and warns; the failure must not become
 *   a silent no-op, and must not be papered over with another bot's secret.
 */
export function resolveFeishuCredentials(sources: NotifyCredentialSources = {}): FeishuCredentials | null {
  const own = effectiveConfig(sources.notify)
  const env = sources.env ?? process.env
  const ownId = own.feishuAppId.trim()
  if (ownId !== '') return ownApplication(own, ownId, sources.feishu, env)
  return resolveSharedFeishuCredentials({
    feishu: sources.feishu,
    legacyInbox: sources.legacyInbox,
    env: withLegacyAmbient(env),
  })
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