/**
 * SessionStore semantics (T-004..T-006):
 * - issue/get/touch with idle expiry and the absolute maxAge cap;
 * - revocation (one session, one account's sessions, all sessions);
 * - persistence: sessions survive a reopen, a corrupt file drops them;
 * - cookie helpers: HttpOnly/SameSite/Path, Secure only under TLS, clear.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore, sanitizeUserAgent, type SessionConfig, type SessionDeps } from '../src/host/services/remote-web-ui/server-mode/sessions.ts'
import { makeClearCookie, makeSetCookie, readCookie } from '../src/host/services/remote-web-ui/server-mode/cookie.ts'

const DAY = 24 * 60 * 60 * 1000

let dir = ''
let now = 0
let idCounter = 0

function makeDeps(): SessionDeps {
  return {
    now: () => now,
    randomId: () => `sess-${String(++idCounter).padStart(8, '0')}`,
  }
}

function makeStore(config: SessionConfig = {}): SessionStore {
  return new SessionStore(join(dir, 'sessions.json'), makeDeps(), { idleExpireMs: 2 * DAY, maxAgeMs: 30 * DAY, ...config })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rwui-sessions-'))
  now = 2_000_000_000
  idCounter = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('T-004 session lifecycle', () => {
  it('issues a session with a fresh id and returns it on touch', () => {
    const store = makeStore()
    const first = store.issue('alice', 'admin', { userAgent: 'TestAgent/1', ip: '192.168.1.5' })
    expect(first.id).toMatch(/^sess-/)
    expect(first.username).toBe('alice')
    expect(first.role).toBe('admin')
    expect(first.userAgent).toBe('TestAgent/1')
    const touched = store.touch(first.id)
    expect(touched?.id).toBe(first.id)
    expect(touched?.lastSeenAt).toBe(now)
  })

  it('expires a session after the idle window with no activity', () => {
    const store = makeStore()
    const session = store.issue('alice', 'admin')
    now += 2 * DAY + 1
    expect(store.touch(session.id)).toBeUndefined()
    expect(store.peek(session.id)).toBeUndefined()
  })

  it('caps a session at the absolute maxAge even with activity', () => {
    const store = makeStore()
    const session = store.issue('alice', 'admin')
    // Daily activity keeps the idle window satisfied for 30 days...
    for (let day = 1; day <= 30; day += 1) {
      now += DAY
      expect(store.touch(session.id), `touch on day ${day}`).toBeDefined()
    }
    // ...but the absolute 30-day cap still ends it.
    now += DAY + 1
    expect(store.touch(session.id)).toBeUndefined()
  })

  it('revokes a single session, one account\'s sessions, and everything', () => {
    const store = makeStore()
    const a = store.issue('alice', 'admin')
    const b1 = store.issue('bob', 'user')
    const b2 = store.issue('bob', 'user')
    expect(store.revoke(a.id)).toBe(true)
    expect(store.touch(a.id)).toBeUndefined()
    expect(store.revokeAllFor('bob')).toBe(2)
    expect(store.list()).toHaveLength(0)
    const c = store.issue('carol', 'admin')
    void c
    expect(store.revokeAll()).toBe(1)
    expect(store.list()).toHaveLength(0)
  })

  it('sweep removes expired sessions and the list never shows them', () => {
    const store = makeStore()
    const fresh = store.issue('alice', 'admin')
    const stale = store.issue('bob', 'user')
    // One day passes; the fresh session is used, the stale one is not.
    now += DAY
    expect(store.touch(fresh.id)).toBeDefined()
    // Idle window (2 days) elapses: stale dies, fresh still within the window.
    now += DAY + 1
    store.sweep()
    expect(store.peek(fresh.id)).toBeDefined()
    expect(store.peek(stale.id)).toBeUndefined()
  })

  it('sanitizes and caps stored user agents', () => {
    expect(sanitizeUserAgent(undefined)).toBeUndefined()
    expect(sanitizeUserAgent('  Firefox/1  \u0000x ')).toBe('Firefox/1 x')
    const long = 'A'.repeat(500)
    expect(sanitizeUserAgent(long)?.length).toBe(180)
  })
})

describe('T-005 persistence', () => {
  it('persists sessions across a store reopen', () => {
    const first = makeStore()
    const session = first.issue('alice', 'admin', { ip: '10.0.0.2' })
    const second = makeStore()
    const touched = second.touch(session.id)
    expect(touched?.username).toBe('alice')
    expect(touched?.role).toBe('admin')
    expect(touched?.ip).toBe('10.0.0.2')
    expect(second.revokeAll()).toBe(1)
  })

  it('writes the session file 0600 and a corrupt file loads empty (never throws)', () => {
    const store = makeStore()
    store.issue('alice', 'admin')
    const path = join(dir, 'sessions.json')
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('alice-secret')
    writeFileSync(path, '{broken', { mode: 0o600 })
    const reopened = makeStore()
    expect(reopened.list()).toHaveLength(0)
  })
})

describe('T-006 cookie helpers', () => {
  it('builds an HttpOnly SameSite=Lax session cookie, Secure only when requested', () => {
    const plain = makeSetCookie('dsh_gw_session', 'abc', {})
    expect(plain).toContain('dsh_gw_session=abc')
    expect(plain).toContain('Path=/')
    expect(plain).toContain('HttpOnly')
    expect(plain).toContain('SameSite=Lax')
    expect(plain).not.toContain('Secure')
    const secure = makeSetCookie('dsh_gw_session', 'abc', { secure: true })
    expect(secure).toContain('Secure')
    expect(makeSetCookie('n', 'v', { maxAgeSeconds: 60 })).toContain('Max-Age=60')
  })

  it('builds a clearing cookie with Max-Age=0', () => {
    const clear = makeClearCookie('dsh_gw_session', { secure: true })
    expect(clear).toContain('dsh_gw_session=')
    expect(clear).toContain('Max-Age=0')
    expect(clear).toContain('Secure')
  })

  it('parses cookie headers case-insensitively and safely', () => {
    expect(readCookie('a=1; dsh_gw_session = s3ss ; b=2', 'dsh_gw_session')).toBe('s3ss')
    expect(readCookie('a=1', 'dsh_gw_session')).toBeUndefined()
    expect(readCookie(undefined, 'dsh_gw_session')).toBeUndefined()
    expect(readCookie('dsh_gw_session=', 'dsh_gw_session')).toBe('')
  })
})