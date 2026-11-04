/**
 * Pure queue-envelope logic shared by host and browser TypeScript programs.
 *
 * The envelope's `content` field is what the agent actually reads, so it holds
 * readable text rather than the platform's wire JSON: Feishu sends
 * `{"text":"@_user_1 ship it?"}` and the agent should see `@Alice ship it?`.
 * The untouched event is kept in `raw`, so nothing is lost by normalizing.
 */

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

/** One `@mention` as the platform reports it. */
export interface MentionSummary {
  /** Placeholder token used inside the message body, e.g. `@_user_1`. */
  key: string
  /** Display name the platform resolved for the mentioned user or bot. */
  name: string
  /** open ids carried by this mention, when the event supplied them. */
  openIds: readonly string[]
}

function mentionEntry(entry: unknown): MentionSummary | undefined {
  if (!isRecord(entry)) return undefined
  const key = typeof entry.key === 'string' ? entry.key.trim() : ''
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  const openIds: string[] = []
  const id = entry.id
  if (isRecord(id)) {
    for (const field of ['open_id', 'user_id', 'union_id']) {
      const value = asString(id[field])
      if (value !== undefined) openIds.push(value)
    }
  } else if (typeof id === 'string' && id !== '') {
    openIds.push(id)
  }
  if (key === '' && name === '' && openIds.length === 0) return undefined
  return { key, name, openIds }
}

/**
 * Read the mentions attached to a message.
 * @param message - the event's `message` object (as sent by both webhook and WS shapes).
 * @param inner - the event body, used as a fallback location.
 * @returns every mention, in event order; an empty list when the event carries none.
 */
export function readMentions(message: unknown, inner?: unknown): MentionSummary[] {
  const candidates: unknown[] = []
  if (isRecord(message) && Array.isArray(message.mentions)) candidates.push(message.mentions)
  if (isRecord(inner)) {
    if (isRecord(inner.message) && Array.isArray(inner.message.mentions)) candidates.push(inner.message.mentions)
    if (Array.isArray(inner.mentions)) candidates.push(inner.mentions)
  }
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const mentions: MentionSummary[] = []
    for (const entry of candidate) {
      const mention = mentionEntry(entry)
      if (mention !== undefined) mentions.push(mention)
    }
    if (mentions.length > 0) return mentions
  }
  return []
}

/**
 * Replace `@_user_N` placeholders with the names the platform resolved.
 *
 * A mention without a display name keeps its placeholder: showing `@_user_2`
 * is honest about an unnamed mention, while inventing a name is not.
 * @param text - the body as the platform wrote it.
 * @param mentions - mentions read from the same event.
 * @returns the body an agent can read.
 */
export function renderMentions(text: string, mentions: readonly MentionSummary[]): string {
  let rendered = text
  for (const mention of mentions) {
    if (mention.key === '' || mention.name === '') continue
    rendered = rendered.split(mention.key).join(`@${mention.name}`)
  }
  return rendered
}

function postBodyText(content: unknown, mentions: readonly MentionSummary[]): string {
  if (!isRecord(content)) return ''
  const title = typeof content.title === 'string' ? content.title.trim() : ''
  const paragraphs: string[] = []
  const rawParagraphs = content.content
  if (Array.isArray(rawParagraphs)) {
    for (const paragraph of rawParagraphs) {
      if (!Array.isArray(paragraph)) continue
      const parts: string[] = []
      for (const node of paragraph) {
        if (!isRecord(node)) continue
        const tag = asString(node.tag) ?? ''
        if (tag === 'text' && typeof node.text === 'string') parts.push(node.text)
        else if (tag === 'a') {
          const label = typeof node.text === 'string' && node.text !== '' ? node.text : ''
          const href = typeof node.href === 'string' ? node.href : ''
          parts.push(href === '' ? label : `${label} (${href})`)
        } else if (tag === 'at') {
          const name = asString(node.user_name) ?? asString(node.user_id) ?? ''
          parts.push(name === '' ? '@' : `@${name}`)
        } else if (tag === 'img' || tag === 'image') {
          parts.push(`[image: ${asString(node.image_key) ?? 'unknown'}]`)
        } else if (tag === 'media') {
          parts.push(`[video: ${asString(node.file_key) ?? 'unknown'}]`)
        } else if (tag === 'emotion') {
          parts.push(asString(node.emoji_type) ?? '[emotion]')
        } else if (tag === 'code_block') {
          const text = typeof node.text === 'string' ? node.text : ''
          parts.push(text)
        }
      }
      const line = renderMentions(parts.join(''), mentions).trim()
      if (line !== '') paragraphs.push(line)
    }
  }
  const body = paragraphs.join('\n')
  if (title === '') return body
  return body === '' ? title : `${title}\n${body}`
}

function placeholder(type: string, detail: string): string {
  return detail === '' ? `[${type}]` : `[${type}: ${detail}]`
}

/**
 * Describe a non-text message body in one readable line.
 * @param type - the platform's `message_type`.
 * @param content - the parsed JSON body.
 * @param mentions - mentions read from the same event.
 * @returns a placeholder summary, or the post body for rich-text messages.
 */
