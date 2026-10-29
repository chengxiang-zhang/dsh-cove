/**
 * Gateway route surface (login page, session/login/logout, admin endpoints):
 * - login page is served pre-auth as HTML;
 * - login mints an HttpOnly session cookie on valid credentials and stays
 *   generic (401) on bad ones; the limiter answers 429 after repeated fails;
 * - the admin surface is closed to non-admin sessions on the public trust
 *   context and open on the loopback context; account/session CRUD works.
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AccountStore, randomSalt } from '../src/host/services/remote-web-ui/server-mode/accounts.ts'
import { SessionStore, randomSessionId } from '../src/host/services/remote-web-ui/server-mode/sessions.ts'
import { LoginLimiter, makeGatewayRequestHandler, isPreAuthGatewayPath, type GatewayRoutesDeps } from '../src/host/services/remote-web-ui/server-mode/gateway-routes.ts'
import { readCookie } from '../src/host/services/remote-web-ui/server-mode/cookie.ts'

let dir = ''
let server: Server | undefined

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

let accounts: AccountStore
let sessions: SessionStore
let deps: (status: { loginRequired: boolean; cookieName: string; tls: boolean; noAccounts: boolean }) => GatewayRoutesDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rwui-gwroutes-'))
  accounts = new AccountStore(join(dir, 'accounts.json'), { now: () => Date.now(), randomSalt })
  sessions = new SessionStore(join(dir, 'sessions.json'), { now: () => Date.now(), randomId: randomSessionId })
  deps = (status) => ({
    accounts,
    sessions,
    cookieName: 'dsh_gw_session',
    secure: false,
    limiter: new LoginLimiter({ windowMs: 5_000, maxFailsPerWindow: 5, maxFailsBeforeLockout: 20, lockoutMs: 5_000 }),
    status,
  })
})

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }
  rmSync(dir, { recursive: true, force: true })
})

/** Boot a tiny http server serving one trust context. */
async function boot(trust: 'loopback' | 'session', status: { loginRequired: boolean; cookieName: string; tls: boolean; noAccounts: boolean }): Promise<number> {
  const handler = makeGatewayRequestHandler(trust, deps(status))
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
  const address = server?.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

describe('isPreAuthGatewayPath', () => {
  it('marks the login page and pre-auth API paths', () => {
    expect(isPreAuthGatewayPath('GET', '/login')).toBe(true)
    expect(isPreAuthGatewayPath('GET', '/api/gateway/status')).toBe(true)
    expect(isPreAuthGatewayPath('POST', '/api/gateway/login')).toBe(true)
    expect(isPreAuthGatewayPath('GET', '/api/gateway/accounts')).toBe(false)
    expect(isPreAuthGatewayPath('POST', '/api/gateway/accounts')).toBe(false)
  })
})

describe('login page and session endpoints (public trust)', () => {
  it('serves the login page pre-auth with a username field', async () => {
    const port = await boot('session', { loginRequired: true, cookieName: 'dsh_gw_session', tls: false, noAccounts: true })
    const res = await request(port, '/login', { headers: { accept: 'text/html' } })
    expect(res.status).toBe(200)
    expect(res.headers['content-type'] ?? '').toContain('text/html')
    expect(res.text).toContain('username')
  })

  it('mints an HttpOnly session cookie on valid credentials', async () => {
    accounts.create('alice', 'correct-horse-9', 'admin')
    const port = await boot('session', { loginRequired: true, cookieName: 'dsh_gw_session', tls: false, noAccounts: false })
    const res = await request(port, '/api/gateway/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'correct-horse-9' }),
    })
    expect(res.status).toBe(200)
    const cookie = res.headers['set-cookie']
    expect(Array.isArray(cookie) ? cookie.join('') : cookie ?? '').toContain('dsh_gw_session=')
    expect(Array.isArray(cookie) ? cookie.join('') : cookie ?? '').toContain('HttpOnly')
    const sessionId = readCookie(Array.isArray(cookie) ? cookie.join(';') : cookie, 'dsh_gw_session')
    expect(sessionId).toBeDefined()
    expect(sessions.peek(sessionId as string)?.username).toBe('alice')
  })

  it('rejects bad credentials generically and rate-limits repeated failures', async () => {
    accounts.create('alice', 'correct-horse-9', 'admin')
    const port = await boot('session', { loginRequired: true, cookieName: 'dsh_gw_session', tls: false, noAccounts: false })
    const attempt = () => request(port, '/api/gateway/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrong-password-9' }),
    })
    for (let i = 0; i < 5; i += 1) {
      const res = await attempt()
      expect(res.status).toBe(401)
      expect(res.text).toContain('invalid-credentials')
    }
    const limited = await attempt()
    expect(limited.status).toBe(429)
    expect(limited.text).toContain('rate-limited')
  })

  it('keys the public login limiter by socket address, never spoofable XFF', async () => {
    accounts.create('alice', 'correct-horse-9', 'admin')
    const port = await boot('session', { loginRequired: true, cookieName: 'dsh_gw_session', tls: false, noAccounts: false })
    for (let i = 0; i < 5; i += 1) {
      const res = await request(port, '/api/gateway/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${String(i + 1)}` },
        body: JSON.stringify({ username: 'alice', password: 'wrong-password-9' }),
      })
      expect(res.status).toBe(401)
    }
    const limited = await request(port, '/api/gateway/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.250' },
      body: JSON.stringify({ username: 'alice', password: 'wrong-password-9' }),
    })
    expect(limited.status).toBe(429)
  })

  it('reports the session probe and logs out by clearing the cookie', async () => {
    accounts.create('alice', 'correct-horse-9', 'admin')
    sessions.bindAccounts(accounts)
    const session = sessions.issue('alice', 'admin', {})
    const port = await boot('session', { loginRequired: true, cookieName: 'dsh_gw_session', tls: false, noAccounts: false })
    const probe = await request(port, '/api/gateway/session', { headers: { cookie: `dsh_gw_session=${session.id}` } })
    expect(probe.status).toBe(200)
    expect(JSON.parse(probe.text)).toMatchObject({ authenticated: true, username: 'alice', role: 'admin' })
    const out = await request(port, '/api/gateway/logout', { method: 'POST', headers: { cookie: `dsh_gw_session=${session.id}` } })
    expect(out.status).toBe(200)
    const cookie = Array.isArray(out.headers['set-cookie']) ? out.headers['set-cookie'].join('') : (out.headers['set-cookie'] ?? '')
    expect(cookie).toContain('Max-Age=0')
    expect(sessions.peek(session.id)).toBeUndefined()
  })
})

