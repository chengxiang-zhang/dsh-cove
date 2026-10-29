import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
const network = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('node:net', async original => ({ ...await original<typeof import('node:net')>(), connect: network.connect }))
import { AccountStore, randomSalt } from '../src/host/services/remote-web-ui/server-mode/accounts.ts'
import { SessionStore, randomSessionId } from '../src/host/services/remote-web-ui/server-mode/sessions.ts'
import { Gateway } from '../src/host/services/remote-web-ui/server-mode/gateway.ts'
const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    if (!realpathSync(root).startsWith(`${realpathSync(tmpdir())}/auth-journal-fixes-`)) throw new Error('unexpected cleanup target')
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'auth-journal-fixes-')))
  roots.push(root)
  const accountFile = join(root, 'accounts.json')
  const sessionFile = join(root, 'sessions.json')
  let now = 10_000
  const accounts = new AccountStore(accountFile, { now: () => now, randomSalt })
  accounts.create('owner', 'fixture-password-123', 'admin')
  accounts.create('target', 'fixture-password-123', 'admin')
  const sessions = new SessionStore(sessionFile, { now: () => now, randomId: randomSessionId })
  sessions.bindAccounts(accounts)
  const session = sessions.issue('target', 'admin')
  return { root, accountFile, sessionFile, accounts, sessions, session, clock: (next: number) => { now = next },
    reload() {
      const a = new AccountStore(accountFile, { now: () => now, randomSalt })
      const s = new SessionStore(sessionFile, { now: () => now, randomId: randomSessionId })
      s.bindAccounts(a)
      return { accounts: a, sessions: s }
    },
  }
}
class MemorySocket extends Duplex {
  output: Buffer[] = []
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { this.output.push(Buffer.from(chunk)); callback() }
}
async function upgraded(f: ReturnType<typeof fixture>) {
  const client = new MemorySocket()
  const upstream = new MemorySocket()
  network.connect.mockReturnValue(upstream)
  const gateway = new Gateway({ host: '127.0.0.1', port: 0, upstreamPort: 54321, cookieName: 'fixture', routes: async () => {} }, f.sessions)
  const request = new EventEmitter() as IncomingMessage
  Object.assign(request, { url: '/terminal', headers: { host: 'localhost', cookie: `fixture=${f.session.id}` }, socket: { remoteAddress: '127.0.0.1' } })
  ;(gateway as unknown as { onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void }).onUpgrade(request, client, Buffer.alloc(0))
  upstream.emit('connect')
  return { client, upstream, gateway }
}
describe('atomic account authority image', () => {
  it('commits account revision in the same image and preserves authorized sessions on ordinary reload', () => {
    const f = fixture()
    const image = JSON.parse(readFileSync(f.accountFile, 'utf8'))
    expect(image.version).toBe(2)
    expect(image.accounts.every((row: { authVersion: string }) => /^[a-f0-9]{64}$/.test(row.authVersion))).toBe(true)
    expect(f.reload().sessions.peek(f.session.id)).toBeDefined()
    f.accounts.setPassword('target', 'replacement-password')
    unlinkSync(`${f.accountFile}.auth`)
    expect(f.reload().sessions.peek(f.session.id)).toBeUndefined()
  })
  it('strictly migrates valid v1 accounts before allowing login, invalidating versionless cookies', () => {
    const f = fixture()
    const image = JSON.parse(readFileSync(f.accountFile, 'utf8'))
    image.version = 1
    for (const row of image.accounts) delete row.authVersion
    writeFileSync(f.accountFile, JSON.stringify(image))
    const reloaded = f.reload()
    expect(reloaded.accounts.verify('target', 'fixture-password-123')).toBe(true)
    expect(reloaded.sessions.peek(f.session.id)).toBeUndefined()
    expect(JSON.parse(readFileSync(f.accountFile, 'utf8')).version).toBe(2)
  })
  it.each(['{broken', '{"version":999,"accounts":[]}', '{"version":2,"accounts":{}}'])('refuses bootstrap and writes against invalid account image %s', image => {
    const f = fixture()
    writeFileSync(f.accountFile, image)
    const reloaded = f.reload()
    expect(reloaded.accounts.canBootstrap()).toBe(false)
    expect(() => reloaded.accounts.create('replacement', 'replacement-password', 'admin')).toThrow(/recovery/)
    expect(readFileSync(f.accountFile, 'utf8')).toBe(image)
  })
  it('does not bootstrap a missing account image when an authorization sidecar proves prior initialization', () => {
    const f = fixture()
    f.accounts.setPassword('target', 'replacement-password')
    unlinkSync(f.accountFile)
    const reloaded = f.reload()
    expect(reloaded.accounts.canBootstrap()).toBe(false)
    expect(() => reloaded.accounts.create('replacement', 'replacement-password', 'admin')).toThrow(/recovery/)
  })
  it('rejects missing v2 versions and invalid roles without silently elevating', () => {
    const f = fixture()
    const image = JSON.parse(readFileSync(f.accountFile, 'utf8'))
    image.accounts.find((row: { username: string }) => row.username === 'target').authVersion = ''
    writeFileSync(f.accountFile, JSON.stringify(image))
    expect(f.reload().sessions.peek(f.session.id)).toBeUndefined()
  })
})
describe('silent upgrade revocation and lifecycle', () => {
  it.each(['revoke', 'role', 'password', 'disable', 'remove'] as const)('actively closes both silent sockets on %s', async kind => {
    const f = fixture()
    const { client, upstream, gateway } = await upgraded(f)
    if (kind === 'revoke') f.sessions.revoke(f.session.id)
    if (kind === 'role') f.accounts.setRole('target', 'user')
    if (kind === 'password') f.accounts.setPassword('target', 'replacement-password')
    if (kind === 'disable') f.accounts.setEnabled('target', false)
    if (kind === 'remove') f.accounts.remove('target')
    expect(client.destroyed).toBe(true)
    expect(upstream.destroyed).toBe(true)
    await gateway.close()
  })
  it('cleans active upgraded sockets even when no listener was started', async () => {
    const f = fixture()
    const { client, upstream, gateway } = await upgraded(f)
    await gateway.close()
    expect(client.destroyed).toBe(true)
    expect(upstream.destroyed).toBe(true)
  })
  it('expires fully silent sockets without waiting for another client byte', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const { client, upstream, gateway } = await upgraded(f)
    f.clock(10_000 + 31 * 24 * 60 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.destroyed).toBe(true)
    expect(upstream.destroyed).toBe(true)
    await gateway.close()
  })
  it('isolates throwing authorization observers from remaining socket cleanup', async () => {
    const f = fixture()
    f.sessions.subscribe(() => { throw new Error('broken observer') })
    const { client, gateway } = await upgraded(f)
    f.sessions.revoke(f.session.id)
    expect(client.destroyed).toBe(true)
    await gateway.close()
  })
})

