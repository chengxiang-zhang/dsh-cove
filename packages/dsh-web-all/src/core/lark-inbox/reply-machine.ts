/**
 * Pure decisions for answering a Feishu message with an agent turn.
 *
 * The inbound queue already stores messages; nothing in this repository ever
 * turned one into a turn. This module holds the parts of that decision that do
 * not touch IO, so the state machine can be tested without a socket, a clock or
 * a model: who may be answered, what a control word means, how a batch becomes
 * one prompt, and what the person sees when the turn does not produce text.
 *
 * Two rules shape it:
 *
 * 1. Silence is a bug. Every admitted batch ends in exactly one reply, so an
 *    outcome that produced no model text still sends a sentence saying so. The
 *    failure this repository already paid for was a bot that looked configured
 *    and never answered.
 * 2. A batch is keyed by a message, not by an event. Feishu redelivers under a
 *    new event id after a reconnect (see `host/services/lark-inbox/inbox-store.ts`),
 *    so an idempotency key derived from the event id would answer twice while
 *    one derived from the first message id stays stable across the retry.
 */

/** How far the answer path may go. */
export type ReplyMode = 'off' | 'probe' | 'self'

/** Why a message was or was not admitted to the answer path. */
export type ReplyRejection =
  | 'disabled'
  | 'not-direct'
  | 'sender-not-allowed'
  | 'empty-text'
  | 'control-command'

/** Admission input: what the event says about itself. */
export interface ReplyAdmissionInput {
  readonly chatType?: string | undefined
  readonly senderOpenId?: string | undefined
  /** The human-readable message body, as the envelope already renders it. */
  readonly text: string
}

/** Admission policy: the live settings that decide reach. */
export interface ReplyAdmissionConfig {
  readonly mode: ReplyMode
  readonly openIds: readonly string[]
}

export type ReplyAdmission =
  | { readonly accept: true; readonly command?: 'stop' | 'new' }
  | { readonly accept: false; readonly reason: ReplyRejection }

/** The control words a direct message may carry instead of a question. */
export type ControlCommand = 'stop' | 'new'

/**
 * Read a control word.
 *
 * Deliberately exact after trimming and lowercasing: a sentence that happens to
 * begin with "stop" is a question, and treating it as a command would silently
 * swallow a person's message instead of answering it.
 * @param text - the message body.
 * @returns the command, or undefined for anything else.
 */
export function parseControlCommand(text: string): ControlCommand | undefined {
  const normalized = text.trim().toLowerCase()
  if (normalized === '/stop' || normalized === '停止') return 'stop'
  if (normalized === '/new' || normalized === '新会话') return 'new'
  return undefined
}

/**
 * Decide whether a message enters the answer path.
 *
 * Order matters and mirrors the inbound gate: mode first (an operator turning
 * this off must win over every other rule), then the conversation shape, then
 * the sender list. A control word is admitted as a control word rather than as
 * a question, because it must not create a job of its own.
 * @param input - chat shape, sender and body.
 * @param config - live mode and sender list.
 * @returns the admission decision.
 */
export function admitReply(input: ReplyAdmissionInput, config: ReplyAdmissionConfig): ReplyAdmission {
  if (config.mode === 'off') return { accept: false, reason: 'disabled' }
  // Direct messages only for now: a group answer is visible to everyone in the
  // room, so it waits until the direct path has readings behind it.
  if (input.chatType !== 'p2p') return { accept: false, reason: 'not-direct' }
  if (config.openIds.length > 0) {
    const sender = (input.senderOpenId ?? '').trim()
    // An empty sender cannot be shown to be allowed, so it is refused. Unlike
    // the inbound gate, which keeps ingesting for the operator to read later,
    // this path speaks to a person and therefore fails closed.
    if (sender === '' || !config.openIds.includes(sender)) return { accept: false, reason: 'sender-not-allowed' }
  }
  if (input.text.trim() === '') return { accept: false, reason: 'empty-text' }
  const command = parseControlCommand(input.text)
  if (command !== undefined) return { accept: true, command }
  return { accept: true }
}

/** Longest `uuid` idempotency token Feishu accepts. */
export const MAX_JOB_ID_CHARS = 50

/**
 * Derive one job id from the first message of a batch.
 *
 * The same value is used as the prompt's request id and as the Feishu `uuid`,
 * so a redelivered message and a crashed retry collapse into one answer. It is
 * derived rather than generated: a generated id would change on every attempt
 * and give both layers a reason to answer twice.
 * @param messageId - the platform message id that opened the batch.
 * @param fallback - the event id, used only when the message carried no id.
 * @returns a stable, charset-safe id of at most {@link MAX_JOB_ID_CHARS}.
 */
export function replyJobId(messageId: string | undefined, fallback: string): string {
  const base = (messageId ?? '').trim() !== '' ? (messageId ?? '').trim() : fallback.trim()
  const safe = base.replace(/[^A-Za-z0-9_-]/gu, '_')
  const body = safe === '' ? 'unknown' : safe
  return `fj_${body}`.slice(0, MAX_JOB_ID_CHARS)
}

