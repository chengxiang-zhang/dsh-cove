/**
 * Outbound Feishu/Lark delivery for finished runs.
 *
 * This is the mirror of `lark-inbox/gateway.ts`: that file owns the inbound
 * WebSocket connection and this one owns the outbound message call, and both
 * hide the vendor SDK behind a narrow injected seam so the behaviour the
 * capability actually promises can be tested without a network or a tenant.
 *
 * Three properties matter more than throughput here, because this runs from an
 * event handler rather than from a request:
 *
 * 1. It never throws into the emitter. A notification that cannot be delivered
 *    is reported and dropped; it must not turn a finished run into a failed one.
 * 2. It stays under the application's rate limit. Feishu caps one application at
 *    five calls per second, and one finished run addresses several recipients,
 *    so sends are serialized with a minimum gap instead of fired in parallel.
 * 3. It distinguishes "later" from "never". Feishu answers business errors
 *    inside a resolved promise and only some of them are worth another attempt;
 *    flattening them all into "failed" makes rate limiting look like a
 *    permission bug. The target's id namespace is inferred for the same reason:
 *    a chat id sent as `open_id` fails in a way that reads like a permission
 *    problem but is really a wrong declaration.
 *
 * Messages are plain text rather than interactive cards on purpose: a card's
 * schema is versioned and a rejected card is a silently lost notification,
 * while a text message delivers the same three facts with nothing to validate.
 */

import { Domain, Client } from '@larksuiteoapi/node-sdk'
import { OUTCOME_LABEL_ZH, type RunNotice } from '../../../core/notify/contract.ts'
import { detectReceiveIdType, isRetryableFeishuCode, type ReceiveIdType } from '../feishu/send.ts'
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
  /** Vendor business code, when the failure carried one. */
  code?: number
  /**
   * Whether the failure could plausibly succeed later (rate limiting, transport)
   * as opposed to a refusal that will hold on every attempt (permission, format,
   * unknown target). `false` for a delivered message.
   */
  retryable?: boolean
}

/** One recipient that could not be reached, in the shape the report carries. */
export interface DeliveryFailure {
  recipient: string
  code?: number
  error: string
  retryable: boolean
}

/**
 * What one `notify` call did.
 *
 * Kept on the sender (and returned to the owning service) so the last push is a
 * diagnosable fact rather than a log line someone has to recall: which
 * recipients were reached, which were not, and whether the failure was the
 * retryable kind.
 */
export interface DeliveryReport {
  /** When the report was produced. */
  at: number
  /** True only when every recipient was reached. */
  ok: boolean
  /** Messages the vendor accepted. */
  delivered: number
  /** Recipients that were not reached, with their classification. */
  failed: DeliveryFailure[]
}

/** Options for one sender instance. */
export interface FeishuSenderOptions {
  credentials: FeishuCredentials
  /** Open ids (`ou_…`), user ids, or chat ids (`oc_…`) to address. */
  recipients: readonly string[]
  /** Human name of the machine the run happened on. */
  hostLabel: string
  log?: (message: string) => void
  sdk?: FeishuSenderSdk
  /** Minimum gap between two vendor calls, keeping the app under its rate limit. */
  minGapMs?: number
  /** Attempts per recipient, including the first one. Never unbounded. */
  maxAttempts?: number
  /** First backoff delay; every further retry doubles it. */
  backoffBaseMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Default gap: five calls per second is the application ceiling, so 250 ms is the floor. */
const DEFAULT_MIN_GAP_MS = 250

/** Attempts one recipient gets: the first send plus two backoff retries. */
const DEFAULT_MAX_ATTEMPTS = 3

/** First backoff delay, doubled per retry. */
const DEFAULT_BACKOFF_BASE_MS = 500

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

/** One failure line inside the aggregated log, carrying what a reader needs. */
function describeFailure(failure: DeliveryFailure): string {
  return `${failure.recipient}（${failure.error}, retryable=${failure.retryable ? 'yes' : 'no'}）`
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
  private readonly maxAttempts: number
  private readonly backoffBaseMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private client: ReturnType<FeishuSenderSdk['createClient']> | undefined
  /** Serializes sends and carries the last call time, so the rate limit holds across callers. */
  private chain: Promise<void> = Promise.resolve()
  private lastCallAt = 0
  private lastReport: DeliveryReport | undefined

  constructor(options: FeishuSenderOptions) {
    this.options = options
    this.log = options.log ?? (() => undefined)
    this.sdk = options.sdk ?? officialSdk
    this.minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS
    // A non-positive attempt count would make "send nothing" look like success.
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))
    this.backoffBaseMs = Math.max(0, options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS)
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

