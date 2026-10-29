/**
 * The finished-run feed, as this client reads it.
 *
 * A red dot on a machine row answers one question - "did the work I left running
 * somewhere finish while I was looking elsewhere?" - and this module owns the two
 * decisions behind it: which stored watermark an incoming feed is compared
 * against, and which unseen notices are worth a dot. Keeping both here rather
 * than inside the shell is what makes them verifiable without launching the app.
 *
 * The wire shape and the reconciliation rule are owned by
 * `packages/dsh-web-all/src/core/notify/contract.ts`. That file is TypeScript and
 * the shell cannot import it, so the rule is ported rather than paraphrased: ids
 * count from one host process, so a host that has restarted serves ids that start
 * over, and a stored watermark left higher than every new id would hide each new
 * run forever. A regression in `latest` therefore means "start over from 0".
 *
 * A machine that has not been updated yet does not serve this path at all. That is
 * an absence, not a failure: it is reported as nothing unseen, never as an error.
 */

/** The route every machine serves once it has the capability. */
export const NOTIFY_FEED_PATH = '/api/dsh-notify/feed';

/** Notices one read asks for; the same default the host holds. */
export const NOTIFY_DEFAULT_LIMIT = 20;

/**
 * The most notices one read may ask for, which is also everything the host retains.
 *
 * A badge read asks for this rather than the default. A count taken from the first
 * page of twenty stops being the answer to "how many did I miss" the moment a host
 * has run more than twenty turns, and the page's own newest id is what a look used
 * to record as read - twenty ids at a time, which is how a count that never reaches
 * zero is built.
 */
export const NOTIFY_MAX_LIMIT = 100;

/**
 * Reads a watermark that may have come from a file someone edited, or from a
 * previous version of this client.
 *
 * A value that cannot be parsed means "nothing has been seen yet" (0) rather than
 * a throw: a client that cannot read its own stored number should be told
 * everything again, not nothing.
 *
 * @param {unknown} value the stored value, of unknown quality
 * @returns {number} a non-negative whole number
 */
export function clampWatermark(value) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.trunc(parsed);
}

/**
 * Reconciles the stored watermark with the feed just read.
 *
 * @param {number} previous the watermark this client stored for the machine
 * @param {number} latest the feed's newest id
 * @returns {number} the watermark to compare against; 0 after the host restarted
 */
export function reconcileWatermark(previous, latest) {
  if (!Number.isFinite(latest) || latest < 0) {
    return previous;
  }
  return latest < previous ? 0 : previous;
}

/**
 * Whether an outcome is worth interrupting a person for.
 *
 * A run the user stopped ended on purpose and was not news, so it advances the
 * watermark without lighting a dot.
 *
 * @param {unknown} outcome one of completed / failed / stopped
 * @returns {boolean} true when the outcome deserves attention
 */
