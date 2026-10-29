/**
 * Codex auth primitives for the restored codex-bridge service domain:
 * auth-file checks, the device-code flow, and atomic auth.json writes. Every
 * device endpoint is mocked — nothing real is called.
 *
 * Ported from the pre-merge @dsh-cove/dsh-codex-bridge package tests
 * (tests/codex-auth.spec.ts); the module under test moved into the
 * dsh-web-all host services.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkCodexAuth,
  exchangeDeviceCode,
  idTokenIdentity,
  pollDeviceCode,
  requestDeviceCode,
  runDeviceCodeLogin,
  writeCodexAuthFile,
} from '../src/host/services/codex-bridge/codex-auth.ts'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `header.${enc(payload)}.sig`
}

function fakeAuthFile(tokens: Record<string, string> | undefined, authMode?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-auth-spec-'))
  const path = join(dir, 'auth.json')
  writeFileSync(
    path,
    JSON.stringify(
      {
        auth_mode: authMode ?? (tokens ? 'chatgpt' : undefined),
        tokens,
      },
      null,
      2,
    ),
  )
  return path
}

let tempDirs: string[] = []
beforeEach(() => {
  tempDirs = []
})
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('checkCodexAuth', () => {
  it('reports missing when the file does not exist', () => {
    const status = checkCodexAuth(join(tmpdir(), 'definitely-missing-auth.json'))
    expect(status.present).toBe(false)
    expect(status.valid).toBe(false)
  })

  it('rejects an incomplete token set', () => {
    const path = fakeAuthFile({ access_token: 'a' })
    tempDirs.push(join(path, '..'))
    const status = checkCodexAuth(path)
    expect(status.present).toBe(true)
    expect(status.valid).toBe(false)
    expect(status.reason).toBe('incomplete-tokens')
  })

  it('rejects non-chatgpt auth modes', () => {
    const file = fakeAuthFile({ access_token: 'a', refresh_token: 'r' }, 'pat')
    tempDirs.push(join(file, '..'))
    const status = checkCodexAuth(file)
    expect(status.valid).toBe(false)
    expect(status.reason).toBe('auth-mode:pat')
  })

  it('accepts a valid chatgpt token set', () => {
    const idToken = makeJwt({
      email: 'alice@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1', chatgpt_plan_type: 'plus' },
    })
    const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const file = fakeAuthFile({ access_token: accessToken, refresh_token: 'r', id_token: idToken })
    tempDirs.push(join(file, '..'))
    const status = checkCodexAuth(file)
    expect(status.valid).toBe(true)
    expect(status.email).toBe('alice@example.com')
    expect(status.planType).toBe('plus')
    expect(status.accountId).toBe('acc-1')
    expect(status.expired).toBe(false)
  })

  it('flags an expired access token', () => {
    const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 })
    const file = fakeAuthFile({ access_token: accessToken, refresh_token: 'r' })
    tempDirs.push(join(file, '..'))
    const status = checkCodexAuth(file)
    expect(status.present).toBe(true)
    expect(status.valid).toBe(false)
    expect(status.expired).toBe(true)
  })
})

describe('idTokenIdentity', () => {
  it('extracts identity claims from the nested auth namespace', () => {
    const idToken = makeJwt({
      email: 'bob@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc-2', chatgpt_plan_type: 'free' },
    })
    expect(idTokenIdentity(idToken)).toEqual({
      email: 'bob@example.com',
      planType: 'free',
      accountId: 'acc-2',
    })
  })

  it('returns nothing for a malformed token', () => {
    expect(idTokenIdentity('not-a-jwt')).toEqual({})
  })
})

describe('device code flow', () => {
  it('requests a user code from the deviceauth endpoint', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      expect(url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode')
      return new Response(JSON.stringify({ device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval: '5' }), { status: 200 })
    }) as unknown as typeof fetch
    const grant = await requestDeviceCode(fetchImpl)
    expect(grant.deviceAuthId).toBe('dev-1')
    expect(grant.userCode).toBe('ABCD-EFGH')
    expect(grant.intervalSec).toBe(5)
    expect(grant.verificationUrl).toBe('https://auth.openai.com/codex/device')
  })

  it('polls until authorized and returns the PKCE material', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls < 3) return new Response('pending', { status: 403 })
      return new Response(
        JSON.stringify({ authorization_code: 'authz', code_challenge: 'ch', code_verifier: 'ver' }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const success = await pollDeviceCode('dev-1', 'CODE', 0, fetchImpl)
    expect(calls).toBe(3)
    expect(success).toEqual({ authorizationCode: 'authz', codeChallenge: 'ch', codeVerifier: 'ver' })
  })

  it('times out when the user never authorizes', async () => {
    const fetchImpl = (async () => new Response('pending', { status: 403 })) as unknown as typeof fetch
    const success = await pollDeviceCode('dev-1', 'CODE', 0, fetchImpl, undefined, undefined, 10)
    expect(success).toBeNull()
  })

  it('surfaces a non-retryable status as an error', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(pollDeviceCode('dev-1', 'CODE', 0, fetchImpl)).rejects.toThrow(/500/)
  })

  it('exchanges the authorization code with the device redirect', async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      expect(url).toBe('https://auth.openai.com/oauth/token')
      const body = String(init?.body)
      expect(body).toContain('grant_type=authorization_code')
      expect(body).toContain('redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback')
      expect(body).toContain(`client_id=${CLIENT_ID}`)
      expect(body).toContain('code_verifier=ver')
      return new Response(
        JSON.stringify({ id_token: 'idt', access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const tokens = await exchangeDeviceCode('authz', 'ver', fetchImpl)
    expect(tokens).toEqual({ idToken: 'idt', accessToken: 'at', refreshToken: 'rt', expiresInSec: 3600 })
  })

  it('writes the auth.json shape atomically, preserving unrelated fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-write-spec-'))
    tempDirs.push(dir)
    const path = join(dir, 'auth.json')
    writeFileSync(path, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, custom: 1 }))
    const idToken = makeJwt({
      email: 'carol@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc-3' },
    })
    writeCodexAuthFile(path, { idToken, accessToken: 'at2', refreshToken: 'rt2' })
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.auth_mode).toBe('chatgpt')
    expect(written.custom).toBe(1)
    expect(written.tokens).toEqual({ id_token: idToken, access_token: 'at2', refresh_token: 'rt2', account_id: 'acc-3' })
    expect(written.last_refresh).toBeTruthy()
  })

  it('runs the full login and persists the tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-login-spec-'))
    tempDirs.push(dir)
    const path = join(dir, 'auth.json')
    let usercodeCalls = 0
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/deviceauth/usercode')) {
        usercodeCalls += 1
        return new Response(JSON.stringify({ device_auth_id: 'dev-9', user_code: 'WXYZ-1234', interval: 0 }), { status: 200 })
      }
      if (url.endsWith('/deviceauth/token')) {
        return new Response(
          JSON.stringify({ authorization_code: 'authz9', code_challenge: 'ch9', code_verifier: 'ver9' }),
          { status: 200 },
        )
      }
      if (url.endsWith('/oauth/token')) {
        return new Response(
          JSON.stringify({ id_token: makeJwt({ email: 'dave@example.com' }), access_token: 'at9', refresh_token: 'rt9' }),
          { status: 200 },
        )
      }
      return new Response('unexpected', { status: 500 })
    }) as unknown as typeof fetch

    let surfaced: { userCode: string; verificationUrl: string } | undefined
    const result = await runDeviceCodeLogin({
      authFile: path,
      onCode: (grant) => {
        surfaced = { userCode: grant.userCode, verificationUrl: grant.verificationUrl }
      },
      fetchImpl,
    })
    expect(usercodeCalls).toBe(1)
    expect(surfaced?.userCode).toBe('WXYZ-1234')
    expect(surfaced?.verificationUrl).toBe('https://auth.openai.com/codex/device')
    expect(result?.email).toBe('dave@example.com')
    expect(existsSync(path)).toBe(true)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.tokens.access_token).toBe('at9')
  })
})