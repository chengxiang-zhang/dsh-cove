import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Socket } from 'node:net'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountStore, randomSalt } from '../src/host/services/remote-web-ui/server-mode/accounts.ts'
import { SessionStore, randomSessionId } from '../src/host/services/remote-web-ui/server-mode/sessions.ts'
import { LoginLimiter, makeGatewayRequestHandler } from '../src/host/services/remote-web-ui/server-mode/gateway-routes.ts'
import { Gateway } from '../src/host/services/remote-web-ui/server-mode/gateway.ts'
import { readCookie } from '../src/host/services/remote-web-ui/server-mode/cookie.ts'
import { installIntegratedBrowserAuth, type BrowserAuthLike } from '../src/host/services/remote-web-ui/server-mode/integrated-auth.ts'
import { isTrustedHostRequest } from '../src/host/services/access-trust/trust.ts'

// Only ephemeral stores/listeners: this suite never contacts the running DSH.
const disposals: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })
const cookieName = 'dsh_gw_session'
const password = 'adversarial-fixture-only-123'
interface Result { status: number; body: any; cookies?: string[] }
function request(port: number, path: string, method = 'GET', cookie?: string, body?: unknown, extra: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra, ...(cookie ? { cookie } : {}),
    } }, res => {
      let text = ''
      res.on('data', data => { text += data })
      res.on('end', () => { let value: unknown = text; try { value = JSON.parse(text) } catch {} ; resolve({ status: res.statusCode!, body: value, cookies: res.headers['set-cookie'] }) })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(new Error('fixture HTTP timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
async function listen(server: Server): Promise<number> {
  const sockets = new Set<Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  disposals.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture address missing')
  return address.port
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-auth-adversarial-')))
  disposals.push(() => {
    const target = realpathSync(root)
    if (!target.startsWith(`${realpathSync(tmpdir())}/dsh-auth-adversarial-`)) throw new Error('unsafe fixture cleanup')
    rmSync(target, { recursive: true, force: true })
  })
  const accountPath = join(root, 'accounts.json')
  const sessionPath = join(root, 'sessions.json')
  const accounts = new AccountStore(accountPath, { now: Date.now, randomSalt })
  const sessions = new SessionStore(sessionPath, { now: Date.now, randomId: randomSessionId })
  accounts.create('owner', password, 'admin')
  accounts.create('target', password, 'admin')
  const handler = makeGatewayRequestHandler('session', {
    accounts, sessions, cookieName, secure: false,
    limiter: new LoginLimiter({ windowMs: 1000, maxFailsPerWindow: 100, maxFailsBeforeLockout: 200, lockoutMs: 1000 }),
    status: { loginRequired: true, cookieName, tls: false, noAccounts: false },
  })
  const bodyWaiters: Array<() => void> = []
  const server = createServer((req, res) => {
    // Observes the actual handler reaching readBoundedJson, not a time-based race.
    const original = req[Symbol.asyncIterator].bind(req)
    req[Symbol.asyncIterator] = function () { bodyWaiters.shift()?.(); return original() }
    void handler(req, res).catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) })
  })
  const port = await listen(server)
  const login = async (name = 'target', pass = password) => {
    const result = await request(port, '/api/gateway/login', 'POST', undefined, { username: name, password: pass })
    return { ...result, cookie: result.cookies?.find(value => value.startsWith(`${cookieName}=`))?.split(';')[0] }
  }
  const owner = await login('owner')
  if (!owner.cookie) throw new Error('owner fixture did not log in')
  const mutate = (kind: string) => kind === 'delete'
    ? request(port, '/api/gateway/accounts/target', 'DELETE', owner.cookie)
    : request(port, `/api/gateway/accounts/target/${kind}`, 'POST', owner.cookie,
      kind === 'role' ? { role: 'user' } : kind === 'enabled' ? { enabled: false } : { password: 'replacement-fixture-123' })
  const slow = async (path: string, cookie: string | undefined, body: unknown) => {
    const entered = new Promise<void>(resolve => bodyWaiters.push(resolve))
    let finish!: () => void
    const result = new Promise<Result>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }, res => {
        let text = ''; res.on('data', data => { text += data })
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), cookies: res.headers['set-cookie'] }))
      })
      req.on('error', reject)
      req.setTimeout(3000, () => req.destroy(new Error('slow fixture timeout')))
      req.flushHeaders()
      finish = () => req.end(JSON.stringify(body))
    })
    await entered
    return { result, finish }
  }
  return { root, accounts, sessions, accountPath, sessionPath, handler, port, owner: owner.cookie, login, mutate, slow }
}

