/**
 * Notification capability: records finished runs, serves them, and pushes them.
 *
 * Where it sits. `dsh-session` already owns the durable answer to "what
 * happened" (the append-only log) and `dsh-agent` owns the live answer to "is
 * anything still running" (`agent/status`). This domain adds the third thing
 * neither provides: a small, recent, cross-surface answer to "did the work I
 * left running finish, and how did it end" that a phone or a desktop fleet list
 * can read without holding a session log.
 *
 * What it therefore does NOT do. It keeps no durable copy of anything the
 * session log already holds — see `core/notify/feed.ts` for why the notice log
 * is deliberately in-memory. It records nothing for subagent sessions, because
 * a child's turns are internal to a parent's work and a dot that lights up for
 * every delegation is a dot nobody trusts. It records nothing for a turn that
 * never entered a step, because an empty turn is not finished work.
 *
 * Two delivery shapes, one setting. `each-turn` reports every finished turn;
 * `idle` waits until the agent has no driver left and reports the batch, which
 * is what a notification is for. The feed ignores the setting entirely and
 * always records every eligible turn, so a client's badge stays accurate no
 * matter which push shape the deployment chose. Because "idle" is an event and
 * an event can be missed, a buffered batch also carries a deadline and is
 * delivered when the capability is disposed: a finished run that is never
 * reported is the one failure this domain exists to prevent.
 *
 * Which Feishu application sends. The shared `feishu` namespace decides; this
 * domain contributes its own fields as an override and reads the legacy
 * `lark-inbox` fields only as a fallback for installations configured before the
 * namespace moved. `notify/config.ts` holds that decision and stays Cordis-free;
 * this file is where the three namespaces are read from the family bridge.
 *
 * @module dsh-web-all/notify
 */

import { hostname } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import { NOTIFY_MAX_LIMIT, type NotifyDeliverySnapshot, type RunNotice } from '../../../core/notify/contract.ts'
import { NoticeLog, TitleBook, textOfContent } from '../../../core/notify/feed.ts'
import { registerResources } from '../resources.ts'
import { accessTrustOf } from '../access-trust/index.ts'
import { familyNamespace, onFamilyConfigChange } from '../family-config.ts'
import { FEISHU_SETTINGS_NAMESPACE, type FeishuConfig } from '../feishu/config.ts'
import { isBotSession } from '../feishu/bot-sessions.ts'
import { describeFeishuCredentials } from '../feishu/credentials.ts'
import { LARK_INBOX_SETTINGS_NAMESPACE, type LarkInboxConfig } from '../lark-inbox/config.ts'
import {
  NOTIFY_SETTINGS_NAMESPACE,
  effectiveConfig,
  normalizeRecipients,
  resolveFeishuCredentials,
  type NotifyConfig,
} from './config.ts'
import { FeishuSender } from './feishu-sender.ts'
import { makeNotifyRoutes } from './host-routes.ts'

export { Config, NOTIFY_SETTINGS_NAMESPACE, resolveFeishuCredentials } from './config.ts'
export { FeishuSender, composeFeishuText } from './feishu-sender.ts'
export { makeNotifyRoutes, readFeedQuery, requestAuthority } from './host-routes.ts'
export type { DeliveryAttempt, DeliveryFailure, DeliveryReport } from './feishu-sender.ts'

/** Turns buffered for one session before the oldest are dropped. */
export const PENDING_TURN_CAP = 20

/**
 * How long one session's buffered turns wait for its agent to go idle.
 *
 * The idle signal is the normal delivery trigger, but it is not guaranteed: the
 * agent can be replaced, the run interrupted, or the session closed between the
 * last `turn/end` and the idle event. Without a deadline that batch would wait
 * for the next event that may never come, which is the "notification never
 * arrives" failure this buffer exists to avoid. The deadline bounds the wait
 * instead of removing it.
 */
export const PENDING_FLUSH_DEADLINE_MS = 60_000

/** The sender surface this domain needs, so tests can supply their own. */
export interface NotifySender {
  /**
   * Deliver one batch. A sender may return a delivery summary
   * (`DeliveryReport`); this domain does not depend on it, because a sender
   * already logs what failed and why.
   */
  notify(notices: readonly RunNotice[]): Promise<unknown>
  readonly recipients: readonly string[]
  readonly domain: string
}

