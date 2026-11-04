/**
 * Lark inbox service domain: the bot's inbound side plus the agent's answer path.
 *
 * Three rules shape this file:
 *
 * 1. A message the queue could not store must make the platform redeliver it.
 *    The event handler below therefore never catches a store failure: it only
 *    decides whether an event is usable at all (parse it, admit it), and lets
 *    everything else reach the gateway, which turns it into a non-200 ACK.
 * 2. Settings are read per event, not snapshotted at startup. A gate decision
 *    must use the rules in force when the message arrives, or a settings change
 *    appears to be ignored for exactly the messages an operator was reacting to.
 * 3. The bot's credentials are the shared `feishu` namespace's. One application
 *    serves the inbound socket, the outbound push and these replies, so the reply
 *    sender is rebuilt whenever that namespace changes instead of holding a stale
 *    tenant token.
 *
 * Single-instance constraint: the queue lives under one `$DSH_HOME` and has no
 * cross-process claim protocol (see `inbox-store.ts`). One `dsh-web` process per
 * `$DSH_HOME` consumes it.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { familyNamespace, onFamilyConfigChange, updateFamilyNamespace } from '../family-config.ts'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { gateEvent, type GateInput, type GatingConfig } from '../../../core/lark-inbox/gating.ts'
import { toEnvelope, type LarkInboxEnvelope } from '../../../core/lark-inbox/queue.ts'
import { FEISHU_SETTINGS_NAMESPACE, currentFeishuCredentials, createFeishuTextSender, describeFeishuCredentials, type FeishuCredentials } from '../feishu/index.ts'
import { Config, LARK_INBOX_SETTINGS_NAMESPACE, effectiveConfig, resolveQueueDir, type LarkInboxConfig } from './config.ts'
import { LarkGateway, type GatewayHealth, type GatewaySdk } from './gateway.ts'
import { InboxStore } from './inbox-store.ts'
import { makeLarkWizardRoutes } from './host-routes.ts'
import { accessTrustOf } from '../access-trust/index.ts'
import { registerInboxTools, type InboxReplyCapability, type InboxReplySender } from './tools.ts'
import { LarkWizard, writeWithConflictRetry, type SpawnFn } from './wizard.ts'
import { registerResources } from '../resources.ts'
const SECTION_ORDER = 210

export const LARK_INBOX_GUIDANCE = '本机已安装 dsh-lark-inbox 插件（飞书/Lark 机器人消息收件箱）：飞书 bot 以 WebSocket 长连接收到的消息幂等写入本地 JSONL 队列（$DSH_HOME/lark-inbox，按日轮转，SQLite 索引去重与游标）。可用工具：lark_inbox_peek（查看待处理消息与网关连接状态）、lark_inbox_pop（取出最旧一条并锁定）、lark_inbox_ack（确认完成 ok=true，或退回重试 ok=false，超次转死信）、lark_inbox_reply（回复某条入站消息，落在原会话/话题）。用户提到「飞书机器人消息 / lark-inbox / 飞书收件箱 / 回复飞书消息」时即指本插件。'

/** One running inbound runtime: the queue plus the socket feeding it. */
interface InboxRuntime {
  store: InboxStore
  gateway: Pick<LarkGateway, 'start' | 'stop' | 'isRunning'>
  /** Gateway close first, then the store it feeds; never the other way around. */
  stop(): Promise<void>
}

export interface LarkInboxServiceDeps {
  dshHome?: string
  env?: NodeJS.ProcessEnv
  gatewaySdk?: GatewaySdk
  wizardSpawn?: SpawnFn
  wizardQrDir?: string
  createStore?: (options: { rootDir: string; maxAttempts: number; staleTimeoutMs: number }) => InboxStore
  createGateway?: (options: ConstructorParameters<typeof LarkGateway>[0]) => Pick<LarkGateway, 'start' | 'stop' | 'isRunning'>
  /** Builds the reply sender for one credential set; tests inject a fake. */
  createSender?: (credentials: FeishuCredentials) => InboxReplySender
}

function readSenderType(event: unknown): string {
  const source = typeof event === 'object' && event !== null ? event as Record<string, unknown> : {}
  const inner = typeof source.event === 'object' && source.event !== null ? source.event as Record<string, unknown> : source
  const sender = inner.sender
  const type = typeof sender === 'object' && sender !== null ? (sender as Record<string, unknown>).sender_type : undefined
  return typeof type === 'string' && type.length > 0 ? type : 'user'
}

function gatingConfig(config: Required<LarkInboxConfig>): GatingConfig {
  return { requireMentionInGroup: config.requireMentionInGroup, allowedOpenIds: config.allowedOpenIds, dropAppMessages: config.dropAppMessages }
}

