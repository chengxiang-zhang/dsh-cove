import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { registerServerMode } from './server.ts'
import { registerResources } from '../resources.ts'
import { isLoopbackRequest } from '../access-trust/trust.ts'
import {
  DEFAULT_GATEWAY_MAX_BODY_BYTES,
  DEFAULT_GATEWAY_TARGET_ORIGIN,
  DEFAULT_GATEWAY_TIMEOUT_MS,
  PairTokenStore,
  bearerToken,
  isAllowedGatewayMethod,
  resolveGatewayTarget,
  type PairTokenStoreOptions,
} from '../../../core/remote-web-ui/security.ts'

export const PAIR_API_PREFIX = '/api/pair'
export const GATEWAY_API_PREFIX = '/api/gateway'

const MAX_PAIR_BODY_BYTES = 64 * 1024
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const REQUEST_CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'host', 'origin', 'referer'])
const RESPONSE_CREDENTIAL_HEADERS = new Set(['set-cookie', 'set-cookie2'])

export interface RemoteDeps extends PairTokenStoreOptions {
  logger: { warn(error: unknown): void }
  fetch?: typeof fetch
  targetOrigin?: string
  maxRequestBytes?: number
  maxResponseBytes?: number
  timeoutMs?: number
  tokenStore?: PairTokenStore
}

class PayloadTooLargeError extends Error {}

/**
 * Loopback privilege rule for the pairing control surface: a loopback socket
 * AND a loopback Host AND same-origin browser markers. The socket alone is not
 * enough behind the documented same-host reverse proxy (nginx connects to
 * 127.0.0.1), where every remote browser request would otherwise look local and
 * could mint, list or revoke pair tokens.
 */
function isLoopback(req: IncomingMessage): boolean {
  return isLoopbackRequest(req)
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
  })
  res.end(encoded)
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(req.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.resume()
    throw new PayloadTooLargeError('request body too large')
  }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) {
      req.resume()
      throw new PayloadTooLargeError('request body too large')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const raw = await readBody(req, maxBytes)
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // Return one uniform bad-request response below.
  }
  throw new SyntaxError('invalid JSON body')
}

async function readFetchBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
  if (body === null) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const buffer = Buffer.from(value)
      total += buffer.length
      if (total > maxBytes) throw new PayloadTooLargeError('upstream response too large')
      chunks.push(buffer)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
}

function loopbackGuard(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (!isLoopback(req)) {
    req.resume()
    writeJson(res, 403, { error: 'forbidden: loopback-only' })
    return false
  }
  if (req.method !== method) {
    req.resume()
    res.setHeader('allow', method)
    writeJson(res, 405, { error: `method not allowed: ${req.method ?? 'GET'}` })
    return false
  }
  return true
}

function sanitizedRequestHeaders(headers: IncomingHttpHeaders, target: URL): Headers {
  const forwarded = new Headers()
  const connectionTokens = connectionHeaderTokens(headers.connection)
  connectionTokens.add('proxy-connection')
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase()
    if (value === undefined || HOP_BY_HOP_HEADERS.has(lowerName) || REQUEST_CREDENTIAL_HEADERS.has(lowerName) || connectionTokens.has(lowerName)) continue
    if (Array.isArray(value)) {
      for (const item of value) forwarded.append(name, item)
    } else {
      forwarded.set(name, value)
    }
  }
  forwarded.set('host', target.host)
  return forwarded
}

function sanitizedResponseHeaders(headers: Headers): Record<string, string | string[]> {
  const forwarded: Record<string, string | string[]> = {}
  const connectionTokens = connectionHeaderTokens(headers.get('connection'))
  connectionTokens.add('proxy-connection')
  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lowerName) || RESPONSE_CREDENTIAL_HEADERS.has(lowerName) || connectionTokens.has(lowerName)) continue
    forwarded[name] = value
  }
  return forwarded
}

function connectionHeaderTokens(value: string | string[] | undefined | null): Set<string> {
  const source = Array.isArray(value) ? value.join(',') : value ?? ''
  return new Set(source.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string') return 'mobile'
  const normalized = value.trim().slice(0, 120)
  return normalized === '' ? 'mobile' : normalized
}

function normalizeTokenId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return /^[a-f\d]{24}$/i.test(normalized) ? normalized : undefined
}

function gatewayError(res: ServerResponse, status: number, error: string): void {
  writeJson(res, status, { ok: false, error })
}

