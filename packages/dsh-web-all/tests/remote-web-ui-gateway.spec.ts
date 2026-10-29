/**
 * Gateway listener semantics (T-007..T-009):
 * - the auth wall: unauthenticated JSON /api requests get 401, HTML
 *   navigations get a 302 to /login;
 * - admin sessions proxy through to the loopback upstream as loopback-shaped
 *   calls (the upstream observes Host 127.0.0.1), user sessions are refused
 *   for privileged methods/control prefixes but pass the working surface;
 * - an unreachable upstream answers 502 instead of hanging or leaking, and a
 *   body-less request is retried on a fresh socket when the first connection
 *   dies before answering (a long-uptime loopback stack can leave connects in
 *   SYN_SENT);
 * - the client's encoding negotiation is forwarded upstream and the upstream's
 *   content-encoding comes back, so plugin bundles travel compressed.
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, roleAllowsUpgrade } from '../src/host/services/remote-web-ui/server-mode/gateway.ts'
import { SessionStore, randomSessionId } from '../src/host/services/remote-web-ui/server-mode/sessions.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

let dir = ''
let upstream: Server | undefined
let upstreamPort = 0
let gateway: Gateway | undefined
let sessions: SessionStore

/** Canned upstream: echoes the request the gateway shaped for it. */
async function bootUpstream(): Promise<void> {
  if (upstream !== undefined) await new Promise<void>((resolve) => upstream?.close(() => resolve()))
  upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ sawHost: req.headers.host, sawPath: req.url, sawFetchSite: req.headers['sec-fetch-site'] ?? null, sawCookie: req.headers.cookie ?? null }))
  })
  await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', () => resolve()))
  const address = upstream?.address()
  upstreamPort = typeof address === 'object' && address !== null ? address.port : 0
}

function noOpRoutes(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(404)
  res.end('nope')
}

async function bootGateway(): Promise<void> {
  await bootUpstream()
  gateway = new Gateway({
    host: '127.0.0.1',
    port: 0,
    upstreamPort,
    cookieName: 'dsh_gw_session',
    routes: noOpRoutes,
  }, sessions)
  await gateway.start()
}

function request(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path,
      method: opts.method ?? 'GET',
      headers: opts.headers,
    }, (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += String(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, text: data }) })
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rwui-gateway-'))
  sessions = new SessionStore(join(dir, 'sessions.json'), { now: () => Date.now(), randomId: randomSessionId })
  await bootGateway()
})

afterEach(async () => {
  await gateway?.close()
  gateway = undefined
  if (upstream !== undefined) await new Promise<void>((resolve) => upstream?.close(() => resolve()))
  upstream = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('T-007 auth wall', () => {
  it('refuses unauthenticated /api calls with 401 JSON', async () => {
    const res = await request(gateway?.port ?? 0, '/api/workspace.list', { method: 'POST', headers: { accept: 'application/json' } })
    expect(res.status).toBe(401)
    expect(res.text).toContain('unauthenticated')
  })

  it('redirects unauthenticated HTML navigations to /login', async () => {
    const res = await request(gateway?.port ?? 0, '/workspace/abc', { headers: { accept: 'text/html' } })
    expect(res.status).toBe(302)
    expect(res.headers.location).toContain('/login?next=')
  })

  it('refuses a revoked session id as unauthenticated', async () => {
    const session = sessions.issue('alice', 'admin', {})
    sessions.revoke(session.id)
    const res = await request(gateway?.port ?? 0, '/api/workspace.list', { method: 'POST', headers: { cookie: `dsh_gw_session=${session.id}` } })
    expect(res.status).toBe(401)
  })
})

describe('integrated auth passthrough', () => {
  it('answers /login and /api/gateway locally by default', async () => {
    const res = await request(gateway?.port ?? 0, '/login', { headers: { accept: 'text/html' } })
    expect(res.status).toBe(404)
    expect(res.text).toBe('nope')
  })

  it('proxies /login and /api/gateway to the DSH origin, preserving Host and scheme', async () => {
    await gateway?.close()
    gateway = new Gateway({
      host: '127.0.0.1',
      port: 0,
      upstreamPort,
      cookieName: 'dsh_gw_session',
      routes: noOpRoutes,
      proxyAuthRoutes: true,
    }, sessions)
    await gateway.start()

    const login = await request(gateway.port, '/login', {
      headers: { accept: 'text/html', host: 'dsh.example', 'x-forwarded-proto': 'https' },
    })
    expect(login.status).toBe(200)
    const loginBody = JSON.parse(login.text) as { sawHost: string; sawPath: string }
    expect(loginBody.sawHost).toBe('dsh.example')
    expect(loginBody.sawPath).toBe('/login')

    const api = await request(gateway.port, '/api/gateway/session', { headers: { host: 'dsh.example' } })
    const apiBody = JSON.parse(api.text) as { sawHost: string; sawPath: string }
    expect(apiBody.sawHost).toBe('dsh.example')
    expect(apiBody.sawPath).toBe('/api/gateway/session')
  })

  it('forwards the origin-issued session cookie only in passthrough mode', async () => {
    await gateway?.close()
    if (upstream !== undefined) await new Promise<void>((resolve) => upstream?.close(() => resolve()))
    upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dsh_gw_session=abc; Path=/; HttpOnly' })
      res.end('{}')
    })
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', () => resolve()))
    const address = upstream.address()
    upstreamPort = typeof address === 'object' && address !== null ? address.port : 0

    gateway = new Gateway({
      host: '127.0.0.1', port: 0, upstreamPort, cookieName: 'dsh_gw_session', routes: noOpRoutes, proxyAuthRoutes: true,
    }, sessions)
    await gateway.start()
    const passthrough = await request(gateway.port, '/api/gateway/login', { method: 'POST', headers: { host: 'dsh.example' }, body: '{}' })
    expect(String(passthrough.headers['set-cookie'])).toContain('dsh_gw_session=abc')

    await gateway.close()
    gateway = new Gateway({
      host: '127.0.0.1', port: 0, upstreamPort, cookieName: 'dsh_gw_session', routes: noOpRoutes,
    }, sessions)
    await gateway.start()
    const session = sessions.issue('alice', 'admin', {})
    const walled = await request(gateway.port, '/api/workspace.list', { method: 'POST', headers: { cookie: `dsh_gw_session=${session.id}` }, body: '{}' })
    expect(walled.headers['set-cookie'] ?? '').not.toContain('abc')
  })
})