const changes = ['role', 'password', 'enabled', 'delete'] as const

describe('adversarial stale-cookie and asynchronous authorization boundaries', () => {
  it.each(changes)('old cookies cannot survive successful %s and subsequent relogin', async kind => {
    const f = await fixture()
    const old = await f.login()
    const oldId = readCookie(old.cookie, cookieName)!
    expect((await f.mutate(kind)).status).toBe(200)
    expect(f.sessions.peek(oldId)).toBeUndefined()
    expect((await request(f.port, '/api/gateway/session', 'GET', old.cookie)).body.authenticated).toBe(false)
    const fresh = await f.login('target', kind === 'password' ? 'replacement-fixture-123' : password)
    if (kind === 'enabled' || kind === 'delete') expect(fresh.status).toBe(401)
    else {
      expect(fresh.status).toBe(200)
      expect(fresh.cookie).not.toBe(old.cookie)
      expect((await request(f.port, '/api/gateway/accounts', 'GET', old.cookie)).status).toBe(403)
    }
  })

  it.each(changes)('a login body completed after %s cannot issue stale privileges', async kind => {
    const f = await fixture()
    const delayed = await f.slow('/api/gateway/login', undefined, { username: 'target', password })
    expect((await f.mutate(kind)).status).toBe(200)
    delayed.finish()
    const result = await delayed.result
    if (kind === 'role') {
      expect(result.status).toBe(200)
      expect(result.body.role).toBe('user')
    } else expect(result.status).toBe(401)
  })

  it.each(changes)('an admin request awaiting its body must not gain a new admin account after %s', async kind => {
    const f = await fixture()
    const old = await f.login()
    const delayed = await f.slow('/api/gateway/accounts', old.cookie, { username: 'late-admin', password, role: 'admin' })
    expect((await f.mutate(kind)).status).toBe(200)
    delayed.finish()
    const result = await delayed.result
    expect.soft(result.status, 'authorization must be live at mutation, not only before awaiting attacker-controlled bytes').toBe(403)
    expect(f.accounts.roleOf('late-admin')).toBeUndefined()
  })
})

describe('adversarial persistence failures', () => {
  it.each(changes)('failed %s persistence cannot leave an old session with admin authorization', async kind => {
    const f = await fixture()
    const old = await f.login()
    mkdirSync(`${f.accountPath}.tmp-${process.pid}`)
    const changed = await f.mutate(kind)
    expect(changed.status).toBe(500)
    // A failed atomic commit must not acknowledge a half-applied account edit;
    // authorization nevertheless fails closed until operator recovery.
    expect(f.accounts.authorization('target')).toBeUndefined()
    expect(f.accounts.verify('target', password)).toBe(false)
    expect((await request(f.port, '/api/gateway/accounts', 'GET', old.cookie)).status).toBe(403)
  })

  it('failed session revocation persistence cannot resurrect an old admin after store reload', async () => {
    const f = await fixture()
    const old = await f.login()
    const id = readCookie(old.cookie, cookieName)!
    mkdirSync(`${f.sessionPath}.tmp-${process.pid}`)
    // A broad session filesystem failure blocks authentication at touch() first.
    // Use the real loopback administrative handler to isolate the later revoke
    // persistence boundary, rather than replacing either store with a fake.
    const local = makeGatewayRequestHandler('loopback', {
      accounts: f.accounts, sessions: f.sessions, cookieName, secure: false,
      limiter: new LoginLimiter({ windowMs: 1000, maxFailsPerWindow: 100, maxFailsBeforeLockout: 200, lockoutMs: 1000 }),
      status: { loginRequired: true, cookieName, tls: false, noAccounts: false },
    })
    const localServer = createServer((req, res) => { void local(req, res).catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) }) })
    const port = await listen(localServer)
    expect((await request(port, '/api/gateway/accounts/target/role', 'POST', undefined, { role: 'user' })).status).toBe(500)
    expect(f.accounts.roleOf('target')).toBe('user')
    const reloadedAccounts = new AccountStore(f.accountPath, { now: Date.now, randomSalt })
    const reloadedSessions = new SessionStore(f.sessionPath, { now: Date.now, randomId: randomSessionId })
    expect(reloadedAccounts.roleOf('target')).toBe('user')
    const reloaded = makeGatewayRequestHandler('session', {
      accounts: reloadedAccounts, sessions: reloadedSessions, cookieName, secure: false,
      limiter: new LoginLimiter({ windowMs: 1000, maxFailsPerWindow: 100, maxFailsBeforeLockout: 200, lockoutMs: 1000 }),
      status: { loginRequired: true, cookieName, tls: false, noAccounts: false },
    })
    const restarted = createServer((req, res) => { void reloaded(req, res).catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) }) })
    const restartedPort = await listen(restarted)
    expect((await request(restartedPort, '/api/gateway/accounts', 'GET', `${cookieName}=${id}`)).status,
      'a persisted admin snapshot must not authorize after revocation failed and stores reload').toBe(403)
  })
})

