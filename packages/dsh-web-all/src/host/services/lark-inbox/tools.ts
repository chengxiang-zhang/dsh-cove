/**
 * Agent tools for consuming and answering the local inbox queue.
 *
 * The tools are the only place the agent learns what the bot actually has. Two
 * details follow from that:
 *
 * - `lark_inbox_peek` reports connection health next to the counters. A bot that
 *   never connected looks exactly like a bot nobody messaged, and an agent that
 *   cannot tell those apart will confidently report "no new messages".
 * - `lark_inbox_reply` exists so answering is a queue operation rather than a
 *   second platform client the agent has to configure. It resolves its target
 *   from the stored envelope (chat id, sender open id, original message id) so a
 *   reply lands in the conversation the message came from.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type GenericCallView, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { LarkInboxEnvelope } from '../../../core/lark-inbox/queue.ts'
import type { InboxItem, InboxStore, InboxSettleStatus } from './inbox-store.ts'
import type { GatewayHealth } from './gateway.ts'
import { registerResources } from '../resources.ts'

const NOT_RUNNING = 'dsh-lark-inbox 未运行：请在「飞书」设置页填写应用凭据（appId/appSecret）并启用插件'
const NO_REPLY_TARGET = 'lark_inbox_reply 需要 event_id（从 lark_inbox_peek/pop 得到）或 chat_id 之一'
const ACK_STATUSES = ['done', 'pending', 'dead', 'not-found'] as const satisfies readonly InboxSettleStatus[]

function clampLimit(limit: number | undefined): number {
  const value = limit ?? 10
  return Number.isFinite(value) ? Math.min(50, Math.max(1, Math.trunc(value))) : 10
}

function preview(item: InboxItem) {
  const envelope = item.envelope
  return {
    eventId: envelope.eventId,
    receivedAt: envelope.receivedAt,
    chatType: envelope.chatType ?? '',
    chatId: envelope.chatId ?? '',
    senderOpenId: envelope.senderOpenId ?? '',
    messageType: envelope.messageType ?? '',
    contentPreview: envelope.content.slice(0, 300),
  }
}

function popped(item: InboxItem) {
  const envelope = item.envelope
  return {
    eventId: envelope.eventId,
    receivedAt: envelope.receivedAt,
    chatType: envelope.chatType ?? '',
    chatId: envelope.chatId ?? '',
    senderOpenId: envelope.senderOpenId ?? '',
    messageType: envelope.messageType ?? '',
    content: envelope.content,
    messageId: envelope.messageId ?? '',
  }
}

/** The send surface a reply needs, so tests can supply their own. */
export interface InboxReplySender {
  send(
    to: string,
    text: string,
    target?: { replyToMessageId?: string; idempotencyKey?: string },
  ): Promise<{ ok: boolean; error?: string; messageId?: string; retryable?: boolean }>
}

/** Whether replying is currently possible, and why not when it is not. */
export interface InboxReplyCapability {
  sender?: InboxReplySender
  /** Operator-facing reason the capability is unavailable. */
  error?: string
}

export interface InboxReplyRequest {
  /** Event id of the message being answered; resolves chat, sender and thread. */
  eventId?: string
  /** Explicit conversation to answer in, overriding the stored envelope. */
  chatId?: string
  text: string
  /**
   * Answer the original message (Feishu's reply API) instead of starting a new
   * message in the chat. Defaults to true: an answer belongs next to its question.
   */
  replyInThread?: boolean
}

export interface InboxReplyResult {
  ok: boolean
  messageId?: string
  error?: string
}

/** Feishu truncates the `uuid` idempotency token at 50 characters. */
const MAX_IDEMPOTENCY_KEY = 50

function idempotencyKeyOf(envelope: LarkInboxEnvelope | undefined): string | undefined {
  if (envelope === undefined) return undefined
  const key = (envelope.eventId || envelope.messageId || '').trim()
  return key === '' ? undefined : key.slice(0, MAX_IDEMPOTENCY_KEY)
}

