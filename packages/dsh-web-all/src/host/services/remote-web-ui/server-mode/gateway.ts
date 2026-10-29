/**
 * The server-mode gateway: a node:http/https listener owned by the plugin
 * that is the only public front door to the loopback dsh web. Every request
 * passes the session-cookie auth wall and the role check before being
 * re-issued to 127.0.0.1:<webServer.port> as a loopback-shaped call (Host
 * rewritten, synthetic same-origin marker, client cookies/Origin stripped).
 * Because the gateway is loopback from the upstream's point of view, every
 * privilege the loopback surface grants — including the SDK's
 * loopback-pinned privileged methods — is under the gateway's control.
 *
 * Surface:
 * - Pre-auth: `/login` and `/api/gateway/*` are answered by the route
 *   handler (see gateway-routes.ts), never proxied.
 * - Everything else: auth wall -> role check -> loopback proxy.
 * - WebSocket upgrades (/api/events.mux, /api/events.host, terminal
 *   sockets) and SSE streaming ride the same wall before the upgrade proxy.
 *
 * The gateway is the authentication layer the SDK /api fence is explicitly
 * documented not to be.
 *
 * Upstream resilience: the upstream is loopback, but a long-uptime host can
 * stop answering new loopback connects (a large TIME_WAIT backlog plus a stale
 * SYN leaves fresh `connect()` attempts in SYN_SENT for tens of seconds). Every
 * proxied request therefore uses a reused keep-alive socket when possible, gives
 * a fresh connect 1.5s to complete, and — for requests that carry no body or a
 * small buffered one, so they can be replayed — retries on a new socket (five
 * attempts, which measured ~20% success per attempt on the affected host)
 * before failing. The same
 * applies to WebSocket upgrades, so a client module bundle or the event mux
 * cannot hang the browser behind a dead SYN.
 */

import { Agent, createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { Transform, type Duplex } from 'node:stream'
import { writeJson } from './http.ts'
import { makeReadableCookie, readCookie } from './cookie.ts'
import type { SessionStore } from './sessions.ts'
import { GATEWAY_API_PREFIX, userRoleAllows } from './roles.ts'

/** Validate the actual browser origin before rewriting anything as loopback. */
export function gatewaySameOrigin(req: IncomingMessage, secure: boolean): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    const expected = new URL(`${secure ? 'https' : 'http'}://${host}`)
    const supplied = new URL(origin)
    return supplied.origin === expected.origin && supplied.username === '' && supplied.password === ''
  } catch { return false }
}

/** Upstream response headers forwarded from the loopback webServer. */
const HTTP_FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'content-encoding',
  'vary',
  'cache-control',
  'etag',
  'last-modified',
] as const

/** WebSocket handshake headers forwarded to the loopback upstream. */
const WS_FORWARD_HEADERS = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
] as const

/** Gateway listener config. */
export interface GatewayConfig {
  /** Listen host (default 0.0.0.0 — the only public listener). */
  host: string
  /** Listen port; 0 asks the OS to assign one. */
  port: number
  /** Optional TLS: PEM cert and key file paths; both set -> https. */
  tlsCert?: string
  tlsKey?: string
  /** The loopback webServer port to proxy to. */
  upstreamPort: number
  cookieName: string
  /** The /api/gateway route handler (login + admin surface). */
  routes: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
  /** When true, pass /login and /api/gateway through to the DSH origin. */
  proxyAuthRoutes?: boolean
}

/**
 * Browser-readable provenance marker: a non-secret cookie set alongside the
 * HttpOnly session cookie. The client half (client/trust.ts) reads it
 * synchronously to recognise "this page was served by our gateway" and keep the
 * 0.2 settings plane on the Host — a cached shell HTML has no boot script to do
 * it. The marker carries no secret: its presence only says how the page arrived.
 */
export const GATEWAY_MARKER_COOKIE = 'dsh_gw'
/** Value the marker carries; anything else (or absence) means "not marked yet". */
export const GATEWAY_MARKER_VALUE = '1'
/** Marker lifetime mirrors the session cookie. */
export const GATEWAY_MARKER_MAX_AGE_SECONDS = 30 * 24 * 3600

