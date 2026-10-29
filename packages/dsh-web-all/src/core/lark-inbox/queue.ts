/** Pure queue-envelope logic shared by host and browser TypeScript programs. */

export const ENVELOPE_VERSION = 1 as const
export const INBOX_EVENT_TYPE = 'im.message.receive_v1' as const

export interface LarkInboxEnvelope {
  envelopeVersion: 1
  eventId: string
  receivedAt: string
  eventType: string
  chatType?: 'p2p' | 'group'
  chatId?: string
  senderOpenId?: string
  messageId?: string
  messageType?: string
  content: string
  mentionBot?: boolean
  raw?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function resolveSenderOpenId(sender: unknown, inner: unknown): string | undefined {
  if (!isRecord(sender)) return isRecord(inner) ? asString(inner.sender_id) : undefined
  const senderId = sender.sender_id
  if (typeof senderId === 'string' && senderId.length > 0) return senderId
  if (isRecord(senderId)) {
    const openId = asString(senderId.open_id)
    if (openId) return openId
  }
  return isRecord(inner) ? asString(inner.sender_id) : undefined
}

/** Normalize either SDK event shape into the stable queue envelope. */
export function toEnvelope(
  event: unknown,
  opts: { mentionBot?: boolean; receivedAt?: string } = {},
): LarkInboxEnvelope {
  const source = isRecord(event) ? event : {}
  const header = isRecord(source.header) ? source.header : {}
  const inner = isRecord(source.event) ? source.event : source
  const message = isRecord(inner.message) ? inner.message : {}
  const messageId = asString(message.message_id) ?? asString(inner.message_id)
  const eventId = asString(header.event_id) ?? messageId ?? ''
  const senderOpenId = resolveSenderOpenId(isRecord(inner.sender) ? inner.sender : undefined, inner)
  const chatTypeRaw = asString(message.chat_type) ?? asString(inner.chat_type)
  const chatType = chatTypeRaw === 'p2p' || chatTypeRaw === 'group' ? chatTypeRaw : undefined
  const contentRaw = message.content
  let content = ''
  if (typeof contentRaw === 'string') content = contentRaw
  else if (isRecord(contentRaw)) content = JSON.stringify(contentRaw)

  return {
    envelopeVersion: ENVELOPE_VERSION,
    eventId,
    receivedAt: opts.receivedAt ?? new Date().toISOString(),
    eventType: INBOX_EVENT_TYPE,
    chatType,
    chatId: asString(message.chat_id) ?? asString(inner.chat_id),
    senderOpenId,
    messageId,
    messageType: asString(message.message_type) ?? asString(inner.message_type),
    content,
    mentionBot: opts.mentionBot,
    raw: source,
  }
}

export function envelopeToLine(envelope: LarkInboxEnvelope): string {
  return JSON.stringify(envelope) + '\n'
}

export function dayPart(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function inboxFilePath(rootDir: string, eventType: string, ts: number): string {
  return `${rootDir}/${sanitizeSegment(eventType)}/${dayPart(ts)}.jsonl`
}
