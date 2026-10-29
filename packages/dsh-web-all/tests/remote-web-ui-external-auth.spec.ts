import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { ExternalAuthService, externalAccountName } from '../src/host/services/remote-web-ui/server-mode/external-auth.ts'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('external WebAuth providers', () => {
  it('runs OIDC code+PKCE and verifies issuer, audience, nonce and subject', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwk = await exportJWK(publicKey)
    Object.assign(jwk, { kid: 'one', alg: 'RS256', use: 'sig' })
    let authorizeNonce = ''
    let tokenBody = ''
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer: 'https://id.example', authorization_endpoint: 'https://id.example/auth', token_endpoint: 'https://id.example/token', jwks_uri: 'https://id.example/jwks' })
      if (url.endsWith('/token')) {
        tokenBody = String(init?.body ?? '')
        const id_token = await new SignJWT({ nonce: authorizeNonce, email: 'alice@example.com', name: 'Alice' })
          .setProtectedHeader({ alg: 'RS256', kid: 'one' })
          .setIssuer('https://id.example').setAudience('client').setSubject('subject-1').setIssuedAt().setExpirationTime('5m').sign(privateKey)
        return json({ id_token })
      }
      if (url.endsWith('/jwks')) return json({ keys: [jwk] })
      throw new Error(`unexpected ${url}`)
    })
    const service = new ExternalAuthService({ oidc: [{ id: 'company', issuer: 'https://id.example', clientId: 'client', clientSecret: 'secret', allowedSubjects: ['subject-1'], allowedEmailDomains: ['example.com'] }] }, { fetch: fetchMock as typeof fetch, randomBytes: size => Buffer.alloc(size, 7) })

    const redirect = 'https://dsh.example/auth/company/callback'
    const start = await service.begin('company', redirect, '/session/one')
    authorizeNonce = start.searchParams.get('nonce') ?? ''
    expect(start.searchParams.get('code_challenge_method')).toBe('S256')
    expect(start.searchParams.get('state')).toBeTruthy()
    const result = await service.callback('company', redirect, 'code-1', start.searchParams.get('state') ?? '')
    expect(result.next).toBe('/session/one')
    expect(result.principal).toMatchObject({ providerId: 'company', subject: 'subject-1', email: 'alice@example.com', role: 'user' })
    expect(tokenBody).toContain('code_verifier=')
    await expect(service.callback('company', redirect, 'again', start.searchParams.get('state') ?? '')).rejects.toThrow(/state/)
  })

  it('runs Feishu authorization and enforces stable subject allowlist', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/open-apis/authen/v2/oauth/token')) return json({ access_token: 'access' })
      if (url.endsWith('/open-apis/authen/v1/user_info')) return json({ data: { open_id: 'ou_allowed', tenant_key: 'tenant', name: '飞书用户' } })
      throw new Error(`unexpected ${url}`)
    })
    const service = new ExternalAuthService({ feishu: { appId: 'cli_x', appSecret: 'secret', baseUrl: 'https://open.feishu.cn', allowedOpenIds: ['ou_allowed'] } }, { fetch: fetchMock as typeof fetch, randomBytes: size => Buffer.alloc(size, 3) })
    const redirect = 'https://dsh.example/auth/feishu/callback'
    const start = await service.begin('feishu', redirect, '/')
    expect(start.origin).toBe('https://accounts.feishu.cn')
    const result = await service.callback('feishu', redirect, 'code', start.searchParams.get('state') ?? '')
    expect(result.principal).toMatchObject({ providerId: 'feishu', subject: 'ou_allowed', tenant: 'tenant' })
    expect(externalAccountName(result.principal)).toBe('feishu:tenant:ou_allowed')
  })

  it('ignores an unconfigured Feishu schema object', () => {
    const service = new ExternalAuthService({ feishu: { appId: '', appSecret: '' } })
    expect(service.list()).toEqual([])
  })

  it('publishes no provider secrets', () => {
    const service = new ExternalAuthService({
      oidc: [{ id: 'company', issuer: 'https://id.example', clientId: 'client', clientSecret: 'top-secret' }],
      feishu: { appId: 'cli_x', appSecret: 'feishu-secret' },
    })
    const serialized = JSON.stringify(service.list())
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('feishu-secret')
    expect(service.list()).toEqual([
      { id: 'company', label: 'company', type: 'oidc' },
      { id: 'feishu', label: '飞书', type: 'feishu' },
    ])
  })
})
