import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('node:net', async original => ({ ...await original<typeof import('node:net')>(), connect: network.connect }))
import { AccountStore, randomSalt } from '../src/host/services/remote-web-ui/server-mode/accounts.ts'
import { SessionStore, randomSessionId } from '../src/host/services/remote-web-ui/server-mode/sessions.ts'
import { LoginLimiter, makeGatewayRequestHandler } from '../src/host/services/remote-web-ui/server-mode/gateway-routes.ts'
import { Gateway } from '../src/host/services/remote-web-ui/server-mode/gateway.ts'

// Real ephemeral stores and in-process handlers only: no listeners, network,
// real DSH home, real credentials, or production-source mutation.
const roots: string[] = []
const password = 'journal-fixture-only-123'
const cookieName = 'journal_fixture_session'
afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = realpathSync(root)
    if (!resolved.startsWith(`${realpathSync(tmpdir())}/auth-journal-adversarial-`)) throw new Error('unexpected cleanup path')
    chmodSync(resolved, 0o700)
    rmSync(resolved, { recursive: true, force: true })
  }
})
function stores() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'auth-journal-adversarial-')))
  roots.push(root)
  const accountFile = join(root, 'accounts.json')
  const sessionFile = join(root, 'sessions.json')
  let now = 10_000
  const deps = { now: () => now, randomSalt }
  const accounts = new AccountStore(accountFile, deps)
  accounts.create('owner', password, 'admin')
  accounts.create('target', password, 'user')
  const sessions = new SessionStore(sessionFile, { now: () => now, randomId: randomSessionId })
  sessions.bindAccounts(accounts)
  const session = sessions.issue('target', 'user')
  const reload = () => {
    const a = new AccountStore(accountFile, deps)
    const s = new SessionStore(sessionFile, { now: () => now, randomId: randomSessionId })
    s.bindAccounts(a)
    return { accounts: a, sessions: s }
  }
  return { root, accountFile, sessionFile, accounts, sessions, session, reload, clock: (next: number) => { now = next } }
}
async function invoke(accounts: AccountStore, sessions: SessionStore, path: string, cookie?: string, body?: unknown) {
  const handler = makeGatewayRequestHandler('session', {
    accounts, sessions, cookieName, secure: false, limiter: new LoginLimiter(),
    status: { loginRequired: true, cookieName, tls: false, noAccounts: accounts.isEmpty() },
  })
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, {
    url: path, method: body === undefined ? 'GET' : 'POST',
    headers: { host: 'localhost:3080', ...(cookie ? { cookie: `${cookieName}=${cookie}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  })
  let status = 0
  let text = ''
  const res = { writeHead: (code: number) => { status = code }, end: (chunk = '') => { text += chunk } } as unknown as ServerResponse
  await handler(req, res)
  return { status, body: text ? JSON.parse(text) : undefined }
}

class MemorySocket extends Duplex {
  readonly output: Buffer[] = []
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void { this.output.push(Buffer.from(chunk)); done() }
}

describe('second-round authorization journal adversarial boundaries', () => {
  it('revocation stops a silent client receiving a previously admitted privileged stream', async () => {
    const f = stores()
    const owner = f.sessions.issue('owner', 'admin')
    const upstream = new MemorySocket()
    const client = new MemorySocket()
    network.connect.mockReturnValue(upstream)
    const gateway = new Gateway({ host: 'unused-fixture', port: 0, upstreamPort: 1, cookieName, routes: async () => {} }, f.sessions)
    try {
      const req = { url: '/terminal', headers: { host: 'localhost:3080', cookie: `${cookieName}=${owner.id}` } } as IncomingMessage
      // Exercise the production upgrade handler without starting a listener or
      // connecting a real socket. Only node:net.connect is replaced by a duplex.
      ;(gateway as unknown as { onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void }).onUpgrade(req, client, Buffer.alloc(0))
      upstream.emit('connect')
      upstream.push('sensitive-before')
      await new Promise(resolve => setImmediate(resolve))
      expect(Buffer.concat(client.output).toString()).toBe('sensitive-before')
      f.sessions.revoke(owner.id)
      upstream.push('sensitive-after-revocation')
      await new Promise(resolve => setImmediate(resolve))
      expect(Buffer.concat(client.output).toString(), 'server-originated data must stop even if the revoked client sends no more bytes').toBe('sensitive-before')
    } finally {
      upstream.destroy()
      client.destroy()
      network.connect.mockReset()
    }
  })

  it.each(['missing', 'empty-object', 'empty-generation'] as const)('lost generation state (%s) cannot revive a password-invalidated cookie after restart', async kind => {
    const f = stores()
    f.accounts.setPassword('target', 'replacement-fixture-only-456')
    expect(f.sessions.peek(f.session.id)).toBeUndefined()
    if (kind === 'missing') unlinkSync(`${f.accountFile}.auth`)
    if (kind === 'empty-object') writeFileSync(`${f.accountFile}.auth`, '{}')
    if (kind === 'empty-generation') writeFileSync(`${f.accountFile}.auth`, JSON.stringify({ target: '' }))
    const reloaded = f.reload()
    const response = await invoke(reloaded.accounts, reloaded.sessions, '/api/gateway/session', f.session.id)
    expect(response.body.authenticated, 'a missing/corrupt generation must not reset to the legacy empty generation').toBe(false)
  })

  it.each(['{broken', '{"version":999,"accounts":[]}', '{"version":1,"accounts":{}}'])(
    'an existing invalid accounts image cannot be treated as a bootstrap-empty store: %s', async image => {
      const f = stores()
      writeFileSync(f.accountFile, image)
      const reloaded = f.reload()
      // Bootstrap is only legal for a genuinely absent, healthy image.
      expect(reloaded.accounts.canBootstrap()).toBe(false)
      expect(() => reloaded.accounts.create('bootstrap', password, 'admin')).toThrow(/recovery/)
      expect(readFileSync(f.accountFile, 'utf8')).toBe(image)
      const response = await invoke(reloaded.accounts, reloaded.sessions, '/api/gateway/login', undefined, { username: 'bootstrap', password })
      expect(response.status, 'corruption/unsupported schema must require recovery, not permit bootstrap replacement').toBe(401)
    },
  )

  it.each(['missing', 'invalid', 'null'] as const)('invalid persisted role (%s) never promotes a user to admin', async kind => {
    const f = stores()
    const image = JSON.parse(readFileSync(f.accountFile, 'utf8'))
    const row = image.accounts.find((account: { username: string }) => account.username === 'target')
    if (kind === 'missing') delete row.role
    if (kind === 'invalid') row.role = 'administrator'
    if (kind === 'null') row.role = null
    writeFileSync(f.accountFile, JSON.stringify(image))
    const reloaded = f.reload()
    const response = await invoke(reloaded.accounts, reloaded.sessions, '/api/gateway/accounts', f.session.id)
    expect(response.status, 'live authority must not upgrade a valid user cookie from malformed account data').toBe(403)
  })

  it('reports uncommitted revocation on an entirely unwritable medium without claiming durable denial', async () => {
    const f = stores()
    const committedImage = readFileSync(f.accountFile, 'utf8')
    chmodSync(f.root, 0o500)
    try {
      expect(() => f.accounts.setPassword('target', 'replacement-fixture-only-456')).toThrow()
      expect(f.accounts.authorization('target')).toBeUndefined()
      expect(existsSync(`${f.accountFile}.blocked`)).toBe(false)
    } finally { chmodSync(f.root, 0o700) }
    const reloaded = f.reload()
    const response = await invoke(reloaded.accounts, reloaded.sessions, '/api/gateway/session', f.session.id)
    expect(readFileSync(f.accountFile, 'utf8')).toBe(committedImage)
    // There is no persistent evidence when every write is denied. The operation
    // threw, was not acknowledged, and cannot revoke the last committed image.
    // Requiring denial here would require expiring every session at each boot.
    expect(response.body.authenticated).toBe(true)
  })

  it('overflow JSON expiry is not admitted indefinitely by peek', async () => {
    const f = stores()
    const image = readFileSync(f.sessionFile, 'utf8').replace(/"expiresAt":\d+/, '"expiresAt":1e400')
    writeFileSync(f.sessionFile, image)
    f.clock(10_000 + 31 * 24 * 60 * 60 * 1000)
    // Keep lastSeenAt fresh to isolate the absolute cap, not the idle cap.
    const parsed = JSON.parse(readFileSync(f.sessionFile, 'utf8'))
    const timestamp = 10_000 + 31 * 24 * 60 * 60 * 1000
    writeFileSync(f.sessionFile, image.replace(/"lastSeenAt":\d+/, `"lastSeenAt":${timestamp}`))
    expect(parsed.sessions[0].expiresAt).toBe(Infinity)
    expect(f.reload().sessions.peek(f.session.id), 'loaded sessions must obey finite absolute lifetime and original maxAge').toBeUndefined()
  })

  it('NaN idle configuration cannot disable the idle lifetime check', () => {
    const f = stores()
    const sessions = new SessionStore(f.sessionFile, { now: () => 10_000 + 8 * 24 * 60 * 60 * 1000, randomId: randomSessionId }, { idleExpireMs: Number.NaN })
    sessions.bindAccounts(f.accounts)
    expect(sessions.peek(f.session.id), 'invalid tuning must reject or fall back, never disable expiry comparisons').toBeUndefined()
  })

  it.each(['{broken', '[]', '{"target":42}'])('syntactically corrupt authorization journal still denies: %s', image => {
    const f = stores()
    writeFileSync(`${f.accountFile}.auth`, image)
    expect(f.reload().sessions.peek(f.session.id)).toBeUndefined()
  })

  it('existing durable blocked marker denies restart authorization', async () => {
    const f = stores()
    writeFileSync(`${f.accountFile}.blocked`, 'fixture failure')
    const reloaded = f.reload()
    expect((await invoke(reloaded.accounts, reloaded.sessions, '/api/gateway/session', f.session.id)).body.authenticated).toBe(false)
  })
})
