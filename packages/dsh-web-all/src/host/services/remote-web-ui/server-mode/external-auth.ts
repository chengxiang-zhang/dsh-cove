/** External identity providers for integrated DSH WebAuth. */
import { createHash, randomBytes } from 'node:crypto'
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose'
import type { AccountRole } from './accounts.ts'

export interface OidcProviderConfig {
  id: string
  label?: string
  issuer: string
  clientId: string
  clientSecret: string
  scopes?: string[]
  allowedSubjects?: string[]
  allowedEmailDomains?: string[]
  defaultRole?: AccountRole
}

export interface FeishuProviderConfig {
  id?: string
  label?: string
  appId: string
  appSecret: string
  authorizationUrl?: string
  baseUrl?: string
  allowedOpenIds?: string[]
  defaultRole?: AccountRole
}

export interface ExternalPrincipal {
  providerId: string
  subject: string
  issuer?: string
  tenant?: string
  displayName?: string
  email?: string
  role: AccountRole
}

export interface PublicAuthProvider {
  id: string
  label: string
  type: 'oidc' | 'feishu'
}

interface PendingAuthorization {
  providerId: string
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  next: string
  createdAt: number
}

export interface ExternalAuthDeps {
  now?: () => number
  randomBytes?: (size: number) => Buffer
  fetch?: typeof fetch
  maxPendingMs?: number
}

interface OidcDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

function form(body: Record<string, string>): URLSearchParams {
  const value = new URLSearchParams()
  for (const [key, item] of Object.entries(body)) value.set(key, item)
  return value
}

function normalizeIssuer(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && !url.hostname.startsWith('127.')) {
    throw new Error('external auth issuer must use https')
  }
  url.hash = ''
  url.search = ''
  return url.href.replace(/\/$/, '')
}

function domainAllowed(email: string | undefined, allowed: readonly string[] | undefined): boolean {
  if (allowed === undefined || allowed.length === 0) return true
  if (email === undefined) return false
  const at = email.lastIndexOf('@')
  if (at < 0) return false
  const domain = email.slice(at + 1).toLowerCase()
  return allowed.some(candidate => candidate.toLowerCase() === domain)
}

function subjectAllowed(subject: string, allowed: readonly string[] | undefined): boolean {
  return allowed === undefined || allowed.length === 0 || allowed.includes(subject)
}

async function jsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${String(response.status)}`)
  const value = await response.json() as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned malformed JSON`)
  return value as Record<string, unknown>
}

/** Short-lived, one-time authorization state plus provider protocol adapters. */
export class ExternalAuthService {
  private readonly pending = new Map<string, PendingAuthorization>()
  private readonly discoveries = new Map<string, Promise<OidcDiscovery>>()
  private readonly oidc = new Map<string, OidcProviderConfig>()
  private readonly feishu = new Map<string, FeishuProviderConfig>()
  private readonly now: () => number
  private readonly random: (size: number) => Buffer
  private readonly fetchImpl: typeof fetch
  private readonly maxPendingMs: number