  /** The most recent delivery attempt, or undefined when nothing was sent yet. */
  get lastDelivery(): DeliveryReport | undefined {
    return this.lastReport
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
    // Serialize every call through one chain: `send` is not concurrency safe and
    // the vendor limit is per application, not per recipient.
    const run = this.chain.then(async () => this.attemptWithRetry(recipient, text))
    // Keep the chain alive after a rejection so one failure cannot block later sends.
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Try one recipient until it is delivered, permanently refused, or out of
   * attempts.
   *
   * Only a failure classified retryable is repeated, and the number of attempts
   * is bounded by construction, so a wedged tenant cannot turn the notification
   * path into a retry storm. The terminal failure is returned rather than
   * swallowed: rate limiting, a revoked permission and an unknown target are
   * reported with their own code and classification.
   *
   * @param recipient - the target id.
   * @param text - the message body.
   * @returns the last attempt made.
   */
  private async attemptWithRetry(recipient: string, text: string): Promise<DeliveryAttempt> {
    let attempt: DeliveryAttempt = { recipient, ok: false, error: 'dsh-notify: 未尝试发送', retryable: false }
    for (let index = 1; index <= this.maxAttempts; index += 1) {
      await this.respectGap()
      attempt = await this.attemptOnce(recipient, text)
      if (attempt.ok || attempt.retryable !== true || index === this.maxAttempts) return attempt
      const delay = this.backoffBaseMs * 2 ** (index - 1)
      this.log(`dsh-notify: 推送给 ${recipient} 失败（${attempt.error ?? '未知错误'}），${delay}ms 后第 ${index + 1} 次尝试`)
      await this.sleep(delay)
    }
    return attempt
  }

  /**
   * One vendor call for one recipient.
   * @param recipient - the target id.
   * @param text - the message body.
   * @returns the attempt result; never throws for a vendor or transport failure.
   */
  private async attemptOnce(recipient: string, text: string): Promise<DeliveryAttempt> {
    let receiveIdType: ReceiveIdType
    try {
      receiveIdType = detectReceiveIdType(recipient)
    } catch (error) {
      // An unusable target is a configuration mistake, not something a retry fixes.
      return { recipient, ok: false, error: error instanceof Error ? error.message : String(error), retryable: false }
    }
    try {
      const response = await this.vendorClient().im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: recipient.trim(), msg_type: 'text', content: JSON.stringify({ text }) },
      })
      const code = (response as { code?: unknown } | undefined)?.code
      // The SDK resolves even for a business error, so the envelope decides.
      if (typeof code === 'number' && code !== 0) {
        return {
          recipient,
          ok: false,
          code,
          error: `feishu code ${code}: ${String((response as { msg?: unknown }).msg ?? '')}`,
          retryable: isRetryableFeishuCode(code),
        }
      }
      return { recipient, ok: true }
    } catch (error) {
      // A transport failure carries no vendor code: the message may never have
      // reached the platform, so it stays in the retryable class.
      return { recipient, ok: false, error: error instanceof Error ? error.message : String(error), retryable: true }
    } finally {
      this.lastCallAt = this.now()
    }
  }

  private async respectGap(): Promise<void> {
    if (this.minGapMs <= 0) return
    const elapsed = this.now() - this.lastCallAt
    if (this.lastCallAt !== 0 && elapsed < this.minGapMs) await this.sleep(this.minGapMs - elapsed)
  }

  /**
   * Deliver and reduce the result to one diagnosable log line.
   *
   * Event handlers cannot await a promise they do not own, and a rejected one
   * would be an unhandled rejection, so the caller uses this instead of
   * {@link send} whenever the notification is fire-and-forget. Failures are
   * aggregated into a single line naming each recipient, its vendor code and
   * whether it was retryable; the same facts are kept as
   * {@link lastDelivery} so the last push can be asked about instead of
   * reconstructed from logs.
   *
   * @param notices - the finished runs to report.
   * @returns the delivery report, or undefined when nothing was attempted.
   */
  async notify(notices: readonly RunNotice[]): Promise<DeliveryReport | undefined> {
    if (notices.length === 0) return undefined
    const text = composeFeishuText(notices, this.options.hostLabel)
    const attempts = await this.send(text)
    if (attempts.length === 0) return undefined
    const failed: DeliveryFailure[] = []
    for (const attempt of attempts) {
      if (attempt.ok) continue
      failed.push({
        recipient: attempt.recipient,
        ...(attempt.code === undefined ? {} : { code: attempt.code }),
        error: attempt.error ?? '未知错误',
        retryable: attempt.retryable === true,
      })
    }
    const report: DeliveryReport = { at: this.now(), ok: failed.length === 0, delivered: attempts.length - failed.length, failed }
    this.lastReport = report
    if (report.ok) {
      this.log(`dsh-notify: 已推送 ${report.delivered} 条飞书通知`)
      return report
    }
    this.log(`dsh-notify: 推送失败 ${failed.length}/${attempts.length} 条未送达：${failed.map(describeFailure).join('; ')}`)
    return report
  }
}