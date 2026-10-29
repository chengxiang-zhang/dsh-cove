import { createHash, randomBytes } from 'node:crypto'

export const DEFAULT_PAIR_TOKEN_TTL_MS = 15 * 60 * 1000
export const DEFAULT_GATEWAY_MAX_BODY_BYTES = 1024 * 1024
export const DEFAULT_GATEWAY_TIMEOUT_MS = 15 * 1000
export const DEFAULT_GATEWAY_TARGET_ORIGIN = 'http://127.0.0.1:3080'

const ALLOWED_GATEWAY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const FORBIDDEN_GATEWAY_PREFIXES = ['/api/pair', '/api/gateway'] as const

export interface PairTokenSummary {
  id: string
  label: string
  createdAt: number
  expiresAt: number
}

interface PairTokenRecord extends PairTokenSummary {
  digest: string
}

export interface PairTokenStoreOptions {
  ttlMs?: number
  now?: () => number
  randomToken?: () => string
  randomId?: () => string
}

export class PairTokenStore {
  private readonly records = new Map<string, PairTokenRecord>()
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly randomToken: () => string
  private readonly randomId: () => string

  constructor(options: PairTokenStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PAIR_TOKEN_TTL_MS
    this.now = options.now ?? Date.now
    this.randomToken = options.randomToken ?? defaultSecret
    this.randomId = options.randomId ?? defaultId
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error('pair token ttl must be positive')
  }

  issue(label: string): PairTokenSummary & { token: string } {
    this.pruneExpired()
    const token = this.randomToken()
    const digest = digestToken(token)
    const now = this.now()
    const id = this.randomId()
    if (token.length === 0 || this.records.has(digest)) throw new Error('pair token generator produced a duplicate token')
    if (!/^[a-f\d]{24}$/i.test(id) || [...this.records.values()].some(record => record.id === id)) throw new Error('pair token generator produced an invalid id')
    const record: PairTokenRecord = {
      id,
      label,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      digest,
    }
    this.records.set(digest, record)
    return { id: record.id, label: record.label, createdAt: record.createdAt, expiresAt: record.expiresAt, token }
  }

  authenticate(token: string): PairTokenSummary | undefined {
    if (token.length === 0) return undefined
    const digest = digestToken(token)
    const record = this.records.get(digest)
    if (record === undefined) return undefined
    if (record.expiresAt <= this.now()) {
      this.records.delete(digest)
      return undefined
    }
    return summarize(record)
  }

  list(): PairTokenSummary[] {
    this.pruneExpired()
    return [...this.records.values()]
      .map(summarize)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  revoke(id: string): boolean {
    this.pruneExpired()
    for (const [digest, record] of this.records) {
      if (record.id === id) {
        this.records.delete(digest)
        return true
      }
    }
    return false
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [digest, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(digest)
    }
  }
}

export function bearerToken(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^Bearer[ \t]+([^\s,]+)[ \t]*$/i.exec(value)
  return match?.[1]
}

export function resolveGatewayTarget(
  requestUrl: string | undefined,
  targetOrigin = DEFAULT_GATEWAY_TARGET_ORIGIN,
): URL | undefined {
  if (typeof requestUrl !== 'string' || requestUrl === '' || /^[a-z][a-z\d+.-]*:/i.test(requestUrl) || requestUrl.startsWith('//')) {
    return undefined
  }

  let outer: URL
  let origin: URL
  try {
    outer = new URL(requestUrl, 'http://gateway.invalid')
    origin = new URL(targetOrigin)
  } catch {
    return undefined
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return undefined
  if (origin.username !== '' || origin.password !== '' || origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') return undefined

  const pathname = outer.pathname
  const gatewayPrefix = '/api/gateway'
  if (pathname !== gatewayPrefix && !pathname.startsWith(`${gatewayPrefix}/`)) return undefined

  const innerPath = pathname.slice(gatewayPrefix.length)
  if (innerPath === '' || !isSafeApiPath(innerPath)) return undefined

  const target = new URL(origin.href)
  target.pathname = innerPath
  target.search = outer.search
  target.hash = ''
  return target
}

export function isAllowedGatewayMethod(method: string | undefined): boolean {
  return ALLOWED_GATEWAY_METHODS.has(method ?? 'GET')
}

function isSafeApiPath(pathname: string): boolean {
  if (!pathname.startsWith('/api/') || pathname.includes('\\') || pathname.includes('\0')) return false
  if (FORBIDDEN_GATEWAY_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))) return false

  const rawSegments = pathname.slice(1).split('/')
  if (rawSegments.length < 2 || rawSegments.some(segment => segment.length === 0)) return false
  for (const rawSegment of rawSegments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(rawSegment)
    } catch {
      return false
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return false
  }
  return true
}

function defaultSecret(): string { return randomBytes(32).toString('base64url') }
function defaultId(): string { return randomBytes(12).toString('hex') }

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function summarize(record: PairTokenRecord): PairTokenSummary {
  return { id: record.id, label: record.label, createdAt: record.createdAt, expiresAt: record.expiresAt }
}
