/**
 * The one description of a finished-run notice, shared by the host that records
 * it and every surface that reads it.
 *
 * A notice answers one question — "did the work I left running finish, and how
 * did it end?" — so the wire shape stays small enough to render as a phone
 * notification title. Two of the three consumers (the desktop client and the
 * mobile client) parse this JSON without this package's types, so the shape is
 * documented here once and every reader narrows defensively.
 *
 * @module dsh-web-all/notify-contract
 */

/** Host route family prefix for the notification feed. */
export const NOTIFY_API_PREFIX = '/api/dsh-notify'

/** The read route every client polls. */
export const NOTIFY_FEED_PATH = `${NOTIFY_API_PREFIX}/feed`

/** Notices the host keeps and returns by default. */
export const NOTIFY_DEFAULT_LIMIT = 20

/** Upper bound for one request's `limit`, so a client cannot ask for everything. */
export const NOTIFY_MAX_LIMIT = 100

/** Sessions whose titles the host remembers, so a long-lived host cannot grow unbounded. */
export const NOTIFY_TITLE_MEMORY = 200

/**
 * How a finished turn ended, collapsed from the extensible `TurnEndReason` map
 * into the three answers a person acts on.
 */
export type NotifyOutcome = 'completed' | 'failed' | 'stopped'

/** One finished turn, as the feed reports it. */
export interface RunNotice {
  /** Strictly increasing across the host's lifetime; a client's read watermark. */
  readonly id: number
  /** Epoch milliseconds when the turn ended. */
  readonly at: number
  /** Session the turn belonged to. */
  readonly sessionId: string
  /** Session title, else a short excerpt of the first human prompt, else ''. */
  readonly title: string
  /** Turn number inside the session. */
  readonly turn: number
  /** Raw `TurnEndReason` kind, kept verbatim because plugins extend that map. */
  readonly reason: string
  /** The collapse of `reason` a client can act on without knowing the map. */
  readonly outcome: NotifyOutcome
}

/** What one finished turn is built from, before the host assigns its id. */
export type RunNoticeInput = Omit<RunNotice, 'id' | 'outcome'> & { readonly outcome?: NotifyOutcome }

/** The feed document. */
export interface NotifyFeed {
  /**
   * Authority serving this feed, taken from the request's `Host` header.
   *
   * It is the origin the caller actually reached, not a configured name, so a
   * client aggregating several machines can label each row with what it dialed.
   */
  readonly origin: string
  /** Newest notice id, or 0 when none. A client stores it as its watermark. */
  readonly latest: number
  /** Notices newer than the request's `since`, oldest first, capped by `limit`. */
  readonly notices: readonly RunNotice[]
}

/** Reasons that mean the model finished the work it was given. */
const COMPLETED_REASONS = new Set(['completed', 'max-tokens'])

/** Reasons that mean the turn ended because something went wrong. */
const FAILED_REASONS = new Set(['error', 'blocked'])

/** Reasons that mean the turn ended without either succeeding or failing. */
const STOPPED_REASONS = new Set(['aborted', 'interrupted', 'forked'])

/**
 * Collapse one `TurnEndReason` kind into the outcome a client acts on.
 *
 * An unrecognized reason comes from a plugin that merged a new variant into the
 * reason map. Reporting it as `completed` would put a success claim on something
 * no one has inspected, so an unknown closure takes the neutral outcome and the
 * caller still has {@link RunNotice.reason} to render verbatim.
 *
 * @param reason - the raw reason kind, or '' when the event carried none.
 * @returns the outcome to record.
 */
export function outcomeOf(reason: string): NotifyOutcome {
  if (COMPLETED_REASONS.has(reason)) return 'completed'
  if (FAILED_REASONS.has(reason)) return 'failed'
  if (STOPPED_REASONS.has(reason)) return 'stopped'
  return 'stopped'
}

/** Chinese label for one outcome, shared so the three surfaces cannot drift. */
export const OUTCOME_LABEL_ZH: Readonly<Record<NotifyOutcome, string>> = {
  completed: '已完成',
  failed: '出错',
  stopped: '已结束',
}

