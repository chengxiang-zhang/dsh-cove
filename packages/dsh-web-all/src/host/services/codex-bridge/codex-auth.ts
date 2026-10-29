/**
 * Codex CLI auth primitives for the codex-bridge service domain.
 *
 * Pure logic, no cordis/DSH coupling: reading and checking the Codex CLI
 * auth file (`~/.codex/auth.json`), the ChatGPT device-code login flow
 * (usercode request, polling, PKCE token exchange), and atomic writes back
 * into the auth file shape the official Codex CLI owns.
 *
 * Endpoints verified against openai/codex (codex-rs/login/src/device_code_auth.rs
 * and server.rs): the device auth routes live under
 * `{issuer}/api/accounts/deviceauth/*`, the token exchange is the standard
 * `{issuer}/oauth/token` authorization-code grant with the device callback
 * redirect URI.
 *
 * Ported verbatim from the pre-merge @dsh-cove/dsh-codex-bridge package
 * (src/codex-auth.ts) into the dsh-web-all host services.
 */

const ISSUER = 'https://auth.openai.com'
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/** Overall device login budget (matches the Codex CLI's 15 minutes). */
export const DEVICE_POLL_TIMEOUT_MS = 15 * 60 * 1000

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Shape of the Codex CLI auth file (`~/.codex/auth.json`). */
export interface CodexAuthFile {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
}

/** Result of a structural auth-file check. */
export interface CodexAuthStatus {
  /** auth.json exists and parses. */
  present: boolean
  /** ChatGPT-mode tokens (access + refresh) are present. */
  valid: boolean
  /** Whether the access token JWT is still within its `exp` window. */
  expired?: boolean
  email?: string
  planType?: string
  accountId?: string
  reason?: string
}

/** One step of the device-code login. */
export interface DeviceCodeGrant {
  deviceAuthId: string
  userCode: string
  intervalSec: number
  verificationUrl: string
}

/** Poll result of the device-auth token endpoint. */
export interface DeviceCodeSuccess {
  authorizationCode: string
  codeChallenge: string
  codeVerifier: string
}

/** Tokens returned by the authorization-code exchange. */
export interface CodexTokens {
  idToken: string
  accessToken: string
  refreshToken: string
  expiresInSec?: number
}

function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return `${process.env.HOME ?? '/root'}${p.slice(1)}`
  }
  return p
}

/** Base64url-decode a JWT payload without verifying the signature. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1]
  if (!part) return {}
  const normalized = part.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const raw = Buffer.from(padded, 'base64').toString('utf8')
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Identity claims (email / plan / account id) extracted from a ChatGPT id_token. */
export function idTokenIdentity(idToken: string | undefined): {
  email?: string
  planType?: string
  accountId?: string
} {
  if (!idToken) return {}
  const claims = decodeJwtPayload(idToken)
  const auth = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>
  return {
    email: typeof claims.email === 'string' ? claims.email : undefined,
    planType:
      typeof auth.chatgpt_plan_type === 'string'
        ? auth.chatgpt_plan_type
        : typeof claims.chatgpt_plan_type === 'string'
          ? claims.chatgpt_plan_type
          : undefined,
    accountId:
      typeof auth.chatgpt_account_id === 'string'
        ? auth.chatgpt_account_id
        : typeof claims.chatgpt_account_id === 'string'
          ? claims.chatgpt_account_id
          : undefined,
  }
}

/** Read and structurally validate the Codex CLI auth file. */
export function readCodexAuthFile(filePath: string): CodexAuthFile | null {
  const resolved = expandHome(filePath)
  if (!existsSync(resolved)) return null
  try {
    const raw = JSON.parse(readFileSync(resolved, 'utf8')) as CodexAuthFile
    return raw
  } catch {
    return null
  }
}

/** Structural + expiry check of the auth file (no network). */
export function checkCodexAuth(filePath: string): CodexAuthStatus {
  const raw = readCodexAuthFile(filePath)
  if (!raw) return { present: false, valid: false, reason: 'missing' }
  const tokens = raw.tokens
  if (!tokens?.access_token || !tokens?.refresh_token) {
    return { present: true, valid: false, reason: 'incomplete-tokens' }
  }
  if (raw.auth_mode && raw.auth_mode !== 'chatgpt') {
    return { present: true, valid: false, reason: `auth-mode:${raw.auth_mode}` }
  }
  const identity = idTokenIdentity(tokens.id_token)
  let expired: boolean | undefined
  const claims = decodeJwtPayload(tokens.access_token)
  if (typeof claims.exp === 'number') {
    expired = claims.exp * 1000 <= Date.now()
  }
  return {
    present: true,
    valid: !expired,
    expired,
    email: identity.email,
    planType: identity.planType,
    accountId: identity.accountId,
  }
}

