/**
 * `Channel.send`: one text body to one conversation, idempotent by the caller's key.
 *
 * The vendor collapses two sends that carry the same `uuid`, so the key the
 * kernel chooses is the key that prevents a double answer after a crash between
 * "wrote the outbox row" and "sent it". Feishu caps that field at 50 characters,
 * and the keys this host derives (job ids, steer request ids) can exceed it, so
 * the derivation is deterministic and length-bounded instead of a truncation:
 * truncating two long keys that differ only in their tail would collapse two
 * different answers into one.
 *
 * The channel does not retry. The backoff that exists today (30 seconds, giving
 * up after 24 hours) lives in `reply_jobs`, which the responder owns; a channel
 * that also retried would multiply it and hide the attempt count from the ledger.
 * A failed send is returned to the caller as a rejection carrying `retryable`.
 *
 * @module dsh-web-all/superagent/channels/feishu/send
 */

/** Feishu's limit for `uuid`; longer values are rejected by the vendor. */
export const FEISHU_UUID_MAX_CHARS = 50

/** What a send port reports; mirrors the reply capability the host already has. */
export interface ChannelSendResult {
  ok: boolean
  error?: string
  messageId?: string
  retryable?: boolean
}

/** The send surface a channel needs, so tests supply their own. */
export interface ChannelSendPort {
  send(
    to: string,
    text: string,
    target?: { replyToMessageId?: string; idempotencyKey?: string },
  ): Promise<ChannelSendResult>
}

/** Named send failure; `retryable` is the vendor's own verdict, not a guess. */
export class ChannelSendError extends Error {
  readonly code: 'SEND_UNAVAILABLE' | 'SEND_FAILED'
  readonly retryable: boolean
  constructor(code: 'SEND_UNAVAILABLE' | 'SEND_FAILED', detail: string, retryable = false) {
    super(`${code}: ${detail}`)
    this.name = 'ChannelSendError'
    this.code = code
    this.retryable = retryable
  }
}

/**
 * Stable 64-bit FNV-1a of one string, as 15 lowercase hex characters.
 * @param value - the key to fold.
 * @returns the digest.
 */
function digest15(value: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(15, '0').slice(-15)
}

/**
 * The vendor idempotency token for one kernel key.
 *
 * A key that already fits is used verbatim, so the token an operator sees in a
 * Feishu log still matches the row in `outbox`. A longer one keeps a readable
 * prefix and is disambiguated by a digest of the whole key.
 * @param idemKey - the kernel's idempotency key.
 * @returns a token of at most {@link FEISHU_UUID_MAX_CHARS} characters.
 */
export function deliveryUuid(idemKey: string): string {
  const key = idemKey.trim()
  if (key === '') return 'superagent-empty-key'
  if (key.length <= FEISHU_UUID_MAX_CHARS) return key
  const prefix = key.slice(0, FEISHU_UUID_MAX_CHARS - 16)
  return `${prefix}-${digest15(key)}`
}

/**
 * Deliver one text body.
 * @param port - the send surface, when one is configured.
 * @param chatId - the conversation to answer in.
 * @param text - the body; the vendor trims it, so an empty one is refused here.
 * @param replyTo - message being answered, when the answer belongs to one.
 * @param idemKey - the kernel's idempotency key.
 * @returns the vendor's message id.
 * @throws {ChannelSendError} when nothing can send, the body is empty, or the vendor refused.
 */
export async function deliverText(
  port: ChannelSendPort | undefined,
  chatId: string,
  text: string,
  replyTo: string | undefined,
  idemKey: string,
): Promise<{ messageId: string }> {
  if (port === undefined) throw new ChannelSendError('SEND_UNAVAILABLE', 'no Feishu application is configured')
  if (text.trim() === '') throw new ChannelSendError('SEND_FAILED', 'refusing to send an empty body')
  const result = await port.send(chatId, text, {
    ...(replyTo === undefined ? {} : { replyToMessageId: replyTo }),
    idempotencyKey: deliveryUuid(idemKey),
  })
  if (!result.ok) throw new ChannelSendError('SEND_FAILED', result.error ?? 'the platform refused the message', result.retryable === true)
  const messageId = (result.messageId ?? '').trim()
  if (messageId === '') throw new ChannelSendError('SEND_FAILED', 'the platform reported success without a message id', false)
  return { messageId }
}