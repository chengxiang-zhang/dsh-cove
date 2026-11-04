/**
 * Outbound Feishu text delivery shared by the reply path and the run-finished
 * push.
 *
 * Two things live here rather than in each consumer:
 *
 * 1. `receive_id_type` inference. Feishu requires the caller to declare whether a
 *    target is a person (`ou_` open id) or a conversation (`oc_` chat id), and the
 *    two are not interchangeable. Both surfaces accept a target chosen by an
 *    operator, so both must infer the type from the id's prefix.
 * 2. Error classification. Feishu answers business errors inside a resolved
 *    promise, and only some of them are worth another attempt. Flattening them
 *    all into "failed" makes rate limiting look like a permission bug.
 *
 * Text is deliberate: a card's schema is versioned and a rejected card is a
 * silently lost message, while a text body delivers the same facts with nothing
 * to validate.
 */

import { Client, Domain } from '@larksuiteoapi/node-sdk'
import type { FeishuCredentials } from './credentials.ts'

/** The id namespaces Feishu distinguishes on the send path. */
export type ReceiveIdType = 'open_id' | 'chat_id' | 'union_id' | 'user_id' | 'email'

/** Feishu's documented per-request ceiling for a text body (150 KB). */
const MAX_TEXT_CHARS = 140_000

/**
 * Infer Feishu's `receive_id_type` from a target id.
 *
 * Mirrors the platform's own documented prefixes: `oc_` is a conversation, `ou_`
 * a user's open id, `on_` a union id, anything containing `@` an email address.
 * @param to - the configured or event-derived target.
 * @returns the id type to declare on the request.
 * @throws when the target is empty, because an empty target has no correct type.
 */
export function detectReceiveIdType(to: string): ReceiveIdType {
  const value = to.trim()
  if (value === '') throw new Error('feishu: 收件人为空，无法判断 receive_id_type')
  if (value.startsWith('oc_')) return 'chat_id'
  if (value.startsWith('ou_')) return 'open_id'
  if (value.startsWith('on_')) return 'union_id'
  if (value.includes('@')) return 'email'
  return 'user_id'
}

/**
 * Feishu codes that mean "later", as opposed to "never".
 *
 * 99991400 is the interface-level frequency gate (HTTP 429), 230020 the per-chat
 * send gate, 11232 the message subsystem's own limiter.
 */
const RETRYABLE_CODES: readonly number[] = [99991400, 230020, 11232]

/**
 * Whether a business error code is worth retrying.
 * @param code - the `code` field of a Feishu response.
 * @returns true for rate limiting, false for permission/format/target errors.
 */
export function isRetryableFeishuCode(code: number | undefined): boolean {
  return typeof code === 'number' && RETRYABLE_CODES.includes(code)
}

/**
 * Pull the created message's id out of a Feishu send response.
 *
 * Both `im/v1/messages` and its reply variant answer with
 * `data.message_id`; older envelopes put it at the root. Missing is not an
 * error — the message was sent either way.
 * @param response - the resolved response envelope.
 * @returns the id, or undefined when the envelope carried none.
 */
