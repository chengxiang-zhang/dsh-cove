/**
 * Session store for the server-mode gateway: one session per authenticated
 * browser, keyed by a 256-bit random id carried in an HttpOnly cookie.
 *
 * Security invariants:
 * - Session ids are 256-bit random and never reused; a new id is issued on
 *   every login (fixation-safe).
 * - A session dies at the absolute `maxAgeMs` cap regardless of activity,
 *   and after `idleExpireMs` without any gated request or heartbeat.
 * - `revoke` cuts a session immediately: the next request carrying its id
 *   is refused; `revokeAllFor(username)` drops every session of one account
 *   (used on password change / disable / remove).
 * - The store persists to a 0600 file with atomic rename so authenticated
 *   browsers stay signed in across a `dsh web` restart.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AccountRole, AccountStore } from './accounts.ts'

/** One live session. */
export interface SessionRecord {
  /** Cookie value / session credential (256-bit random hex). */
  id: string
  username: string
  role: AccountRole
  authVersion?: string
  /** Sanitized User-Agent captured at login (optional). */
  userAgent?: string
  /** Client IP captured at login (optional; the first XFF hop when trusted). */
  ip?: string
  createdAt: number
  lastSeenAt: number
  /** Absolute expiry; the session dies at this instant no matter what. */
  expiresAt: number
}

/** Redacted session row for the admin surface (no id hashing needed; ids are already opaque). */
export interface SessionSnapshot {
  id: string
  username: string
  role: AccountRole
  userAgent?: string
  ip?: string
  createdAt: number
  lastSeenAt: number
  online: boolean
}

/** Clock/randomness seams. */
export interface SessionDeps {
  now: () => number
  /** 32-byte random hex session id. */
  randomId: () => string
}

/** Store tuning. */
export interface SessionConfig {
  /** A session with no gated request for this long is dead (default 7 days). */
  idleExpireMs?: number
  /** Absolute lifetime cap (default 30 days). */
  maxAgeMs?: number
}

export const DEFAULT_IDLE_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const STORE_VERSION = 1

/** Persisted file shape. */
interface StoreFile {
  version: number
  sessions: SessionRecord[]
}

/** Sanitize and cap a User-Agent string stored with a session. */
export function sanitizeUserAgent(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned === '') return undefined
  return cleaned.length <= 180 ? cleaned : cleaned.slice(0, 180)
}