describe('T-008 role-gated proxy', () => {
  it('proxies an admin session through as a loopback-shaped call', async () => {
    const session = sessions.issue('alice', 'admin', {})
    const res = await request(gateway?.port ?? 0, '/api/workspace.list', {
      method: 'POST',
      headers: { cookie: `dsh_gw_session=${session.id}` },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = JSON.parse(res.text) as { sawHost: string; sawPath: string; sawFetchSite: string | null; sawCookie: string | null }
    expect(body.sawHost).toBe(`127.0.0.1:${String(upstreamPort)}`)
    expect(body.sawPath).toBe('/api/workspace.list')
    expect(body.sawFetchSite).toBe('same-origin')
    // The DSH origin also runs integrated WebAuth, so the admitted session
    // cookie must reach it; the gateway still owns the public auth wall.
    expect(body.sawCookie).toBe(`dsh_gw_session=${session.id}`)
  })

  it('lets the user role reach the native settings and plugin surfaces', async () => {
    const user = sessions.issue('bob', 'user', {})
    for (const path of ['/api/settings/describe', '/api/pluginManager/setPluginEnabled', '/api/llm/listProviders', '/api/credentials/describe']) {
      const res = await request(gateway?.port ?? 0, path, { method: 'POST', headers: { cookie: `dsh_gw_session=${user.id}` }, body: '{}' })
      expect(res.status, path).toBe(200)
    }
  })

  it('refuses the family control prefix for the user role with 403', async () => {
    const user = sessions.issue('bob', 'user', {})
    for (const path of ['/api/pair', '/api/pair/status']) {
      const res = await request(gateway?.port ?? 0, path, { method: 'POST', headers: { cookie: `dsh_gw_session=${user.id}` }, body: '{}' })
      expect(res.status, path).toBe(403)
      expect(res.text).toContain('forbidden-role')
    }
  })

  it('proxies user-role working-surface RPCs', async () => {
    const user = sessions.issue('bob', 'user', {})
    const res = await request(gateway?.port ?? 0, '/api/workspace.list', { method: 'POST', headers: { cookie: `dsh_gw_session=${user.id}` }, body: '{}' })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text) as { sawPath: string }).toMatchObject({ sawPath: '/api/workspace.list' })
  })
})

