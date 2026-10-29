/**
 * Outbound Feishu/Lark delivery for finished runs.
 *
 * This is the mirror of `lark-inbox/gateway.ts`: that file owns the inbound
 * WebSocket connection and this one owns the outbound message call, and both
 * hide the vendor SDK behind a narrow injected seam so the behaviour the
 * capability actually promises can be tested without a network or a tenant.
 *
 * Two properties matter more than throughput here, because this runs from an
 * event handler rather than from a request:
 *
 * 1. It never throws into the emitter. A notification that cannot be delivered
 *    is logged and dropped; it must not turn a finished run into a failed one.
 * 2. It stays under the application's rate limit. Feishu caps one application at
 *    five calls per second, and one finished run addresses several recipients,
 *    so sends are serialized with a minimum gap instead of fired in parallel.
 *
 * Messages are plain text rather than interactive cards on purpose: a card's
 * schema is versioned and a rejected card is a silently lost notification,
 * while a text message delivers the same three facts with nothing to validate.
 */

import { Domain, Client } from '@larksuiteoapi/node-sdk'
import { OUTCOME_LABEL_ZH, type RunNotice } from '../../../core/notify/contract.ts'
import type { FeishuCredentials } from './config.ts'

/** The vendor surface this module uses, so tests can supply their own. */
export interface FeishuSenderSdk {
  createClient(options: { appId: string; appSecret: string; domain: unknown }): {
    im: { message: { create(payload: unknown): Promise<unknown> } }
  }
  domain: { Feishu: unknown; Lark: unknown }
}

/** The real SDK, narrowed to {@link FeishuSenderSdk}. */
const officialSdk: FeishuSenderSdk = {
  domain: { Feishu: Domain.Feishu, Lark: Domain.Lark },
  createClient: options => new Client(options as ConstructorParameters<typeof Client>[0]) as unknown as ReturnType<FeishuSenderSdk['createClient']>,
}

/** One delivery's outcome, reported rather than thrown. */
export interface DeliveryAttempt {
  recipient: string
  ok: boolean
  /** Vendor error text when the call failed. */
  error?: string
}

/** Options for one sender instance. */
export interface FeishuSenderOptions {
  credentials: FeishuCredentials
  /** Open ids (`ou_…`), user ids, or chat ids to address as `open_id`. */
  recipients: readonly string[]
  /** Human name of the machine the run happened on. */
  hostLabel: string
  log?: (message: string) => void
  sdk?: FeishuSenderSdk
  /** Minimum gap between two vendor calls, keeping the app under its rate limit. */
  minGapMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Default gap: five calls per second is the application ceiling, so 250 ms is the floor. */
const DEFAULT_MIN_GAP_MS = 250

/**
 * Compose the message body for one delivery.
 *
 * The text states three things and nothing else: how it ended, which
 * conversation it was, and which machine it ran on. It deliberately carries no
 * session ids, no turn numbers and no raw reason kinds — those are diagnosable
 * in the workspace, and putting them in a phone notification makes the one line
 * that matters harder to find.
 *
 * @param notices - the finished runs this delivery covers, oldest first.
 * @param hostLabel - the machine's name.
 * @returns the message text, with no trailing newline.
 */
export function composeFeishuText(notices: readonly RunNotice[], hostLabel: string): string {
  const machine = hostLabel.trim() === '' ? '' : `机器：${hostLabel.trim()}`
  if (notices.length === 0) return machine
  const lines: string[] = []
  if (notices.length === 1) {
    const notice = notices[0] as RunNotice
    lines.push(`运行结束：${OUTCOME_LABEL_ZH[notice.outcome]}`)
    if (notice.title !== '') lines.push(`会话：${notice.title}`)
  } else {
    lines.push(`${notices.length} 个会话运行结束`)
    for (const notice of notices) {
      const label = OUTCOME_LABEL_ZH[notice.outcome]
      lines.push(notice.title === '' ? `- ${label}` : `- ${label} · ${notice.title}`)
    }
  }
  if (machine !== '') lines.push(machine)
  return lines.join('\n')
}

/**
 * Delivers composed messages to every configured recipient.
 *
 * One instance is bound to one credential set and one recipient list; the
 * owning service rebuilds it when the configuration changes, so a credential
 * rotation cannot leave a stale token cache behind.
 */
export class FeishuSender {
  private readonly options: FeishuSenderOptions
  private readonly log: (message: string) => void
  private readonly sdk: FeishuSenderSdk
  private readonly minGapMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private client: ReturnType<FeishuSenderSdk['createClient']> | undefined
  /** Serializes sends and carries the last call time, so the rate limit holds across callers. */
  private chain: Promise<void> = Promise.resolve()
  private lastCallAt = 0