/** Injectables that let tests run the domain without a tenant or a clock. */
export interface NotifyServiceDeps {
  env?: NodeJS.ProcessEnv
  /** Name this machine reports in a pushed message. */
  hostLabel?: string
  /** Builds the outbound sender; returns null when nothing can be sent. */
  createSender?: (options: {
    credentials: ReturnType<typeof resolveFeishuCredentials>
    recipients: readonly string[]
    hostLabel: string
  }) => NotifySender | null
  /** Arms the buffered-batch deadline; defaults to an unreferenced `setTimeout`. */
  setTimeout?: (callback: () => void, ms: number) => unknown
  /** Cancels a deadline armed by `setTimeout`. */
  clearTimeout?: (handle: unknown) => void
}

/** Minimal shape of the session event the domain reads. */
interface SessionEventLike {
  type?: unknown
  data?: unknown
  time?: unknown
}

/** Minimal shape of the session the domain reads. */
interface SessionLike {
  id?: unknown
  header?: { origin?: unknown; delegationDepth?: unknown } | undefined
}

/** Finished runs held for one session until its agent is idle or the deadline hits. */
interface PendingBatch {
  notices: RunNotice[]
  /** Armed deadline, so a buffer cannot outlive the wait it was created for. */
  timer?: unknown
}

/**
 * Whether a session belongs to a subagent.
 *
 * `delegationDepth` is the durable field (a resumed child keeps its depth);
 * `origin` is the coarser presentation marker. Either one answering "child" is
 * enough, because recording a child's finished turn would put internal
 * delegation on the same list as the user's own work.
 *
 * @param session - the session the event belongs to.
 * @returns true when the session is a subagent child.
 */
export function isSubagentSession(session: SessionLike | undefined): boolean {
  const header = session?.header
  if (header === undefined) return false
  if (header.origin === 'subagent') return true
  const depth = header.delegationDepth
  return typeof depth === 'number' && depth > 0
}

/**
 * Register the notification capability.
 *
 * @param ctx - host plugin context.
 * @param base - namespace value used when the family settings document has none.
 * @param deps - injectables for tests.
 * @returns the disposer releasing the route, the subscriptions and the sender.
 */