async function gatewayFixture() {
  const f = await fixture()
  const wss = new WebSocketServer({ noServer: true })
  disposals.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close() })
  let privilegedMessages = 0
  wss.on('connection', ws => { ws.on('message', data => { privilegedMessages++; ws.send(data) }) })
  const upstream = createServer((_req, res) => { res.end(JSON.stringify({ ok: true })) })
  upstream.on('upgrade', (req, socket, head) => { wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)) })
  const upstreamPort = await listen(upstream)
  const gateway = new Gateway({ host: '127.0.0.1', port: 0, upstreamPort, cookieName, routes: f.handler }, f.sessions)
  await gateway.start()
  disposals.push(() => gateway.close())
  const connect = async (cookie: string, origin?: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/terminal`, { headers: { cookie, ...(origin ? { origin } : {}) } })
    disposals.push(() => ws.terminate())
    await once(ws, 'open')
    return ws
  }
  return { ...f, gateway, connect, count: () => privilegedMessages }
}
async function exchange(ws: WebSocket): Promise<'message' | 'closed'> {
  if (ws.readyState !== WebSocket.OPEN) return 'closed'
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ws.off('message', message); ws.off('close', close); ws.off('error', error) }
    const message = () => { cleanup(); resolve('message') }
    const close = () => { cleanup(); resolve('closed') }
    const error = (reason: Error) => { cleanup(); reject(reason) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('fixture WebSocket response timeout')) }, 1000)
    ws.once('message', message); ws.once('close', close); ws.once('error', error)
    ws.send('privileged-fixture-command')
  })
}

describe('active legacy WebSocket revocation and browser origin admission', () => {
  it.each(changes)('an already-open privileged socket must stop accepting operations after %s', async kind => {
    const f = await gatewayFixture()
    const old = await f.login()
    const ws = await f.connect(old.cookie!)
    await exchange(ws)
    expect((await f.mutate(kind)).status).toBe(200)
    // New handshakes/HTTP requests are rejected, but this probes the old tunnel.
    expect((await request(f.gateway.port, '/api/test', 'GET', old.cookie)).status).toBe(401)
    await exchange(ws)
    expect(f.count(), 'the second privileged message crossed after explicit account revocation').toBe(1)
  })

  it('a foreign Origin must not open an authenticated privileged socket', async () => {
    const f = await gatewayFixture()
    const old = await f.login()
    const ws = new WebSocket(`ws://127.0.0.1:${f.gateway.port}/terminal`, { headers: { cookie: old.cookie!, host: 'victim.invalid', origin: 'http://attacker.victim.invalid' } })
    disposals.push(() => ws.terminate())
    const outcome = await new Promise<'open' | 'rejected'>((resolve, reject) => {
      ws.once('open', () => resolve('open'))
      ws.once('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolve('rejected') })
      ws.on('error', error => { if (ws.readyState === WebSocket.CONNECTING) reject(error) })
    })
    if (outcome === 'open') await exchange(ws)
    expect.soft(outcome).toBe('rejected')
    expect(f.count(), 'ambient cookie must not authenticate a cross-origin WebSocket handshake').toBe(0)
  })

  it('a same-site foreign-origin simple HTTP request must not mutate accounts through the legacy public listener', async () => {
    const f = await gatewayFixture()
    const old = await f.login()
    const result = await request(f.gateway.port, '/api/gateway/accounts', 'POST', old.cookie,
      { username: 'cross-site-admin', password, role: 'admin' },
      { 'content-type': 'text/plain', host: 'victim.invalid', origin: 'http://attacker.victim.invalid', 'sec-fetch-site': 'same-site', 'x-forwarded-host': '127.0.0.1', 'x-forwarded-proto': 'https' })
    expect.soft(result.status).toBe(403)
    expect(f.accounts.roleOf('cross-site-admin')).toBeUndefined()
  })
})