function describeStructured(type: string, content: Record<string, unknown>, mentions: readonly MentionSummary[]): string {
  switch (type) {
    case 'post': return postBodyText(content, mentions)
    case 'image': return placeholder('image', asString(content.image_key) ?? '')
    case 'file': {
      const name = asString(content.file_name) ?? ''
      const key = asString(content.file_key) ?? ''
      return placeholder('file', name !== '' ? name : key)
    }
    case 'audio': {
      const key = asString(content.file_key) ?? ''
      const duration = typeof content.duration === 'number' ? ` ${Math.round(content.duration / 1000)}s` : ''
      return placeholder('audio', `${key}${duration}`.trim())
    }
    case 'media': {
      const key = asString(content.file_key) ?? ''
      const duration = typeof content.duration === 'number' ? ` ${Math.round(content.duration / 1000)}s` : ''
      return placeholder('video', `${key}${duration}`.trim())
    }
    case 'sticker': return placeholder('sticker', asString(content.file_key) ?? '')
    case 'interactive': return placeholder('interactive card', '')
    case 'share_chat': return placeholder('shared chat', asString(content.chat_id) ?? '')
    case 'share_user': return placeholder('shared contact', asString(content.user_id) ?? '')
    case 'location': {
      const name = asString(content.name) ?? ''
      const latitude = typeof content.latitude === 'number' ? String(content.latitude) : ''
      const longitude = typeof content.longitude === 'number' ? String(content.longitude) : ''
      const coordinates = latitude === '' || longitude === '' ? '' : ` (${latitude}, ${longitude})`
      return placeholder('location', `${name}${coordinates}`.trim())
    }
    case 'merge_forward':
    case 'forward': return placeholder('forwarded messages', '')
    case 'system': {
      const body = typeof content.body === 'string' ? content.body : ''
      return placeholder('system notice', body)
    }
    default: return placeholder(type === '' ? 'unsupported message' : type, '')
  }
}

/**
 * Turn the platform's `message.content` payload into readable text.
 *
 * Backward compatibility matters here: a body that is not JSON at all is
 * returned unchanged, and a missing body yields an empty string rather than an
 * exception, because a malformed event must not cost the queue a message.
 * @param messageType - the platform's `message_type`, when the event carried it.
 * @param raw - `message.content` exactly as received (string or object).
 * @param mentions - mentions read from the same event.
 * @returns the text an agent should read.
 */
export function describeContent(
  messageType: string | undefined,
  raw: unknown,
  mentions: readonly MentionSummary[] = [],
): string {
  if (raw === undefined || raw === null) return ''
  const text = typeof raw === 'string' ? raw : ''
  if (text === '') {
    // An object body (webhook-shaped events) is already parsed; describe it directly.
    return isRecord(raw) ? describeStructured(messageType ?? '', raw, mentions) : ''
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return text }
  if (typeof parsed === 'string') return renderMentions(parsed, mentions)
  if (Array.isArray(parsed)) return describeStructured(messageType ?? 'post', { content: parsed }, mentions)
  if (!isRecord(parsed)) return text
  const declared = messageType !== undefined && messageType !== ''
  const type = declared ? messageType : inferContentType(parsed)
  // `text` messages are the common case: their body carries a `text` field and
  // the mentions sit next to it in the event, not inside the content.
  if (type === 'text' && typeof parsed.text === 'string') return renderMentions(parsed.text, mentions)
  // A post body is either the paragraphs themselves or a locale wrapper around them.
  if (type === 'post') {
    const candidates = isRecord(parsed.post) ? [parsed.post, parsed] : [parsed]
    for (const candidate of candidates) {
      if (Array.isArray(candidate.content)) return postBodyText(candidate, mentions)
      const locale = Object.values(candidate).find(entry => isRecord(entry) && Array.isArray(entry.content))
      if (isRecord(locale)) return postBodyText(locale, mentions)
    }
    return placeholder('post', '')
  }
  return describeStructured(type, parsed, mentions)
}

/**
 * Guess the message type of a body whose event omitted `message_type`.
 * @param content - the parsed JSON body.
 * @returns the best matching platform type, or '' when nothing matches.
 */
function inferContentType(content: Record<string, unknown>): string {
  if (typeof content.text === 'string') return 'text'
  if (isRecord(content.post)) return 'post'
  if (Array.isArray(content.content) || typeof content.title === 'string') return 'post'
  if (typeof content.image_key === 'string') return 'image'
  if (typeof content.file_key === 'string') return typeof content.file_name === 'string' ? 'file' : 'audio'
  if (typeof content.chat_id === 'string') return 'share_chat'
  if (typeof content.user_id === 'string') return 'share_user'
  return ''
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
  const messageType = asString(message.message_type) ?? asString(inner.message_type)
  const mentions = readMentions(message, inner)

  return {
    envelopeVersion: ENVELOPE_VERSION,
    eventId,
    receivedAt: opts.receivedAt ?? new Date().toISOString(),
    eventType: INBOX_EVENT_TYPE,
    chatType,
    chatId: asString(message.chat_id) ?? asString(inner.chat_id),
    senderOpenId,
    messageId,
    messageType,
    content: describeContent(messageType, message.content, mentions),
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