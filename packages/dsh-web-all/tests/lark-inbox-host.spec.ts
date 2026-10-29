import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gateEvent } from '../src/core/lark-inbox/gating.ts'
import { toEnvelope } from '../src/core/lark-inbox/queue.ts'
import { Config, LARK_INBOX_GUIDANCE, register } from '../src/host/services/lark-inbox/index.ts'
import { bindFamilyConfig } from '../src/host/services/family-config.ts'
import { LarkGateway, type GatewaySdk } from '../src/host/services/lark-inbox/gateway.ts'
import { makeLarkWizardRoutes } from '../src/host/services/lark-inbox/host-routes.ts'
import { InboxStore } from '../src/host/services/lark-inbox/inbox-store.ts'
import { createInboxTools } from '../src/host/services/lark-inbox/tools.ts'
import { LarkWizard } from '../src/host/services/lark-inbox/wizard.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); bindFamilyConfig(undefined) })

function envelope(eventId: string) {
  return toEnvelope({
    header: { event_id: eventId },
    event: {
      sender: { sender_id: { open_id: 'ou_allowed' }, sender_type: 'user' },
      message: { message_id: `om_${eventId}`, chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: `message-${eventId}` },
    },
  }, { receivedAt: '2026-01-02T03:04:05.000Z' })
}

function request(method: string, body?: unknown, options: { remoteAddress?: string; host?: string; origin?: string } = {}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, {
    method,
    headers: { host: options.host ?? '127.0.0.1:3080', ...(options.origin ? { origin: options.origin } : {}) },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    destroy: vi.fn(),
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  })
  return req
}

function response() {
  const state = { status: 0, headers: {} as Record<string, string>, text: '' }
  const res = new EventEmitter() as unknown as ServerResponse
  Object.assign(res, {
    writeHead(status: number, headers?: Record<string, string>) { state.status = status; state.headers = headers ?? {}; return res },
    end(chunk?: string | Buffer) { state.text += chunk === undefined ? '' : String(chunk); return res },
  })
  return { res, state }
}

async function invoke(routes: ReturnType<typeof makeLarkWizardRoutes>, path: string, req: IncomingMessage) {
  const route = routes.find(item => item.path === path)
  if (!route) throw new Error(`missing route ${path}`)
  const { res, state } = response()
  await route.handler(req, res)
  return { ...state, json: state.text === '' ? undefined : JSON.parse(state.text) as unknown }
}