  constructor(config: { oidc?: OidcProviderConfig[]; feishu?: FeishuProviderConfig }, deps: ExternalAuthDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.random = deps.randomBytes ?? randomBytes
    this.fetchImpl = deps.fetch ?? globalThis.fetch
    this.maxPendingMs = deps.maxPendingMs ?? 10 * 60 * 1000
    for (const provider of config.oidc ?? []) {
      if (!/^[a-z][a-z0-9-]{1,31}$/.test(provider.id)) throw new Error(`invalid OIDC provider id: ${provider.id}`)
      this.oidc.set(provider.id, { ...provider, issuer: normalizeIssuer(provider.issuer) })
    }
    if (config.feishu !== undefined && config.feishu.appId !== '' && config.feishu.appSecret !== '') {
      const id = config.feishu.id ?? 'feishu'
      if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) throw new Error(`invalid Feishu provider id: ${id}`)
      this.feishu.set(id, { ...config.feishu, id })
    }
  }

  list(): PublicAuthProvider[] {
    return [
      ...[...this.oidc.values()].map(provider => ({ id: provider.id, label: provider.label ?? provider.id, type: 'oidc' as const })),
      ...[...this.feishu.entries()].map(([id, provider]) => ({ id, label: provider.label ?? '飞书', type: 'feishu' as const })),
    ]
  }

  private newPending(providerId: string, redirectUri: string, next: string): PendingAuthorization {
    this.sweep()
    const state = base64url(this.random(32))
    const record = {
      providerId,
      state,
      nonce: base64url(this.random(32)),
      verifier: base64url(this.random(48)),
      redirectUri,
      next,
      createdAt: this.now(),
    }
    this.pending.set(state, record)
    return record
  }

  private take(state: string, providerId: string, redirectUri: string): PendingAuthorization {
    const record = this.pending.get(state)
    this.pending.delete(state)
    if (record === undefined || record.providerId !== providerId || record.redirectUri !== redirectUri) throw new Error('authorization state is invalid')
    if (this.now() - record.createdAt > this.maxPendingMs) throw new Error('authorization state expired')
    return record
  }

  private sweep(): void {
    const cutoff = this.now() - this.maxPendingMs
    for (const [state, record] of this.pending) if (record.createdAt < cutoff) this.pending.delete(state)
  }

  private async discovery(provider: OidcProviderConfig): Promise<OidcDiscovery> {
    let current = this.discoveries.get(provider.id)
    if (current !== undefined) return current
    current = (async () => {
      const response = await this.fetchImpl(`${provider.issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } })
      const value = await jsonResponse(response, 'OIDC discovery')
      const result = {
        issuer: String(value.issuer ?? ''),
        authorization_endpoint: String(value.authorization_endpoint ?? ''),
        token_endpoint: String(value.token_endpoint ?? ''),
        jwks_uri: String(value.jwks_uri ?? ''),
      }
      if (normalizeIssuer(result.issuer) !== provider.issuer) throw new Error('OIDC discovery issuer mismatch')
      for (const endpoint of [result.authorization_endpoint, result.token_endpoint, result.jwks_uri]) {
        if (new URL(endpoint).protocol !== 'https:' && !endpoint.startsWith('http://127.') && !endpoint.startsWith('http://localhost')) throw new Error('OIDC endpoint must use https')
      }
      return result
    })()
    this.discoveries.set(provider.id, current)
    try { return await current } catch (error) { this.discoveries.delete(provider.id); throw error }
  }

  async begin(providerId: string, redirectUri: string, next: string): Promise<URL> {
    const oidc = this.oidc.get(providerId)
    if (oidc !== undefined) {
      const record = this.newPending(providerId, redirectUri, next)
      const discovery = await this.discovery(oidc)
      const url = new URL(discovery.authorization_endpoint)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', oidc.clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('scope', (oidc.scopes ?? ['openid', 'profile', 'email']).join(' '))
      url.searchParams.set('state', record.state)
      url.searchParams.set('nonce', record.nonce)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('code_challenge', createHash('sha256').update(record.verifier).digest('base64url'))
      return url
    }

    const feishu = this.feishu.get(providerId)
    if (feishu !== undefined) {
      const record = this.newPending(providerId, redirectUri, next)
      const url = new URL(feishu.authorizationUrl ?? 'https://accounts.feishu.cn/open-apis/authen/v1/authorize')
      url.searchParams.set('client_id', feishu.appId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('state', record.state)
      url.searchParams.set('scope', 'auth:user.id:read')
      return url
    }
    throw new Error('unknown authentication provider')
  }

  async callback(providerId: string, redirectUri: string, code: string, state: string): Promise<{ principal: ExternalPrincipal; next: string }> {
    const record = this.take(state, providerId, redirectUri)
    const oidc = this.oidc.get(providerId)
    if (oidc !== undefined) return { principal: await this.finishOidc(oidc, record, code), next: record.next }
    const feishu = this.feishu.get(providerId)
    if (feishu !== undefined) return { principal: await this.finishFeishu(providerId, feishu, record, code), next: record.next }
    throw new Error('unknown authentication provider')
  }

  private async finishOidc(provider: OidcProviderConfig, record: PendingAuthorization, code: string): Promise<ExternalPrincipal> {
    const discovery = await this.discovery(provider)
    const response = await this.fetchImpl(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form({ grant_type: 'authorization_code', client_id: provider.clientId, client_secret: provider.clientSecret, code, redirect_uri: record.redirectUri, code_verifier: record.verifier }),
    })
    const token = await jsonResponse(response, 'OIDC token exchange')
    const idToken = typeof token.id_token === 'string' ? token.id_token : undefined
    if (idToken === undefined) throw new Error('OIDC token response has no id_token')
    const jwksValue = await jsonResponse(await this.fetchImpl(discovery.jwks_uri, { headers: { accept: 'application/json' } }), 'OIDC JWKS')
    if (!Array.isArray(jwksValue.keys)) throw new Error('OIDC JWKS has no keys array')
    const jwks = createLocalJWKSet(jwksValue as unknown as JSONWebKeySet)
    const verified = await jwtVerify(idToken, jwks, { issuer: discovery.issuer, audience: provider.clientId })
    if (verified.payload.nonce !== record.nonce) throw new Error('OIDC nonce mismatch')
    if (Array.isArray(verified.payload.aud) && verified.payload.aud.length > 1 && verified.payload.azp !== provider.clientId) {
      throw new Error('OIDC azp mismatch')
    }
    return this.oidcPrincipal(provider, verified.payload)
  }

  private oidcPrincipal(provider: OidcProviderConfig, payload: JWTPayload): ExternalPrincipal {
    const subject = payload.sub
    if (typeof subject !== 'string' || !subjectAllowed(subject, provider.allowedSubjects)) throw new Error('OIDC subject is not allowed')
    const email = typeof payload.email === 'string' ? payload.email : undefined
    if (!domainAllowed(email, provider.allowedEmailDomains)) throw new Error('OIDC email domain is not allowed')
    return {
      providerId: provider.id,
      subject,
      issuer: provider.issuer,
      ...(typeof payload.name === 'string' ? { displayName: payload.name } : {}),
      ...(email !== undefined ? { email } : {}),
      role: provider.defaultRole ?? 'user',
    }
  }

  private async finishFeishu(providerId: string, provider: FeishuProviderConfig, record: PendingAuthorization, code: string): Promise<ExternalPrincipal> {
    const api = (provider.baseUrl ?? 'https://open.feishu.cn').replace(/\/$/, '')
    const token = await jsonResponse(await this.fetchImpl(`${api}/open-apis/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', client_id: provider.appId, client_secret: provider.appSecret, code, redirect_uri: record.redirectUri, code_verifier: record.verifier }),
    }), 'Feishu token exchange')
    const accessToken = typeof token.access_token === 'string' ? token.access_token : undefined
    if (accessToken === undefined) throw new Error('Feishu token response has no access_token')
    const info = await jsonResponse(await this.fetchImpl(`${api}/open-apis/authen/v1/user_info`, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } }), 'Feishu user info')
    const data = info.data !== null && typeof info.data === 'object' ? info.data as Record<string, unknown> : info
    const subject = typeof data.union_id === 'string' && data.union_id !== '' ? data.union_id : typeof data.open_id === 'string' ? data.open_id : undefined
    if (subject === undefined || !subjectAllowed(subject, provider.allowedOpenIds)) throw new Error('Feishu subject is not allowed')
    return {
      providerId,
      subject,
      ...(typeof data.tenant_key === 'string' ? { tenant: data.tenant_key } : {}),
      ...(typeof data.name === 'string' ? { displayName: data.name } : {}),
      ...(typeof data.email === 'string' ? { email: data.email } : {}),
      role: provider.defaultRole ?? 'user',
    }
  }
}

/** External identities are namespaced local account keys, never display names. */
export function externalAccountName(principal: ExternalPrincipal): string {
  return `${principal.providerId}:${principal.issuer ?? principal.tenant ?? 'default'}:${principal.subject}`
}
