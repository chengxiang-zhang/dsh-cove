import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountStore, randomSalt } from '../src/host/services/remote-web-ui/server-mode/accounts.ts'
import { SessionStore, randomSessionId } from '../src/host/services/remote-web-ui/server-mode/sessions.ts'
import { gatewaySameOrigin } from '../src/host/services/remote-web-ui/server-mode/gateway.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!realpathSync(root).startsWith(`${realpathSync(tmpdir())}/auth-fixes-`)) throw new Error('unexpected cleanup target')
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'auth-fixes-')))
  roots.push(root)
  const accountFile = join(root, 'accounts.json')
  const sessionFile = join(root, 'sessions.json')
  const accounts = new AccountStore(accountFile, { now: Date.now, randomSalt })
  accounts.create('owner', 'fixture-password-123', 'admin')
  accounts.create('target', 'fixture-password-123', 'admin')
  const sessions = new SessionStore(sessionFile, { now: Date.now, randomId: randomSessionId })
  sessions.bindAccounts(accounts)
  const session = sessions.issue('target', 'admin')
  const reload = () => {
    const a = new AccountStore(accountFile, { now: Date.now, randomSalt })
    const s = new SessionStore(sessionFile, { now: Date.now, randomId: randomSessionId })
    s.bindAccounts(a)
    return { accounts: a, sessions: s }
  }
  return { root, accounts, sessions, session, accountFile, sessionFile, reload }
}

describe('live session authorization and durable invalidation', () => {
  it.each(['role', 'password', 'enabled', 'remove'] as const)('invalidates sessions on direct account %s, not only HTTP revoke callbacks', kind => {
    const f = fixture()
    if (kind === 'role') f.accounts.setRole('target', 'user')
    if (kind === 'password') f.accounts.setPassword('target', 'replacement-password')
    if (kind === 'enabled') f.accounts.setEnabled('target', false)
    if (kind === 'remove') f.accounts.remove('target')
    expect(f.sessions.peek(f.session.id)).toBeUndefined()
    expect(f.reload().sessions.peek(f.session.id)).toBeUndefined()
  })

  it('a failed account commit blocks authorization and password login across restart', () => {
    const f = fixture()
    mkdirSync(`${f.accountFile}.tmp-${process.pid}`)
    expect(() => f.accounts.setRole('target', 'user')).toThrow()
    expect(f.sessions.peek(f.session.id)).toBeUndefined()
    const reloaded = f.reload()
    expect(reloaded.accounts.verify('target', 'fixture-password-123')).toBe(false)
    expect(reloaded.sessions.peek(f.session.id)).toBeUndefined()
  })

  it('a failed generation journal cannot authorize through a stale disk image', () => {
    const f = fixture()
    mkdirSync(`${f.accountFile}.auth.tmp-${process.pid}`)
    expect(() => f.accounts.setPassword('target', 'replacement-password')).toThrow()
    expect(f.sessions.peek(f.session.id)).toBeUndefined()
    const reloaded = f.reload()
    expect(reloaded.accounts.authorization('target')).toBeUndefined()
    expect(reloaded.sessions.peek(f.session.id)).toBeUndefined()
  })

  it('revocation remains durable when the session snapshot cannot be rewritten', () => {
    const f = fixture()
    mkdirSync(`${f.sessionFile}.tmp-${process.pid}`)
    expect(() => f.sessions.revoke(f.session.id)).toThrow()
    const unbound = new SessionStore(f.sessionFile, { now: Date.now, randomId: randomSessionId })
    expect(unbound.peek(f.session.id)).toBeUndefined()
    expect(f.reload().sessions.peek(f.session.id)).toBeUndefined()
  })

  it('a failed revocation journal leaves a durable deny marker', () => {
    const f = fixture()
    mkdirSync(`${f.sessionFile}.revoked.tmp-${process.pid}`)
    expect(() => f.sessions.revokeAll()).toThrow()
    expect(f.sessions.peek(f.session.id)).toBeUndefined()
    expect(f.reload().sessions.peek(f.session.id)).toBeUndefined()
  })

  it('deleting and recreating a username does not revive its old sessions', () => {
    const f = fixture()
    f.accounts.remove('target')
    f.accounts.create('target', 'fixture-password-123', 'admin')
    expect(f.sessions.peek(f.session.id)).toBeUndefined()
    expect(f.reload().sessions.peek(f.session.id)).toBeUndefined()
    expect(f.sessions.issue('target', 'admin').id).not.toBe(f.session.id)
  })

  it('corrupt authorization journals fail closed rather than resetting generations', () => {
    const f = fixture()
    writeFileSync(`${f.accountFile}.auth`, '{broken')
    expect(f.reload().sessions.peek(f.session.id)).toBeUndefined()
  })
})

describe('legacy gateway browser origin', () => {
  const req = (headers: Record<string, string>) => ({ headers } as IncomingMessage)
  it('matches the real scheme and authority and ignores forwarded claims', () => {
    expect(gatewaySameOrigin(req({ host: 'localhost:1234', origin: 'http://localhost:1234' }), false)).toBe(true)
    expect(gatewaySameOrigin(req({ host: 'localhost:1234', origin: 'https://localhost:1234' }), false)).toBe(false)
    expect(gatewaySameOrigin(req({ host: 'localhost:1234', origin: 'https://evil.invalid', 'x-forwarded-host': 'evil.invalid', 'x-forwarded-proto': 'https' }), false)).toBe(false)
    expect(gatewaySameOrigin(req({ host: 'localhost', 'sec-fetch-site': 'cross-site' }), false)).toBe(false)
    expect(gatewaySameOrigin(req({ host: 'localhost', origin: 'null' }), false)).toBe(false)
  })
})