describe('lark inbox config and wizard route contracts', () => {
  it('keeps namespace defaults including announcement default false', () => {
    expect(Config({})).toEqual({
      enabled: true, announceToAgent: false, appId: '', appSecret: '', domain: 'feishu',
      requireMentionInGroup: true, allowedOpenIds: [], dropAppMessages: true,
      queueDir: '', maxAttempts: 5, staleTimeoutMs: 300_000,
    })
  })

  it('serves exact status/start/cancel/bind envelopes with no-store', async () => {
    const writes = vi.fn().mockResolvedValue(undefined)
    const wizard = new LarkWizard({ settingsWrite: writes })
    const routes = makeLarkWizardRoutes(wizard)

    const idle = await invoke(routes, '/lark-inbox/wizard/status', request('GET'))
    expect(idle).toMatchObject({ status: 200, json: { phase: 'idle' } })
    expect(idle.headers['cache-control']).toBe('no-store')

    const start = await invoke(routes, '/lark-inbox/wizard/start-bind', request('POST', { appId: 'cli_abc' }))
    expect(start).toMatchObject({ status: 200, json: { consoleUrl: 'https://open.feishu.cn/app/cli_abc' } })
    expect((await invoke(routes, '/lark-inbox/wizard/status', request('GET'))).json).toEqual({ phase: 'awaiting-secret', mode: 'bind', consoleUrl: 'https://open.feishu.cn/app/cli_abc' })

    expect((await invoke(routes, '/lark-inbox/wizard/finish-bind', request('POST', { appSecret: 'secret-value' }))).json).toEqual({ ok: true })
    expect(writes).toHaveBeenCalledWith({ appId: 'cli_abc', appSecret: 'secret-value' })
    expect((await invoke(routes, '/lark-inbox/wizard/cancel', request('POST'))).json).toEqual({ ok: true })
  })

  it('rejects non-loopback or cross-origin wizard/control requests', async () => {
    const routes = makeLarkWizardRoutes(new LarkWizard({ settingsWrite: vi.fn() }))
    const remote = await invoke(routes, '/lark-inbox/wizard/status', request('GET', undefined, { remoteAddress: '192.0.2.10' }))
    expect(remote).toMatchObject({ status: 403, json: { error: 'forbidden: loopback-only' } })
    const crossOrigin = await invoke(routes, '/lark-inbox/wizard/status', request('GET', undefined, { origin: 'http://attacker.invalid' }))
    expect(crossOrigin.status).toBe(403)
  })

  it('refuses the credential write while the feature is disabled', async () => {
    // 路由随服务域挂载（禁用不卸载路由），所以启用开关必须在守卫里生效：
    // 否则关闭的功能仍保留一条能写入 appSecret 的活口。
    const writes = vi.fn().mockResolvedValue(undefined)
    const wizard = new LarkWizard({ settingsWrite: writes })
    const routes = makeLarkWizardRoutes(wizard, () => true, () => false)

    const bound = await invoke(routes, '/lark-inbox/wizard/finish-bind', request('POST', { appSecret: 'secret-value' }))
    expect(bound).toMatchObject({ status: 409, json: { error: 'lark-inbox-disabled' } })
    expect(writes).not.toHaveBeenCalled()

    const started = await invoke(routes, '/lark-inbox/wizard/start-bind', request('POST', { appId: 'cli_abc' }))
    expect(started.status).toBe(409)

    const enabled = makeLarkWizardRoutes(wizard, () => true, () => true)
    expect((await invoke(enabled, '/lark-inbox/wizard/status', request('GET'))).status).toBe(200)
  })

  it('admits the deployment browser entry when the shared fence is injected', async () => {
    // The wizard drives a host-side Lark login, so it admits the same surface
    // as the other privileged panels instead of dying on `连接失败 /
    // forbidden: loopback-only` for every remote browser.
    const injected = makeLarkWizardRoutes(new LarkWizard({ settingsWrite: vi.fn() }), () => true)
    const admitted = await invoke(injected, '/lark-inbox/wizard/status', request('GET', undefined, { host: 'dsh.studio-mac', origin: 'http://dsh.studio-mac' }))
    expect(admitted).toMatchObject({ status: 200, json: { phase: 'idle' } })

    // Without injection the default stays the strict loopback rule.
    const strict = makeLarkWizardRoutes(new LarkWizard({ settingsWrite: vi.fn() }))
    const refused = await invoke(strict, '/lark-inbox/wizard/status', request('GET', undefined, { host: 'dsh.studio-mac', origin: 'http://dsh.studio-mac' }))
    expect(refused).toMatchObject({ status: 403, json: { error: 'forbidden: loopback-only' } })
  })
})