describe('T-013 upstream resilience', () => {
  it('drops a SYN-stuck connect and answers an unreachable upstream with 502', async () => {
    // A loopback port with no listener: the connect is refused immediately and
    // every retry is refused too, so the client sees one bounded failure.
    const local = new Gateway({
      host: '127.0.0.1',
      port: 0,
      upstreamPort: 9,
      cookieName: 'dsh_gw_session',
      routes: noOpRoutes,
    }, sessions)
    await local.start()
    const session = sessions.issue('alice', 'admin', {})
    const res = await request(local.port, '/plugins/??x/client.js&rev=1', { headers: { cookie: `dsh_gw_session=${session.id}` } })
    expect(res.status).toBe(502)
    expect(res.text).toContain('upstream-failure')
    await local.close()
  })

  it('retries a body-less request on a fresh socket when the upstream drops the first connection', async () => {
    let connections = 0
    const flaky = createServer((req, res) => {
      if (connections === 1) {
        req.socket.destroy()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('second try')
    })
    flaky.on('connection', () => { connections += 1 })
    await new Promise<void>((resolve) => { flaky.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = flaky.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const local = new Gateway({
      host: '127.0.0.1',
      port: 0,
      upstreamPort: port,
      cookieName: 'dsh_gw_session',
      routes: noOpRoutes,
    }, sessions)
    await local.start()
    const session = sessions.issue('alice', 'admin', {})
    const res = await request(local.port, '/plugins/??x/client.js&rev=1', { headers: { cookie: `dsh_gw_session=${session.id}` } })
    expect(res.status).toBe(200)
    expect(res.text).toBe('second try')
    expect(connections).toBeGreaterThanOrEqual(2)
    await local.close()
    await new Promise<void>((resolve) => { flaky.close(() => { resolve() }) })
  })

  it('does not replay a POST that already reached the upstream', async () => {
    // The origin may have executed the request before its socket died; replaying
    // a non-idempotent method would run the side effect twice (a duplicate
    // `/api/commands/execute` produced the reported `busy` second command).
    let connections = 0
    const flaky = createServer((req, res) => {
      let data = ''
      req.on('data', (chunk: Buffer) => { data += String(chunk) })
      req.on('end', () => {
        req.socket.destroy()
      })
    })
    flaky.on('connection', () => { connections += 1 })
    await new Promise<void>((resolve) => { flaky.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = flaky.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const local = new Gateway({
      host: '127.0.0.1',
      port: 0,
      upstreamPort: port,
      cookieName: 'dsh_gw_session',
      routes: noOpRoutes,
    }, sessions)
    await local.start()
    const session = sessions.issue('alice', 'admin', {})
    const body = '{"hello":"world"}'
    const res = await request(local.port, '/api/commands/execute', {
      method: 'POST',
      headers: {
        cookie: `dsh_gw_session=${session.id}`,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    })
    expect(res.status).toBe(502)
    expect(res.text).toContain('upstream-failure')
    expect(connections).toBe(1)
    await local.close()
    await new Promise<void>((resolve) => { flaky.close(() => { resolve() }) })
  })

  it('lets a slow upstream answer instead of killing and replaying the request', async () => {
    // A long-running RPC (for example `/compact`) holds its HTTP response for
    // minutes. The connect deadline must never cover that wait: killing a
    // written request both aborts the upstream work and replays it as a second,
    // duplicate command.
    let requests = 0
    const slow = createServer((req, res) => {
      let data = ''
      req.on('data', (chunk: Buffer) => { data += String(chunk) })
      req.on('end', () => {
        requests += 1
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ saw: data }))
        }, 2_000)
      })
    })
    await new Promise<void>((resolve) => { slow.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = slow.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const local = new Gateway({
      host: '127.0.0.1',
      port: 0,
      upstreamPort: port,
      cookieName: 'dsh_gw_session',
      routes: noOpRoutes,
    }, sessions)
    await local.start()
    const session = sessions.issue('alice', 'admin', {})
    const body = '{"type":"client-request","rpcId":"slow-1","method":"commands/execute","payload":{}}'
    const res = await request(local.port, '/api/commands/execute', {
      method: 'POST',
      headers: {
        cookie: `dsh_gw_session=${session.id}`,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toEqual({ saw: body })
    expect(requests).toBe(1)
    await local.close()
    await new Promise<void>((resolve) => { slow.close(() => { resolve() }) })
  }, 15_000)

  it('passes encoding negotiation through both ways', async () => {
    const echoing = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', vary: 'accept-encoding' })
      res.end(JSON.stringify({ sawAcceptEncoding: req.headers['accept-encoding'] ?? null }))
    })
    await new Promise<void>((resolve) => { echoing.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = echoing.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const local = new Gateway({
      host: '127.0.0.1',
      port: 0,
      upstreamPort: port,
      cookieName: 'dsh_gw_session',
      routes: noOpRoutes,
    }, sessions)
    await local.start()
    const session = sessions.issue('alice', 'admin', {})
    const res = await request(local.port, '/assets/index.js', {
      headers: { cookie: `dsh_gw_session=${session.id}`, 'accept-encoding': 'gzip, deflate' },
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.headers.vary).toBe('accept-encoding')
    expect(res.text).toContain('gzip, deflate')
    await local.close()
    await new Promise<void>((resolve) => { echoing.close(() => { resolve() }) })
  })
})

describe('T-014 provenance marker and document caching', () => {
  /** Upstream that answers one HTML document and one JSON body. */
  async function bootDocumentUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><body>shell</body></html>')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    return { port, close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) } }
  }

  it('backfills the browser-readable provenance marker once', async () => {
    const upstream = await bootDocumentUpstream()
    const local = new Gateway({
      host: '127.0.0.1',
      port: 0,
      upstreamPort: upstream.port,
      cookieName: 'dsh_gw_session',
      routes: noOpRoutes,
    }, sessions)
    await local.start()
    const session = sessions.issue('alice', 'admin', {})
    const first = await request(local.port, '/api/whatever', { headers: { cookie: `dsh_gw_session=${session.id}` } })
    const raw = first.headers['set-cookie'] ?? ''
    const list = Array.isArray(raw) ? raw : [raw]
    const markerCookie = list.find(entry => entry.startsWith('dsh_gw=1')) ?? ''
    expect(markerCookie).toContain('dsh_gw=1')
    expect(markerCookie).not.toContain('HttpOnly')
    // 代理响应只带我们的标记：会话 cookie 只由 /api/gateway/login 下发（见 gateway-routes 规格）。
    expect(list).toHaveLength(1)
    // 带着标记再来一次：不再重复下发
    const second = await request(local.port, '/api/whatever', { headers: { cookie: `dsh_gw_session=${session.id}; dsh_gw=1` } })
    expect(second.headers['set-cookie']).toBeUndefined()
    await local.close()
    await upstream.close()
  })

  it('marks HTML documents no-store and leaves other bodies alone', async () => {
    const upstream = await bootDocumentUpstream()
    const local = new Gateway({
      host: '127.0.0.1',
      port: 0,
      upstreamPort: upstream.port,
      cookieName: 'dsh_gw_session',
      routes: noOpRoutes,
    }, sessions)
    await local.start()
    const session = sessions.issue('alice', 'admin', {})
    const html = await request(local.port, '/', { headers: { cookie: `dsh_gw_session=${session.id}` } })
    expect(html.status).toBe(200)
    expect(html.headers['cache-control']).toBe('no-store')
    expect(html.text).toContain('shell')
    const json = await request(local.port, '/api/whatever', { headers: { cookie: `dsh_gw_session=${session.id}` } })
    expect(json.headers['cache-control']).toBeUndefined()
    await local.close()
    await upstream.close()
  })
})

describe('upgrade role policy', () => {
  it('denies user SSH/sidebar terminals while permitting working streams and every admin upgrade', () => {
    expect(roleAllowsUpgrade('user', '/api/remote.mux')).toBe(true)
    expect(roleAllowsUpgrade('user', '/api/events.mux')).toBe(true)
    expect(roleAllowsUpgrade('user', '/api/events.host')).toBe(true)
    expect(roleAllowsUpgrade('user', '/api/dsh-ssh/terminal')).toBe(false)
    expect(roleAllowsUpgrade('user', '/sidebar/ws/terminal')).toBe(false)
    expect(roleAllowsUpgrade('admin', '/api/dsh-ssh/terminal')).toBe(true)
    expect(roleAllowsUpgrade('admin', '/sidebar/ws/terminal')).toBe(true)
  })
})

describe('T-009 upstream failure', () => {
  it('answers 502 when the upstream is unreachable', async () => {
    const admin = sessions.issue('alice', 'admin', {})
    await new Promise<void>((resolve) => upstream?.close(() => resolve()))
    upstream = undefined
    const res = await request(gateway?.port ?? 0, '/api/workspace.list', { method: 'POST', headers: { cookie: `dsh_gw_session=${admin.id}` }, body: '{}' })
    expect(res.status).toBe(502)
    expect(res.text).toContain('upstream-failure')
  })
})