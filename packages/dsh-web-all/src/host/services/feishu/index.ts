/**
 * Feishu capability domain: the shared application identity every Feishu-facing
 * capability on this host resolves through.
 *
 * It owns no connection and registers no route. Its single job at runtime is to
 * say — once at mount, then again whenever the settings document changes — which
 * application the host talks to and where that answer came from, so an operator
 * reading the log never has to guess whether the bot, the push, and the reply
 * path are the same app.
 */

import type { Context } from '@deepseek-ai/cordis'
import { familyNamespace, onFamilyConfigChange } from '../family-config.ts'
import { FEISHU_SETTINGS_NAMESPACE, type FeishuConfig } from './config.ts'
import { describeFeishuCredentials, resolveFeishuCredentials, type LegacyFeishuConfig } from './credentials.ts'

export { Config, FEISHU_APP_SECRET_ENV, FEISHU_DOMAINS, FEISHU_SETTINGS_NAMESPACE, LEGACY_APP_SECRET_ENV, effectiveConfig } from './config.ts'
export type { FeishuConfig, FeishuDomain } from './config.ts'
export { describeFeishuCredentials, readSecret, resolveFeishuCredentials } from './credentials.ts'
export type { FeishuCredentials, FeishuCredentialSources, LegacyFeishuConfig } from './credentials.ts'
export { FeishuTextSender, createFeishuTextSender, detectReceiveIdType, isRetryableFeishuCode } from './send.ts'
export type { FeishuClientLike, FeishuSendAttempt, FeishuSendTarget, FeishuSenderSdk, FeishuTextSenderOptions, ReceiveIdType } from './send.ts'

/**
 * Read the legacy credential fields without importing the inbox domain.
 *
 * The dependency direction matters: `lark-inbox` and `notify` both depend on this
 * domain, so this domain must not depend on either of them. Reading the old
 * namespace through the family bridge keeps that direction intact while still
 * honoring an installation configured before the credentials moved here.
 *
 * @returns the legacy fields, or undefined when that namespace is unset.
 */
function legacyInboxCredentials(): LegacyFeishuConfig | undefined {
  return familyNamespace<LegacyFeishuConfig>('lark-inbox')
}

/** Shared credential resolution for consumers inside this package. */
export function currentFeishuCredentials(): ReturnType<typeof resolveFeishuCredentials> {
  return resolveFeishuCredentials({
    feishu: familyNamespace<FeishuConfig>(FEISHU_SETTINGS_NAMESPACE),
    legacyInbox: legacyInboxCredentials(),
    env: process.env,
  })
}

/**
 * Register the domain: report the resolved application and keep doing so while
 * the settings document changes.
 *
 * @param ctx - host plugin context.
 * @returns the disposer releasing the settings subscription.
 */
export function register(ctx: Context): () => void {
  const log = ctx.logger('feishu')
  const report = (): void => {
    let credentials: ReturnType<typeof resolveFeishuCredentials>
    try {
      credentials = currentFeishuCredentials()
    } catch (error) {
      log.warn('feishu: %s', error instanceof Error ? error.message : String(error))
      return
    }
    if (credentials === null) {
      log.info('feishu: 未配置应用凭据，飞书能力保持停用')
      return
    }
    log.info('feishu: 应用凭据 %s', describeFeishuCredentials(credentials))
  }
  const off = onFamilyConfigChange(report)
  report()
  return off
}