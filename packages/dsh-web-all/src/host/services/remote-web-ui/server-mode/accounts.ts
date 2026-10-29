/**
 * Account store for the server-mode gateway: username, scrypt password hash,
 * role, and enabled flag, persisted to a 0600 JSON file with atomic writes.
 *
 * Security invariants:
 * - Passwords are never stored in plaintext; only the scrypt verifier string
 *   (`scrypt$N$r$p$saltHex$hashHex`) is persisted.
 * - Verification uses `timingSafeEqual` over the derived key.
 * - The store file is created 0600 (owner read/write only) and rewritten via
 *   a temp file + rename so a crash cannot leave a half-written store.
 * - No record exposes the password hash through the snapshot surface.
 */

import {
  randomBytes as nodeRandomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** Role set of the server-mode gateway (decided: admin + user). */
export type AccountRole = 'admin' | 'user'

/** One persisted account record. */
export interface AccountRecord {
  username: string
  /** scrypt verifier string; never surfaced by snapshots. */
  passwordHash: string
  role: AccountRole
  enabled: boolean
  /** Account creation time (ms epoch). */
  createdAt: number
  authVersion: string
}

/** Redacted account row safe for the admin surface (no hash, no secrets). */
export interface AccountSnapshot {
  username: string
  role: AccountRole
  enabled: boolean
  createdAt: number
}

/** Stable conflict codes for account-domain invariants. */
export type AccountConflictCode = 'username-exists' | 'last-enabled-admin' | 'external-bootstrap-forbidden'

/** Typed mutation conflict surfaced as HTTP 409 by the gateway routes. */
export class AccountConflictError extends Error {
  constructor(readonly code: AccountConflictCode, message: string) {
    super(message)
    this.name = 'AccountConflictError'
  }
}

/** Clock/randomness seams so the whole security semantics are unit-testable. */
export interface AccountStoreDeps {
  now: () => number
  /** 16-byte random salt per password set. */
  randomSalt: () => Buffer
}

/**
 * scrypt parameters: 16 MiB memory (128*N*r), node's default cost class.
 * N=16384 stays well under the OpenSSL default maxmem (32 MiB) and keeps a
 * single verification fast enough for a login endpoint while still making
 * offline brute force ~1s-class per guess.
 */
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64, maxmem: 32 * 1024 * 1024 } as const

const STORE_VERSION = 2

/** Persisted file shape (versioned for forward migration). */
interface StoreFile {
  version: number
  accounts: AccountRecord[]
}