/** Session id prefix, so a Feishu session is identifiable in the session list. */
export const REPLY_SESSION_PREFIX = 'feishu-'

/**
 * FNV-1a over two offsets, rendered as 16 hex characters.
 *
 * A hash is needed to turn a conversation key into a legal session id, and
 * `node:crypto` is the obvious tool - except this module is compiled for both
 * the host and the browser program, so a Node builtin would break the client
 * build. A 64-bit non-cryptographic hash is enough here: the input is a chat id
 * this host already knows, and a collision would only merge two conversations
 * that no real installation has.
 * @param text - the conversation key.
 * @returns 16 lowercase hex characters.
 */
export function hashConversationKey(text: string): string {
  let low = 0x811c9dc5
  let high = 0xcbf29ce4
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    low = (low ^ code) >>> 0
    low = Math.imul(low, 0x01000193) >>> 0
    high = (high ^ (code + index)) >>> 0
    high = Math.imul(high, 0x01000193) >>> 0
  }
  return (high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0')).slice(0, 16)
}

/**
 * Name the DSH session that carries one conversation.
 *
 * Deterministic so a restart reattaches to the same session instead of starting
 * a new one with no memory of what was already discussed.
 * @param convKey - conversation key; the chat id for a direct message.
 * @param generation - bumped by `/new` to deliberately start over.
 * @returns the session id.
 */
export function replySessionId(convKey: string, generation: number): string {
  const suffix = generation > 1 ? `:${generation}` : ''
  return `${REPLY_SESSION_PREFIX}${hashConversationKey(`${convKey}${suffix}`)}`
}

/**
 * Turn a batch of message bodies into the one prompt sent for that batch.
 *
 * A single message is passed through: numbering a lone question would make the
 * model answer "message 1 of 1" instead of the person. Several messages are
 * numbered, because they arrived apart and the order carries meaning.
 * @param parts - message bodies in arrival order.
 * @param preamble - standing instructions for this conversation.
 * @returns the prompt content.
 */
export function composePrompt(parts: readonly string[], preamble: string): string {
  const bodies = parts.map(part => part.trim()).filter(part => part !== '')
  const head = preamble.trim()
  const body = bodies.length <= 1
    ? (bodies[0] ?? '')
    : bodies.map((part, index) => `${index + 1}. ${part}`).join('\n')
  return head === '' ? body : `${head}\n\n${body}`
}

/** How an admitted batch finished. Never omitted: every one sends something. */
export type ReplyOutcome = 'answer' | 'empty' | 'error' | 'timeout' | 'interrupted' | 'stopped'

/**
 * Compose the sentence sent when the turn itself produced no usable text.
 *
 * Fixed strings rather than model output: the failure sentence must be
 * available when the model is exactly what failed.
 * @param outcome - how the batch finished; `answer` is handled by the caller.
 * @param detail - provider or reason text, included when it is short and useful.
 * @returns the body to send.
 */
export function fallbackReplyText(outcome: Exclude<ReplyOutcome, 'answer'>, detail = ''): string {
  const tail = detail.trim() === '' ? '' : `（${detail.trim()}）`
  switch (outcome) {
    case 'empty': return '这条我处理完了，但没有可回复的内容。换个说法再问一次？'
    case 'timeout': return `这次处理超时了，我先停下来${tail}。可以让我继续，或者把问题缩小一点。`
    case 'interrupted': return '上一次处理被中断了，我没有重跑它，因为那可能重复执行副作用。请再发一次。'
    case 'stopped': return '已停止。'
    case 'error': return `这次处理出错了${tail}。要我重试吗？`
  }
}

/**
 * Clamp model text to what one Feishu text message can carry.
 *
 * Truncating with a marker is deliberately chosen over dropping: a long answer
 * still answers its first part, and the marker tells the reader something was
 * cut instead of pretending the answer ended there.
 * @param text - assistant text.
 * @param limit - maximum characters (Feishu's own limit is enforced upstream).
 * @returns the text to send.
 */
export function clampReplyText(text: string, limit: number): string {
  const body = text.trim()
  if (body.length <= limit) return body
  const marker = '\n\n（内容过长，已截断）'
  const room = Math.max(0, limit - marker.length)
  return `${body.slice(0, room).trimEnd()}${marker}`
}

/**
 * Extract the text of one assistant message.
 *
 * Only `text` blocks count. A turn's tool blocks are the work, not the answer,
 * and forwarding them would send the person the machinery instead of the reply.
 * @param content - the message's content blocks.
 * @returns the joined text, empty when the message carried none.
 */
export function assistantTextOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type !== 'text') continue
    if (typeof record.text === 'string' && record.text.trim() !== '') parts.push(record.text)
  }
  return parts.join('\n').trim()
}