/**
 * Resolve the target of one reply and send it.
 *
 * Everything that can go wrong is reported in the result instead of thrown: an
 * agent tool that throws gives the model a stack trace where it needed an
 * instruction ("the credentials are not configured yet").
 * @param store - the live inbox store, when the runtime is up.
 * @param capability - whether a sender is available right now.
 * @param request - which message to answer, and with what.
 * @returns the delivery result.
 */
export async function replyToInboxMessage(
  store: InboxStore | undefined,
  capability: InboxReplyCapability | undefined,
  request: InboxReplyRequest,
): Promise<InboxReplyResult> {
  const text = request.text.trim()
  if (text === '') return { ok: false, error: 'lark_inbox_reply: text 不能为空' }
  const eventId = (request.eventId ?? '').trim()
  const explicitChatId = (request.chatId ?? '').trim()
  if (eventId === '' && explicitChatId === '') return { ok: false, error: NO_REPLY_TARGET }
  let envelope: LarkInboxEnvelope | undefined
  if (eventId !== '') {
    if (store === undefined) return { ok: false, error: NOT_RUNNING }
    envelope = store.get(eventId)?.envelope
    if (envelope === undefined) {
      return { ok: false, error: `lark_inbox_reply: 找不到 event_id=${eventId} 的消息（可能已被确认或清理）` }
    }
  }
  // An explicit chat id wins; otherwise answer where the message came from, and
  // as a last resort in the sender's direct conversation.
  const to = explicitChatId !== '' ? explicitChatId : (envelope?.chatId ?? envelope?.senderOpenId ?? '').trim()
  if (to === '') {
    return { ok: false, error: 'lark_inbox_reply: 这条消息既没有 chat_id 也没有 sender open_id，无法确定回复对象' }
  }
  const sender = capability?.sender
  if (sender === undefined) {
    return { ok: false, error: capability?.error ?? 'feishu: 未配置飞书应用凭据，无法回复' }
  }
  const messageId = (envelope?.messageId ?? '').trim()
  const replyToMessageId = request.replyInThread === false || messageId === '' ? undefined : messageId
  const idempotencyKey = idempotencyKeyOf(envelope)
  const target = replyToMessageId === undefined && idempotencyKey === undefined
    ? undefined
    : { ...(replyToMessageId === undefined ? {} : { replyToMessageId }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }
  try {
    const attempt = await sender.send(to, text, target)
    if (!attempt.ok) return { ok: false, error: attempt.error ?? 'feishu: 发送失败' }
    return attempt.messageId === undefined || attempt.messageId === ''
      ? { ok: true }
      : { ok: true, messageId: attempt.messageId }
  } catch (error) {
    return { ok: false, error: `feishu: 发送失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Live state the read tools report alongside the queue itself. */
export interface InboxToolOptions {
  /** Current connection health, so "no messages" is distinguishable from "not connected". */
  gatewayStatus?(): GatewayHealth
  /** The reply capability for the current credentials, or why it is unavailable. */
  reply?(): InboxReplyCapability
}

export function createInboxTools(getStore: () => InboxStore | undefined, options: InboxToolOptions = {}): ToolDefinition[] {
  return [
    defineTool({
      name: 'lark_inbox_peek',
      description: 'List pending Feishu/Lark bot messages without locking them. Returns queue pending/processing/dead counters plus gateway connection health, or an error when the inbox is disabled or unconfigured.',
      parameters: { limit: { type: 'integer', default: 10, description: 'Maximum pending messages (clamped to 1..50).' } },
      output: {
        schema: {
          type: 'object', additionalProperties: false, properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
              eventId: { type: 'string', required: true }, receivedAt: { type: 'string', required: true },
              chatType: { type: 'string', required: true }, chatId: { type: 'string', required: true },
              senderOpenId: { type: 'string', required: true },
              messageType: { type: 'string', required: true }, contentPreview: { type: 'string', required: true },
            } } },
            pending: { type: 'integer' }, processing: { type: 'integer' }, dead: { type: 'integer' },
            gateway: { type: 'string', enum: ['connecting', 'connected', 'error'] },
            gatewayError: { type: 'string' }, error: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const store = getStore()
        if (!store) return { error: NOT_RUNNING }
        const stats = store.stats()
        const health = options.gatewayStatus?.() ?? { status: 'connecting' }
        return {
          items: store.peek(clampLimit(args.limit)).map(preview),
          pending: stats.pending, processing: stats.processing, dead: stats.dead,
          gateway: health.status,
          ...(health.error === undefined || health.error === '' ? {} : { gatewayError: health.error }),
        }
      },
      presentCall(args): GenericCallView { return { card: 'generic', title: 'Peek lark inbox', kind: 'read', rawInput: args } },
    }),
    defineTool({
      name: 'lark_inbox_pop',
      description: 'Claim the oldest pending Feishu/Lark message into processing. You must settle its eventId with lark_inbox_ack; stale claims are recovered before each pop.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          item: { oneOf: [
            { type: 'object', additionalProperties: false, properties: {
              eventId: { type: 'string', required: true }, receivedAt: { type: 'string', required: true },
              chatType: { type: 'string', required: true }, chatId: { type: 'string', required: true },
              senderOpenId: { type: 'string', required: true },
              messageType: { type: 'string', required: true }, content: { type: 'string', required: true }, messageId: { type: 'string', required: true },
            } },
            { type: 'null' },
          ] }, pending: { type: 'integer' }, error: { type: 'string' },
        } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        const store = getStore()
        if (!store) return { error: NOT_RUNNING }
        store.recoverStale()
        const item = store.pop()
        return { item: item === null ? null : popped(item), pending: store.stats().pending }
      },
      presentCall(args): GenericCallView { return { card: 'generic', title: 'Pop next lark inbox message', kind: 'read', rawInput: args } },
    }),
    defineTool({
      name: 'lark_inbox_ack',
      description: 'Settle a message claimed by lark_inbox_pop. ok=true marks done; ok=false retries it or moves it to dead after maxAttempts. Returns not-found when no claimed message has that eventId.',
      parameters: {
        event_id: { type: 'string', required: true, description: 'eventId returned by peek or pop.' },
        ok: { type: 'boolean', required: true, description: 'true to finish, false to retry.' },
        note: { type: 'string', description: 'Optional non-persisted decision note.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ACK_STATUSES }, error: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const store = getStore()
        if (!store) return { error: NOT_RUNNING }
        return { status: args.ok ? store.ack(args.event_id) : store.nack(args.event_id) }
      },
      presentCall(args): GenericCallView { return { card: 'generic', title: 'Acknowledge lark inbox message', kind: 'read', rawInput: args } },
    }),
    defineTool({
      name: 'lark_inbox_reply',
      description: 'Reply to a Feishu/Lark message this bot received. Target it with event_id (from peek/pop) so the answer lands in the same conversation, or with chat_id to answer somewhere else. Returns ok plus the sent message id, or a plain error string when the bot has no credentials or the message is unknown.',
      parameters: {
        event_id: { type: 'string', description: 'eventId returned by lark_inbox_peek or lark_inbox_pop; resolves chat, sender and the original message.' },
        chat_id: { type: 'string', description: 'Explicit conversation id (oc_...). Takes precedence over event_id for the destination.' },
        text: { type: 'string', required: true, description: 'Message body to send.' },
        reply_in_thread: { type: 'boolean', default: true, description: 'Answer the original message in its thread (default) instead of posting a new top-level message.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false, properties: {
            ok: { type: 'boolean', required: true },
            messageId: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        return replyToInboxMessage(getStore(), options.reply?.(), {
          eventId: args.event_id,
          chatId: args.chat_id,
          text: args.text,
          replyInThread: args.reply_in_thread,
        })
      },
      presentCall(args): GenericCallView { return { card: 'generic', title: 'Reply to lark inbox message', kind: 'edit', rawInput: args } },
    }),
  ]
}

export function registerInboxTools(
  ctx: Context,
  getStore: () => InboxStore | undefined,
  options: InboxToolOptions = {},
): () => void {
  return registerResources(own => {
    for (const tool of createInboxTools(getStore, options)) own(ctx.tools.register(tool))
  })
}