describe('finite session lifetimes', () => {
  it.each([NaN, Infinity, -1, 0])('normalizes invalid idle TTL %s to a safe default', ttl => {
    const f = fixture()
    f.clock(10_000 + 8 * 24 * 60 * 60 * 1000)
    const reloaded = new SessionStore(f.sessionFile, { now: () => 10_000 + 8 * 24 * 60 * 60 * 1000, randomId: randomSessionId }, { idleExpireMs: ttl })
    reloaded.bindAccounts(f.accounts)
    expect(reloaded.peek(f.session.id)).toBeUndefined()
  })
})

describe('failed storage operations are not committed mutations', () => {
  it('preserves committed account state while denying this process after failed writes', () => {
    const f = fixture()
    const committed = readFileSync(f.accountFile, 'utf8')
    chmodSync(f.root, 0o500)
    try { expect(() => f.accounts.setPassword('target', 'replacement-password')).toThrow() }
    finally { chmodSync(f.root, 0o700) }
    expect(readFileSync(f.accountFile, 'utf8')).toBe(committed)
    expect(f.sessions.peek(f.session.id)).toBeUndefined()
    // No persistent intent can be promised when every write is refused.
    // Reloading a completely unchanged image is not a successful revocation.
    expect(f.reload().sessions.peek(f.session.id)).toBeDefined()
  })
})