describe('JSONL + SQLite queue and tools', () => {
  it('supports peek/pop/ack, retry, dead-letter, and event-id dedup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'web-all-lark-'))
    roots.push(root)
    const store = InboxStore.open({ rootDir: root, maxAttempts: 2 })
    expect(store.append(envelope('evt-1'))).toBe('appended')
    expect(store.append(envelope('evt-1'))).toBe('duplicate')

    const tools = Object.fromEntries(createInboxTools(() => store).map(tool => [tool.name, tool]))
    const exec = { signal: new AbortController().signal } as never
    await expect(tools.lark_inbox_peek.execute({ limit: 10 }, exec)).resolves.toMatchObject({ pending: 1, processing: 0, dead: 0, items: [{ eventId: 'evt-1' }] })
    await expect(tools.lark_inbox_pop.execute({}, exec)).resolves.toMatchObject({ pending: 0, item: { eventId: 'evt-1', content: 'message-evt-1' } })
    await expect(tools.lark_inbox_ack.execute({ event_id: 'evt-1', ok: false }, exec)).resolves.toEqual({ status: 'pending' })
    await tools.lark_inbox_pop.execute({}, exec)
    await expect(tools.lark_inbox_ack.execute({ event_id: 'evt-1', ok: false }, exec)).resolves.toEqual({ status: 'pending' })
    expect(store.stats()).toEqual({ pending: 0, processing: 0, done: 0, dead: 1, total: 1 })
    await expect(tools.lark_inbox_ack.execute({ event_id: 'missing', ok: true }, exec)).resolves.toEqual({ status: 'done' })
    store.close()
  })

  it('returns the structured not-running envelope when disabled/unconfigured', async () => {
    const tools = createInboxTools(() => undefined)
    for (const tool of tools) {
      const args = tool.name === 'lark_inbox_ack' ? { event_id: 'evt', ok: true } : {}
      await expect(tool.execute(args, { signal: new AbortController().signal } as never)).resolves.toEqual({ error: expect.stringContaining('未运行') })
    }
  })
})

describe('gateway conversion and gating', () => {
  it('uses the injected WSClient seam and dispatches the subscribed event', async () => {
    let handler: ((event: unknown) => void) | undefined
    const close = vi.fn()
    const start = vi.fn().mockResolvedValue(undefined)
    const onEvent = vi.fn()
    const sdk: GatewaySdk = {
      domain: { Feishu: 0, Lark: 1 },
      createDispatcher: () => ({ register(handlers) { handler = handlers['im.message.receive_v1']; return { handlers } } }),
      createClient: options => { expect(options).toMatchObject({ appId: 'cli_a', appSecret: 'secret', domain: 0, wsConfig: { pingTimeout: 3 } }); return { start, close } },
    }
    const gateway = new LarkGateway({ appId: 'cli_a', appSecret: 'secret', sdk, onEvent })
    await gateway.start()
    handler?.({ message: { mentions: [{ id: { open_id: 'ou_bot' } }] } })
    expect(onEvent).toHaveBeenCalledWith(expect.any(Object), { mentionBot: true })
    await gateway.stop()
    expect(close).toHaveBeenCalledOnce()
  })

  it('gates app messages, unmentioned groups, and non-allowlisted senders in order', () => {
    const config = { dropAppMessages: true, requireMentionInGroup: true, allowedOpenIds: ['ou_allowed'] }
    expect(gateEvent({ senderType: 'app', chatType: 'group' }, config)).toEqual({ accept: false, reason: 'app-message' })
    expect(gateEvent({ senderType: 'user', chatType: 'group', senderOpenId: 'ou_allowed' }, config)).toEqual({ accept: false, reason: 'group-without-mention' })
    expect(gateEvent({ senderType: 'user', chatType: 'p2p', senderOpenId: 'ou_other' }, config)).toEqual({ accept: false, reason: 'sender-not-allowed' })
    expect(gateEvent({ senderType: 'user', chatType: 'group', senderOpenId: 'ou_allowed', mentionBot: true }, config)).toEqual({ accept: true })
  })
})

describe('gateway late-start rollback', () => {
  it('closes a client whose SDK startup completes after stop and ignores late messages', async () => {
    let ready!: () => void
    let handler!: (data: unknown) => void
    const close = vi.fn()
    const onEvent = vi.fn()
    const sdk = {
      domain: { Feishu: 'feishu', Lark: 'lark' },
      createClient: () => ({ start: () => new Promise<void>(resolve => { ready = resolve }), close }),
      createDispatcher: () => ({ register: (events: Record<string, (data: unknown) => void>) => {
        handler = events['im.message.receive_v1']!
        return {}
      } }),
    } as unknown as GatewaySdk
    const gateway = new LarkGateway({ appId: 'test', appSecret: 'test-only', sdk, onEvent })
    const starting = gateway.start()
    await gateway.stop()
    ready()
    await starting
    handler({ message: 'late' })
    expect(close).toHaveBeenCalledOnce()
    expect(onEvent).not.toHaveBeenCalled()
    expect(gateway.isRunning()).toBe(false)
  })
})

