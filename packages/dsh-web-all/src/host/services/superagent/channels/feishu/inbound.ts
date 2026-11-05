/**
 * Envelope to protocol event: the one place a Feishu message becomes an `inbound`.
 *
 * The queue stores a normalized envelope whose `raw` is the untouched platform
 * event, and two shapes of that event reach this host: the flat body (the
 * webhook payload's `event` object on its own) and the v2 wrapper (`{ header,
 * event }`). The channel reads both, because a shape it refused would be a
 * message nobody answers.
 *
 * Identity comes from `sender.sender_id`. `union_id` is the person key the world
 * model uses, so it is read when present and left absent when not: an event
 * without one is a weak identity, and inventing a key from another field would
 * silently merge two people. `open_id` is the only fallback and it is a
 * per-application id, which is why it never becomes `party_id` on its own.
 *
 * @module dsh-web-all/superagent/channels/feishu/inbound
 */

import type { InboundEvent } from '../../protocol/events.ts'
import { threadKey } from '../../protocol/events.ts'
import type { LarkInboxEnvelope } from '../../../../../core/lark-inbox/queue.ts'

/** Why an envelope could not be turned into an inbound event; stable for logging. */
export type InboundRejection =
  | 'INBOUND_MISSING_CHAT_TYPE'
  | 'INBOUND_MISSING_CHAT_ID'
  | 'INBOUND_MISSING_SENDER'
  | 'INBOUND_MISSING_MESSAGE_ID'

/** Named error so the channel can log a reason and still let the responder answer. */
export class InboundShapeError extends Error {
  readonly code: InboundRejection
  constructor(code: InboundRejection, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'InboundShapeError'
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The event body inside either shape.
 * @param raw - the envelope's untouched platform payload.
 * @returns the object holding `sender` and `message`.
 */
function eventBody(raw: unknown): Record<string, unknown> {
  const outer = isRecord(raw) ? raw : {}
  return isRecord(outer.event) ? outer.event : outer
}

function senderRecord(body: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  const inner = isRecord(body.sender) ? body.sender : undefined
  if (inner !== undefined) return inner
  const outer = isRecord(raw) ? raw : {}
  return isRecord(outer.sender) ? outer.sender : {}
}

/**
 * The cross-application person key carried by one raw event.
 *
 * Absent means weak identity, never "look elsewhere": `user_id` is null in every
 * event this host has recorded, and `open_id` is application-scoped.
 * @param raw - the envelope's untouched platform payload.
 * @returns the `union_id`, or undefined when the event did not carry one.
 */
export function unionIdOf(raw: unknown): string | undefined {
  const body = eventBody(raw)
  const sender = senderRecord(body, raw)
  const senderId = sender.sender_id
  if (isRecord(senderId)) return asString(senderId.union_id)
  return undefined
}

/** @param raw - the envelope's untouched platform payload. @returns the `open_id`. */
function openIdOf(raw: unknown): string | undefined {
  const body = eventBody(raw)
  const sender = senderRecord(body, raw)
  const senderId = sender.sender_id
  if (isRecord(senderId)) return asString(senderId.open_id)
  return asString(senderId)
}

/** @param raw - the envelope's untouched platform payload. @returns the message body. */
function messageOf(raw: unknown, body: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(body.message)) return body.message
  const outer = isRecord(raw) ? raw : {}
  return isRecord(outer.message) ? outer.message : {}
}

/**
 * Turn one stored envelope into the protocol's inbound event.
 *
 * `received_at` is supplied by the caller rather than read from the envelope: the
 * envelope's `receivedAt` is an ISO string written when the event was queued, and
 * the kernel compares epoch milliseconds.
 * @param envelope - the stored queue envelope.
 * @param receivedAt - epoch milliseconds the channel admitted the event.
 * @returns the inbound event.
 * @throws {InboundShapeError} when a field the protocol requires is missing.
 */
export function toInboundEvent(envelope: LarkInboxEnvelope, receivedAt: number): InboundEvent {
  const raw = envelope.raw
  const body = eventBody(raw)
  const message = messageOf(raw, body)

  const chatTypeRaw = envelope.chatType ?? asString(message.chat_type)
  if (chatTypeRaw !== 'p2p' && chatTypeRaw !== 'group') {
    throw new InboundShapeError('INBOUND_MISSING_CHAT_TYPE', `event ${envelope.eventId} carried no usable chat type`)
  }
  const chatId = envelope.chatId ?? asString(message.chat_id)
  if (chatId === undefined) {
    throw new InboundShapeError('INBOUND_MISSING_CHAT_ID', `event ${envelope.eventId} carried no chat id`)
  }
  const openId = envelope.senderOpenId ?? openIdOf(raw)
  if (openId === undefined) {
    throw new InboundShapeError('INBOUND_MISSING_SENDER', `event ${envelope.eventId} carried no sender open id`)
  }
  const messageId = envelope.messageId ?? asString(message.message_id)
  if (messageId === undefined) {
    throw new InboundShapeError('INBOUND_MISSING_MESSAGE_ID', `event ${envelope.eventId} carried no message id`)
  }

  // A message that answers inside a thread belongs to the thread's root, not to
  // itself: keying it to its own id would open one thread per message.
  const rootId = asString(message.root_id) ?? asString(message.thread_id) ?? messageId
  const unionId = unionIdOf(raw)

  return {
    event_id: envelope.eventId,
    chat: { id: chatId, type: chatTypeRaw },
    sender: unionId === undefined ? { open_id: openId } : { open_id: openId, union_id: unionId },
    thread: threadKey(chatTypeRaw, chatId, rootId),
    text: envelope.content,
    message_id: messageId,
    received_at: receivedAt,
  }
}