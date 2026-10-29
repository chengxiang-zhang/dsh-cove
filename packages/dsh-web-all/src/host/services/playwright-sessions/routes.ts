/** Loopback and same-origin control plane for the attended Chrome lease. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { PLAYWRIGHT_CONTROL_API_PREFIX, PlaywrightControlError } from '../../../core/playwright-sessions/control.ts'
import { isLoopbackRequest } from '../access-trust/trust.ts'
import { accessTrustOf } from '../access-trust/index.ts'
import type { PlaywrightSessionsController } from './controller.ts'

/**
 * The strict loopback core fence for this control plane: a loopback socket,
 * a loopback Host, and same-origin browser markers. The route family is mounted
 * with the shared host access fence (see `registerPlaywrightControlRoutes`), so
 * the deployment's canonical browser entry reaches the host's Chrome through an
 * authenticated session; this predicate stays available for the loopback-only
 * callers and tests.
 */
function trusted(request: IncomingMessage): boolean {
  return isLoopbackRequest(request)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(JSON.stringify(body))
}

async function body(request: IncomingMessage, maxBytes = 16 * 1024): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > maxBytes) return null
    chunks.push(value)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch { return null }
}

export function makePlaywrightControlRoutes(
  controller: PlaywrightSessionsController,
  isTrusted: (request: IncomingMessage) => boolean = trusted,
): WebRoute[] {
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isTrusted(request)) { json(response, 403, { ok: false, error: { code: 'forbidden', message: 'loopback same-origin access only' } }); return }
    const url = new URL(request.url ?? '/', 'http://dsh.local')
    try {
      if (url.pathname === `${PLAYWRIGHT_CONTROL_API_PREFIX}/status` && request.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId')
        if (!sessionId) throw new PlaywrightControlError('bad-request', 'sessionId is required')
        json(response, 200, { ok: true, value: controller.status(sessionId) })
        return
      }
      if ((url.pathname === `${PLAYWRIGHT_CONTROL_API_PREFIX}/connect` || url.pathname === `${PLAYWRIGHT_CONTROL_API_PREFIX}/disconnect`) && request.method === 'POST') {
        if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          json(response, 415, { ok: false, error: { code: 'bad-request', message: 'application/json required' } })
          return
        }
        const input = await body(request)
        if (typeof input?.['sessionId'] !== 'string' || input['sessionId'] === '') throw new PlaywrightControlError('bad-request', 'sessionId is required')
        const value = url.pathname.endsWith('/connect')
          ? await controller.connect(input['sessionId'])
          : await controller.disconnect(input['sessionId'])
        json(response, 200, { ok: true, value })
        return
      }
      json(response, 404, { ok: false, error: { code: 'not-found', message: 'unknown route' } })
    } catch (error) {
      const code = error instanceof PlaywrightControlError ? error.code : 'internal'
      const status = code === 'forbidden' ? 403 : code === 'not-found' ? 404 : code === 'busy' || code === 'not-owner' || code === 'wrong-mode' ? 409 : code === 'bad-request' ? 400 : code === 'connect-failed' ? 502 : 500
      json(response, status, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } })
    }
  }
  return [{ kind: 'prefix', path: PLAYWRIGHT_CONTROL_API_PREFIX, handler }]
}

export function registerPlaywrightControlRoutes(ctx: Context, controller: PlaywrightSessionsController): () => void {
  const isTrusted = accessTrustOf(ctx).isTrusted
  const disposers = makePlaywrightControlRoutes(controller, isTrusted).map(route => ctx.webServer.register(route))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

export { trusted as trustedPlaywrightControlRequest }