describe('runtime settings and optional announcement', () => {
  function context(config: Record<string, unknown>) {
    // 0.2 reads the capability config through the family bridge (the loader's
    // resolved `web-all` entry), so the harness binds that entry directly.
    bindFamilyConfig({ 'lark-inbox': config })
    const definitions: Array<{ name: string; execute: Function }> = []
    const sections: Array<{ name: string; order: number; text: string }> = []
    const routes: string[] = []
    const ctx = {
      logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      get: () => ({ update: vi.fn().mockResolvedValue(undefined) }),
      settings: { get: () => config },
      tools: { register: (definition: { name: string; execute: Function }) => { definitions.push(definition); return vi.fn() } },
      systemPrompt: { section: (section: { name: string; order: number; text: string }) => { sections.push(section); return vi.fn() } },
      webServer: { register: (route: { path: string }) => { routes.push(route.path); return vi.fn() } },
    }
    return { ctx, definitions, sections, routes }
  }

  it('keeps disabled and unconfigured runtimes inert while tools/routes remain registered', () => {
    for (const config of [{ enabled: false }, { enabled: true, appId: '', appSecret: '' }]) {
      const { ctx, definitions, sections, routes } = context(config)
      const createStore = vi.fn()
      const createGateway = vi.fn()
      const dispose = register(ctx as never, {}, { createStore, createGateway })
      expect(definitions.map(tool => tool.name)).toEqual(['lark_inbox_peek', 'lark_inbox_pop', 'lark_inbox_ack'])
      expect(routes).toEqual(expect.arrayContaining(['/lark-inbox/wizard/status', '/lark-inbox/wizard/start-new', '/lark-inbox/wizard/cancel']))
      expect(createStore).not.toHaveBeenCalled()
      expect(createGateway).not.toHaveBeenCalled()
      expect(sections).toEqual([])
      dispose()
    }
  })

  it('rolls back tools and earlier routes when a later route cannot register', () => {
    const { ctx } = context({ enabled: false })
    const releaseTool = vi.fn()
    const releaseRoute = vi.fn()
    ctx.tools.register = () => releaseTool
    let routes = 0
    ctx.webServer.register = () => {
      if (++routes === 2) throw new Error('route conflict')
      return releaseRoute
    }
    expect(() => register(ctx as never)).toThrow('route conflict')
    expect(releaseTool).toHaveBeenCalledTimes(3)
    expect(releaseRoute).toHaveBeenCalledOnce()
  })

  it('closes an opened queue if gateway construction fails', () => {
    const { ctx } = context({ enabled: true, appId: 'cli_a', appSecret: 'test-only' })
    const close = vi.fn()
    const store = { close } as unknown as InboxStore
    expect(() => register(ctx as never, {}, {
      createStore: () => store,
      createGateway: () => { throw new Error('gateway unavailable') },
    })).toThrow('gateway unavailable')
    expect(close).toHaveBeenCalledOnce()
  })

  it('registers the original guidance only when announceToAgent is true', () => {
    const { ctx, sections } = context({ enabled: true, announceToAgent: true, appId: 'cli_a', appSecret: 'secret' })
    const store = { append: vi.fn(), close: vi.fn() } as unknown as InboxStore
    const gateway = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined), isRunning: () => true }
    const dispose = register(ctx as never, {}, { createStore: () => store, createGateway: () => gateway })
    expect(sections).toEqual([{ name: 'plugin:lark-inbox', order: 210, text: LARK_INBOX_GUIDANCE }])
    dispose()
  })
})