function readCreatedMessageId(response: unknown): string | undefined {
  if (typeof response !== 'object' || response === null) return undefined
  const root = response as { message_id?: unknown; data?: { message_id?: unknown } }
  const candidates = [root.data?.message_id, root.message_id]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/** One delivery's outcome, reported rather than thrown. */
export interface FeishuSendAttempt {
  ok: boolean
  error?: string
  code?: number
  retryable: boolean
  /** Id of the message the platform created, when it answered with one. */
  messageId?: string
}

/** The vendor surface this module uses, so tests can supply their own. */
export interface FeishuSenderSdk {
  domain: { Feishu: unknown; Lark: unknown }
  createClient(options: { appId: string; appSecret: string; domain: unknown }): FeishuClientLike
}

/** The narrow client shape a text send needs. */
export interface FeishuClientLike {
  im: {
    message: {
      create(payload: unknown): Promise<unknown>
      reply(payload: unknown): Promise<unknown>
    }
  }
}

const officialSdk: FeishuSenderSdk = {
  domain: { Feishu: Domain.Feishu, Lark: Domain.Lark },
  createClient: options => new Client(options as ConstructorParameters<typeof Client>[0]) as unknown as FeishuClientLike,
}

export interface FeishuTextSenderOptions {
  credentials: FeishuCredentials
  sdk?: FeishuSenderSdk
  log?: (message: string) => void
}

/** How to address one delivery. */
export interface FeishuSendTarget {
  /** Reply inside the thread of this message instead of starting a new one. */
  replyToMessageId?: string
  /** Feishu-side idempotency token; a retry with the same value is collapsed. */
  idempotencyKey?: string
}

/**
 * Sends one text body to one target.
 *
 * One instance is bound to one credential set, so a settings change rebuilds it
 * rather than leaving a stale tenant token behind.
 */
export class FeishuTextSender {
  private readonly options: FeishuTextSenderOptions
  private readonly sdk: FeishuSenderSdk
  private readonly log: (message: string) => void
  private client: FeishuClientLike | undefined

  constructor(options: FeishuTextSenderOptions) {
    this.options = options
    this.sdk = options.sdk ?? officialSdk
    this.log = options.log ?? (() => undefined)
  }

  private vendorClient(): FeishuClientLike {
    if (this.client !== undefined) return this.client
    const { credentials } = this.options
    const mapped = credentials.domain === 'feishu' ? this.sdk.domain.Feishu : this.sdk.domain.Lark
    this.client = this.sdk.createClient({ appId: credentials.appId, appSecret: credentials.appSecret, domain: mapped })
    return this.client
  }

  /**
   * Deliver one text body.
   * @param to - open id, chat id, union id, email, or user id of the target.
   * @param text - the message body.
   * @param target - reply/idempotency controls.
   * @returns the attempt result; never throws for a vendor or transport failure.
   */
  async send(to: string, text: string, target: FeishuSendTarget = {}): Promise<FeishuSendAttempt> {
    const body = text.trim()
    if (body === '') return { ok: false, error: 'feishu: 消息正文为空', retryable: false }
    if (body.length > MAX_TEXT_CHARS) {
      return { ok: false, error: `feishu: 消息正文超过 ${MAX_TEXT_CHARS} 字符上限（${body.length}）`, retryable: false }
    }
    const content = JSON.stringify({ text: body })
    try {
      const client = this.vendorClient()
      const response = target.replyToMessageId !== undefined
        ? await client.im.message.reply({
          path: { message_id: target.replyToMessageId },
          data: { msg_type: 'text', content, ...(target.idempotencyKey === undefined ? {} : { uuid: target.idempotencyKey }) },
        })
        : await client.im.message.create({
          params: { receive_id_type: detectReceiveIdType(to) },
          data: { receive_id: to.trim(), msg_type: 'text', content, ...(target.idempotencyKey === undefined ? {} : { uuid: target.idempotencyKey }) },
        })
      // The SDK resolves for a business error too, so the envelope decides.
      const code = (response as { code?: unknown } | undefined)?.code
      if (typeof code === 'number' && code !== 0) {
        const message = String((response as { msg?: unknown }).msg ?? '')
        return { ok: false, code, error: `feishu code ${code}: ${message}`, retryable: isRetryableFeishuCode(code) }
      }
      // The created message's id is what a caller needs to link or edit the
      // message later, so it travels with the attempt instead of being dropped.
      const messageId = readCreatedMessageId(response)
      return { ok: true, retryable: false, ...(messageId === undefined ? {} : { messageId }) }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log(`feishu: 发送失败：${detail}`)
      return { ok: false, error: detail, retryable: true }
    }
  }
}

/**
 * Build a text sender for one credential set.
 * @param options - credentials, log sink, and an optional vendor seam.
 * @returns the sender.
 */
export function createFeishuTextSender(options: FeishuTextSenderOptions): FeishuTextSender {
  return new FeishuTextSender(options)
}