function dshHome(env: NodeJS.ProcessEnv): string {
  const raw = env.DSH_HOME?.trim()
  if (!raw) return join(homedir(), '.dsh')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

function liveConfig(base: LarkInboxConfig): LarkInboxConfig {
  return familyNamespace<LarkInboxConfig>(LARK_INBOX_SETTINGS_NAMESPACE) ?? base
}

/**
 * Read the shared Feishu application without throwing.
 *
 * A half-configured bot is an operator mistake, and the resolver says so by
 * throwing; here that has to become "this capability stays off, and says why",
 * not a failed plugin load.
 * @returns the credentials, or the reason they could not be resolved.
 */
function resolveCredentials(): { credentials?: FeishuCredentials; error?: string } {
  try {
    const credentials = currentFeishuCredentials()
    return credentials === null
      ? { error: '未配置飞书应用凭据（飞书设置页填写 appId/appSecret，或导出 FEISHU_APP_SECRET）' }
      : { credentials }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Register tools, live runtime, announcement, and exact old wizard routes. */
export function register(ctx: Context, base: LarkInboxConfig = {}, deps: LarkInboxServiceDeps = {}): () => Promise<void> {
  const log = ctx.logger('lark-inbox')
  const env = deps.env ?? process.env
  let activeStore: InboxStore | undefined
  let replyCapability: InboxReplyCapability = { error: 'dsh-lark-inbox 未运行：请在设置里启用插件并配置飞书应用凭据' }
  let gatewayHealth: GatewayHealth = { status: 'connecting' }
  let runtime: InboxRuntime | undefined
  let disposeSection: (() => void) | undefined
  /** Signature of the settings+runtime inputs actually applied, to skip no-op rebuilds. */
  let appliedKey = ''
  /** Teardown of the runtime most recently dropped; awaited by this domain's disposer. */
  let pendingTeardown: Promise<void> | undefined
  const current = (): LarkInboxConfig => liveConfig(base)

  /**
   * Drop the running runtime.
   *
   * Detach it from every read path synchronously, then close asynchronously:
   * the socket is closed before the store it feeds, so nothing can append to a
   * store that is already closed.
   */
  const stopRuntime = (): Promise<void> => {
    const stopping = runtime
    runtime = undefined
    if (stopping === undefined) return pendingTeardown ?? Promise.resolve()
    if (activeStore === stopping.store) activeStore = undefined
    replyCapability = { error: 'dsh-lark-inbox 正在重启网关' }
    gatewayHealth = { status: 'connecting' }
    // Serialize teardowns: a rebuild during a rebuild must not close the new
    // socket with the old teardown's store handle.
    const previous = pendingTeardown
    const done = (async () => {
      await (previous ?? Promise.resolve()).catch(() => undefined)
      try { await stopping.stop() } catch (error) {
        log.warn('dsh-lark-inbox: 网关关闭失败：%s', error instanceof Error ? error.message : String(error))
      }
    })()
    pendingTeardown = done
    return done
  }

  /**
   * Build the reply capability for the current credentials.
   * @param credentials - the shared application, when one is configured.
   * @param credentialsError - why no application could be resolved.
   */
  const buildReplyCapability = (credentials: FeishuCredentials | undefined, credentialsError: string | undefined): InboxReplyCapability => {
    if (credentials === undefined) return { error: `feishu: ${credentialsError ?? '未配置飞书应用凭据'}，无法回复` }
    try {
      const sender = deps.createSender?.(credentials)
        ?? createFeishuTextSender({ credentials, log: message => log.warn(message) })
      return { sender }
    } catch (error) {
      return { error: `feishu: 无法构建回复发送器：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * Reconcile the runtime with the settings document.
   *
   * Called once at mount and again on every settings change. It rebuilds only
   * when something that matters actually changed: the family event fires for
   * every namespace in the aggregate, and reconnecting the bot's socket because
   * an unrelated setting moved would drop messages for no reason.
   */
  const sync = (): void => {
    const active = effectiveConfig(current())
    const resolved = resolveCredentials()
    const key = JSON.stringify({
      active,
      credentials: resolved.credentials ?? null,
      credentialsError: resolved.error ?? '',
    })
    if (key === appliedKey && (runtime !== undefined || !active.enabled)) return
    appliedKey = key
    void stopRuntime()
    disposeSection?.()
    disposeSection = undefined
    if (!active.enabled) {
      replyCapability = { error: 'dsh-lark-inbox 已停用：在设置里启用插件后才能回复飞书消息' }
      return
    }
    replyCapability = buildReplyCapability(resolved.credentials, resolved.error)
    const credentials = resolved.credentials
    if (credentials === undefined) {
      log.warn('dsh-lark-inbox: %s；网关未启动', resolved.error ?? '未配置飞书应用凭据')
      return
    }
    if (active.allowedOpenIds.length === 0) {
      // Deliberately not enforced here: an empty list means "no allowlist", and
      // changing that to "deny everyone" is a policy decision, not a bug fix.
      log.warn('dsh-lark-inbox: allowedOpenIds 为空，任何能给该 bot 发消息的人都能进入本机队列')
    }
    const store = (deps.createStore ?? (options => InboxStore.open(options)))({
      rootDir: resolveQueueDir(active, deps.dshHome ?? dshHome(env)),
      maxAttempts: active.maxAttempts,
      staleTimeoutMs: active.staleTimeoutMs,
    })
    activeStore = store
    const gatewayOptions: ConstructorParameters<typeof LarkGateway>[0] = {
      appId: credentials.appId, appSecret: credentials.appSecret, domain: credentials.domain, sdk: deps.gatewaySdk,
      log: (level, message) => level === 'info' ? log.info(message) : level === 'warn' ? log.warn(message) : log.error(message),
      onStatus: health => { gatewayHealth = health },
      onEvent: (event, meta) => {
        // Parsing and admission are local decisions, so they are handled here: a
        // poison event that can never be stored must not be retried forever.
        // Storage is NOT local — `store.append` below is deliberately outside the
        // try, so a write failure reaches the SDK as a non-200 ACK and the
        // platform redelivers the message.
        let envelope: LarkInboxEnvelope
        let config: Required<LarkInboxConfig>
        try {
          envelope = toEnvelope(event, { mentionBot: meta.mentionBot })
          config = effectiveConfig(current())
        } catch (error) {
          log.error('dsh-lark-inbox: 无法解析飞书事件或当前配置，已丢弃：%s', error instanceof Error ? error.message : String(error))
          return
        }
        const input: GateInput = {
          chatType: envelope.chatType,
          senderType: readSenderType(event),
          senderOpenId: envelope.senderOpenId,
          mentionBot: meta.mentionBot,
          botOpenId: meta.botOpenId,
        }
        const decision = gateEvent(input, gatingConfig(config))
        if (!decision.accept) { log.warn('dsh-lark-inbox: 丢弃飞书事件 %s：%s', envelope.eventId, decision.reason); return }
        store.append(envelope)
      },
    }
    let gateway: ReturnType<NonNullable<LarkInboxServiceDeps['createGateway']>>
    try {
      gateway = (deps.createGateway ?? (options => new LarkGateway(options)))(gatewayOptions)
    } catch (error) {
      try { store.close() } catch { /* the constructor failure is the error worth reporting */ }
      if (activeStore === store) activeStore = undefined
      replyCapability = { error: `dsh-lark-inbox: 网关构造失败：${error instanceof Error ? error.message : String(error)}` }
      throw error
    }
    runtime = {
      store,
      gateway,
      stop: async () => {
        try { await gateway.stop() } finally { store.close() }
      },
    }
    log.info('dsh-lark-inbox: 使用飞书应用 %s', describeFeishuCredentials(credentials))
    void gateway.start().catch(error => log.error('dsh-lark-inbox: 网关启动失败：%s', error instanceof Error ? error.message : String(error)))
    if (active.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({ name: 'plugin:lark-inbox', order: SECTION_ORDER, text: LARK_INBOX_GUIDANCE })
    }
  }

  const dispose = registerResources(own => {
    own(registerInboxTools(ctx, () => activeStore, {
      gatewayStatus: () => gatewayHealth,
      reply: () => replyCapability,
    }))
    own(() => { disposeSection?.(); disposeSection = undefined })
    // An async disposer: `registerResources` records it like any other release and
    // invokes it here, and this domain's own disposer (below) awaits the returned
    // promise, so the socket is closed before the plugin is gone rather than after.
    own(() => stopRuntime())
    // The settings document is read/written through the family namespace pair
    // (familyNamespace + updateFamilyNamespace); DSH 0.2's settings service has
    // neither `get` nor `installSection`, so the old compat branch was a no-op.
    own(onFamilyConfigChange(() => {
      try { sync() } catch (error) { log.warn('dsh-lark-inbox: 配置变更后重建失败：%s', error instanceof Error ? error.message : String(error)) }
    }))

    const wizard = new LarkWizard({
      qrDir: deps.wizardQrDir,
      spawn: deps.wizardSpawn,
      settingsWrite: async patch => {
        // Credentials belong to the shared application, so the wizard writes the
        // `feishu` namespace: the inbox, the push and the reply path must never
        // disagree about which bot this host is.
        const record: Record<string, unknown> = {}
        if (patch.appId !== undefined) record.appId = patch.appId
        if (patch.appSecret !== undefined) record.appSecret = patch.appSecret
        await writeWithConflictRetry(() => updateFamilyNamespace(ctx, FEISHU_SETTINGS_NAMESPACE, record))
      },
      log: (level, message) => level === 'info' ? log.info(message) : level === 'warn' ? log.warn(message) : log.error(message),
    })
    own(() => { void wizard.cancel().catch(() => undefined) })
    for (const route of makeLarkWizardRoutes(
      wizard,
      accessTrustOf(ctx).isTrusted,
      () => effectiveConfig(current()).enabled,
    )) own(ctx.webServer.register(route))
    sync()
  })

  // Async on purpose: the socket close is awaited before the store it feeds is
  // closed, and the lifecycle owner awaits this before the plugin is gone.
  return async () => {
    try { dispose() } finally { await pendingTeardown }
  }
}

export { Config, LARK_INBOX_SETTINGS_NAMESPACE, InboxStore, LarkGateway, LarkWizard, makeLarkWizardRoutes }