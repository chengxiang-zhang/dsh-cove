/**
 * Shared Feishu application credentials.
 *
 * One Feishu application is used by every web-all capability that talks to the
 * platform: the inbound bot connection (`lark-inbox`), the outbound run-finished
 * push (`notify`), and the reply path the agent uses to answer an inbound
 * message. This namespace is the one place an operator configures it, so the
 * three consumers cannot drift into different answers for "which bot is this".
 *
 * The secret stays out of every response: the host strips `role('secret')`
 * fields from what the settings UI reads. `env:NAME` is the recommended form for
 * deployments that would rather keep the secret out of the profile document.
 */

import z from 'schemastery'
import { registerFamilyNamespace } from '../family-config.ts'

/** Namespace this capability occupies inside the aggregated `web-all` entry. */
export const FEISHU_SETTINGS_NAMESPACE = 'feishu'

/** Feishu deployments the credentials know how to address. */
export const FEISHU_DOMAINS = ['feishu', 'lark'] as const

/** One Feishu deployment. */
export type FeishuDomain = (typeof FEISHU_DOMAINS)[number]

/** Ambient environment variable consulted when the namespace holds no secret. */
export const FEISHU_APP_SECRET_ENV = 'FEISHU_APP_SECRET'

/**
 * The pre-`feishu`-namespace ambient variable (`LARK_APP_SECRET`).
 *
 * Kept so an installation that exported it before the credentials moved into a
 * shared namespace keeps working without an edit.
 */
export const LEGACY_APP_SECRET_ENV = 'LARK_APP_SECRET'

/** The credentials slice of the family settings document. */
export interface FeishuConfig {
  appId?: string
  appSecret?: string
  domain?: FeishuDomain
}

export const Config = z.object({
  appId: z.string().default(''),
  appSecret: z.string().role('secret').default(''),
  domain: z.union(FEISHU_DOMAINS).default('feishu'),
}) as unknown as z<FeishuConfig>

registerFamilyNamespace(FEISHU_SETTINGS_NAMESPACE, Config)

/**
 * Fill every absent field with its documented default.
 * @param config - the namespace value as stored, possibly partial.
 * @returns a complete configuration.
 */
export function effectiveConfig(config: FeishuConfig | undefined): Required<FeishuConfig> {
  return Config(config ?? {}) as Required<FeishuConfig>
}