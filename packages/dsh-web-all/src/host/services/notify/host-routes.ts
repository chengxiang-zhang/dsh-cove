/**
 * The one host route the notification capability serves: a read-only feed of
 * finished runs.
 *
 * It is a privileged read surface like every other web-all host route family
 * and goes through the shared admission fence, because the feed names the
 * conversations this machine has been running. A partially mounted plugin can
 * never widen access: without the fence service the strict loopback rule
 * applies.
 *
 * There is deliberately no write route. A client's read watermark lives on the
 * client, so the host keeps no per-client state to acknowledge and exposes no
 * mutation an attacker could aim at. The only effect a caller can have is
 * reading, which is why this family needs no CSRF-shaped defence beyond the
 * fence itself.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  NOTIFY_FEED_PATH,
  clampLimit,
  clampWatermark,
  type NotifyFeed,
} from '../../../core/notify/contract.ts'
import { isLoopbackRequest } from '../access-trust/trust.ts'
import type { NoticeLog } from '../../../core/notify/feed.ts'

/** Query values one feed read is built from. */
export interface FeedQuery {
  /** Notices strictly newer than this id. */
  since: number
  /** Maximum notices to return. */
  limit: number
}

/** What the route handler needs from its owning service. */
export interface NotifyRouteDeps {
  /** Retained notices, read fresh per request. */
  log: () => NoticeLog
  /** Notices one read returns when the caller does not say. */
  defaultLimit: () => number
  /** Host access fence; defaults to the strict loopback rule. */
  isTrusted?: (request: IncomingMessage) => boolean
  /** Whether the capability is enabled right now, read per request. */
  enabled?: () => boolean
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/**
 * Read `since` and `limit` out of a request URL.
 *
 * Both are clamped rather than rejected: a client sending nonsense is asking
 * for an answer, not for a diagnostic, and the bounded log already limits what
 * any of these values can do.
 *
 * @param request - the request whose query string is read.
 * @param defaultLimit - the limit used when the caller does not supply one.
 * @returns the effective query.
 */
export function readFeedQuery(request: IncomingMessage, defaultLimit: number): FeedQuery {
  let search = ''
  try {
    search = new URL(request.url ?? '/', 'http://feed.invalid').search
  } catch {
    search = ''
  }
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search)
  } catch {
    params = new URLSearchParams()
  }
  return {
    since: clampWatermark(params.get('since') ?? ''),
    limit: clampLimit(params.get('limit') ?? '', defaultLimit),
  }
}

/**
 * The authority to report as this feed's origin.
 *
 * It comes from the request's own `Host` header rather than from configuration,
 * because the caller reached the machine under that name and a client listing
 * several machines must be able to label each row with what it dialed. A header
 * carrying separators or whitespace is not an authority and is reported empty
 * instead of being echoed into a document.
 *
 * @param request - the request being answered.
 * @returns the authority, or '' when the header is unusable.
 */
export function requestAuthority(request: IncomingMessage): string {
  const raw = request.headers.host
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '' || value.length > 255 || /[\s/\\@?#]/.test(value)) return ''
  return value
}

/**
 * Build the feed route.
 * @param deps - the owning service's read surface.
 * @returns the routes to register on the web server.
 */
export function makeNotifyRoutes(deps: NotifyRouteDeps): WebRoute[] {
  const isTrusted = deps.isTrusted ?? isLoopbackRequest
  const enabled = deps.enabled ?? (() => true)
  return [
    {
      kind: 'exact',
      path: NOTIFY_FEED_PATH,
      handler: (request, response) => {
        if (!isTrusted(request)) { writeJson(response, 403, { error: 'forbidden' }); return }
        // The capability's switch gates reads as well as writes. A disabled
        // capability that still answers would publish the list of conversations
        // this machine has been running, which is the whole reason it is off.
        if (!enabled()) { writeJson(response, 409, { error: 'notify-disabled' }); return }
        if (request.method !== 'GET') { writeJson(response, 405, { error: 'method-not-allowed' }); return }
        const query = readFeedQuery(request, deps.defaultLimit())
        const log = deps.log()
        const body: NotifyFeed = {
          origin: requestAuthority(request),
          latest: log.latest,
          notices: log.since(query.since, query.limit),
        }
        writeJson(response, 200, body)
      },
    },
  ]
}