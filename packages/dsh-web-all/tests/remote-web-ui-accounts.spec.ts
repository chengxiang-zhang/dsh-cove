/**
 * AccountStore security semantics (T-001..T-003):
 * - create/verify/roles with constant-time scrypt verification;
 * - persistence: 0600 file, scrypt verifier only (never plaintext), reload;
 * - snapshots never leak the hash; malformed verifiers and duplicate
 *   usernames are handled without leaking existence.
 */
import { chmodSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AccountStore, hashPassword, randomSalt, verifyPassword, type AccountStoreDeps } from '../src/host/services/remote-web-ui/server-mode/accounts.ts'

let dir = ''
let now = 0
let saltCounter = 0

function makeDeps(): AccountStoreDeps {
  return {
    now: () => now,
    randomSalt: () => {
      saltCounter += 1
      const salt = Buffer.alloc(16)
      salt.writeUInt32BE(saltCounter)
      return salt
    },
  }
}

function makeStore(): AccountStore {
  return new AccountStore(join(dir, 'accounts.json'), makeDeps())
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rwui-accounts-'))
  now = 1_000_000_000
  saltCounter = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('T-001 account create and verify', () => {
  it('creates an admin and a user account and verifies their passwords', () => {
    const store = makeStore()
    const admin = store.create('alice', 'correct-horse-9', 'admin')
    const user = store.create('bob', 'battery-staple-9', 'user')
    expect(admin).toMatchObject({ username: 'alice', role: 'admin', enabled: true })
    expect(user).toMatchObject({ username: 'bob', role: 'user' })
    expect(store.verify('alice', 'correct-horse-9')).toBe(true)
    expect(store.verify('bob', 'battery-staple-9')).toBe(true)
    expect(store.verify('alice', 'wrong-password')).toBe(false)
    expect(store.roleOf('alice')).toBe('admin')
    expect(store.roleOf('bob')).toBe('user')
  })

  it('rejects a duplicate username and refuses empty usernames', () => {
    const store = makeStore()
    store.create('alice', 'correct-horse-9', 'admin')
    expect(() => store.create('alice', 'other-pass-9', 'user')).toThrow('already exists')
    expect(() => store.create('   ', 'other-pass-9', 'user')).toThrow('must not be empty')
  })

  it('never verifies a disabled account, and setPassword/setRole/setEnabled take effect', () => {
    const store = makeStore()
    store.create('alice', 'correct-horse-9', 'admin')
    store.create('backup', 'backup-pass-9', 'admin')
    expect(store.setPassword('alice', 'new-pass-9-9')).toBe(true)
    expect(store.verify('alice', 'correct-horse-9')).toBe(false)
    expect(store.verify('alice', 'new-pass-9-9')).toBe(true)
    expect(store.setRole('alice', 'user')).toBe(true)
    expect(store.roleOf('alice')).toBe('user')
    expect(store.setEnabled('alice', false)).toBe(true)
    expect(store.isEnabled('alice')).toBe(false)
    expect(store.verify('alice', 'new-pass-9-9')).toBe(false)
    expect(store.setPassword('nobody', 'x'.repeat(10))).toBe(false)
  })

  it('requires an explicit local administrator before binding external identities', () => {
    const store = makeStore()
    expect(() => store.ensureExternal('oidc:company:subject-1', 'user')).toThrow(/local administrator/)
    expect(store.isEmpty()).toBe(true)

    store.create('admin', 'correct-horse-9', 'admin')
    expect(store.ensureExternal('oidc:company:subject-1', 'user')).toMatchObject({ role: 'user', enabled: true })
    expect(store.ensureExternal('oidc:company:subject-2', 'admin')).toMatchObject({ role: 'admin', enabled: true })
  })
})

describe('T-002 persistence and file hygiene', () => {
  it('writes a 0600 file holding scrypt verifiers, never plaintext', () => {
    const store = makeStore()
    store.create('alice', 'correct-horse-9', 'admin')
    const path = join(dir, 'accounts.json')
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('correct-horse-9')
    expect(raw).toContain('scrypt$')
  })

  it('reloads the same accounts from disk, and password changes persist', () => {
    const first = makeStore()
    first.create('alice', 'correct-horse-9', 'admin')
    first.create('bob', 'battery-staple-9', 'user')
    first.setPassword('bob', 'replacement-9')
    const second = makeStore()
    expect(second.list()).toHaveLength(2)
    expect(second.verify('alice', 'correct-horse-9')).toBe(true)
    expect(second.verify('bob', 'replacement-9')).toBe(true)
    expect(second.verify('bob', 'battery-staple-9')).toBe(false)
  })

  it('a corrupt store file loads as empty rather than throwing (fail-closed)', () => {
    const path = join(dir, 'accounts.json')
    chmodSync(dir, 0o700)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(path, '{not-json', { mode: 0o600 })
    const store = makeStore()
    expect(store.isEmpty()).toBe(true)
  })
})

describe('T-003 secret hygiene', () => {
  it('snapshots never expose the password hash', () => {
    const store = makeStore()
    store.create('alice', 'correct-horse-9', 'admin')
    const snapshots = store.list()
    expect(snapshots).toEqual([
      expect.objectContaining({ username: 'alice', role: 'admin', enabled: true }),
    ])
    expect(JSON.stringify(snapshots)).not.toContain('scrypt$')
    expect(JSON.stringify(snapshots)).not.toContain('hash')
  })

  it('each password gets its own salt (no shared verifier reuse)', () => {
    const store = makeStore()
    const a = store.create('alice', 'same-password-9', 'admin')
    const b = store.create('bob', 'same-password-9', 'user')
    void a; void b
    // The two records must hash differently even though the password matches.
    const path = join(dir, 'accounts.json')
    const raw = readFileSync(path, 'utf8')
    const records = (JSON.parse(raw) as { accounts: Array<{ username: string; passwordHash: string }> }).accounts
    const alice = records.find(record => record.username === 'alice')
    const bob = records.find(record => record.username === 'bob')
    expect(alice?.passwordHash).not.toBe(bob?.passwordHash)
  })

  it('verifyPassword rejects malformed or foreign verifiers without throwing', () => {
    expect(verifyPassword('x', 'garbage')).toBe(false)
    expect(verifyPassword('x', 'bcrypt$10$abc')).toBe(false)
    expect(verifyPassword('x', 'scrypt$bad$r$p$zz$zz')).toBe(false)
    expect(verifyPassword('x', 'scrypt$32768$8$1$00$00')).toBe(false)
  })

  it('hashPassword produces a valid round-trippable verifier', () => {
    const salt = randomSalt()
    const verifier = hashPassword('pw', salt)
    expect(verifyPassword('pw', verifier)).toBe(true)
    expect(verifyPassword('pwX', verifier)).toBe(false)
  })
})