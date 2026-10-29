/**
 * Route-contract tests for the restored codex-bridge service domain: the
 * /api/dsh-codex-bridge status / login.start / login.status / login.cancel /
 * proxy.restart / verify / register family must keep the original envelope
 * shapes the restored client card parses (BridgeStatus + login state, the
 * device grant with intervalSec/expiresInSec, the phase object, the
 * register result with the provider route) and the loopback-only fence.
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { makeRoutes } from '../src/host/services/codex-bridge/routes.ts'
import type { ApiProxyBridge, BridgeStatus, DeviceLoginState } from '../src/host/services/codex-bridge/bridge.ts'
import type { DeviceCodeGrant } from '../src/host/services/codex-bridge/codex-auth.ts'
import { PROVIDER_ROUTE } from '../src/host/services/codex-bridge/dsh-integration.ts'

function makeReq(method: string, url: string, body?: unknown, remoteAddress = '127.0.0.1'): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  Object.assign(req, {
    method,
    url,
    socket: { remoteAddress },
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  })
  return req
}

async function run(
  bridge: ApiProxyBridge,
  ctx: Context,
  method: string,
  pathname: string,
  onLoginComplete?: () => Promise<void>,
  remoteAddress?: string,
): Promise<{ status: number; text: string }> {
  const req = makeReq(method, pathname, undefined, remoteAddress)
  let status = 0
  let text = ''
  const res = new EventEmitter() as unknown as ServerResponse & { writeHead(code: number): unknown; end(chunk?: string | Buffer): unknown; write(chunk: string | Buffer): boolean; writableEnded: boolean }
  Object.assign(res, {
    writeHead(code: number) { status = code; return this },
    end(chunk?: string | Buffer) { if (chunk !== undefined) text += chunk.toString(); this.emit('finish'); return this },
    write(chunk: string | Buffer) { text += chunk.toString(); return true },
    writableEnded: false,
  })
  const routes = makeRoutes({
    bridge,
    ctx,
    authFile: '/definitely/missing/codex/auth.json',
    autoRegister: true,
    onLoginComplete,
  })
  const route = routes.find(r => r.kind === 'exact' && pathname === r.path)
  if (route === undefined) throw new Error(`no route for ${pathname}`)
  await (route as { handler(req: IncomingMessage, res: ServerResponse): Promise<void> }).handler(req, res as ServerResponse)
  return { status, text }
}

function fakeBridge(): ApiProxyBridge & Record<string, ReturnType<typeof vi.fn>> {
  return {
    baseURL: 'http://127.0.0.1:8317',
    status: vi.fn(async (auth: BridgeStatus['auth']): Promise<BridgeStatus> => ({
      proxy: 'running',
      port: 8317,
      baseURL: 'http://127.0.0.1:8317',
      apiKeyConfigured: true,
      auth,
      models: ['gpt-5.5', 'codex-mini'],
      accountEmail: 'alice@example.com',
      accountPlan: 'plus',
      adopted: false,
    })),
    deviceLoginState: vi.fn((): DeviceLoginState => ({ phase: 'idle' })),
    startDeviceLogin: vi.fn(async (): Promise<DeviceCodeGrant> => ({
      deviceAuthId: 'dev-1',
      userCode: 'ABCD-EFGH',
      intervalSec: 5,
      verificationUrl: 'https://auth.openai.com/codex/device',
    })),
    cancelDeviceLogin: vi.fn(() => undefined),
    restart: vi.fn(async () => undefined),
    verify: vi.fn(async () => ({ ok: true, model: 'gpt-5.5', reply: 'OK' })),
    listModels: vi.fn(async () => ['gpt-5.5', 'codex-mini', 'gpt-reserve']),
    apiKey: vi.fn(() => 'sk-test'),
  } as unknown as ApiProxyBridge & Record<string, ReturnType<typeof vi.fn>>
}

function fakeCtx(withSettings = true): Context & { credentials: { set: ReturnType<typeof vi.fn> }; settings?: { update: ReturnType<typeof vi.fn> } } {
  const ctx = {
    credentials: { set: vi.fn(async () => undefined) },
  } as unknown as Context & { credentials: { set: ReturnType<typeof vi.fn> }; settings?: { update: ReturnType<typeof vi.fn> } }
  if (withSettings) {
    ctx.settings = { update: vi.fn(async () => undefined) }
  }
  return ctx
}

describe('codex-bridge routes — restored legacy contract', () => {
  it('GET /status returns the BridgeStatus envelope plus the login state', async () => {
    const bridge = fakeBridge()
    const { status, text } = await run(bridge, fakeCtx(), 'GET', '/api/dsh-codex-bridge/status')
    expect(status).toBe(200)
    const parsed = JSON.parse(text) as { proxy: string; baseURL: string; auth: { present: boolean }; models: string[]; accountEmail?: string; login: { phase: string } }
    expect(parsed.proxy).toBe('running')
    expect(parsed.baseURL).toBe('http://127.0.0.1:8317')
    expect(parsed.auth.present).toBe(false)
    expect(parsed.auth).toMatchObject({ present: false, valid: false, reason: 'missing' })
    expect(parsed.models).toEqual(['gpt-5.5', 'codex-mini'])
    expect(parsed.accountEmail).toBe('alice@example.com')
    expect(parsed.login).toEqual({ phase: 'idle' })
  })

  it('rejects non-loopback requests with 403 and the original envelope', async () => {
    const bridge = fakeBridge()
    const { status, text } = await run(bridge, fakeCtx(), 'GET', '/api/dsh-codex-bridge/status', undefined, '10.0.0.1')
    expect(status).toBe(403)
    expect(JSON.parse(text)).toEqual({ error: 'loopback only' })
  })

  it('POST /login/start returns the device grant with the 15-minute budget', async () => {
    const bridge = fakeBridge()
    const { status, text } = await run(bridge, fakeCtx(), 'POST', '/api/dsh-codex-bridge/login/start')
    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
      intervalSec: 5,
      expiresInSec: 15 * 60,
    })
  })

  it('POST /login/start answers 409 when a login is already in progress', async () => {
    const bridge = fakeBridge()
    bridge.startDeviceLogin = vi.fn(async () => { throw new Error('a device login is already in progress') })
    const { status, text } = await run(bridge, fakeCtx(), 'POST', '/api/dsh-codex-bridge/login/start')
    expect(status).toBe(409)
    expect(JSON.parse(text)).toEqual({ error: 'a device login is already in progress' })
  })

  it('GET /login/status returns the raw login phase object', async () => {
    const bridge = fakeBridge()
    bridge.deviceLoginState = vi.fn((): DeviceLoginState => ({ phase: 'waiting', grant: { deviceAuthId: 'dev-1', userCode: 'ABCD-EFGH', intervalSec: 5, verificationUrl: 'https://auth.openai.com/codex/device' } }))
    const { status, text } = await run(bridge, fakeCtx(), 'GET', '/api/dsh-codex-bridge/login/status')
    expect(status).toBe(200)
    const parsed = JSON.parse(text) as { phase: string; grant: { userCode: string } }
    expect(parsed.phase).toBe('waiting')
    expect(parsed.grant?.userCode).toBe('ABCD-EFGH')
  })

  it('GET /login/status re-runs registration once the login succeeds', async () => {
    const bridge = fakeBridge()
    bridge.deviceLoginState = vi.fn((): DeviceLoginState => ({ phase: 'success', email: 'alice@example.com' }))
    const onLoginComplete = vi.fn(async () => undefined)
    await run(bridge, fakeCtx(), 'GET', '/api/dsh-codex-bridge/login/status', onLoginComplete)
    expect(onLoginComplete).toHaveBeenCalledOnce()
  })

  it('GET /login/status leaves registration alone while the login is pending', async () => {
    const bridge = fakeBridge()
    const onLoginComplete = vi.fn(async () => undefined)
    await run(bridge, fakeCtx(), 'GET', '/api/dsh-codex-bridge/login/status', onLoginComplete)
    expect(onLoginComplete).not.toHaveBeenCalled()
  })

  it('POST /login/cancel acknowledges the cancellation', async () => {
    const bridge = fakeBridge()
    const { status, text } = await run(bridge, fakeCtx(), 'POST', '/api/dsh-codex-bridge/login/cancel')
    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({ cancelled: true })
    expect(bridge.cancelDeviceLogin).toHaveBeenCalledOnce()
  })

  it('POST /proxy/restart reports the base URL, and a failure is a 500', async () => {
    const bridge = fakeBridge()
    const { status, text } = await run(bridge, fakeCtx(), 'POST', '/api/dsh-codex-bridge/proxy/restart')
    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({ restarted: true, baseURL: 'http://127.0.0.1:8317' })

    bridge.restart = vi.fn(async () => { throw new Error('proxy crashed') })
    const failed = await run(bridge, fakeCtx(), 'POST', '/api/dsh-codex-bridge/proxy/restart')
    expect(failed.status).toBe(500)
    expect(JSON.parse(failed.text)).toEqual({ error: 'proxy crashed' })
  })

  it('POST /verify answers 200 on an ok chain and 502 on a broken one', async () => {
    const bridge = fakeBridge()
    const ok = await run(bridge, fakeCtx(), 'POST', '/api/dsh-codex-bridge/verify')
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.text)).toEqual({ ok: true, model: 'gpt-5.5', reply: 'OK' })

    bridge.verify = vi.fn(async () => ({ ok: false, error: 'no models advertised' }))
    const broken = await run(bridge, fakeCtx(), 'POST', '/api/dsh-codex-bridge/verify')
    expect(broken.status).toBe(502)
    expect(JSON.parse(broken.text)).toEqual({ ok: false, error: 'no models advertised' })
  })

  it('POST /register stores the key, updates llm-pi-ai and reports the provider route', async () => {
    const bridge = fakeBridge()
    const ctx = fakeCtx()
    const { status, text } = await run(bridge, ctx, 'POST', '/api/dsh-codex-bridge/register')
    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({
      registered: true,
      keyStored: true,
      models: ['gpt-5.5', 'codex-mini'],
      route: PROVIDER_ROUTE,
    })
    expect(ctx.credentials.set).toHaveBeenCalledWith('DSH_API_PROXY_KEY', 'sk-test')
    expect(ctx.settings?.update).toHaveBeenCalledWith('llm-pi-ai', {
      providers: {
        [PROVIDER_ROUTE]: expect.objectContaining({ apiKeyEnv: 'DSH_API_PROXY_KEY', api: 'openai-completions', baseURL: 'http://127.0.0.1:8317' }),
      },
    })
  })

  it('POST /register answers 500 when the DSH settings service is unavailable', async () => {
    const bridge = fakeBridge()
    const { status, text } = await run(bridge, fakeCtx(false), 'POST', '/api/dsh-codex-bridge/register')
    expect(status).toBe(500)
    const parsed = JSON.parse(text) as { error: string }
    expect(parsed.error).toContain('DSH settings service unavailable')
  })
})