/** How long a fresh loopback connect may stay in SYN_SENT before it is dropped. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 1_500
/** Total attempts for a replayable (body-less) request. */
const UPSTREAM_ATTEMPTS = 5
/** Keep-alive pools per upstream port, so steady traffic never needs a new socket. */
const upstreamAgents = new Map<number, Agent>()

/** The keep-alive agent for one upstream port. */
function upstreamAgent(port: number): Agent {
  let agent = upstreamAgents.get(port)
  if (agent === undefined) {
    agent = new Agent({
      keepAlive: true,
      keepAliveMsecs: 30_000,
      maxSockets: 64,
      maxFreeSockets: 32,
      scheduling: 'lifo',
    })
    upstreamAgents.set(port, agent)
  }
  return agent
}

/** Whether the inbound request carries a body. */
function hasRequestBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length']
  if (typeof length === 'string' && Number(length) > 0) return true
  return req.headers['transfer-encoding'] !== undefined
}

/**
 * Whether the method may be replayed after its request bytes were handed to the
 * upstream. Only idempotent methods qualify: replaying a POST the origin may have
 * executed would run its side effect twice (`/api/session/prompt`,
 * `/api/commands/execute` and `/api/session/cancel` are all POSTs).
 * @param method - inbound HTTP method.
 * @returns whether an executed request may safely be attempted again.
 */
function isIdempotentMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

/**
 * Largest request body the gateway keeps in memory so a connect that died before
 * the request was written can be retried with the same bytes. RPC payloads are
 * tiny; larger uploads stream straight through (and then only the connect
 * timeout applies, never a replay).
 */
const MAX_REPLAY_BODY_BYTES = 256 * 1024

/**
 * Buffer a small, length-delimited request body. Returns undefined when the body
 * is absent, chunked or too large — the caller then streams it instead.
 * @param req - the inbound request.
 * @returns the buffered body, or undefined to stream.
 */
async function bufferRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const declared = req.headers['content-length']
  if (typeof declared !== 'string') return undefined
  const size = Number(declared)
  if (!Number.isFinite(size) || size <= 0 || size > MAX_REPLAY_BODY_BYTES) return undefined
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    chunks.push(buffer)
  }
  if (total !== size) return undefined
  return Buffer.concat(chunks)
}