describe('boundary controls: integrated/native composition, Host, cookie, encoded paths', () => {
  it('revoked account cookies are refused while independent native break-glass remains valid', async () => {
    const f = await fixture()
    const old = await f.login()
    const auth: BrowserAuthLike = {
      isAuthenticated: req => readCookie(req.headers.cookie, 'native_fixture') === 'valid',
      authorizeIndex: () => false,
      authenticatedUrl: base => `${base}?token=fixture`,
    }
    const restore = installIntegratedBrowserAuth({ browserAuth: auth }, {
      enabled: () => true,
      hasSession: req => { const id = readCookie(req.headers.cookie, cookieName); return !!id && !!f.sessions.touch(id) },
    })
    disposals.push(restore)
    const incoming = (cookie: string) => ({ headers: { cookie }, url: '/', method: 'GET' } as IncomingMessage)
    expect(auth.isAuthenticated(incoming(old.cookie!))).toBe(true)
    await f.mutate('role')
    expect(auth.isAuthenticated(incoming(old.cookie!))).toBe(false)
    // Native token belongs to the trusted host operator, not to the account being revoked.
    expect(auth.isAuthenticated(incoming(`${old.cookie}; native_fixture=valid`))).toBe(true)
    expect((await request(f.port, '/api/gateway/accounts', 'GET', 'native_fixture=valid')).status).toBe(403)
  })

  it.each([
    { host: 'attacker.invalid', 'x-forwarded-host': 'trusted.invalid', 'x-forwarded-for': '127.0.0.1' },
    { host: 'trusted.invalid', origin: 'https://attacker.invalid' },
    { host: 'trusted.invalid', 'sec-fetch-site': 'cross-site' },
  ])('shared fence ignores spoofed forwarding or foreign Origin: %j', headers => {
    const req = { headers, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage
    expect(isTrustedHostRequest(req, { trustedAuthorities: ['trusted.invalid'], isAuthenticated: () => true })).toBe(false)
  })

  it('duplicate cookie ordering cannot bring a revoked cookie back to life', async () => {
    const f = await fixture()
    const old = await f.login()
    await f.mutate('role')
    for (const cookie of [`${old.cookie}; ${cookieName}=forged`, `${cookieName}=forged; ${old.cookie}`]) {
      expect((await request(f.port, '/api/gateway/accounts', 'GET', cookie)).status).toBe(403)
    }
    expect((await request(f.port, '/api/gateway/accounts', 'GET', `${cookieName}=forged`, undefined, { 'x-forwarded-for': '127.0.0.1' })).status).toBe(403)
  })

  it.each(['/api/gateway/%61ccounts', '/api/gateway/accounts%2f', '/api/gateway/accounts/../accounts', '/api/gateway//accounts'])('encoded or normalized path never bypasses admin admission: %s', async path => {
    const f = await fixture()
    expect((await request(f.port, path)).status).toBe(403)
  })
})
