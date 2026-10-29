/** Authoritative pre-merge Lark inbox host behavior, adapted to web-all ownership. */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { familyNamespace, updateFamilyNamespace } from '../family-config.ts'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { gateEvent, type GateInput, type GatingConfig } from '../../../core/lark-inbox/gating.ts'
import { toEnvelope } from '../../../core/lark-inbox/queue.ts'
import { Config, LARK_INBOX_SETTINGS_NAMESPACE, effectiveConfig, resolveAppSecret, resolveQueueDir, type LarkInboxConfig } from './config.ts'
import { LarkGateway, type GatewaySdk } from './gateway.ts'
import { InboxStore } from './inbox-store.ts'
import { makeLarkWizardRoutes } from './host-routes.ts'
import { accessTrustOf } from '../access-trust/index.ts'
import { registerInboxTools } from './tools.ts'
import { LarkWizard, writeWithConflictRetry, type SpawnFn } from './wizard.ts'
import { registerResources } from '../resources.ts'
const SECTION_ORDER = 210

export const LARK_INBOX_GUIDANCE = '本机已安装 dsh-lark-inbox 插件（飞书/Lark 机器人消息收件箱）：飞书 bot 以 WebSocket 长连接收到的消息幂等写入本地 JSONL 队列（$DSH_HOME/lark-inbox，按日轮转，SQLite 索引去重与游标）。可用工具：lark_inbox_peek（查看待处理消息）、lark_inbox_pop（取出最旧一条并锁定）、lark_inbox_ack（确认完成 ok=true，或退回重试 ok=false，超次转死信）。用户提到「飞书机器人消息 / lark-inbox / 飞书收件箱」时即指本插件。'

export interface LarkInboxServiceDeps {
  dshHome?: string
  env?: NodeJS.ProcessEnv
  gatewaySdk?: GatewaySdk
  wizardSpawn?: SpawnFn
  wizardQrDir?: string
  createStore?: (options: { rootDir: string; maxAttempts: number; staleTimeoutMs: number }) => InboxStore
  createGateway?: (options: ConstructorParameters<typeof LarkGateway>[0]) => Pick<LarkGateway, 'start' | 'stop' | 'isRunning'>
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

function liveConfig(ctx: Context, fallback: LarkInboxConfig): LarkInboxConfig {
  void ctx
  return familyNamespace<LarkInboxConfig>(LARK_INBOX_SETTINGS_NAMESPACE) ?? fallback
}

/** Register tools, live runtime, announcement, and exact old wizard routes. */
export function register(ctx: Context, base: LarkInboxConfig = {}, deps: LarkInboxServiceDeps = {}): () => void {
  const log = ctx.logger('lark-inbox')
  const env = deps.env ?? process.env
  let activeStore: InboxStore | undefined
  let disposeRuntime: (() => void) | undefined
  let disposeSection: (() => void) | undefined
  let current: () => LarkInboxConfig = () => liveConfig(ctx, base)

  return registerResources(own => {
    own(registerInboxTools(ctx, () => activeStore))
    own(() => { disposeSection?.() })
    own(() => { disposeRuntime?.() })

    const sync = (): void => {
      disposeRuntime?.(); disposeRuntime = undefined
      disposeSection?.(); disposeSection = undefined
      const active = effectiveConfig(current())
      if (!active.enabled) return

      let appSecret: string
      try { appSecret = resolveAppSecret(active, env) }
      catch (error) { log.warn('dsh-lark-inbox: %s', error instanceof Error ? error.message : String(error)); return }
      const appId = active.appId.trim()
      if (appId === '') { log.warn('dsh-lark-inbox: 未配置 appId，网关未启动；请在设置里填写 appId'); return }

      const store = (deps.createStore ?? (options => InboxStore.open(options)))({
        rootDir: resolveQueueDir(active, deps.dshHome ?? dshHome(env)),
        maxAttempts: active.maxAttempts,
        staleTimeoutMs: active.staleTimeoutMs,
      })
      activeStore = store
      const gatewayOptions: ConstructorParameters<typeof LarkGateway>[0] = {
        appId, appSecret, domain: active.domain, sdk: deps.gatewaySdk,
        log: (level, message) => level === 'info' ? log.info(message) : level === 'warn' ? log.warn(message) : log.error(message),
        onEvent: (event, meta) => {
          try {
            const envelope = toEnvelope(event, { mentionBot: meta.mentionBot })
            const input: GateInput = { chatType: envelope.chatType, senderType: readSenderType(event), senderOpenId: envelope.senderOpenId, mentionBot: meta.mentionBot }
            const decision = gateEvent(input, gatingConfig(active))
            if (!decision.accept) { log.warn('dsh-lark-inbox: 丢弃飞书事件 %s：%s', envelope.eventId, decision.reason); return }
            store.append(envelope)
          } catch (error) { log.error('dsh-lark-inbox: 处理飞书事件失败：%s', error instanceof Error ? error.message : String(error)) }
        },
      }
      let gateway: ReturnType<NonNullable<LarkInboxServiceDeps['createGateway']>> | undefined
      disposeRuntime = () => {
        void gateway?.stop().catch(error => log.error('dsh-lark-inbox: 网关关闭失败：%s', error instanceof Error ? error.message : String(error)))
        try { store.close() } catch (error) { log.error('dsh-lark-inbox: 队列关闭失败：%s', error instanceof Error ? error.message : String(error)) }
        if (activeStore === store) activeStore = undefined
      }
      gateway = (deps.createGateway ?? (options => new LarkGateway(options)))(gatewayOptions)
      void gateway.start().catch(error => log.error('dsh-lark-inbox: 网关启动失败：%s', error instanceof Error ? error.message : String(error)))
      if (active.announceToAgent) {
        disposeSection = ctx.systemPrompt.section({ name: 'plugin:lark-inbox', order: SECTION_ORDER, text: LARK_INBOX_GUIDANCE })
      }
    }

    // The settings document is read/written through the family namespace pair
    // (familyNamespace + updateFamilyNamespace); DSH 0.2's settings service has
    // neither `get` nor `installSection`, so the old compat branch was a no-op.

    const wizard = new LarkWizard({
      qrDir: deps.wizardQrDir,
      spawn: deps.wizardSpawn,
      settingsWrite: async patch => {
        await writeWithConflictRetry(() => updateFamilyNamespace(ctx, LARK_INBOX_SETTINGS_NAMESPACE, patch))
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
}

export { Config, LARK_INBOX_SETTINGS_NAMESPACE, InboxStore, LarkGateway, LarkWizard, makeLarkWizardRoutes }