/** One loopback-shaped HTTP request to the upstream, retried when replayable. */
async function proxyLoopbackHttp(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  upstreamPath: string,
  originOf: (upstream: string) => string,
  extraSetCookie?: string,
  extraHeaders?: Record<string, string>,
  forwardUpstreamSetCookie?: boolean,
  authorized?: () => boolean,
): Promise<void> {
  const headers: Record<string, string> = {
    host: `127.0.0.1:${String(port)}`,
    'sec-fetch-site': 'same-origin',
  }
  if (extraHeaders !== undefined) Object.assign(headers, extraHeaders)
  const contentType = req.headers['content-type']
  if (typeof contentType === 'string') headers['content-type'] = contentType
  const contentLength = req.headers['content-length']
  if (typeof contentLength === 'string') headers['content-length'] = contentLength
  // The DSH origin owns integrated WebAuth on a proxied front too: without the
  // client cookie it would answer every admitted request with the login wall.
  const cookie = req.headers.cookie
  if (typeof cookie === 'string' && cookie !== '') headers.cookie = cookie
  const accept = req.headers.accept
  if (typeof accept === 'string') headers.accept = accept
  // Bring the client's encoding negotiation through, so plugin bundles and pages
  // travel compressed (the response side forwards content-encoding back).
  const acceptEncoding = req.headers['accept-encoding']
  if (typeof acceptEncoding === 'string') headers['accept-encoding'] = acceptEncoding

  // Small RPC bodies are buffered so a POST survives one dead loopback connect;
  // anything larger streams and keeps the connect timeout only.
  let body: Buffer | undefined
  try {
    body = await bufferRequestBody(req)
  } catch {
    writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'request body could not be read', details: { issues: [] } } })
    return
  }
  if (authorized !== undefined && !authorized()) {
    writeJson(res, 401, { ok: false, error: { code: 'unauthenticated', message: 'session no longer authorized' } })
    return
  }
  const streaming = body === undefined && hasRequestBody(req)
  /** Automatic replay is idempotent-only once a request has reached the upstream. */
  const idempotent = isIdempotentMethod(req.method)
  const replayable = body !== undefined || !streaming
  let attempt = 0
  /** The client response has been taken over by exactly one attempt. */
  let responded = false

  const fail = (): void => {
    if (responded) return
    responded = true
    if (res.headersSent) {
      res.destroy()
      return
    }
    writeJson(res, 502, { ok: false, error: { code: 'upstream-failure', message: 'upstream request failed' } })
  }

  const start = (): void => {
    attempt += 1
    /** This attempt may still write the response. Cleared the moment it loses. */
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined

    /**
     * The deadline guards the loopback connect only. The upstream may take
     * arbitrarily long before it answers — a long-running RPC such as `/compact`
     * holds its response for minutes — and a written request must never be
     * killed (killing it both aborts the upstream work and replays it as a
     * duplicate command).
     */
    let connected = false
    /** This attempt handed its request bytes to the socket (see the `finish` listener). */
    let flushed = false
    const settleConnect = (): void => {
      connected = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    }

    const upstream = httpRequest({
      host: '127.0.0.1',
      port,
      path: upstreamPath,
      method: req.method,
      headers,
      agent: upstreamAgent(port),
    }, (upstreamRes) => {
      // An abandoned attempt can still deliver a response: never let it touch a
      // response another attempt already owns (that threw ERR_HTTP_HEADERS_SENT
      // and killed the host process once).
      if (!live || responded) {
        upstreamRes.destroy()
        return
      }
      live = false
      responded = true
      if (timer !== undefined) clearTimeout(timer)
      try {
        const out: OutgoingHttpHeaders = {}
        for (const name of HTTP_FORWARD_RESPONSE_HEADERS) {
          const value = upstreamRes.headers[name]
          if (value !== undefined) out[name] = value
        }
        // The gateway owns the auth domain: never forward upstream cookies —
        // only our own provenance marker rides along. Auth-route passthrough is
        // the exception: there the DSH origin itself issues the session cookie.
        if (forwardUpstreamSetCookie === true) {
          const upstreamCookies = upstreamRes.headers['set-cookie']
          if (upstreamCookies !== undefined) out['set-cookie'] = upstreamCookies
        }
        const location = upstreamRes.headers.location
        if (typeof location === 'string') out.location = originOf(location)
        if (extraSetCookie !== undefined) out['set-cookie'] = extraSetCookie
        // Documents must never be replayed from cache: they carry the module
        // revisions of the build that served them.
        const contentType = upstreamRes.headers['content-type']
        if (typeof contentType === 'string' && contentType.toLowerCase().includes('text/html')) {
          out['cache-control'] = 'no-store'
        }
        upstreamRes.on('error', () => { res.destroy() })
        res.writeHead(upstreamRes.statusCode ?? 502, out)
        upstreamRes.pipe(res)
      } catch {
        upstreamRes.destroy()
        res.destroy()
      }
    })

    // A pooled socket arrives already open; a fresh one reports its connect.
    upstream.on('socket', (socket) => {
      if (socket.readyState === 'open') settleConnect()
      else socket.once('connect', settleConnect)
    })
    // `finish` means the request bytes were handed to the socket: from here on a
    // non-idempotent request may already be executing upstream and must not be
    // replayed, only reported.
    upstream.on('finish', () => {
      flushed = true
    })

    timer = setTimeout(() => {
      if (!live || connected) return
      live = false
      upstream.destroy()
      if (replayable && attempt < UPSTREAM_ATTEMPTS) {
        start()
        return
      }
      fail()
    }, UPSTREAM_CONNECT_TIMEOUT_MS)

    upstream.on('error', () => {
      if (timer !== undefined) clearTimeout(timer)
      if (!live) return
      live = false
      if (replayable && (!flushed || idempotent) && attempt < UPSTREAM_ATTEMPTS && !res.headersSent) {
        start()
        return
      }
      fail()
    })
    if (body !== undefined) upstream.end(body)
    else if (streaming) req.pipe(upstream)
    else upstream.end()
  }

  start()
}