/** Hash a password into the persisted verifier string. */
export function hashPassword(password: string, salt: Buffer): string {
  const derived = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  })
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${derived.toString('hex')}`
}

/** Constant-time password verification against a stored verifier string. */
export function verifyPassword(password: string, verifier: string): boolean {
  const parts = verifier.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], 'hex')
    expected = Buffer.from(parts[5], 'hex')
  } catch {
    return false
  }
  // A hostile or malformed verifier (wrong params, absurd memory) must read
  // as a failed verification, never as a crash in the login path.
  let derived: Buffer
  try {
    derived = scryptSync(password, salt, SCRYPT.keylen, { N: n, r, p, maxmem: SCRYPT.maxmem })
  } catch {
    return false
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/**
 * The account store. Loads the file at construction and persists every
 * mutation through an atomic 0600 write.
 */
export class AccountStore {
  private readonly accounts = new Map<string, AccountRecord>()
  private readonly file: string
  private readonly deps: AccountStoreDeps
  private readonly generations = new Map<string, string>()
  private healthy = true
  private pristine = false
  private readonly listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(): void {
    for (const listener of [...this.listeners]) { try { listener() } catch { /* isolate observers */ } }
  }

  private requireHealthy(): void {
    if (!this.healthy) throw new Error('account store requires operator recovery')
  }

  canBootstrap(): boolean { return this.healthy && this.pristine && this.accounts.size === 0 }

  /** Live authorization identity, independent of a persisted session's role snapshot. */
  authorization(username: string): { role: AccountRole; version: string } | undefined {
    const account = this.accounts.get(username)
    if (!this.healthy || account?.enabled !== true) return undefined
    if (this.generations.has(username) && this.generations.get(username) !== account.authVersion) return undefined
    return /^[a-f0-9]{64}$/.test(account.authVersion) ? { role: account.role, version: account.authVersion } : undefined
  }

  private invalidate(username: string): void {
    this.requireHealthy()
    this.generations.set(username, nodeRandomBytes(32).toString('hex'))
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.auth.tmp-${process.pid}`
      writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.generations)), { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, `${this.file}.auth`)
    } catch (error) {
      this.healthy = false
      this.changed()
      // A separate durable deny marker prevents an older account/session image
      // being trusted after restart when the generation journal cannot commit.
      writeFileSync(`${this.file}.blocked`, 'authorization persistence failed', { mode: 0o600 })
      throw error
    }
  }

  constructor(file: string, deps: AccountStoreDeps) {
    this.file = file
    this.deps = deps
    this.healthy = !existsSync(`${file}.blocked`)
    try {
      if (existsSync(`${file}.auth`)) {
        const versions: unknown = JSON.parse(readFileSync(`${file}.auth`, 'utf8'))
        if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) throw new Error('invalid authorization journal')
        for (const [name, version] of Object.entries(versions)) {
          if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)) throw new Error('invalid authorization generation')
          this.generations.set(name, version)
        }
      }
    } catch { this.healthy = false }
    this.load()
  }

  /** Read the persisted file, if any, into memory. */
  private load(): void {
    if (!existsSync(this.file)) {
      this.pristine = this.healthy && !existsSync(`${this.file}.auth`)
      if (!this.pristine) this.healthy = false
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoreFile
      if ((parsed.version !== 1 && parsed.version !== STORE_VERSION) || !Array.isArray(parsed.accounts)) throw new Error('unsupported account image')
      const next = new Map<string, AccountRecord>()
      for (const row of parsed.accounts) {
        if (row === null || typeof row !== 'object' || typeof row.username !== 'string' || !row.username.trim()
          || next.has(row.username) || typeof row.passwordHash !== 'string' || !row.passwordHash
          || (row.role !== 'admin' && row.role !== 'user') || typeof row.enabled !== 'boolean'
          || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0
          || (parsed.version === STORE_VERSION && (typeof row.authVersion !== 'string' || !/^[a-f0-9]{64}$/.test(row.authVersion)))) throw new Error('invalid account image')
        next.set(row.username, { ...row, authVersion: parsed.version === 1 ? nodeRandomBytes(32).toString('hex') : row.authVersion })
      }
      if (!this.healthy) return
      if (parsed.version === 1) {
        // Commit the migration barrier before the v2 image. An interruption
        // between writes denies old credentials instead of resetting identity.
        this.generations.clear()
        for (const [name, row] of next) this.generations.set(name, row.authVersion)
        const temporary = `${this.file}.auth.tmp-${process.pid}`
        writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.generations)), { mode: 0o600 })
        chmodSync(temporary, 0o600)
        renameSync(temporary, `${this.file}.auth`)
        this.persist(next)
      }
      for (const [name, row] of next) this.accounts.set(name, row)
    } catch { this.healthy = false; this.accounts.clear() }
  }

  /** Atomic 0600 persistence of the current account set. */
  private persist(next: ReadonlyMap<string, AccountRecord> = this.accounts): void {
    const dir = dirname(this.file)
    mkdirSync(dir, { recursive: true })
    const payload = JSON.stringify({
      version: STORE_VERSION,
      accounts: [...next.values()],
    } satisfies StoreFile)
    const tmp = `${this.file}.tmp-${String(process.pid)}`
    try {
      writeFileSync(tmp, payload, { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.file)
      this.pristine = false
    } catch (error) {
      this.healthy = false
      this.changed()
      writeFileSync(`${this.file}.blocked`, 'account persistence failed; operator recovery required', { mode: 0o600 })
      throw error
    }
  }

  /** Whether the store has any account (gateway fails closed on empty). */
  isEmpty(): boolean {
    return this.accounts.size === 0
  }

  /** Whether this mutation would remove the store's final enabled admin. */
  private isLastEnabledAdmin(record: AccountRecord): boolean {
    if (record.role !== 'admin' || !record.enabled) return false
    for (const account of this.accounts.values()) {
      if (account !== record && account.role === 'admin' && account.enabled) return false
    }
    return true
  }

  /** Refuse a mutation that would leave no enabled administrator. */
  private requireAdminSurvivor(record: AccountRecord): void {
    if (this.isLastEnabledAdmin(record)) {
      throw new AccountConflictError('last-enabled-admin', 'at least one enabled admin account is required')
    }
  }

  /**
   * Create one account. Refuses an existing username. The first account is
   * always an administrator, regardless of the caller-supplied role.
   */
  create(username: string, password: string, role: AccountRole): AccountSnapshot {
    this.requireHealthy()
    const name = username.trim()
    if (role !== 'admin' && role !== 'user') throw new Error('invalid account role')
    if (name === '') throw new Error('account: username must not be empty')
    if (this.accounts.has(name)) throw new AccountConflictError('username-exists', 'account: username already exists')
    const record: AccountRecord = {
      username: name,
      passwordHash: hashPassword(password, this.deps.randomSalt()),
      role: this.accounts.size === 0 ? 'admin' : role,
      enabled: true,
      createdAt: this.deps.now(),
      authVersion: nodeRandomBytes(32).toString('hex'),
    }
    if (this.generations.has(name)) { this.invalidate(name); record.authVersion = this.generations.get(name)! }
    const next = new Map(this.accounts).set(name, record)
    this.persist(next)
    this.accounts.set(name, record)
    this.changed()
    return this.snapshotOf(record)
  }

  /** Verify a username/password pair. Never reveals whether the user exists. */
  verify(username: string, password: string): boolean {
    const record = this.accounts.get(username)
    if (!this.healthy || record === undefined || !record.enabled) return false
    return verifyPassword(password, record.passwordHash)
  }

  /** Look up the role of an existing account, or undefined. */
  roleOf(username: string): AccountRole | undefined {
    return this.accounts.get(username)?.role
  }

  /**
   * Create a passwordless external-identity binding. External login may not
   * bootstrap the store: an operator must create the first local administrator
   * explicitly, otherwise unrestricted provider JIT binding could claim it.
   */
  ensureExternal(username: string, role: AccountRole): AccountSnapshot {
    this.requireHealthy()
    if (!username.trim() || (role !== 'admin' && role !== 'user')) throw new Error('invalid external account')
    const existing = this.accounts.get(username)
    if (existing !== undefined) return this.snapshotOf(existing)
    if (this.accounts.size === 0) {
      throw new AccountConflictError('external-bootstrap-forbidden', 'create a local administrator before external sign-in')
    }
    const record: AccountRecord = {
      username,
      // A valid but unknowable verifier keeps the version-1 store compatible;
      // external accounts can authenticate only through their provider.
      passwordHash: hashPassword(nodeRandomBytes(32).toString('base64url'), this.deps.randomSalt()),
      role,
      enabled: true,
      createdAt: this.deps.now(),
      authVersion: nodeRandomBytes(32).toString('hex'),
    }
    if (this.generations.has(username)) { this.invalidate(username); record.authVersion = this.generations.get(username)! }
    const next = new Map(this.accounts).set(username, record)
    this.persist(next)
    this.accounts.set(username, record)
    this.changed()
    return this.snapshotOf(record)
  }

  /** Whether an account exists and is enabled. */
  isEnabled(username: string): boolean {
    return this.accounts.get(username)?.enabled === true
  }

  /** Replace a password (does not touch other fields). */
  setPassword(username: string, password: string): boolean {
    const record = this.accounts.get(username)
    if (record === undefined) return false
    this.invalidate(username)
    this.commitChange(username, { ...record, passwordHash: hashPassword(password, this.deps.randomSalt()) })
    return true
  }

  /** Change a role without allowing the last enabled admin to be demoted. */
  setRole(username: string, role: AccountRole): boolean {
    this.requireHealthy()
    if (role !== 'admin' && role !== 'user') throw new Error('invalid account role')
    const record = this.accounts.get(username)
    if (record === undefined) return false
    if (role === record.role) return true
    if (role !== 'admin') this.requireAdminSurvivor(record)
    this.invalidate(username)
    this.commitChange(username, { ...record, role })
    return true
  }

  /** Enable or disable an account (disabled accounts cannot log in). */
  setEnabled(username: string, enabled: boolean): boolean {
    this.requireHealthy()
    if (typeof enabled !== 'boolean') throw new Error('invalid enabled flag')
    const record = this.accounts.get(username)
    if (record === undefined) return false
    if (enabled === record.enabled) return true
    if (!enabled) this.requireAdminSurvivor(record)
    this.invalidate(username)
    this.commitChange(username, { ...record, enabled })
    return true
  }

  /** Remove an account without deleting the last enabled admin. */
  remove(username: string): boolean {
    const record = this.accounts.get(username)
    if (record === undefined) return false
    this.requireAdminSurvivor(record)
    this.invalidate(username)
    const next = new Map(this.accounts)
    next.delete(username)
    this.persist(next)
    this.accounts.delete(username)
    this.changed()
    return true
  }

  private commitChange(username: string, record: AccountRecord): void {
    record.authVersion = this.generations.get(username)!
    const next = new Map(this.accounts).set(username, record)
    this.persist(next)
    this.accounts.set(username, record)
    this.changed()
  }

  /** All accounts as redacted snapshots. */
  list(): AccountSnapshot[] {
    return [...this.accounts.values()].map((record) => this.snapshotOf(record)).sort((a, b) => a.username.localeCompare(b.username))
  }

  private snapshotOf(record: AccountRecord): AccountSnapshot {
    return {
      username: record.username,
      role: record.role,
      enabled: record.enabled,
      createdAt: record.createdAt,
    }
  }
}

/** A 16-byte cryptographically random salt (the live seam implementation). */
export function randomSalt(): Buffer {
  return nodeRandomBytes(16)
}
