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
 *    new event id after a reconnect (see `host/services/superagent/channels/feishu/inbox-store.ts`),
 *    so an idempotency key derived from the event id would answer twice while
 *    one derived from the first message id stays stable across the retry.
 */

/** How far the answer path may go. */
export type ReplyMode = 'off' | 'probe' | 'self'

/** Why a message was or was not admitted to the answer path. */
export type ReplyRejection =
  | 'disabled'
  | 'not-direct'
  | 'group-not-addressed'
  | 'sender-not-allowed'
  | 'empty-text'
  | 'control-command'

/** Admission input: what the event says about itself. */
export interface ReplyAdmissionInput {
  readonly chatType?: string | undefined
  readonly senderOpenId?: string | undefined
  /**
   * Whether the message addresses this bot by name. Required for a group: an
   * answer there is visible to everyone in the room, so it waits for an explicit
   * request rather than reacting to a conversation the bot happens to be in.
   */
  readonly mentionBot?: boolean | undefined
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
  if (input.chatType === 'group') {
    // A group is not addressed to the bot by construction, so being named is the
    // request. The identity used here is the same one the inbound gate compares
    // (`mentionsBot` against the bot's own open id), so "mentioned" cannot mean
    // two different things on the two paths.
    if (input.mentionBot !== true) return { accept: false, reason: 'group-not-addressed' }
  } else if (input.chatType !== 'p2p') {
    // Neither a direct message nor a group this bot can address unambiguously.
    return { accept: false, reason: 'not-direct' }
  }
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
 * Derive the request id a steered message is delivered under.
 *
 * One message, one id, for the same reason a batch has one: the engine collapses a
 * repeated request id instead of queueing the text twice, so a retried steer cannot
 * add the same line to a turn twice. Prefixed so it can never be mistaken for a
 * batch id in the ledger.
 * @param messageId - the platform message id being folded in.
 * @returns a stable, charset-safe id of at most {@link MAX_JOB_ID_CHARS}.
 */
export function steerRequestId(messageId: string): string {
  const safe = messageId.trim().replace(/[^A-Za-z0-9_-]/gu, '_')
  return `fs_${safe === '' ? 'unknown' : safe}`.slice(0, MAX_JOB_ID_CHARS)
}

/**
 * How far a steered message may go.
 *
 * Three states rather than a switch, because turning this on is a change in how the
 * bot behaves mid-answer and that deserves a rehearsal: `shadow` runs every decision
 * and writes down what it would have done without touching the engine, so a day of
 * logs can be read before anything is actually folded in.
 */
export type SteerMode = 'off' | 'shadow' | 'on'

/** Why a message was not folded into the running turn. */
export type SteerRefusal =
  | 'disabled'
  | 'no-turn-running'
  | 'turn-not-bound'
  | 'proactive-turn'
  | 'stopping'
  | 'timing-out'
  | 'carrying'
  | 'deadline-close'
  | 'batch-open'
  | 'too-many'

/** What a fold-in decision needs to know about the running turn. */
export interface SteerInflight {
  readonly kind: string
  readonly state: string
  /** The turn the job bound to; absent while its prompt is still queued. */
  readonly turn?: number | undefined
  readonly stopRequested: boolean
  /** Whether the sweep already asked this turn to stop for running too long. */
  readonly timingOut: boolean
  /** Set while the job waits for the turn that will consume an earlier steer. */
  readonly carryUntil?: number | undefined
  readonly deadlineAt?: number | undefined
}

/** Everything the fold-in decision is allowed to consider. */
export interface SteerGateInput {
  readonly mode: SteerMode
  readonly inflight?: SteerInflight | undefined
  /** Batches already collecting in this conversation. */
  readonly collecting: number
  /** Steers this job already owns. */
  readonly steered: number
  readonly now: number
  /** How much of the turn's deadline must remain for it to accept more work. */
  readonly minDeadlineLeftMs: number
  /** How many steers one turn may take. */
  readonly maxPerJob: number
}

export type SteerVerdict =
  | { readonly steer: true }
  | { readonly steer: false; readonly reason: SteerRefusal }

/**
 * Decide whether an arriving message joins the turn already running.
 *
 * Order is deliberate and every clause is a way the answer would otherwise be
 * wrong: a turn that has not bound yet would receive the line *before* the question
 * it belongs to (the engine takes next-step input ahead of the queued turn), a turn
 * that is stopping would answer with the half it already had, an open batch means an
 * earlier line is still unanswered and ordering matters, and an unlimited number of
 * steers means a turn that never has to end.
 *
 * This decides only *where* a message goes. Whether it is a correction or a new task
 * is the model's call, made with the whole conversation in front of it.
 * @param input - switch, running turn, conversation and job counters.
 * @returns whether to steer, and why not when the answer is no.
 */
export function steerDecision(input: SteerGateInput): SteerVerdict {
  if (input.mode === 'off') return { steer: false, reason: 'disabled' }
  const inflight = input.inflight
  if (inflight === undefined || inflight.state !== 'running') return { steer: false, reason: 'no-turn-running' }
  if (inflight.kind !== 'request') return { steer: false, reason: 'proactive-turn' }
  if (inflight.turn === undefined) return { steer: false, reason: 'turn-not-bound' }
  if (inflight.stopRequested) return { steer: false, reason: 'stopping' }
  if (inflight.timingOut) return { steer: false, reason: 'timing-out' }
  if (inflight.carryUntil !== undefined) return { steer: false, reason: 'carrying' }
  const left = inflight.deadlineAt === undefined ? Number.POSITIVE_INFINITY : inflight.deadlineAt - input.now
  if (left < input.minDeadlineLeftMs) return { steer: false, reason: 'deadline-close' }
  if (input.collecting > 0) return { steer: false, reason: 'batch-open' }
  if (input.steered >= input.maxPerJob) return { steer: false, reason: 'too-many' }
  return { steer: true }
}

/**
 * Wrap a steered line so the model can tell it apart from its original task.
 *
 * The marker is the whole mechanism: the turn already has the earlier question in
 * context, and without a sign that this arrived mid-answer the model would treat a
 * correction as a new topic and answer both. Kept in one place so the wording a
 * person sees the model reason about never drifts from what the tests assert.
 * @param text - the message body as the person wrote it.
 * @returns the prompt content for one steered message.
 */
export function composeSteer(text: string): string {
  return `（对方在你处理上一条时补充）\n${text.trim()}`
}

/**
 * The sentence appended when steers never caught the turn they were meant for.
 *
 * Fixed text rather than model output: the whole point is to admit, in words the
 * model cannot soften, that part of what the person said did not reach the answer.
 * @param count - how many messages missed the turn.
 * @returns the note to append to the reply, or an empty string for none.
 */
export function steerMissedNote(count: number): string {
  if (count <= 0) return ''
  return `（你后来补充的 ${count} 条没赶上这一轮，请再发一次。）`
}

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
 * @param header - one line of conversation metadata, placed above everything else.
 * @returns the prompt content.
 */
export function composePrompt(parts: readonly string[], preamble: string, header = ''): string {
  const bodies = parts.map(part => part.trim()).filter(part => part !== '')
  const head = preamble.trim()
  const body = bodies.length <= 1
    ? (bodies[0] ?? '')
    : bodies.map((part, index) => `${index + 1}. ${part}`).join('\n')
  const opening = header.trim()
  const framed = head === '' ? body : `${head}\n\n${body}`
  return opening === '' ? framed : `${opening}\n\n${framed}`
}

/** The one word a model may answer with instead of prose, to mean "just acknowledge". */
export const ACK_REPLY_TOKEN = 'ACK'

/** Longest message that may be acknowledged without words. */
export const ACK_TEXT_MAX_CHARS = 12

/**
 * Words that make a message a question rather than a closed acknowledgement.
 *
 * Deliberately broad. A false positive costs one explanatory sentence; a false
 * negative answers a real question with a thumbs-up.
 */
const ACK_QUESTION_WORDS = /(吗|呢|么|什么|怎么|为什么|如何|哪|几|多少|能否|可否|是否|要不要|行不行)/u

/** The closed set of acknowledgements, whole-message only. */
const ACK_CONFIRMATIONS = /^(好|好的|好滴|ok|okay|收到|嗯+|谢谢|多谢|thx|thanks|知道了|明白|了解|辛苦了?)[。.!！~]*$/iu

/**
 * Whether the conversation itself decides the shape of an answer.
 *
 * `off` keeps the fixed shape every earlier build had; `on` lets the model answer
 * with prose or with an acknowledgement, and hands the decision about whether an
 * acknowledgement is allowed to {@link mayAcknowledgeOnly}.
 */
export type RouterMode = 'off' | 'on'

/**
 * Decide whether every message in a batch may be answered with a reaction alone.
 *
 * This is the one guard between "the model decides how to answer" and a bot that
 * silently likes a real question. It therefore errs towards speech at every step:
 * one message with a question mark, one question word, one message longer than a
 * couple of breath's worth of text, or one message that is not purely an
 * acknowledgement, and the answer has to be words. An empty batch is not
 * acknowledgeable either: there is nothing to acknowledge.
 *
 * Note what this function cannot do: it never turns prose into silence. A true
 * result only permits a reaction the model asked for.
 * @param texts - every message body in the batch.
 * @returns true when a reaction alone is allowed to be the whole answer.
 */
export function mayAcknowledgeOnly(texts: readonly string[]): boolean {
  if (texts.length === 0) return false
  for (const raw of texts) {
    const body = raw.trim()
    if (body === '') return false
    if (body.length > ACK_TEXT_MAX_CHARS) return false
    if (body.includes('?') || body.includes('？')) return false
    if (ACK_QUESTION_WORDS.test(body)) return false
    if (!ACK_CONFIRMATIONS.test(body)) return false
  }
  return true
}

/**
 * One line of conversation metadata prepended to a turn's prompt.
 *
 * Kept in the user message rather than in a system-prompt section: it changes on
 * every turn, and a section with interpolated data is exactly what the
 * system-prompt rules forbid. The trailing clause is dropped when this
 * conversation has never been answered, because "0 minutes" would read as a fact
 * rather than as the absence of one.
 * @param input - how many messages this batch carries, and how long since the last reply.
 * @returns the header line, or an empty string when there is nothing to say.
 */
export function routerTurnHeader(input: {
  count: number
  sinceLastReplyMs?: number | undefined
}): string {
  const parts = ['飞书私聊', `本批 ${input.count} 条`]
  const elapsed = input.sinceLastReplyMs
  if (elapsed !== undefined && Number.isFinite(elapsed)) {
    parts.push(`距上次回复 ${Math.max(0, Math.floor(elapsed / 60_000))} 分钟`)
  }
  return `[${parts.join(' · ')}]`
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