/**
 * Clamp a request's `limit` into the range the host is willing to answer.
 * @param value - the parsed query value, of unknown quality.
 * @param fallback - the value used when `value` is not a usable number.
 * @returns a whole number within 1..{@link NOTIFY_MAX_LIMIT}.
 */
export function clampLimit(value: unknown, fallback: number = NOTIFY_DEFAULT_LIMIT): number {
  const parsed = parseWhole(value)
  if (parsed === null) return fallback
  if (parsed < 1) return 1
  return parsed > NOTIFY_MAX_LIMIT ? NOTIFY_MAX_LIMIT : parsed
}

/**
 * Read a whole number out of a query value.
 *
 * An absent or blank value is `null` rather than zero: `Number('')` is 0, which
 * would silently turn "the caller said nothing" into "the caller asked for the
 * smallest possible answer".
 *
 * @param value - the raw value, of unknown quality.
 * @returns the truncated number, or null when there is no number there.
 */
function parseWhole(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value !== 'string') return value === null || value === undefined ? null : parseWhole(Number(value))
  const text = value.trim()
  if (text === '') return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

/**
 * Clamp a client's read watermark. A malformed watermark means "nothing seen
 * yet" (0) rather than a throw, because a client that cannot parse its stored
 * value should be told everything again instead of nothing.
 * @param value - the parsed watermark, of unknown quality.
 * @returns a non-negative whole number.
 */
export function clampWatermark(value: unknown): number {
  const parsed = parseWhole(value)
  if (parsed === null || parsed < 0) return 0
  return parsed
}

/**
 * Reconcile a client's stored watermark with the feed it just read.
 *
 * Notice ids count from one host process, so a restarted host serves ids that
 * start over. A watermark stored against the previous process would then be
 * higher than every new id and would hide each new notice forever, which is the
 * one failure mode a red dot must not have. A regression therefore means "the
 * host is a different process now; start over", and the caller stores 0 and
 * treats the whole held log as new.
 *
 * @param previous - the watermark the client stored.
 * @param latest - the feed's newest id.
 * @returns the watermark the client should keep and compare against.
 */
export function reconcileWatermark(previous: number, latest: number): number {
  if (!Number.isFinite(latest) || latest < 0) return previous
  return latest < previous ? 0 : previous
}

/**
 * The notices a client has not seen, under the reconciliation rule above.
 * @param feed - the decoded feed document.
 * @param watermark - the client's stored watermark.
 * @returns notices newer than the effective watermark, oldest first.
 */
export function newNotices(feed: NotifyFeed, watermark: number): RunNotice[] {
  const effective = reconcileWatermark(clampWatermark(watermark), feed.latest)
  return feed.notices.filter(notice => notice.id > effective)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asWhole(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

/**
 * Narrow one decoded notice from the wire.
 *
 * Every field is re-derived rather than cast, so an unknown or truncated
 * payload degrades into a notice with blank strings instead of an `undefined`
 * reaching a renderer.
 *
 * @param value - one decoded element of `notices`.
 * @returns the notice, or null when the element is not an object at all.
 */
export function parseRunNotice(value: unknown): RunNotice | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const reason = asString(record.reason)
  const rawOutcome = asString(record.outcome)
  const outcome: NotifyOutcome = rawOutcome === 'completed' || rawOutcome === 'failed' || rawOutcome === 'stopped'
    ? rawOutcome
    : outcomeOf(reason)
  return {
    id: asWhole(record.id),
    at: asWhole(record.at),
    sessionId: asString(record.sessionId),
    title: asString(record.title),
    turn: asWhole(record.turn),
    reason,
    outcome,
  }
}

/**
 * Narrow a whole feed document from the wire.
 * @param value - the decoded JSON body.
 * @returns the feed, or null when the body is not a feed object.
 */
export function parseFeed(value: unknown): NotifyFeed | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const notices = Array.isArray(record.notices)
    ? record.notices.map(parseRunNotice).filter((notice): notice is RunNotice => notice !== null)
    : []
  const latest = asWhole(record.latest, notices.reduce((max, notice) => Math.max(max, notice.id), 0))
  return { origin: asString(record.origin), latest, notices }
}