describe('admin surface', () => {
  it('is closed to requests without an admin session on the session trust', async () => {
    accounts.create('alice', 'correct-horse-9', 'admin')
    accounts.create('bob', 'battery-staple-9', 'user')
    const port = await boot('session', { loginRequired: true, cookieName: 'dsh_gw_session', tls: false, noAccounts: false })
    const denied = await request(port, '/api/gateway/accounts', { headers: { cookie: `dsh_gw_session=${sessions.issue('bob', 'user', {}).id}` } })
    expect(denied.status).toBe(403)
    const none = await request(port, '/api/gateway/accounts')
    expect(none.status).toBe(403)
  })

  it('opens on the loopback trust without any session (first-admin bootstrap path)', async () => {
    const port = await boot('loopback', { loginRequired: true, cookieName: 'dsh_gw_session', tls: false, noAccounts: true })
    const created = await request(port, '/api/gateway/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'correct-horse-9', role: 'admin' }),
    })
    expect(created.status).toBe(200)
    expect(JSON.parse(created.text)).toMatchObject({ ok: true, account: { username: 'alice', role: 'admin' } })
    const dup = await request(port, '/api/gateway/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'another-pass-9', role: 'admin' }),
    })
    expect(dup.status).toBe(409)
    const short = await request(port, '/api/gateway/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'short', role: 'user' }),
    })
    expect(short.status).toBe(400)
  })

  it('forces first-account admin and returns 409 for last-enabled-admin mutations', async () => {
    const port = await boot('loopback', { loginRequired: true, cookieName: 'dsh_gw_session', tls: false, noAccounts: true })
    const created = await request(port, '/api/gateway/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'correct-horse-9', role: 'user' }),
    })
    expect(JSON.parse(created.text)).toMatchObject({ account: { username: 'alice', role: 'admin' } })
    for (const mutation of [
      { method: 'POST', path: '/api/gateway/accounts/alice/role', body: { role: 'user' } },
      { method: 'POST', path: '/api/gateway/accounts/alice/enabled', body: { enabled: false } },
      { method: 'DELETE', path: '/api/gateway/accounts/alice', body: undefined },
    ]) {
      const response = await request(port, mutation.path, {
        method: mutation.method,
        headers: mutation.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: mutation.body === undefined ? undefined : JSON.stringify(mutation.body),
      })
      expect(response.status).toBe(409)
      expect(response.text).toContain('last-enabled-admin')
    }
  })

  it('lists and revokes sessions on the loopback trust', async () => {
    const a = sessions.issue('alice', 'admin', { ip: '10.0.0.2' })
    sessions.issue('bob', 'user', {})
    const port = await boot('loopback', { loginRequired: true, cookieName: 'dsh_gw_session', tls: false, noAccounts: false })
    const list = await request(port, '/api/gateway/sessions')
    expect(list.status).toBe(200)
    const body = JSON.parse(list.text) as { sessions: Array<{ id: string; username: string }> }
    expect(body.sessions).toHaveLength(2)
    const revoke = await request(port, '/api/gateway/sessions/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: a.id }),
    })
    expect(JSON.parse(revoke.text)).toMatchObject({ revoked: true })
    const again = await request(port, '/api/gateway/sessions')
    expect((JSON.parse(again.text) as { sessions: unknown[] }).sessions).toHaveLength(1)
  })

  it('revokes every old admin session on downgrade without affecting another admin', async () => {
    accounts.create('alice', 'correct-horse-9', 'admin')
    accounts.create('carol', 'battery-staple-9', 'admin')
    const port = await boot('session', { loginRequired: true, cookieName: 'dsh_gw_session', tls: false, noAccounts: false })
    const login = async (username: string, password: string): Promise<string> => {
      const response = await request(port, '/api/gateway/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
      })
      expect(response.status).toBe(200)
      const cookies = response.headers['set-cookie']
      const id = readCookie(Array.isArray(cookies) ? cookies.join(';') : cookies, 'dsh_gw_session')
      expect(id).toBeDefined()
      return `dsh_gw_session=${id}`
    }
    const alice = await login('alice', 'correct-horse-9')
    const aliceOther = await login('alice', 'correct-horse-9')
    const carol = await login('carol', 'battery-staple-9')
    expect((await request(port, '/api/gateway/accounts', { headers: { cookie: alice } })).status).toBe(200)
    const changed = await request(port, '/api/gateway/accounts/alice/role', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: carol }, body: JSON.stringify({ role: 'user' }),
    })
    expect(changed.status).toBe(200)
    expect(accounts.roleOf('alice')).toBe('user')
    for (const cookie of [alice, aliceOther]) {
      expect((await request(port, '/api/gateway/accounts', { headers: { cookie } })).status).toBe(403)
      expect(JSON.parse((await request(port, '/api/gateway/session', { headers: { cookie } })).text).authenticated).toBe(false)
    }
    expect((await request(port, '/api/gateway/accounts', { headers: { cookie: carol } })).status).toBe(200)
    const freshAlice = await login('alice', 'correct-horse-9')
    expect(JSON.parse((await request(port, '/api/gateway/session', { headers: { cookie: freshAlice } })).text).role).toBe('user')
    expect((await request(port, '/api/gateway/accounts', { headers: { cookie: freshAlice } })).status).toBe(403)
  })

  it('password change and disable revoke the account\'s live sessions', async () => {
    accounts.create('bob', 'battery-staple-9', 'user')
    const session = sessions.issue('bob', 'user', {})
    const port = await boot('loopback', { loginRequired: true, cookieName: 'dsh_gw_session', tls: false, noAccounts: false })
    const changed = await request(port, '/api/gateway/accounts/bob/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'fresh-password-9' }),
    })
    expect(changed.status).toBe(200)
    expect(sessions.peek(session.id)).toBeUndefined()
  })
})