export function makeRemoteRoutes(deps: RemoteDeps): WebRoute[] {
  const store = deps.tokenStore ?? new PairTokenStore(deps)
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const targetOrigin = deps.targetOrigin ?? DEFAULT_GATEWAY_TARGET_ORIGIN
  const maxRequestBytes = deps.maxRequestBytes ?? DEFAULT_GATEWAY_MAX_BODY_BYTES
  const maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_GATEWAY_MAX_BODY_BYTES
  const timeoutMs = deps.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS

  const gatewayHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const token = bearerToken(req.headers.authorization)
    if (token === undefined || store.authenticate(token) === undefined) {
      req.resume()
      gatewayError(res, 401, 'unauthorized')
      return
    }
    if (!isAllowedGatewayMethod(req.method)) {
      req.resume()
      gatewayError(res, 405, 'method not allowed')
      return
    }

    const target = resolveGatewayTarget(req.url, targetOrigin)
    if (target === undefined) {
      req.resume()
      gatewayError(res, 403, 'forbidden gateway target')
      return
    }

    const method = req.method ?? 'GET'
    let body: Buffer | undefined
    try {
      if (method !== 'GET' && method !== 'HEAD') body = await readBody(req, maxRequestBytes)
      else req.resume()
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        gatewayError(res, 413, error.message)
        return
      }
      throw error
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const upstream = await fetchImpl(target, {
        method,
        headers: sanitizedRequestHeaders(req.headers, target),
        body: body !== undefined && body.byteLength > 0 ? body : undefined,
        redirect: 'manual',
        signal: controller.signal,
      })
      const contentLength = upstream.headers.get('content-length')
      const declaredLength = contentLength === null ? undefined : Number(contentLength)
      if (declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        await upstream.body?.cancel().catch(() => {})
        gatewayError(res, 502, 'upstream response too large')
        return
      }
      const responseBody = await readFetchBody(upstream.body, maxResponseBytes)
      const headers = sanitizedResponseHeaders(upstream.headers)
      headers['content-length'] = String(responseBody.byteLength)
      res.writeHead(upstream.status, headers)
      res.end(responseBody)
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        gatewayError(res, 502, error.message)
        return
      }
      if (controller.signal.aborted) {
        gatewayError(res, 504, 'gateway timeout')
        return
      }
      deps.logger.warn(error)
      gatewayError(res, 502, 'gateway upstream failed')
    } finally {
      clearTimeout(timer)
    }
  }

  return [
    {
      kind: 'exact',
      path: `${PAIR_API_PREFIX}/pair`,
      handler: async (req, res) => {
        if (!loopbackGuard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, MAX_PAIR_BODY_BYTES)
          const issued = store.issue(normalizeLabel(body.label))
          writeJson(res, 201, { ok: true, ...issued })
        } catch (error) {
          if (error instanceof PayloadTooLargeError) writeJson(res, 413, { error: error.message })
          else if (error instanceof SyntaxError) writeJson(res, 400, { error: error.message })
          else {
            deps.logger.warn(error)
            writeJson(res, 500, { error: 'failed to create pair token' })
          }
        }
      },
    },
    {
      kind: 'exact',
      path: `${PAIR_API_PREFIX}/status`,
      handler: async (req, res) => {
        if (!loopbackGuard(req, res, 'GET')) return
        const tokens = store.list()
        writeJson(res, 200, { ok: true, paired: tokens.length > 0, tokens })
      },
    },
    {
      kind: 'exact',
      path: `${PAIR_API_PREFIX}/revoke`,
      handler: async (req, res) => {
        if (!loopbackGuard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, MAX_PAIR_BODY_BYTES)
          const id = normalizeTokenId(body.id)
          if (id === undefined) {
            writeJson(res, 400, { error: 'invalid token id' })
            return
          }
          if (!store.revoke(id)) {
            writeJson(res, 404, { error: 'pair token not found' })
            return
          }
          writeJson(res, 200, { ok: true, id })
        } catch (error) {
          if (error instanceof PayloadTooLargeError) writeJson(res, 413, { error: error.message })
          else if (error instanceof SyntaxError) writeJson(res, 400, { error: error.message })
          else {
            deps.logger.warn(error)
            writeJson(res, 500, { error: 'failed to revoke pair token' })
          }
        }
      },
    },
    {
      kind: 'prefix',
      path: GATEWAY_API_PREFIX,
      handler: gatewayHandler,
    },
  ]
}

export function register(ctx: Context): () => void {
  // The full authenticated server-mode surface owns /api/gateway, /login,
  // authentication callbacks and its public listener. Pairing remains as a compatibility
  // control surface only; the secure pair-token gateway proxy is deliberately
  // omitted here to avoid a second owner for /api/gateway.
  return registerResources(own => {
    own(registerServerMode(ctx))
    const routes = makeRemoteRoutes({
      logger: { warn: (error: unknown) => { console.warn('[web-all:remote-web-ui]', error) } },
    }).filter(route => route.path.startsWith(PAIR_API_PREFIX))
    const webServer = (ctx as Context & { webServer: { register(route: WebRoute): () => void } }).webServer
    for (const route of routes) own(webServer.register(route))
  })
}

export { PairTokenStore } from '../../../core/remote-web-ui/security.ts'
export type { PairTokenSummary } from '../../../core/remote-web-ui/security.ts'