  constructor(options: FeishuSenderOptions) {
    this.options = options
    this.log = options.log ?? (() => undefined)
    this.sdk = options.sdk ?? officialSdk
    this.minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms) }))
  }

  /** Recipients this sender will address. */
  get recipients(): readonly string[] {
    return this.options.recipients
  }

  /** Domain the credentials address. */
  get domain(): string {
    return this.options.credentials.domain
  }

  private vendorClient(): ReturnType<FeishuSenderSdk['createClient']> {
    if (this.client !== undefined) return this.client
    const domain = this.options.credentials.domain
    const mapped = domain === 'feishu' ? this.sdk.domain.Feishu : this.sdk.domain.Lark
    this.client = this.sdk.createClient({
      appId: this.options.credentials.appId,
      appSecret: this.options.credentials.appSecret,
      domain: mapped,
    })
    return this.client
  }

  /**
   * Deliver one text message to every recipient, serially and rate limited.
   * @param text - the message body.
   * @returns one attempt per recipient; empty when no recipient is configured.
   */
  async send(text: string): Promise<DeliveryAttempt[]> {
    const body = text.trim()
    if (body === '' || this.options.recipients.length === 0) return []
    const attempts: DeliveryAttempt[] = []
    for (const recipient of this.options.recipients) {
      attempts.push(await this.sendOne(recipient, body))
    }
    return attempts
  }

  private async sendOne(recipient: string, text: string): Promise<DeliveryAttempt> {
    // Serialize every call through one chain: `notify()` is not concurrency safe
    // and the vendor limit is per application, not per recipient.
    const run = this.chain.then(async () => {
      await this.respectGap()
      try {
        const response = await this.vendorClient().im.message.create({
          params: { receive_id_type: 'open_id' },
          data: { receive_id: recipient, msg_type: 'text', content: JSON.stringify({ text }) },
        })
        const code = (response as { code?: unknown } | undefined)?.code
        // The SDK resolves even for a business error, so the envelope decides.
        if (typeof code === 'number' && code !== 0) {
          return { recipient, ok: false, error: `feishu code ${code}: ${String((response as { msg?: unknown }).msg ?? '')}` }
        }
        return { recipient, ok: true }
      } catch (error) {
        return { recipient, ok: false, error: error instanceof Error ? error.message : String(error) }
      } finally {
        this.lastCallAt = this.now()
      }
    })
    // Keep the chain alive after a rejection so one failure cannot block later sends.
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  private async respectGap(): Promise<void> {
    if (this.minGapMs <= 0) return
    const elapsed = this.now() - this.lastCallAt
    if (this.lastCallAt !== 0 && elapsed < this.minGapMs) await this.sleep(this.minGapMs - elapsed)
  }

  /**
   * Deliver and reduce the result to one log line.
   *
   * Event handlers cannot await a promise they do not own, and a rejected one
   * would be an unhandled rejection, so the caller uses this instead of
   * {@link send} whenever the notification is fire-and-forget.
   *
   * @param notices - the finished runs to report.
   */
  async notify(notices: readonly RunNotice[]): Promise<void> {
    if (notices.length === 0) return
    const text = composeFeishuText(notices, this.options.hostLabel)
    const attempts = await this.send(text)
    const failed = attempts.filter(attempt => !attempt.ok)
    const delivered = attempts.length - failed.length
    if (attempts.length > 0 && failed.length === 0) {
      this.log(`dsh-notify: 已推送 ${delivered} 条飞书通知`)
      return
    }
    for (const attempt of failed) {
      this.log(`dsh-notify: 推送给 ${attempt.recipient} 失败：${attempt.error ?? '未知错误'}`)
    }
  }
}