/** Request a one-time device code and the polling interval. */
export async function requestDeviceCode(
  fetchImpl: typeof fetch = fetch,
  clientId = CODEX_CLIENT_ID,
  issuer = ISSUER,
): Promise<DeviceCodeGrant> {
  const resp = await fetchImpl(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  })
  if (!resp.ok) {
    throw new Error(`device code request failed (${resp.status}): ${await resp.text()}`)
  }
  const data = (await resp.json()) as {
    device_auth_id?: string
    user_code?: string
    usercode?: string
    interval?: number | string
  }
  if (!data.device_auth_id || !data.user_code) {
    throw new Error('device code response missing device_auth_id or user_code')
  }
  const interval = Number(data.interval ?? 5)
  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    intervalSec: Number.isFinite(interval) && interval > 0 ? interval : 5,
    verificationUrl: `${issuer}/codex/device`,
  }
}

/**
 * Poll the device-auth token endpoint until the user authorizes or the
 * budget expires. Resolves to null on timeout.
 */
export async function pollDeviceCode(
  deviceAuthId: string,
  userCode: string,
  intervalSec: number,
  fetchImpl: typeof fetch = fetch,
  issuer = ISSUER,
  signal?: AbortSignal,
  timeoutMs = DEVICE_POLL_TIMEOUT_MS,
): Promise<DeviceCodeSuccess | null> {
  const startedAt = Date.now()
  for (;;) {
    if (signal?.aborted) throw new Error('device login cancelled')
    const resp = await fetchImpl(`${issuer}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      signal,
    })
    if (resp.ok) {
      const data = (await resp.json()) as {
        authorization_code?: string
        code_challenge?: string
        code_verifier?: string
      }
      if (!data.authorization_code || !data.code_challenge || !data.code_verifier) {
        throw new Error('device token response missing authorization fields')
      }
      return {
        authorizationCode: data.authorization_code,
        codeChallenge: data.code_challenge,
        codeVerifier: data.code_verifier,
      }
    }
    if (resp.status !== 403 && resp.status !== 404) {
      throw new Error(`device auth failed (${resp.status}): ${await resp.text()}`)
    }
    if (Date.now() - startedAt >= timeoutMs) return null
    const wait = Math.min(intervalSec * 1000, timeoutMs - (Date.now() - startedAt))
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

/** Exchange the device authorization code for tokens (PKCE, form-urlencoded). */
export async function exchangeDeviceCode(
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
  clientId = CODEX_CLIENT_ID,
  issuer = ISSUER,
): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${issuer}/deviceauth/callback`,
    client_id: clientId,
    code_verifier: codeVerifier,
  })
  const resp = await fetchImpl(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    throw new Error(`device token exchange failed (${resp.status}): ${await resp.text()}`)
  }
  const data = (await resp.json()) as {
    id_token?: string
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!data.id_token || !data.access_token || !data.refresh_token) {
    throw new Error('device token exchange response missing tokens')
  }
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresInSec: data.expires_in,
  }
}

/**
 * Persist tokens into the Codex CLI auth.json shape, preserving unrelated
 * fields and writing atomically (concurrent Codex CLI readers never see a
 * partial file).
 */
export function writeCodexAuthFile(
  filePath: string,
  tokens: CodexTokens,
): void {
  const resolved = expandHome(filePath)
  let existing: CodexAuthFile = {}
  if (existsSync(resolved)) {
    try {
      existing = JSON.parse(readFileSync(resolved, 'utf8')) as CodexAuthFile
    } catch {
      existing = {}
    }
  }
  const identity = idTokenIdentity(tokens.idToken)
  const next: CodexAuthFile = {
    ...existing,
    auth_mode: existing.auth_mode || 'chatgpt',
    tokens: {
      ...(existing.tokens ?? {}),
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: identity.accountId ?? existing.tokens?.account_id,
    },
    last_refresh: new Date().toISOString(),
  }
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 })
  const tmp = `${resolved}.dsh-codex-bridge.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, resolved)
}

/**
 * Run the whole device-code login: request code, surface it, poll, exchange,
 * persist. Returns null when the user never authorized within the budget.
 */
export async function runDeviceCodeLogin(
  options: {
    onCode: (grant: DeviceCodeGrant) => void
    authFile: string
    signal?: AbortSignal
    fetchImpl?: typeof fetch
  },
): Promise<{ tokens: CodexTokens; email?: string } | null> {
  const grant = await requestDeviceCode(options.fetchImpl)
  options.onCode(grant)
  const success = await pollDeviceCode(
    grant.deviceAuthId,
    grant.userCode,
    grant.intervalSec,
    options.fetchImpl,
    ISSUER,
    options.signal,
  )
  if (!success) return null
  const tokens = await exchangeDeviceCode(
    success.authorizationCode,
    success.codeVerifier,
    options.fetchImpl,
  )
  writeCodexAuthFile(options.authFile, tokens)
  const identity = idTokenIdentity(tokens.idToken)
  return { tokens, email: identity.email }
}