export function register(ctx: Context, base: NotifyConfig = {}, deps: NotifyServiceDeps = {}): () => void {
  const log = ctx.logger('notify')
  const env = deps.env ?? process.env
  const hostLabel = deps.hostLabel ?? hostname()
  // Retention is the contract's maximum so a settings change never renumbers
  // notices; `feedLimit` only decides the default size of one read.
  const notices = new NoticeLog(NOTIFY_MAX_LIMIT)
  const titles = new TitleBook()
  /** Turns that entered a step, keyed `${sessionId}\u0000${turn}`. */
  const enteredSteps = new Set<string>()
  /** Notices waiting for their session's agent to go idle, in `idle` mode only. */
  const pending = new Map<string, PendingBatch>()
  // Unreferenced by default: a pending deadline must never be the reason the
  // process stays alive, and a dead process cannot deliver it anyway.
  const armTimer = deps.setTimeout ?? ((callback: () => void, ms: number): unknown => {
    const handle = setTimeout(callback, ms)
    if (typeof (handle as { unref?: unknown }).unref === 'function') (handle as { unref: () => void }).unref()
    return handle
  })
  const disarmTimer = deps.clearTimeout ?? ((handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  })

  let active = effectiveConfig(base)
  let sender: NotifySender | undefined
  /** How the most recent push ended; published on the read feed, never persisted. */
  let lastDelivery: NotifyDeliverySnapshot | undefined

  const current = (): NotifyConfig => familyNamespace<NotifyConfig>(NOTIFY_SETTINGS_NAMESPACE) ?? base

  const stepKey = (sessionId: string, turn: number): string => `${sessionId}\u0000${turn}`

  const buffered = (): boolean => active.feishuMode === 'idle'

  /** Model-facing label for one session, refreshed from the title event. */
  const nameOf = (sessionId: string): string => titles.titleOf(sessionId)

  const wantOutcome = (notice: RunNotice): boolean => active.feishuOutcomes.includes(notice.outcome)

  const deliver = (batch: readonly RunNotice[]): void => {
    if (sender === undefined) return
    const worthy = batch.filter(wantOutcome)
    if (worthy.length === 0) return
    // Fire and forget: a delivery failure must never reach the session log's
    // append path, which is synchronous and must not wait on a network call.
    void sender.notify(worthy).then(report => {
      // Publishing the outcome is how a person finds out that the notification
      // they are waiting for did not go out; the log alone is not a surface.
      if (report !== undefined && report !== null) lastDelivery = report as NotifyDeliverySnapshot
    }).catch(error => {
      log.warn('dsh-notify: 推送失败：%s', error instanceof Error ? error.message : String(error))
    })
  }

  /** Deliver one session's buffered batch, cancelling its deadline. */
  const flush = (sessionId: string): void => {
    const batch = pending.get(sessionId)
    if (batch === undefined) return
    pending.delete(sessionId)
    if (batch.timer !== undefined) disarmTimer(batch.timer)
    deliver(batch.notices)
  }

  /** Deliver every buffered batch; used when the capability or the process goes away. */
  const flushAll = (): void => {
    for (const sessionId of [...pending.keys()]) flush(sessionId)
  }

  /** Drop every buffered batch and its deadline, without delivering. */
  const discardPending = (): void => {
    for (const [sessionId, batch] of [...pending]) {
      pending.delete(sessionId)
      if (batch.timer !== undefined) disarmTimer(batch.timer)
    }
  }

  const buffer = (notice: RunNotice): void => {
    const existing = pending.get(notice.sessionId)
    if (existing === undefined) {
      const batch: PendingBatch = { notices: [notice] }
      pending.set(notice.sessionId, batch)
      // One deadline per session, armed when its first turn lands, so a session
      // that keeps finishing turns does not postpone its own report forever.
      batch.timer = armTimer(() => { flush(notice.sessionId) }, PENDING_FLUSH_DEADLINE_MS)
      return
    }
    existing.notices.push(notice)
    const overflow = existing.notices.length - PENDING_TURN_CAP
    if (overflow <= 0) return
    existing.notices.splice(0, overflow)
    // Dropping is the last resort, so it says so: a silent `splice` here looks
    // exactly like "the notification service loses messages sometimes", which is
    // the report this capability can least afford.
    log.warn('dsh-notify: 会话 %s 的待推送通知超过 %d 条上限，丢弃最早的 %d 条', notice.sessionId, PENDING_TURN_CAP, overflow)
  }

  /**
   * Which application sends the push.
   *
   * Three namespaces answer it and the order matters: this capability's own
   * fields override, the shared `feishu` namespace is the deployment default, and
   * the legacy `lark-inbox` fields keep an installation configured before the
   * migration working. Reading all three here — rather than inside the pure
   * resolver — keeps `notify/config.ts` free of the Cordis runtime.
   *
   * @returns the resolved credentials, or null when no application is configured.
   * @throws when an application id exists but no secret belonging to it resolves.
   */
  const readCredentials = (): ReturnType<typeof resolveFeishuCredentials> => resolveFeishuCredentials({
    notify: active,
    feishu: familyNamespace<FeishuConfig>(FEISHU_SETTINGS_NAMESPACE),
    legacyInbox: familyNamespace<LarkInboxConfig>(LARK_INBOX_SETTINGS_NAMESPACE),
    env,
  })

  /** Rebuild the sender from the current settings; drop it when nothing can send. */
  const syncSender = (): void => {
    sender = undefined
    if (!active.enabled || !active.feishuEnabled) return
    const recipients = normalizeRecipients(active.feishuRecipients)
    if (recipients.length === 0) {
      log.warn('dsh-notify: 已启用飞书推送但没有收件人（feishuRecipients），未创建发送器')
      return
    }
    let credentials: ReturnType<typeof resolveFeishuCredentials>
    try {
      // Rebuilt on every settings change, including a `feishu` namespace change,
      // because both the tenant token and the target application can move.
      credentials = readCredentials()
    } catch (error) {
      log.warn('dsh-notify: %s', error instanceof Error ? error.message : String(error))
      return
    }
    if (credentials === null) {
      log.warn('dsh-notify: 已启用飞书推送但缺少应用凭据（共享「飞书」页的 appId / appSecret，或本页的 feishuAppId / feishuAppSecret，或 lark-inbox 的旧字段）')
      return
    }
    const built = deps.createSender !== undefined
      ? deps.createSender({ credentials, recipients, hostLabel })
      : new FeishuSender({
        credentials,
        recipients,
        hostLabel,
        log: message => log.warn('%s', message),
      })
    if (built === null) return
    sender = built
    log.info('dsh-notify: 飞书推送已就绪（应用 %s，收件人 %d，模式 %s）', describeFeishuCredentials(credentials), recipients.length, active.feishuMode)
  }

  /**
   * Apply a settings change without remounting.
   *
   * An edit while the capability runs keeps what it has recorded — changing the
   * recipient list or the push shape must not wipe the results a client is part
   * way through reading. Turning the capability OFF does drop them, because a
   * disabled capability must not keep a list of the conversations this machine
   * has been running, and because a later enable would otherwise publish a burst
   * of results the user never chose to collect.
   */
  const sync = (): void => {
    const wasEnabled = active.enabled
    active = effectiveConfig(current())
    if (wasEnabled && !active.enabled) {
      notices.clear()
      discardPending()
      enteredSteps.clear()
    }
    syncSender()
  }

  const disposeResources = registerResources(own => {
    own(ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
      if (!active.enabled) return
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      // An answer-path session already speaks to this person in Feishu; a
      // "run finished" push for it would be the same news twice.
      if (sessionId === '' || isSubagentSession(session) || isBotSession(sessionId)) return
      const type = event?.type
      const data = event?.data
      if (type === 'session/title') {
        const title = (data as { title?: unknown } | undefined)?.title
        if (typeof title === 'string') titles.setTitle(sessionId, title)
        return
      }
      const at = typeof event?.time === 'number' ? event.time : Date.now()
      if (type === 'user/message') {
        const source = (data as { source?: { kind?: unknown } } | undefined)?.source
        // Only a human prompt may name a session: the same event type also
        // carries synthetic injections (file-change notices, cron wakes, skill
        // content), and quoting one of those as the conversation's name would
        // be wrong in a way the user cannot correct.
        if (source?.kind === 'user') {
          titles.rememberPrompt(sessionId, textOfContent((data as { content?: unknown } | undefined)?.content))
        }
        return
      }
      if (type === 'step/start') {
        const turn = (data as { turn?: unknown } | undefined)?.turn
        if (typeof turn === 'number') enteredSteps.add(stepKey(sessionId, turn))
        return
      }
      if (type !== 'turn/end') return
      const payload = data as { turn?: unknown; reason?: { kind?: unknown } } | undefined
      const turn = typeof payload?.turn === 'number' ? payload.turn : -1
      // A turn that never entered a step did no work, so there is nothing to
      // report; recording it would make every cancelled empty prompt a notice.
      const key = stepKey(sessionId, turn)
      if (!enteredSteps.delete(key)) return
      const reason = typeof payload?.reason?.kind === 'string' ? payload.reason.kind : ''
      const notice = notices.append({ at, sessionId, title: nameOf(sessionId), turn, reason })
      if (buffered()) buffer(notice)
      else deliver([notice])
    }))

    own(ctx.on('agent/status', (payload: { agent?: { id?: unknown }; status?: unknown }) => {
      if (!active.enabled) return
      if (payload?.status !== 'idle') return
      const sessionId = typeof payload.agent?.id === 'string' ? payload.agent.id : ''
      if (sessionId === '') return
      flush(sessionId)
    }))

    own(ctx.on('session/disposed', (session: SessionLike) => {
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      if (sessionId === '') return
      titles.forget(sessionId)
      // A disposed session can no longer report idle, so its buffered turns are
      // delivered here rather than dropped: they finished, and losing them is
      // the same silent loss the deadline above exists to prevent.
      flush(sessionId)
      // Dropping the entered-step marks keeps the set from growing with the
      // process: a session that is disposed can no longer close a turn.
      for (const key of [...enteredSteps]) {
        if (key.startsWith(`${sessionId}\u0000`)) enteredSteps.delete(key)
      }
    }))

    for (const route of makeNotifyRoutes({
      log: () => notices,
      defaultLimit: () => active.feedLimit,
      isTrusted: request => accessTrustOf(ctx).isTrusted(request),
      enabled: () => active.enabled,
      lastDelivery: () => lastDelivery,
    })) own(ctx.webServer.register(route))

    own(onFamilyConfigChange(() => {
      try {
        sync()
      } catch (error) {
        log.warn('dsh-notify: 应用设置失败：%s', error instanceof Error ? error.message : String(error))
      }
    }))

    sync()
    log.info('dsh-notify: 能力已挂载（%s）', active.enabled ? '启用' : '停用')
  })

  return () => {
    // Deliver what the deadline had not reached yet. A capability stop (and the
    // process exit behind it) must not be the reason a finished run is never
    // reported; the sender is still alive at this point, so the batch can go out.
    try {
      flushAll()
    } catch (error) {
      log.warn('dsh-notify: 退出前刷新待推送通知失败：%s', error instanceof Error ? error.message : String(error))
    }
    disposeResources()
  }
}