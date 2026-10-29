/** Agent tools for consuming the local inbox queue. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type GenericCallView, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { InboxItem, InboxStore } from './inbox-store.ts'
import { registerResources } from '../resources.ts'

const NOT_RUNNING = 'dsh-lark-inbox 未运行：请在设置里配置 appId/appSecret 并启用插件'
const ACK_STATUSES = ['done', 'pending', 'dead', 'not-found'] as const

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
    senderOpenId: envelope.senderOpenId ?? '',
    messageType: envelope.messageType ?? '',
    content: envelope.content,
    messageId: envelope.messageId ?? '',
  }
}

export function createInboxTools(getStore: () => InboxStore | undefined): ToolDefinition[] {
  return [
    defineTool({
      name: 'lark_inbox_peek',
      description: 'List pending Feishu/Lark bot messages without locking them. Returns queue pending/processing/dead counters, or an error when the inbox is disabled or unconfigured.',
      parameters: { limit: { type: 'integer', default: 10, description: 'Maximum pending messages (clamped to 1..50).' } },
      output: {
        schema: {
          type: 'object', additionalProperties: false, properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
              eventId: { type: 'string', required: true }, receivedAt: { type: 'string', required: true },
              chatType: { type: 'string', required: true }, senderOpenId: { type: 'string', required: true },
              messageType: { type: 'string', required: true }, contentPreview: { type: 'string', required: true },
            } } },
            pending: { type: 'integer' }, processing: { type: 'integer' }, dead: { type: 'integer' }, error: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const store = getStore()
        if (!store) return { error: NOT_RUNNING }
        const stats = store.stats()
        return { items: store.peek(clampLimit(args.limit)).map(preview), pending: stats.pending, processing: stats.processing, dead: stats.dead }
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
              chatType: { type: 'string', required: true }, senderOpenId: { type: 'string', required: true },
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
      description: 'Settle a message claimed by lark_inbox_pop. ok=true marks done; ok=false retries it or moves it to dead after maxAttempts.',
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
        const raw = args.ok ? store.ack(args.event_id) : store.nack(args.event_id)
        const status: (typeof ACK_STATUSES)[number] = typeof raw === 'string' && (ACK_STATUSES as readonly string[]).includes(raw)
          ? raw as (typeof ACK_STATUSES)[number]
          : args.ok ? 'done' : 'pending'
        return { status }
      },
      presentCall(args): GenericCallView { return { card: 'generic', title: 'Acknowledge lark inbox message', kind: 'read', rawInput: args } },
    }),
  ]
}

export function registerInboxTools(ctx: Context, getStore: () => InboxStore | undefined): () => void {
  return registerResources(own => {
    for (const tool of createInboxTools(getStore)) own(ctx.tools.register(tool))
  })
}
