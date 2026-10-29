/**
 * The two bounded pieces of state the notification host keeps: the recent
 * notice log a client polls, and the session titles a notice quotes.
 *
 * Both are deliberately in memory only. A notice answers "did my work finish"
 * for a window of a few minutes; persisting it would create a second durable
 * record of the session log that DSH already owns, and would have to answer
 * questions about retention, migration and conflicting truth. A restart
 * therefore forgets the feed, and a client's watermark simply replays from a
 * fresh, empty log.
 *
 * @module dsh-web-all/notify-feed
 */

import {
  NOTIFY_DEFAULT_LIMIT,
  NOTIFY_TITLE_MEMORY,
  outcomeOf,
  type RunNotice,
  type RunNoticeInput,
} from './contract.ts'

/**
 * A bounded log of finished turns, oldest first.
 *
 * Ids are assigned from a counter that never resets while the host lives, so a
 * client watermark stays meaningful even after older entries have been evicted:
 * "newer than 40" keeps working when the log has already dropped everything
 * below 35.
 */
export class NoticeLog {
  private readonly limit: number
  private seq = 0
  private entries: RunNotice[] = []

  /**
   * @param limit - how many notices to retain; clamped to at least one so a
   *   misconfigured host still answers with something.
   */
  constructor(limit: number = NOTIFY_DEFAULT_LIMIT) {
    this.limit = Number.isFinite(limit) && limit >= 1 ? Math.trunc(limit) : NOTIFY_DEFAULT_LIMIT
  }

  /** Newest assigned id, or 0 when nothing has been recorded. */
  get latest(): number {
    return this.seq
  }

  /** How many notices are currently retained. */
  get size(): number {
    return this.entries.length
  }

  /**
   * Record one finished turn.
   * @param input - the turn facts; an absent outcome is derived from the reason.
   * @returns the stored notice, including its assigned id.
   */
  append(input: RunNoticeInput): RunNotice {
    this.seq += 1
    const notice: RunNotice = {
      id: this.seq,
      at: input.at,
      sessionId: input.sessionId,
      title: input.title,
      turn: input.turn,
      reason: input.reason,
      outcome: input.outcome ?? outcomeOf(input.reason),
    }
    this.entries.push(notice)
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
    return notice
  }

  /**
   * Notices newer than a client's watermark, oldest first.
   * @param watermark - the client's last seen id; 0 (or anything unparsable) replays what is held.
   * @param limit - maximum notices to return; at least one.
   * @returns a fresh array of notices.
   */
  since(watermark: number, limit: number): RunNotice[] {
    const floor = Number.isFinite(watermark) && watermark > 0 ? Math.trunc(watermark) : 0
    const cap = Number.isFinite(limit) && limit >= 1 ? Math.trunc(limit) : 1
    const out: RunNotice[] = []
    for (const notice of this.entries) {
      if (notice.id <= floor) continue
      out.push(notice)
      if (out.length >= cap) break
    }
    return out
  }

  /** Everything currently retained, oldest first. */
  snapshot(): readonly RunNotice[] {
    return [...this.entries]
  }

  /** Drop every retained notice. Ids keep counting, so a stale watermark still orders correctly. */
  clear(): void {
    this.entries = []
  }
}

/** One session's remembered naming material. */
interface TitleEntry {
  /** An explicit or generated title, which always outranks a prompt excerpt. */
  title: string
  /** The first human prompt's excerpt, used until a real title exists. */
  prompt: string
}

/**
 * Remembers how each session is named, so a notice can say which conversation
 * finished instead of quoting an opaque `session-7`.
 *
 * A session's own title event is preferred, because `dsh-session-title` already
 * decided which messages are eligible input and normalized the result. Until
 * one exists, the first human prompt stands in. Both maps are bounded by last
 * write, so a host that runs for weeks does not accumulate one entry per
 * conversation it has ever seen.
 */
export class TitleBook {
  private readonly capacity: number
  private readonly entries = new Map<string, TitleEntry>()

  /**
   * @param capacity - sessions to remember; clamped to at least one.
   */
  constructor(capacity: number = NOTIFY_TITLE_MEMORY) {
    this.capacity = Number.isFinite(capacity) && capacity >= 1 ? Math.trunc(capacity) : NOTIFY_TITLE_MEMORY
  }

  /** How many sessions are remembered. */
  get size(): number {
    return this.entries.size
  }

  private entry(sessionId: string): TitleEntry {
    const existing = this.entries.get(sessionId)
    if (existing !== undefined) {
      // Re-insert so the most recently written session is the last evicted.
      this.entries.delete(sessionId)
      this.entries.set(sessionId, existing)
      return existing
    }
    const created: TitleEntry = { title: '', prompt: '' }
    this.entries.set(sessionId, created)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
    return created
  }

  /**
   * Record a session title, which outranks any prompt excerpt.
   * @param sessionId - the titled session.
   * @param title - the title text; blank is ignored so a nameless update cannot erase a name.
   */
  setTitle(sessionId: string, title: string): void {
    const text = title.trim()
    if (sessionId === '' || text === '') return
    this.entry(sessionId).title = excerpt(text, 60)
  }

  /**
   * Record a candidate prompt excerpt. The first one wins, because a session is
   * recognized by what it was opened to do, not by its most recent follow-up.
   * @param sessionId - the session the prompt belongs to.
   * @param text - the human prompt text.
   */
  rememberPrompt(sessionId: string, text: string): void {
    const text2 = text.trim()
    if (sessionId === '' || text2 === '') return
    const entry = this.entry(sessionId)
    if (entry.prompt === '') entry.prompt = excerpt(text2, 60)
  }

  /**
   * How to name one session in a notice.
   * @param sessionId - the session to name.
   * @returns the title, else the prompt excerpt, else '' when nothing is known.
   */
  titleOf(sessionId: string): string {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return ''
    return entry.title !== '' ? entry.title : entry.prompt
  }

  /** Forget one disposed session. */
  forget(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  /** Forget every session. */
  clear(): void {
    this.entries.clear()
  }
}

/**
 * One-line excerpt safe to put in a notification.
 * @param text - any text, possibly multi-line.
 * @param max - maximum code points to keep.
 * @returns whitespace-collapsed text, truncated with an ellipsis when it was longer.
 */
export function excerpt(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const points = [...collapsed]
  if (points.length <= max) return collapsed
  return `${points.slice(0, Math.max(1, max - 1)).join('')}…`
}

/**
 * Pull the plain text out of one message's content blocks.
 *
 * Only text blocks carry quotable prose; every other block kind (an image, a
 * file reference) is skipped rather than stringified, because a title made of a
 * serialized block would be worse than no title.
 *
 * @param content - the message's `content` field, of unknown quality.
 * @returns the concatenated text, space separated.
 */
export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type !== 'text') continue
    if (typeof record.text === 'string' && record.text.trim() !== '') parts.push(record.text)
  }
  return parts.join(' ')
}