/**
 * The session store. Loads at construction and persists every mutation.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly file: string
  private readonly deps: SessionDeps
  private readonly idleExpireMs: number
  private readonly maxAgeMs: number
  private accounts?: AccountStore
  private readonly revoked = new Set<string>()
  private healthy = true
  private readonly listeners = new Set<() => void>()
  private unsubscribeAccounts?: () => void

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(): void {
    for (const listener of [...this.listeners]) { try { listener() } catch { /* isolate observers */ } }
  }


  /** Bind the current account authority; unbound stores remain usable for standalone fixtures. */
  bindAccounts(accounts: AccountStore): void {
    if (this.accounts === accounts) return
    this.unsubscribeAccounts?.()
    this.accounts = accounts
    this.unsubscribeAccounts = accounts.subscribe(() => this.changed())
    this.changed()
  }

  private current(session: SessionRecord): SessionRecord | undefined {
    if (!this.healthy || this.revoked.has(session.id)) return undefined
    if (this.accounts === undefined) return session
    const auth = this.accounts.authorization(session.username)
    if (auth === undefined || !session.authVersion || auth.version !== session.authVersion || auth.role !== session.role) return undefined
    return session
  }

  private persistRevocations(ids: readonly string[]): void {
    for (const id of ids) this.revoked.add(id)
    this.changed()
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.revoked.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify([...this.revoked]), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, `${this.file}.revoked`)
    } catch (error) {
      this.healthy = false
      this.changed()
      writeFileSync(`${this.file}.blocked`, 'session revocation persistence failed', { mode: 0o600 })
      throw error
    }
  }

  constructor(file: string, deps: SessionDeps, config: SessionConfig = {}) {
    this.file = file
    this.deps = deps
    const validTtl = (value: number | undefined, fallback: number): number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
    this.idleExpireMs = validTtl(config.idleExpireMs, DEFAULT_IDLE_EXPIRE_MS)
    this.maxAgeMs = validTtl(config.maxAgeMs, DEFAULT_MAX_AGE_MS)
    this.healthy = !existsSync(`${file}.blocked`)
    try {
      if (existsSync(`${file}.revoked`)) {
        const revoked: unknown = JSON.parse(readFileSync(`${file}.revoked`, 'utf8'))
        if (!Array.isArray(revoked) || !revoked.every(id => typeof id === 'string')) throw new Error('invalid revocation journal')
        for (const id of revoked) this.revoked.add(id)
      }
    } catch { this.healthy = false }
    this.load()
    this.sweep()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoreFile
      if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.sessions)) return
      for (const session of parsed.sessions) {
        if (typeof session?.id !== 'string' || typeof session?.username !== 'string'
          || (session.role !== 'admin' && session.role !== 'user')
          || !Number.isSafeInteger(session.createdAt) || !Number.isSafeInteger(session.lastSeenAt) || !Number.isSafeInteger(session.expiresAt)
          || session.createdAt < 0 || session.createdAt > session.lastSeenAt || session.lastSeenAt > this.deps.now()
          || session.expiresAt < session.lastSeenAt || session.expiresAt > session.createdAt + this.maxAgeMs) continue
        this.sessions.set(session.id, {
          id: session.id,
          username: session.username,
          role: session.role,
          authVersion: typeof session.authVersion === 'string' ? session.authVersion : undefined,
          userAgent: sanitizeUserAgent(session.userAgent),
          ip: typeof session.ip === 'string' ? session.ip : undefined,
          createdAt: typeof session.createdAt === 'number' ? session.createdAt : this.deps.now(),
          lastSeenAt: typeof session.lastSeenAt === 'number' ? session.lastSeenAt : this.deps.now(),
          expiresAt: typeof session.expiresAt === 'number' ? session.expiresAt : this.deps.now(),
        })
      }
    } catch {
      // A corrupt file drops the sessions; users re-login. Never throws.
      this.sessions.clear()
    }
  }

  private persist(): void {
    const dir = dirname(this.file)
    mkdirSync(dir, { recursive: true })
    const payload = JSON.stringify({
      version: STORE_VERSION,
      sessions: [...this.sessions.values()],
    } satisfies StoreFile)
    const tmp = `${this.file}.tmp-${String(process.pid)}`
    try {
      writeFileSync(tmp, payload, { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.file)
    } catch (error) {
      this.healthy = false
      this.changed()
      writeFileSync(`${this.file}.blocked`, 'session persistence failed; operator recovery required', { mode: 0o600 })
      throw error
    }
  }

  /** Issue a new session for one account (fresh random id). */
  issue(username: string, role: AccountRole, meta: { userAgent?: string; ip?: string } = {}): SessionRecord {
    if (!this.healthy) throw new Error('session store requires operator recovery')
    const auth = this.accounts?.authorization(username)
    if (this.accounts !== undefined && auth === undefined) throw new Error('account is not authorized')
    const now = this.deps.now()
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + this.maxAgeMs)) throw new Error('invalid session clock or lifetime')
    const record: SessionRecord = {
      id: this.deps.randomId(),
      username,
      role: auth?.role ?? role,
      authVersion: auth?.version,
      userAgent: sanitizeUserAgent(meta.userAgent),
      ip: meta.ip,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.maxAgeMs,
    }
    this.sessions.set(record.id, record)
    this.persist()
    return record
  }

  /** Whether a session is live (not past its absolute cap). */
  private isAlive(session: SessionRecord): boolean {
    const now = this.deps.now()
    return Number.isSafeInteger(now) && Number.isSafeInteger(session.createdAt + this.maxAgeMs)
      && now >= session.createdAt && now >= session.lastSeenAt && now <= session.expiresAt
      && now <= session.createdAt + this.maxAgeMs && now - session.lastSeenAt <= this.idleExpireMs
  }

  /**
   * Touch a session id (refresh lastSeenAt and the idle window). Returns the
   * live session, or undefined when unknown, expired, or revoked.
   */
  touch(id: string): SessionRecord | undefined {
    const session = this.sessions.get(id)
    if (session === undefined || this.current(session) === undefined) return undefined
    if (!this.isAlive(session) || this.deps.now() - session.lastSeenAt > this.idleExpireMs) {
      this.sessions.delete(id)
      this.persist()
      return undefined
    }
    const now = this.deps.now()
    session.lastSeenAt = now
    const idleEnd = now + this.idleExpireMs
    const capEnd = session.createdAt + this.maxAgeMs
    session.expiresAt = Math.min(idleEnd, capEnd)
    this.persist()
    return this.current(session)
  }

  /** Get a live session by id without mutating lastSeenAt (session probe). */
  peek(id: string): SessionRecord | undefined {
    const session = this.sessions.get(id)
    if (session === undefined || this.current(session) === undefined) return undefined
    if (!this.isAlive(session) || this.deps.now() - session.lastSeenAt > this.idleExpireMs) return undefined
    return this.current(session)
  }

  /** Revoke one session. */
  revoke(id: string): boolean {
    this.persistRevocations([id])
    const existed = this.sessions.delete(id)
    if (existed) this.persist()
    return existed
  }

  /** Revoke every session of one account (password change / disable / remove). */
  revokeAllFor(username: string): number {
    this.persistRevocations([...this.sessions.values()].filter(session => session.username === username).map(session => session.id))
    let count = 0
    for (const [id, session] of this.sessions) {
      if (session.username === username) {
        this.sessions.delete(id)
        count += 1
      }
    }
    if (count > 0) this.persist()
    return count
  }

  /** Revoke every session. */
  revokeAll(): number {
    this.persistRevocations([...this.sessions.keys()])
    const count = this.sessions.size
    if (count > 0) {
      this.sessions.clear()
      this.persist()
    }
    return count
  }

  /** Drop sessions past the absolute cap or idle window. */
  sweep(): number {
    const now = this.deps.now()
    let removed = 0
    for (const [id, session] of this.sessions) {
      if (!this.isAlive(session) || now - session.lastSeenAt > this.idleExpireMs) {
        this.sessions.delete(id)
        removed += 1
      }
    }
    if (removed > 0) { this.changed(); this.persist() }
    return removed
  }

  /** All live sessions as snapshots, newest lastSeen first. */
  list(): SessionSnapshot[] {
    const now = this.deps.now()
    return [...this.sessions.values()]
      .map((session) => ({
        id: session.id,
        username: session.username,
        role: session.role,
        userAgent: session.userAgent,
        ip: session.ip,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        online: now - session.lastSeenAt <= this.idleExpireMs,
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }
}

/** A 32-byte random hex session id (the live seam implementation). */
export function randomSessionId(): string {
  return randomBytes(32).toString('hex')
}