/** Rebuild a WebSocket handshake as loopback-shaped and pipe both directions. */
function proxyLoopbackUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  port: number,
  upstreamPath: string,
  authorized: () => boolean,
  track: (cleanup: () => void) => () => void,
): void {
  const admitted = (): boolean => { try { return authorized() } catch { return false } }
  const lines = [
    `GET ${upstreamPath} HTTP/1.1`,
    `Host: 127.0.0.1:${String(port)}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
  ]
  // The gateway is the trust boundary for remote clients, so the handshake
  // stays loopback-shaped; the session cookie is carried through because the
  // DSH origin authenticates the stream itself. Origin is deliberately not
  // forwarded: a non-loopback Origin against a loopback Host would fail the
  // origin fence after the gateway already authenticated this peer.
  for (const name of ['cookie', 'user-agent'] as const) {
    const value = req.headers[name]
    if (value === undefined) continue
    lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
  }
  for (const name of WS_FORWARD_HEADERS) {
    const value = req.headers[name]
    if (value === undefined) continue
    lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
  }
  const handshake = `${lines.join('\r\n')}\r\n\r\n`

  let attempt = 0
  const start = (): void => {
    if (socket.destroyed || !admitted()) { socket.destroy(); return }
    attempt += 1
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const upstream = connect(port, '127.0.0.1')
    let untrack = (): void => {}
    timer = setTimeout(() => {
      if (!live) return
      if (attempt < UPSTREAM_ATTEMPTS && admitted()) {
        live = false
        untrack()
        upstream.removeListener('error', tearDown)
        upstream.removeListener('close', tearDown)
        socket.removeListener('error', tearDown)
        socket.removeListener('close', tearDown)
        upstream.on('error', () => {})
        upstream.destroy()
        start()
      } else tearDown()
    }, UPSTREAM_CONNECT_TIMEOUT_MS)
    const tearDown = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      live = false
      untrack()
      upstream.destroy()
      socket.destroy()
    }
    untrack = track(tearDown)
    upstream.on('error', tearDown)
    socket.on('error', tearDown)
    socket.once('close', tearDown)
    upstream.once('close', tearDown)
    upstream.on('connect', () => {
      if (!live) {
        upstream.destroy()
        return
      }
      live = false
      if (timer !== undefined) clearTimeout(timer)
      if (!admitted()) { tearDown(); return }
      upstream.write(handshake)
      if (head.length > 0) upstream.write(head)
      // Preserve native framing/negotiation; inspect admission per incoming
      // byte chunk before forwarding, rather than parsing vendor mux messages.
      const admission = new Transform({ transform(chunk, _encoding, done) {
        if (!admitted()) { tearDown(); done(); return }
        done(null, chunk)
      } })
      admission.on('error', tearDown)
      socket.on('close', () => { admission.destroy() })
      socket.pipe(admission).pipe(upstream)
      const downstream = new Transform({ transform(chunk, _encoding, done) {
        if (!admitted()) { tearDown(); done(); return }
        done(null, chunk)
      } })
      downstream.on('error', tearDown)
      socket.once('close', () => downstream.destroy())
      upstream.pipe(downstream).pipe(socket)
    })
  }
  start()
}

/** Working event streams exposed to non-admin accounts. */
const USER_UPGRADE_PATHS = new Set(['/api/remote.mux', '/api/events.mux', '/api/events.host'])

/** Whether one authenticated role may cross the WebSocket upgrade proxy. */
export function roleAllowsUpgrade(role: 'admin' | 'user', pathname: string): boolean {
  return role === 'admin' || USER_UPGRADE_PATHS.has(pathname)
}

/** Whether an Accept header prefers an HTML document (for login redirects). */
function wantsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept
  return typeof accept === 'string' && (accept.includes('text/html') || accept.includes('application/xhtml+xml'))
}

/**
 * The gateway listener. Call `start()` once the account store is non-empty
 * (the plugin fails closed otherwise).
 */
export class Gateway {
  private readonly config: GatewayConfig
  private readonly sessions: SessionStore
  private server?: Server | HttpsServer
  private actualPort = 0
  private readonly upgrades = new Set<() => void>()

  constructor(config: GatewayConfig, sessions: SessionStore) {
    this.config = config
    this.sessions = sessions
  }

  /** The bound port (the OS-assigned value when config.port is 0). */
  get port(): number {
    return this.actualPort
  }

  /** Whether the listener uses TLS. */
  get secure(): boolean {
    return this.config.tlsCert !== undefined && this.config.tlsKey !== undefined
  }

  /** Start listening. Resolves once the socket is bound; rejects on failure. */
  start(): Promise<void> {
    const { host, port, tlsCert, tlsKey } = this.config
    if (this.secure) {
      const options = {
        cert: readFileSync(tlsCert as string),
        key: readFileSync(tlsKey as string),
      }
      this.server = createHttpsServer(options, (req, res) => { this.onRequest(req, res) })
    } else {
      this.server = createHttpServer((req, res) => { this.onRequest(req, res) })
    }
    this.server.on('upgrade', (req, socket, head) => { this.onUpgrade(req, socket, head) })
    this.server.on('error', () => {})
    return new Promise((resolve, reject) => {
      const server = this.server as Server | HttpsServer
      server.once('error', reject)
      server.listen(port, host, () => {
        const address = server.address()
        this.actualPort = typeof address === 'object' && address !== null ? address.port : port
        server.removeListener('error', reject)
        resolve()
      })
    })
  }

  /** Stop listening and drop the socket. */
  close(): Promise<void> {
    const server = this.server
    this.server = undefined
    for (const cleanup of [...this.upgrades]) cleanup()
    this.upgrades.clear()
    if (server === undefined) return Promise.resolve()
    return new Promise((resolve) => {
      server.close(() => resolve())
    })
  }

  /**
   * Browser-origin headers for auth-route passthrough: the DSH origin renders
   * the login page and cookies from the real Host, so a proxied front must not
   * rewrite the request as loopback.
   */
  private originHeadersOf(req: IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {}
    const host = req.headers.host
    if (typeof host === 'string' && host !== '') headers.host = host
    const forwardedProto = req.headers['x-forwarded-proto']
    headers['x-forwarded-proto'] = typeof forwardedProto === 'string' ? forwardedProto : (this.secure ? 'https' : 'http')
    if (typeof host === 'string' && host !== '') headers['x-forwarded-host'] = host
    const forwardedFor = req.headers['x-forwarded-for']
    if (typeof forwardedFor === 'string') headers['x-forwarded-for'] = forwardedFor
    return headers
  }

  /** Rewrite an upstream absolute Location pointing at loopback to this origin. */
  private originOf(req: IncomingMessage, upstream: string): string {
    if (typeof upstream !== 'string') return upstream
    const authority = `127.0.0.1:${String(this.config.upstreamPort)}`
    const prefix = `http://${authority}`
    if (upstream === prefix) return `${this.secure ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`
    if (upstream.startsWith(`${prefix}/`)) {
      return `${this.secure ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}${upstream.slice(prefix.length)}`
    }
    return upstream
  }

  /** Auth wall: resolve the live session for this request, or undefined. */
  private authenticate(req: IncomingMessage): { username: string; role: 'admin' | 'user' } | undefined {
    const cookieValue = readCookie(req.headers.cookie, this.config.cookieName)
    let session
    try { session = cookieValue === undefined ? undefined : this.sessions.touch(cookieValue) } catch { return undefined }
    if (session === undefined) return undefined
    return { username: session.username, role: session.role }
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!gatewaySameOrigin(req, this.secure)) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden-origin', message: 'same-origin request required' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://gateway.local')
    const pathname = url.pathname

    // In compatibility-proxy mode the DSH origin owns login/session rendering,
    // so Host and forwarded scheme describe the real browser origin correctly.
    if (this.config.proxyAuthRoutes === true && (pathname === '/login' || pathname === GATEWAY_API_PREFIX || pathname.startsWith(`${GATEWAY_API_PREFIX}/`))) {
      void proxyLoopbackHttp(req, res, this.config.upstreamPort, `${pathname}${url.search}`, (upstream) => this.originOf(req, upstream), undefined, this.originHeadersOf(req), true)
      return
    }
    if (pathname === '/login' || pathname === GATEWAY_API_PREFIX || pathname.startsWith(`${GATEWAY_API_PREFIX}/`)) {
      void Promise.resolve().then(() => this.config.routes(req, res)).catch(() => {
        if (!res.headersSent) writeJson(res, 500, { ok: false, error: { code: 'internal', message: 'gateway operation failed' } })
        else res.destroy()
      })
      return
    }

    // Pre-auth static assets: browsers fetch the web app manifest / favicon
    // without cookies (credentials: omit), and these files carry no session
    // or user data on the loopback upstream. Let them through the wall so a
    // signed-out visitor still gets a clean manifest fetch (and the PWA shell
    // works after signing in).
    if (pathname === '/manifest.webmanifest' || pathname === '/favicon.ico') {
      void proxyLoopbackHttp(req, res, this.config.upstreamPort, `${pathname}${url.search}`, (upstream) => this.originOf(req, upstream))
      return
    }

    // Auth wall.
    const session = this.authenticate(req)
    if (session === undefined) {
      if (wantsHtml(req)) {
        const next = encodeURIComponent(`${pathname}${url.search}`)
        res.writeHead(302, { location: `/login?next=${next}`, 'cache-control': 'no-store' })
        res.end()
        return
      }
      writeJson(res, 401, { ok: false, error: { code: 'unauthenticated', message: 'sign in required', details: { issues: [] } } })
      return
    }

    // Backfill the provenance marker for sessions created before it existed, and
    // mark every fresh document load — the client half reads it synchronously.
    const marker = readCookie(req.headers.cookie, GATEWAY_MARKER_COOKIE) === GATEWAY_MARKER_VALUE
      ? undefined
      : makeReadableCookie(GATEWAY_MARKER_COOKIE, GATEWAY_MARKER_VALUE, {
        secure: this.secure,
        maxAgeSeconds: GATEWAY_MARKER_MAX_AGE_SECONDS,
      })

    // Role check for the /api plane: only the family control surface is
    // admin-only; the native API and the family feature routes serve both roles.
    if (pathname.startsWith('/api/') && session.role === 'user' && !userRoleAllows(pathname)) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden-role', message: 'this surface requires the admin role', details: { issues: [] } } })
      return
    }

    void proxyLoopbackHttp(req, res, this.config.upstreamPort, `${pathname}${url.search}`, (upstream) => this.originOf(req, upstream), marker, undefined, false, () => {
      const id = readCookie(req.headers.cookie, this.config.cookieName)
      const current = id === undefined ? undefined : this.sessions.peek(id)
      return current !== undefined && (current.role === 'admin' || !pathname.startsWith('/api/') || userRoleAllows(pathname))
    })
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!gatewaySameOrigin(req, this.secure)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const url = new URL(req.url ?? '/', 'http://gateway.local')
    const pathname = url.pathname

    // Auth wall for upgrades (the mux/host event streams, terminals).
    const session = this.authenticate(req)
    if (session === undefined) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (!roleAllowsUpgrade(session.role, pathname)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const authorized = (): boolean => {
      const id = readCookie(req.headers.cookie, this.config.cookieName)
      const current = id === undefined ? undefined : this.sessions.peek(id)
      return current !== undefined && roleAllowsUpgrade(current.role, pathname)
    }
    proxyLoopbackUpgrade(req, socket, head, this.config.upstreamPort, `${pathname}${url.search}`, authorized, cleanup => {
      let closed = false
      const check = (): void => { if (!authorized()) cleanup() }
      const unsubscribe = this.sessions.subscribe(check)
      const expiry = setInterval(check, 1_000)
      expiry.unref()
      const finish = (): void => {
        if (closed) return
        closed = true
        unsubscribe()
        clearInterval(expiry)
        this.upgrades.delete(close)
      }
      const close = (): void => { finish(); cleanup() }
      this.upgrades.add(close)
      return finish
    })
  }
}