export function isNotifiable(outcome) {
  return outcome === 'completed' || outcome === 'failed';
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asWhole(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/** Collapses a raw reason kind when the payload did not carry an outcome. */
function outcomeOf(reason) {
  if (reason === 'completed' || reason === 'max-tokens') {
    return 'completed';
  }
  if (reason === 'error' || reason === 'blocked') {
    return 'failed';
  }
  return 'stopped';
}

/**
 * Narrows one notice from the wire.
 *
 * Every field is re-derived rather than cast, so a truncated payload degrades
 * into a notice with blank strings instead of an `undefined` reaching a screen.
 *
 * @param {unknown} value one element of `notices`
 * @returns {object|null} the notice, or null when the element is not an object
 */
export function parseRunNotice(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const reason = asString(value.reason);
  const rawOutcome = asString(value.outcome);
  const outcome = rawOutcome === 'completed' || rawOutcome === 'failed' || rawOutcome === 'stopped' ? rawOutcome : outcomeOf(reason);
  return {
    id: asWhole(value.id),
    at: asWhole(value.at),
    sessionId: asString(value.sessionId),
    title: asString(value.title),
    turn: asWhole(value.turn),
    reason,
    outcome,
  };
}

/**
 * Narrows a whole feed document from the wire.
 *
 * @param {unknown} value the decoded JSON body
 * @returns {object|null} the feed, or null when the body is not a feed object
 */
export function parseFeed(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const notices = Array.isArray(value.notices)
    ? value.notices.map(parseRunNotice).filter((notice) => notice !== null)
    : [];
  const latest = asWhole(value.latest, notices.reduce((max, notice) => Math.max(max, notice.id), 0));
  return { origin: asString(value.origin), latest, notices };
}

/**
 * The notices a client has not seen, under the reconciliation rule above.
 *
 * @param {object} feed the decoded feed document
 * @param {number} watermark the stored watermark
 * @returns {object[]} notices newer than the effective watermark, oldest first
 */
export function newNotices(feed, watermark) {
  const effective = reconcileWatermark(clampWatermark(watermark), feed.latest);
  return feed.notices.filter((notice) => notice.id > effective);
}

/** Decodes a response body that may be a string of JSON or already decoded. */
function decodeJson(payload) {
  if (typeof payload !== 'string') {
    return payload;
  }
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * The smallest shape a response must have before its reading is acted on.
 *
 * This is deliberately stricter than {@link parseFeed}, which will salvage a
 * notice list out of almost anything. Acting on a body that is not a feed would
 * be read as a host restart and would forget a watermark that is still valid, so
 * an unusable `latest` - the field the restart rule is decided by - is treated as
 * "no reading at all" rather than as zero. `latest` may be absent (the contract
 * derives it from the notices), but a value that is present must be a number.
 *
 * @param {unknown} value the decoded body
 * @returns {boolean} true when the body is worth comparing against a watermark
 */
function looksLikeFeed(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (!Array.isArray(value.notices)) {
    return false;
  }
  if (value.latest === undefined || value.latest === null) {
    return true;
  }
  return typeof value.latest === 'number' && Number.isFinite(value.latest);
}

/**
 * Turns one feed response into the two facts a machine row needs.
 *
 * `unread` counts unseen notices worth attention, never everything the host
 * holds: the dot means "there is something new to look at", so a run the user
 * stopped does not light it. `latestNotice` is the newest unseen notice of any
 * outcome, because that is the id the watermark advances to once the user has
 * looked at the machine - looking at a machine reads all of it, not just the
 * part that happened to be notifiable.
 *
 * `reset` reports that the feed's ids are older than the stored watermark, which
 * can only mean the host is a different process now. The caller re-reads from
 * zero in that case; this function stays pure and only reports it.
 *
 * Anything unreadable - no response, a 404 body, truncated JSON, an object that
 * is not a feed - degrades to "nothing unseen" and never throws.
 *
 * @param {unknown} payload the response body, as text or already decoded
 * @param {number} watermark the watermark stored for that machine
 * @returns {{ unread: number, latestNotice: object|null, reset: boolean, latest: number }}
 */
export function summarizeFeed(payload, watermark) {
  const stored = clampWatermark(watermark);
  const decoded = decodeJson(payload);
  if (!looksLikeFeed(decoded)) {
    return { unread: 0, latestNotice: null, reset: false, latest: 0 };
  }
  const feed = parseFeed(decoded);
  if (feed === null) {
    return { unread: 0, latestNotice: null, reset: false, latest: 0 };
  }
  const effective = reconcileWatermark(stored, feed.latest);
  const unseen = feed.notices.filter((notice) => notice.id > effective);
  let latestNotice = null;
  for (const notice of unseen) {
    if (latestNotice === null || notice.id > latestNotice.id) {
      latestNotice = notice;
    }
  }
  return {
    unread: unseen.filter((notice) => isNotifiable(notice.outcome)).length,
    // Reported separately from the count, because the row has to tell "something
    // finished" from "something failed": only the second one earns a colour that means
    // act on me, and only the first one may stay quiet.
    failed: unseen.filter((notice) => notice.outcome === 'failed').length,
    latestNotice,
    reset: effective !== stored,
    latest: feed.latest,
  };
}

/**
 * The address one read is sent to.
 *
 * `since` is the stored watermark, so the machine answers with what happened
 * after the last look rather than with everything it holds.
 *
 * @param {string} base the machine's base url, with or without its trailing slash
 * @param {number} since the watermark stored for that machine
 * @param {number} [limit] how many notices to ask for
 * @returns {string} the absolute feed url
 */
export function feedUrl(base, since, limit = NOTIFY_DEFAULT_LIMIT) {
  const origin = typeof base === 'string' ? base : '';
  const prefix = origin.endsWith('/') ? origin : `${origin}/`;
  const count = Math.max(1, Math.trunc(Number(limit)) || NOTIFY_DEFAULT_LIMIT);
  return `${prefix}${NOTIFY_FEED_PATH.slice(1)}?since=${clampWatermark(since)}&limit=${count}`;
}

/**
 * The address one badge read is sent to.
 *
 * The same route as {@link feedUrl}, asking for everything the host still holds: the
 * number on a row is the whole backlog, not the first page of it.
 *
 * @param {string} base the machine's base url, with or without its trailing slash
 * @param {number} since the watermark stored for that machine
 * @returns {string} the absolute feed url
 */
export function badgeUrl(base, since) {
  return feedUrl(base, since, NOTIFY_MAX_LIMIT);
}

/**
 * The id the client may record as read after one read of a machine.
 *
 * The feed's `latest` is the answer, never the newest notice that happened to be in
 * the page: looking at a machine reads all of it, and a page that stops at twenty
 * would let the client advance twenty ids per look, leaving a permanent remainder
 * that no amount of looking clears. The page's newest notice is the fallback for a
 * feed that reports no `latest` of its own.
 *
 * @param {object} summary the read, as {@link summarizeFeed} reported it
 * @returns {number} the watermark to store, or 0 when nothing has been reported
 */
export function ackIdOf(summary) {
  const latest = clampWatermark(summary?.latest);
  if (latest > 0) {
    return latest;
  }
  return clampWatermark(summary?.latestNotice?.id);
}

/**
 * What one machine's read means once the screen and the client's own history are taken
 * into account.
 *
 * A machine whose workspace is on screen is one the user is *inside*. Work that
 * finished there is work they watched finish, not work to come back for, so it never
 * carries a count - and the whole of what the host reported counts as looked at, so
 * leaving that machine starts its count instead of dumping everything it did while the
 * user was in it onto the row they are leaving.
 *
 * A machine this client has never read before is a *baseline*, not news: the feed holds
 * the host's recent history, and a client that has just been installed has not been
 * away from anything. Claiming that history would open every fresh install with a
 * number nobody can act on, so the first read only establishes where "seen" starts. A
 * host that has restarted is the opposite case - its ids began again, so everything it
 * now reports really is new, and `known` is true there (the watermark entry exists and
 * is zero).
 *
 * @param {object} summary the read, as {@link summarizeFeed} reported it
 * @param {{ watching?: boolean, known?: boolean }} [options] the screen and the history
 * @returns {{ unread: number, failed: number, ackId: number, baseline: boolean }} what the row shows
 */
export function readDecision(summary, options = {}) {
  const watching = options.watching === true;
  const baseline = options.known === false;
  // Neither a machine the user is inside nor one met for the first time has anything to
  // report; both still deserve the watermark, which is the caller's business.
  const quiet = watching || baseline;
  const count = Number(summary?.unread);
  const failed = Number(summary?.failed);
  return {
    unread: quiet || !Number.isFinite(count) || count < 1 ? 0 : Math.trunc(count),
    failed: quiet || !Number.isFinite(failed) || failed < 1 ? 0 : Math.trunc(failed),
    ackId: ackIdOf(summary),
    baseline,
  };
}

/**
 * The watermarks this client keeps, as stored on disk.
 *
 * A corrupt or absent file is an empty record rather than an error: the worst it
 * can cost is one read from zero, and the alternative - refusing to show the list
 * because a side file is unreadable - is much worse.
 *
 * @param {unknown} value the parsed file contents
 * @returns {Record<string, number>} host -> watermark, blanks dropped
 */
export function parseWatermarks(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const out = {};
  for (const [host, watermark] of Object.entries(value)) {
    if (host === '') {
      continue;
    }
    const parsed = typeof watermark === 'number' ? watermark : Number(watermark);
    if (!Number.isFinite(parsed) || parsed < 0) {
      continue;
    }
    out[host] = Math.trunc(parsed);
  }
  return out;
}