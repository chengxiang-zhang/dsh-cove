/**
 * Notification capability contracts.
 *
 * The capability has three consumers that cannot see its types (a desktop app,
 * a mobile app, and the browser settings card), so most of what is worth
 * pinning here is wire behaviour and event-derived decisions rather than
 * internal structure: what a malformed feed degrades to, which turns become
 * notices, and what a person is actually told.
 */

import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NOTIFY_FEED_PATH,
  NOTIFY_MAX_LIMIT,
  OUTCOME_LABEL_ZH,
  clampLimit,
  clampWatermark,
  outcomeOf,
  parseFeed,
  parseRunNotice,
  reconcileWatermark,
  newNotices,
  type RunNotice,
} from '../src/core/notify/contract.ts'
import { NoticeLog, TitleBook, excerpt, textOfContent } from '../src/core/notify/feed.ts'
import { composeFeishuText, FeishuSender, type FeishuSenderSdk } from '../src/host/services/notify/feishu-sender.ts'
import { makeNotifyRoutes, readFeedQuery, requestAuthority } from '../src/host/services/notify/host-routes.ts'
import { register as registerAccessTrust, accessTrustOf } from '../src/host/services/access-trust/index.ts'
import { effectiveConfig, normalizeRecipients, resolveFeishuCredentials, resolveSecret } from '../src/host/services/notify/config.ts'
import { isSubagentSession, register, type NotifySender } from '../src/host/services/notify/index.ts'
import { bindFamilyConfig, notifyFamilyConfigChange } from '../src/host/services/family-config.ts'

afterEach(() => { bindFamilyConfig(undefined) })

const flush = async (): Promise<void> => { await new Promise(resolve => { setTimeout(resolve, 0) }) }

/** A stored notice with every field, for tests that need an exact shape. */
function notice(overrides: Partial<RunNotice> = {}): RunNotice {
  return { id: 1, at: 1_700_000_000_000, sessionId: 'session-1', title: '', turn: 1, reason: 'completed', outcome: 'completed', ...overrides }
}

/** A request shaped like the ones the web server hands a route. */
function request(
  method: string,
  url = NOTIFY_FEED_PATH,
  options: { remoteAddress?: string; host?: string; origin?: string; site?: string } = {},
): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, {
    method,
    url,
    headers: {
      host: options.host ?? '127.0.0.1:3080',
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.site === undefined ? {} : { 'sec-fetch-site': options.site }),
    },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    destroy: vi.fn(),
  })
  return req
}

/** A response recording what a handler wrote, so assertions read the wire body. */
function response() {
  const state = { status: 0, headers: {} as Record<string, string>, text: '' }
  const res = new EventEmitter() as unknown as ServerResponse
  Object.assign(res, {
    writeHead(status: number, headers?: Record<string, string>) { state.status = status; state.headers = headers ?? {}; return res },
    end(chunk?: string | Buffer) { state.text += chunk === undefined ? '' : String(chunk); return res },
  })
  return { res, state }
}

describe('outcome collapse', () => {
  it('maps every reason this build knows and keeps an unknown one neutral', () => {
    expect(outcomeOf('completed')).toBe('completed')
    expect(outcomeOf('max-tokens')).toBe('completed')
    expect(outcomeOf('error')).toBe('failed')
    expect(outcomeOf('blocked')).toBe('failed')
    expect(outcomeOf('aborted')).toBe('stopped')
    expect(outcomeOf('interrupted')).toBe('stopped')
    expect(outcomeOf('forked')).toBe('stopped')
    // A plugin that merged a new variant into TurnEndReasonMap must not be
    // reported as success: nobody has inspected what that closure means.
    expect(outcomeOf('handoff')).toBe('stopped')
    expect(outcomeOf('')).toBe('stopped')
  })

  it('labels every outcome in the shared dictionary', () => {
    expect(Object.keys(OUTCOME_LABEL_ZH).sort()).toEqual(['completed', 'failed', 'stopped'])
  })
})

describe('query and watermark clamping', () => {
  it('clamps a limit into the range the host will answer', () => {
    expect(clampLimit(undefined)).toBe(20)
    expect(clampLimit('')).toBe(20)
    expect(clampLimit('nonsense')).toBe(20)
    expect(clampLimit('0')).toBe(1)
    expect(clampLimit('-5')).toBe(1)
    expect(clampLimit('7')).toBe(7)
    expect(clampLimit('100000')).toBe(NOTIFY_MAX_LIMIT)
    expect(clampLimit('2.9')).toBe(2)
  })

  it('treats an unusable watermark as nothing seen', () => {
    expect(clampWatermark(undefined)).toBe(0)
    expect(clampWatermark('oops')).toBe(0)
    expect(clampWatermark('-1')).toBe(0)
    expect(clampWatermark('12')).toBe(12)
    expect(clampWatermark(12.7)).toBe(12)
  })

  it('restarts from zero when the host that served the ids has restarted', () => {
    expect(reconcileWatermark(10, 12)).toBe(10)
    expect(reconcileWatermark(10, 10)).toBe(10)
    // A restart renumbers from 1. Keeping 10 would hide every new notice forever.
    expect(reconcileWatermark(10, 3)).toBe(0)
    expect(reconcileWatermark(0, 3)).toBe(0)
  })

  it('returns only unseen notices under that rule', () => {
    const feed = { origin: 'dsh.a.netbird', latest: 3, notices: [notice({ id: 1 }), notice({ id: 2 }), notice({ id: 3 })] }
    expect(newNotices(feed, 1).map(item => item.id)).toEqual([2, 3])
    expect(newNotices(feed, 3)).toEqual([])
    expect(newNotices(feed, 9).map(item => item.id)).toEqual([1, 2, 3])
  })
})

describe('feed parsing for clients that do not share the types', () => {
  it('re-derives every field and defaults an absent outcome from the reason', () => {
    expect(parseRunNotice({ id: '5', at: '123', sessionId: 's', title: 't', turn: '2', reason: 'error' }))
      .toEqual({ id: 5, at: 123, sessionId: 's', title: 't', turn: 2, reason: 'error', outcome: 'failed' })
    // Non-objects are dropped rather than becoming a notice full of undefined.
    expect(parseRunNotice('nope')).toBeNull()
    expect(parseRunNotice(null)).toBeNull()
    expect(parseRunNotice([1, 2])).toBeNull()
  })

  it('degrades a malformed element instead of failing the whole read', () => {
    const parsed = parseRunNotice({})
    expect(parsed).toEqual({ id: 0, at: 0, sessionId: '', title: '', turn: 0, reason: '', outcome: 'stopped' })
  })

  it('narrows a whole document and survives a body that is not one', () => {
    const feed = parseFeed({ origin: 'dsh.a.netbird', latest: 4, notices: [{ id: 4, reason: 'completed' }, 'garbage'] })
    expect(feed).not.toBeNull()
    expect(feed?.origin).toBe('dsh.a.netbird')
    expect(feed?.latest).toBe(4)
    expect(feed?.notices).toHaveLength(1)
    // A feed that omitted `latest` still reports the newest id it did carry.
    expect(parseFeed({ notices: [{ id: 7 }] })?.latest).toBe(7)
    expect(parseFeed('not a feed')).toBeNull()
    expect(parseFeed(null)).toBeNull()
    expect(parseFeed({})?.notices).toEqual([])
  })
})

describe('notice log', () => {
  it('assigns increasing ids, evicts the oldest, and keeps a stale watermark meaningful', () => {
    const log = new NoticeLog(3)
    for (let i = 1; i <= 5; i += 1) log.append({ at: i, sessionId: 's', title: '', turn: i, reason: 'completed' })
    expect(log.latest).toBe(5)
    expect(log.size).toBe(3)
    expect(log.snapshot().map(item => item.id)).toEqual([3, 4, 5])
    // 4 was evicted, so asking for everything after 1 yields what is held.
    expect(log.since(1, 10).map(item => item.id)).toEqual([3, 4, 5])
    expect(log.since(4, 10).map(item => item.id)).toEqual([5])
    expect(log.since(0, 2).map(item => item.id)).toEqual([3, 4])
    expect(log.latest).toBe(5)
  })

  it('never resets its counter, so a cleared log cannot re-issue an id', () => {
    const log = new NoticeLog(2)
    log.append({ at: 1, sessionId: 's', title: '', turn: 1, reason: 'completed' })
    log.clear()
    expect(log.size).toBe(0)
    expect(log.append({ at: 2, sessionId: 's', title: '', turn: 2, reason: 'completed' }).id).toBe(2)
  })

  it('derives the outcome from the reason when the caller does not supply one', () => {
    const log = new NoticeLog(5)
    expect(log.append({ at: 1, sessionId: 's', title: '', turn: 1, reason: 'blocked' }).outcome).toBe('failed')
    expect(log.append({ at: 1, sessionId: 's', title: '', turn: 2, reason: 'completed', outcome: 'completed' }).outcome).toBe('completed')
  })
})

describe('title memory', () => {
  it('prefers a real title over the first prompt and keeps the first prompt', () => {
    const book = new TitleBook(4)
    book.rememberPrompt('s1', 'first question')
    book.rememberPrompt('s1', 'a later follow-up')
    expect(book.titleOf('s1')).toBe('first question')
    book.setTitle('s1', 'Fix the login page')
    expect(book.titleOf('s1')).toBe('Fix the login page')
    expect(book.titleOf('unknown')).toBe('')
    // A blank update must not erase a name.
    book.setTitle('s1', '   ')
    expect(book.titleOf('s1')).toBe('Fix the login page')
  })

  it('evicts the least recently written session and forgets the rest', () => {
    const book = new TitleBook(2)
    book.rememberPrompt('a', 'a')
    book.rememberPrompt('b', 'b')
    // Eviction follows the last write, so `a` is the candidate; a read does not
    // reorder anything, which keeps `titleOf` free of side effects.
    book.rememberPrompt('c', 'c')
    expect(book.size).toBe(2)
    expect(book.titleOf('a')).toBe('')
    expect(book.titleOf('b')).toBe('b')
    // Writing to `b` makes it the most recent, so `c` becomes the candidate.
    book.rememberPrompt('b', 'ignored because the first prompt wins')
    book.rememberPrompt('d', 'd')
    expect(book.titleOf('c')).toBe('')
    expect(book.titleOf('b')).toBe('b')
    book.forget('b')
    expect(book.titleOf('b')).toBe('')
    book.clear()
    expect(book.size).toBe(0)
  })

  it('collapses whitespace and truncates on code points', () => {
    expect(excerpt('  a\n\n b  ', 40)).toBe('a b')
    expect(excerpt('abcdef', 4)).toBe('abc…')
    expect(excerpt('abc', 4)).toBe('abc')
    // Truncation counts code points, not UTF-16 units, so a surrogate pair is
    // never split into a broken character.
    expect([...excerpt('1234567890', 5)].length).toBe(5)
  })

  it('quotes only text blocks, never a serialized non-text block', () => {
    expect(textOfContent([{ type: 'text', text: 'hello' }, { type: 'image', url: 'x' }, { type: 'text', text: 'world' }])).toBe('hello world')
    expect(textOfContent([{ type: 'image', url: 'x' }])).toBe('')
    expect(textOfContent('not an array')).toBe('')
    expect(textOfContent(undefined)).toBe('')
  })
})

describe('Feishu message composition', () => {
  it('states how it ended, which conversation, and which machine', () => {
    expect(composeFeishuText([notice({ title: 'Fix the login page' })], 'leo-mbp')).toBe('运行结束：已完成\n会话：Fix the login page\n机器：leo-mbp')
  })

  it('omits the conversation line when nothing named it', () => {
    expect(composeFeishuText([notice({ title: '' })], 'leo-mbp')).toBe('运行结束：已完成\n机器：leo-mbp')
  })

  it('collapses a batch into one message that says how many', () => {
    const text = composeFeishuText([
      notice({ id: 1, title: 'Fix the login page', outcome: 'completed' }),
      notice({ id: 2, title: 'Deploy', outcome: 'failed' }),
      notice({ id: 3, title: '', outcome: 'stopped' }),
    ], 'leo-mbp')
    expect(text).toBe('3 个会话运行结束\n- 已完成 · Fix the login page\n- 出错 · Deploy\n- 已结束\n机器：leo-mbp')
  })

  it('never invents a machine line it was not given', () => {
    expect(composeFeishuText([notice({ title: 'x' })], '')).toBe('运行结束：已完成\n会话：x')
    expect(composeFeishuText([], 'leo-mbp')).toBe('机器：leo-mbp')
  })
})

describe('Feishu sender', () => {
  function sdkSpy() {
    const create = vi.fn().mockResolvedValue({ code: 0 })
    const createClient = vi.fn(() => ({ im: { message: { create } } }))
    const sdk = { domain: { Feishu: 0, Lark: 1 }, createClient } as unknown as FeishuSenderSdk
    return { sdk, createClient, create }
  }

  const credentials = { appId: 'cli_x', appSecret: 'secret', domain: 'feishu' as const, source: 'notify' as const }

  it('addresses every recipient as open_id with a text body and no gap when it is the first call', async () => {
    const { sdk, create, createClient } = sdkSpy()
    const sender = new FeishuSender({ credentials, recipients: ['ou_a', 'ou_b'], hostLabel: 'm', sdk, minGapMs: 0 })
    const attempts = await sender.send('hello')
    expect(attempts).toEqual([{ recipient: 'ou_a', ok: true }, { recipient: 'ou_b', ok: true }])
    expect(createClient).toHaveBeenCalledWith({ appId: 'cli_x', appSecret: 'secret', domain: 0 })
    expect(create).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenNthCalledWith(1, {
      params: { receive_id_type: 'open_id' },
      data: { receive_id: 'ou_a', msg_type: 'text', content: JSON.stringify({ text: 'hello' }) },
    })
  })

  it('reports a business error the SDK resolved instead of throwing', async () => {
    const { sdk, create } = sdkSpy()
    create.mockResolvedValue({ code: 99991400, msg: 'rate limited' })
    const sender = new FeishuSender({ credentials, recipients: ['ou_a'], hostLabel: 'm', sdk, minGapMs: 0 })
    const attempts = await sender.send('hello')
    expect(attempts).toEqual([{ recipient: 'ou_a', ok: false, error: 'feishu code 99991400: rate limited' }])
  })

  it('contains a thrown failure and keeps serving later recipients', async () => {
    const { sdk, create } = sdkSpy()
    create.mockRejectedValueOnce(new Error('network down')).mockResolvedValue({ code: 0 })
    const sender = new FeishuSender({ credentials, recipients: ['ou_a', 'ou_b'], hostLabel: 'm', sdk, minGapMs: 0 })
    const attempts = await sender.send('hello')
    expect(attempts).toEqual([{ recipient: 'ou_a', ok: false, error: 'network down' }, { recipient: 'ou_b', ok: true }])
  })

  it('waits out the application rate limit between calls', async () => {
    const { sdk, create } = sdkSpy()
    const slept: number[] = []
    let clock = 1_000
    const sender = new FeishuSender({
      credentials,
      recipients: ['ou_a', 'ou_b', 'ou_c'],
      hostLabel: 'm',
      sdk,
      minGapMs: 250,
      now: () => clock,
      sleep: async (ms) => { slept.push(ms); clock += ms },
    })
    await sender.send('hello')
    expect(create).toHaveBeenCalledTimes(3)
    // Three calls serialize to two gaps of the full interval.
    expect(slept).toEqual([250, 250])
  })

  it('does nothing at all without a recipient or without text', async () => {
    const { sdk, create, createClient } = sdkSpy()
    const sender = new FeishuSender({ credentials, recipients: [], hostLabel: 'm', sdk })
    expect(await sender.send('hello')).toEqual([])
    const named = new FeishuSender({ credentials, recipients: ['ou_a'], hostLabel: 'm', sdk })
    expect(await named.send('   ')).toEqual([])
    expect(create).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('logs a failure and stays silent on success', async () => {
    const { sdk, create } = sdkSpy()
    const messages: string[] = []
    const sender = new FeishuSender({ credentials, recipients: ['ou_a', 'ou_b'], hostLabel: 'm', sdk, minGapMs: 0, log: message => { messages.push(message) } })
    await sender.notify([notice()])
    expect(messages).toEqual(['dsh-notify: 已推送 2 条飞书通知'])

    messages.length = 0
    create.mockRejectedValue(new Error('boom'))
    await sender.notify([notice()])
    expect(messages).toEqual([
      'dsh-notify: 推送给 ou_a 失败：boom',
      'dsh-notify: 推送给 ou_b 失败：boom',
    ])
  })

  it('sends nothing for an empty batch', async () => {
    const { sdk, create } = sdkSpy()
    const sender = new FeishuSender({ credentials, recipients: ['ou_a'], hostLabel: 'm', sdk, minGapMs: 0 })
    await sender.notify([])
    expect(create).not.toHaveBeenCalled()
  })
})

describe('credential resolution', () => {
  it('prefers this capability own application and otherwise borrows the inbox bot', () => {
    const env = {}
    expect(resolveFeishuCredentials({ feishuAppId: 'cli_send', feishuAppSecret: 's1' }, { appId: 'cli_inbox', appSecret: 's2' }, env))
      .toEqual({ appId: 'cli_send', appSecret: 's1', domain: 'feishu', source: 'notify' })
    expect(resolveFeishuCredentials({}, { appId: 'cli_inbox', appSecret: 's2', domain: 'lark' }, env))
      .toEqual({ appId: 'cli_inbox', appSecret: 's2', domain: 'lark', source: 'lark-inbox' })
    expect(resolveFeishuCredentials({}, {}, env)).toBeNull()
    expect(resolveFeishuCredentials(undefined, undefined, env)).toBeNull()
  })

  it('reads an env: reference and refuses one that names nothing', () => {
    expect(resolveSecret('env:MY_SECRET', undefined, { MY_SECRET: 'value' })).toBe('value')
    expect(() => resolveSecret('env:', undefined, {})).toThrow(/缺少变量名/)
    expect(() => resolveSecret('env:MISSING', undefined, {})).toThrow(/MISSING 未设置或为空/)
    expect(resolveSecret('', 'AMBIENT', { AMBIENT: 'from-env' })).toBe('from-env')
    expect(resolveSecret('', 'AMBIENT', {})).toBe('')
    expect(resolveSecret('literal', 'AMBIENT', { AMBIENT: 'from-env' })).toBe('literal')
  })

  it('normalizes a recipient list', () => {
    expect(normalizeRecipients([' ou_a ', 'ou_a', '', 'ou_b'])).toEqual(['ou_a', 'ou_b'])
    expect(normalizeRecipients(undefined)).toEqual([])
  })

  it('fills every default so a partial namespace value is usable', () => {
    expect(effectiveConfig({ enabled: false })).toMatchObject({
      enabled: false, feedLimit: 20, feishuEnabled: false, feishuRecipients: [], feishuMode: 'idle', feishuOutcomes: ['completed', 'failed'],
    })
  })
})

describe('feed route', () => {
  async function invoke(routes: ReturnType<typeof makeNotifyRoutes>, req: IncomingMessage) {
    const route = routes[0]
    if (route === undefined) throw new Error('no route')
    const { res, state } = response()
    await route.handler(req, res)
    return { ...state, json: state.text === '' ? undefined : JSON.parse(state.text) as Record<string, unknown> }
  }

  function routesWith(log = new NoticeLog(5), overrides: Partial<Parameters<typeof makeNotifyRoutes>[0]> = {}) {
    return makeNotifyRoutes({ log: () => log, defaultLimit: () => 20, ...overrides })
  }

  it('serves the contract path, oldest unseen first, with no-store', async () => {
    const log = new NoticeLog(5)
    for (let i = 1; i <= 3; i += 1) log.append({ at: i, sessionId: 's', title: 't', turn: i, reason: 'completed' })
    const answer = await invoke(routesWith(log), request('GET', `${NOTIFY_FEED_PATH}?since=1`))
    expect(answer.status).toBe(200)
    expect(answer.headers['cache-control']).toBe('no-store')
    expect(answer.json).toMatchObject({ origin: '127.0.0.1:3080', latest: 3 })
    expect((answer.json?.notices as RunNotice[]).map(item => item.id)).toEqual([2, 3])
  })

  it('refuses a request the fence rejects, and reports a disabled capability', async () => {
    const remote = await invoke(routesWith(), request('GET', NOTIFY_FEED_PATH, { remoteAddress: '192.0.2.10' }))
    expect(remote).toMatchObject({ status: 403, json: { error: 'forbidden' } })

    const disabled = await invoke(routesWith(new NoticeLog(5), { enabled: () => false }), request('GET'))
    expect(disabled).toMatchObject({ status: 409, json: { error: 'notify-disabled' } })
  })

  it('rejects a non-GET and clamps the query it is handed', async () => {
    const log = new NoticeLog(50)
    log.append({ at: 1, sessionId: 's', title: '', turn: 1, reason: 'completed' })
    const posted = await invoke(routesWith(log), request('POST'))
    expect(posted).toMatchObject({ status: 405, json: { error: 'method-not-allowed' } })

    const clamped = await invoke(routesWith(log, { defaultLimit: () => 1 }), request('GET', `${NOTIFY_FEED_PATH}?since=-4&limit=9999`))
    expect(clamped.status).toBe(200)
    expect(clamped.json?.notices).toHaveLength(1)
  })

  it('reports the authority the caller dialed, and nothing when the header is unusable', () => {
    expect(requestAuthority(request('GET', NOTIFY_FEED_PATH, { host: 'dsh.studio-mac.netbird' }))).toBe('dsh.studio-mac.netbird')
    expect(requestAuthority(request('GET', NOTIFY_FEED_PATH, { host: 'dsh.studio-mac.netbird/evil' }))).toBe('')
    expect(requestAuthority(request('GET', NOTIFY_FEED_PATH, { host: 'has space' }))).toBe('')
    expect(requestAuthority(request('GET', NOTIFY_FEED_PATH, { host: '' }))).toBe('')
    expect(requestAuthority(request('GET', NOTIFY_FEED_PATH, { host: 'x'.repeat(300) }))).toBe('')
  })

  it('reads its query from a URL it can parse and survives one it cannot', () => {
    expect(readFeedQuery(request('GET', `${NOTIFY_FEED_PATH}?since=3&limit=4`), 20)).toEqual({ since: 3, limit: 4 })
    expect(readFeedQuery(request('GET', NOTIFY_FEED_PATH), 7)).toEqual({ since: 0, limit: 7 })
    const broken = request('GET')
    Object.assign(broken, { url: 'http://[unparseable' })
    expect(readFeedQuery(broken, 7)).toEqual({ since: 0, limit: 7 })
  })

  it('answers a real request over a real socket', async () => {
    // The handler is also driven directly above, but a socket proves the parts
    // that only exist on the wire: the fence reading a real peer address and Host
    // header, the response headers, and the JSON a client actually parses.
    const log = new NoticeLog(5)
    log.append({ at: 1, sessionId: 's1', title: 'Fix the login page', turn: 1, reason: 'completed' })
    const route = routesWith(log)[0]
    if (route === undefined) throw new Error('feed route missing')
    const server = createServer((req, res) => { void route.handler(req, res) })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no bound port')
      const answer = await fetch(`http://127.0.0.1:${address.port}${NOTIFY_FEED_PATH}?since=0`)
      expect(answer.status).toBe(200)
      expect(answer.headers.get('content-type')).toContain('application/json')
      expect(answer.headers.get('cache-control')).toBe('no-store')
      const body = parseFeed(await answer.json())
      expect(body?.origin).toBe(`127.0.0.1:${address.port}`)
      expect(body?.latest).toBe(1)
      expect(body?.notices).toEqual([{ id: 1, at: 1, sessionId: 's1', title: 'Fix the login page', turn: 1, reason: 'completed', outcome: 'completed' }])
    } finally {
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
  })
})

describe('feed route fence topologies', () => {
  // docs/remote-access.md invariant 2: a new privileged route family is proven
  // against the deployment's canonical authority, a forged Host, a sessionless
  // remote browser, and a loopback page. The service wires the fence through
  // `accessTrustOf(ctx)`, so these cases drive that exact path rather than an
  // injected predicate.
  const CANONICAL = 'dsh.studio-mac.netbird'

  function deployment(authenticated: boolean) {
    const store = new Map<string, unknown>([
      ['webRuntime', { trustedHosts: [CANONICAL] }],
      ['connection', { browserAuth: { isAuthenticated: vi.fn(() => authenticated) } }],
    ])
    const ctx = {
      get: (name: string, strict?: boolean) => {
        if (store.has(name)) return store.get(name)
        if (strict === false) return undefined
        throw new Error(`service not found: ${name}`)
      },
      provide: (name: string, value: unknown) => { store.set(name, value); return () => { store.delete(name) } },
      webServer: { register: () => () => {} },
      logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    }
    registerAccessTrust(ctx as never)
    return ctx as never
  }

  function routesFor(ctx: never) {
    const log = new NoticeLog(5)
    log.append({ at: 1, sessionId: 's1', title: 't', turn: 1, reason: 'completed' })
    return makeNotifyRoutes({
      log: () => log,
      defaultLimit: () => 20,
      isTrusted: r => accessTrustOf(ctx).isTrusted(r),
    })
  }

  async function statusOf(ctx: never, req: IncomingMessage): Promise<number> {
    const route = routesFor(ctx)[0]
    if (route === undefined) throw new Error('feed route missing')
    const { res, state } = response()
    await route.handler(req, res)
    return state.status
  }

  it('admits a loopback page', async () => {
    expect(await statusOf(deployment(false), request('GET', NOTIFY_FEED_PATH, { host: '127.0.0.1:3080' }))).toBe(200)
  })

  it('admits the deployment authority when the browser carries a session', async () => {
    const req = request('GET', NOTIFY_FEED_PATH, { host: CANONICAL, origin: `http://${CANONICAL}` })
    expect(await statusOf(deployment(true), req)).toBe(200)
  })

  it('refuses a sessionless remote browser on an otherwise declared authority', async () => {
    const req = request('GET', NOTIFY_FEED_PATH, { host: CANONICAL, origin: `http://${CANONICAL}` })
    expect(await statusOf(deployment(false), req)).toBe(403)
  })

  it('refuses a forged Host even when the browser is authenticated', async () => {
    const forged = request('GET', NOTIFY_FEED_PATH, { host: 'evil.example.com', origin: 'http://evil.example.com' })
    expect(await statusOf(deployment(true), forged)).toBe(403)
    // A cross-site marker is refused on the loopback page too.
    expect(await statusOf(deployment(false), request('GET', NOTIFY_FEED_PATH, { site: 'cross-site' }))).toBe(403)
    // Without the fence service the family falls back to strict loopback, so a
    // declared authority is not admitted just because it is declared.
    const bare = { get: () => undefined, provide: () => () => {}, webServer: { register: () => () => {} }, logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }
    expect(await statusOf(bare as never, request('GET', NOTIFY_FEED_PATH, { host: CANONICAL, origin: `http://${CANONICAL}` }))).toBe(403)
  })

  it('keeps the feed closed while the capability is disabled, even for a trusted caller', async () => {
    const ctx = deployment(true)
    const route = makeNotifyRoutes({
      log: () => new NoticeLog(5),
      defaultLimit: () => 20,
      isTrusted: r => accessTrustOf(ctx).isTrusted(r),
      enabled: () => false,
    })[0]
    if (route === undefined) throw new Error('feed route missing')
    const { res, state } = response()
    await route.handler(request('GET', NOTIFY_FEED_PATH, { host: CANONICAL, origin: `http://${CANONICAL}` }), res)
    expect(state.status).toBe(409)
  })
})

describe('subagent detection', () => {
  it('treats either durable marker as a child and a top-level session as none', () => {
    expect(isSubagentSession({ header: { origin: 'subagent' } })).toBe(true)
    expect(isSubagentSession({ header: { delegationDepth: 1 } })).toBe(true)
    expect(isSubagentSession({ header: { delegationDepth: 0 } })).toBe(false)
    expect(isSubagentSession({ header: {} })).toBe(false)
    expect(isSubagentSession({})).toBe(false)
    expect(isSubagentSession(undefined)).toBe(false)
  })
})

describe('notification service', () => {
  function harness(config: Record<string, unknown>, deps: Parameters<typeof register>[2] = {}) {
    bindFamilyConfig({ notify: config })
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const mounted: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }> = []
    const releases: Array<() => void> = []
    const warnings: string[] = []
    const ctx = {
      logger: () => ({ info: vi.fn(), warn: (format: string) => { warnings.push(format) }, error: vi.fn() }),
      // A real deployment always has the shared fence mounted, so the harness
      // supplies one; the fence's own behaviour is pinned in its own tests.
      get: (name: string) => name === 'webAllAccessTrust' ? { isTrusted: () => true } : undefined,
      on: (name: string, handler: (...args: unknown[]) => void) => {
        handlers.set(name, handler)
        const release = vi.fn()
        releases.push(release)
        return release
      },
      webServer: {
        register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => {
          mounted.push(route)
          const release = vi.fn()
          releases.push(release)
          return release
        },
      },
    }
    const dispose = register(ctx as never, {}, deps)
    const emit = (name: string, ...args: unknown[]) => { handlers.get(name)?.(...args) }
    const session = (id: string, header: Record<string, unknown> = {}) => ({ id, header })
    const step = (turn: number, at: number) => ({ type: 'step/start', data: { turn }, time: at })
    const end = (turn: number, kind: string, at: number) => ({ type: 'turn/end', data: { turn, reason: { kind } }, time: at })
    return { dispose, emit, session, step, end, mounted, routes: mounted.map(route => route.path), releases, warnings }
  }

  function senderSpy(): NotifySender & { notify: ReturnType<typeof vi.fn> } {
    return { notify: vi.fn().mockResolvedValue(undefined), recipients: ['ou_a'], domain: 'feishu' }
  }

  it('mounts the one read route and releases everything the context handed over', () => {
    const { dispose, routes, releases } = harness({})
    expect(routes).toEqual([NOTIFY_FEED_PATH])
    dispose()
    // Three event subscriptions plus the route registration; the settings
    // listener is owned by the family bridge, not by this context.
    expect(releases).toHaveLength(4)
    for (const release of releases) expect(release).toHaveBeenCalled()
  })

  it('records a finished turn that entered a step and ignores one that did not', async () => {
    const sender = senderSpy()
    const { emit, session, step, end } = harness({ feishuEnabled: true, feishuAppId: 'cli_x', feishuAppSecret: 's', feishuRecipients: ['ou_a'], feishuMode: 'each-turn' }, { createSender: () => sender })
    emit('session/event', session('s1'), step(1, 10))
    emit('session/event', session('s1'), end(1, 'completed', 20))
    // No step/start: an empty or cancelled prompt is not finished work.
    emit('session/event', session('s1'), end(2, 'aborted', 30))
    await flush()
    expect(sender.notify).toHaveBeenCalledTimes(1)
    expect(sender.notify.mock.calls[0]?.[0]).toMatchObject([{ sessionId: 's1', turn: 1, reason: 'completed', outcome: 'completed', at: 20 }])
  })

  it('never records a subagent session', async () => {
    const sender = senderSpy()
    const { emit, session, step, end } = harness({ feishuEnabled: true, feishuAppId: 'cli_x', feishuAppSecret: 's', feishuRecipients: ['ou_a'], feishuMode: 'each-turn' }, { createSender: () => sender })
    emit('session/event', session('child', { origin: 'subagent' }), step(1, 10))
    emit('session/event', session('child', { origin: 'subagent' }), end(1, 'completed', 20))
    emit('session/event', session('deep', { delegationDepth: 2 }), step(1, 10))
    emit('session/event', session('deep', { delegationDepth: 2 }), end(1, 'completed', 20))
    await flush()
    expect(sender.notify).not.toHaveBeenCalled()
  })

  it('names a session from its title event, and from a human prompt until then', async () => {
    const sender = senderSpy()
    const { emit, session, step, end } = harness({ feishuEnabled: true, feishuAppId: 'cli_x', feishuAppSecret: 's', feishuRecipients: ['ou_a'], feishuMode: 'each-turn' }, { createSender: () => sender })
    // A synthetic injection must not become the conversation's name.
    emit('session/event', session('s1'), { type: 'user/message', data: { content: [{ type: 'text', text: 'injected notice' }], source: { kind: 'cron' } }, time: 1 })
    emit('session/event', session('s1'), { type: 'user/message', data: { content: [{ type: 'text', text: 'fix the login page' }], source: { kind: 'user' } }, time: 2 })
    emit('session/event', session('s1'), step(1, 10))
    emit('session/event', session('s1'), end(1, 'completed', 20))
    await flush()
    expect(sender.notify.mock.calls[0]?.[0]?.[0]?.title).toBe('fix the login page')

    emit('session/event', session('s1'), { type: 'session/title', data: { title: 'Login repair' }, time: 25 })
    emit('session/event', session('s1'), step(2, 30))
    emit('session/event', session('s1'), end(2, 'completed', 40))
    await flush()
    expect(sender.notify.mock.calls[1]?.[0]?.[0]?.title).toBe('Login repair')
  })

  it('batches into one message when idle, and reports each turn when asked to', async () => {
    const idle = senderSpy()
    const harnessed = harness({ feishuEnabled: true, feishuAppId: 'cli_x', feishuAppSecret: 's', feishuRecipients: ['ou_a'], feishuMode: 'idle' }, { createSender: () => idle })
    harnessed.emit('session/event', harnessed.session('s1'), harnessed.step(1, 10))
    harnessed.emit('session/event', harnessed.session('s1'), harnessed.end(1, 'completed', 20))
    harnessed.emit('session/event', harnessed.session('s1'), harnessed.step(2, 30))
    harnessed.emit('session/event', harnessed.session('s1'), harnessed.end(2, 'completed', 40))
    await flush()
    // Still working: nothing has been sent yet.
    expect(idle.notify).not.toHaveBeenCalled()
    harnessed.emit('agent/status', { agent: { id: 's1' }, status: 'idle' })
    await flush()
    expect(idle.notify).toHaveBeenCalledTimes(1)
    expect(idle.notify.mock.calls[0]?.[0]).toHaveLength(2)
    // The buffer is drained, so a second idle does not repeat it.
    harnessed.emit('agent/status', { agent: { id: 's1' }, status: 'idle' })
    await flush()
    expect(idle.notify).toHaveBeenCalledTimes(1)
  })

  it('pushes only the outcomes the deployment asked for', async () => {
    const sender = senderSpy()
    const { emit, session, step, end } = harness({ feishuEnabled: true, feishuAppId: 'cli_x', feishuAppSecret: 's', feishuRecipients: ['ou_a'], feishuMode: 'each-turn' }, { createSender: () => sender })
    emit('session/event', session('s1'), step(1, 10))
    emit('session/event', session('s1'), end(1, 'completed', 20))
    emit('session/event', session('s1'), step(2, 30))
    emit('session/event', session('s1'), end(2, 'aborted', 40))
    emit('session/event', session('s1'), step(3, 50))
    emit('session/event', session('s1'), end(3, 'error', 60))
    await flush()
    const pushed = sender.notify.mock.calls.map(call => call[0][0].outcome)
    expect(pushed).toEqual(['completed', 'failed'])
  })

  it('records nothing while disabled and builds no sender', async () => {
    const createSender = vi.fn()
    const { emit, session, step, end } = harness({ enabled: false, feishuEnabled: true, feishuAppId: 'cli_x', feishuAppSecret: 's', feishuRecipients: ['ou_a'] }, { createSender })
    emit('session/event', session('s1'), step(1, 10))
    emit('session/event', session('s1'), end(1, 'completed', 20))
    await flush()
    expect(createSender).not.toHaveBeenCalled()
  })

  it('drops what it recorded when the capability is turned off, and keeps it across other edits', async () => {
    const { emit, session, step, end, mounted } = harness({})
    const feed = async (): Promise<{ latest: number; notices: RunNotice[] }> => {
      const route = mounted[0]
      if (route === undefined) throw new Error('feed route missing')
      const { res, state } = response()
      await route.handler(request('GET', NOTIFY_FEED_PATH), res)
      return JSON.parse(state.text) as { latest: number; notices: RunNotice[] }
    }
    emit('session/event', session('s1'), step(1, 10))
    emit('session/event', session('s1'), end(1, 'completed', 20))
    expect((await feed()).notices).toHaveLength(1)

    // An edit that leaves the capability on must not wipe what a client is reading.
    bindFamilyConfig({ notify: { feedLimit: 5 } })
    notifyFamilyConfigChange()
    expect((await feed()).notices).toHaveLength(1)

    // Turning it off drops the list of conversations this machine has been running,
    // so a later enable cannot publish a burst nobody chose to collect.
    bindFamilyConfig({ notify: { enabled: false } })
    notifyFamilyConfigChange()
    bindFamilyConfig({ notify: { enabled: true } })
    notifyFamilyConfigChange()
    const after = await feed()
    expect(after.notices).toEqual([])
    expect(after.latest).toBe(1)
  })

  it('warns rather than silently dropping a half-configured push', () => {
    const recipients = harness({ feishuEnabled: true, feishuAppId: 'cli_x', feishuAppSecret: 's', feishuRecipients: [] }, { createSender: vi.fn() })
    expect(recipients.warnings.join('\n')).toMatch(/收件人/)
    const credentials = harness({ feishuEnabled: true, feishuRecipients: ['ou_a'] }, { createSender: vi.fn() })
    expect(credentials.warnings.join('\n')).toMatch(/凭据/)
  })

  it('drops a disposed session pending buffer instead of pushing it later', async () => {
    const sender = senderSpy()
    const { emit, session, step, end } = harness({ feishuEnabled: true, feishuAppId: 'cli_x', feishuAppSecret: 's', feishuRecipients: ['ou_a'], feishuMode: 'idle' }, { createSender: () => sender })
    emit('session/event', session('s1'), step(1, 10))
    emit('session/event', session('s1'), end(1, 'completed', 20))
    emit('session/disposed', session('s1'))
    emit('agent/status', { agent: { id: 's1' }, status: 'idle' })
    await flush()
    expect(sender.notify).not.toHaveBeenCalled()
  })

  it('serves through its own route what it recorded from the event stream', async () => {
    const { emit, session, step, end, mounted } = harness({})
    emit('session/event', session('s1'), step(1, 10))
    emit('session/event', session('s1'), end(1, 'error', 20))
    const route = mounted[0]
    if (route === undefined) throw new Error('feed route missing')
    const { res, state } = response()
    const req = request('GET', `${NOTIFY_FEED_PATH}?since=0`)
    Object.assign(req, { headers: { host: 'dsh.studio-mac.netbird' } })
    await route.handler(req, res)
    const body = JSON.parse(state.text) as { origin: string; latest: number; notices: RunNotice[] }
    expect(body.origin).toBe('dsh.studio-mac.netbird')
    expect(body.latest).toBe(1)
    expect(body.notices).toHaveLength(1)
    expect(body.notices[0]).toMatchObject({ id: 1, sessionId: 's1', turn: 1, reason: 'error', outcome: 'failed', at: 20 })
  })

  it('lets the configured read size decide what one read returns', async () => {
    const { emit, session, step, end, mounted } = harness({ feedLimit: 1 })
    for (const turn of [1, 2]) {
      emit('session/event', session('s1'), step(turn, turn * 10))
      emit('session/event', session('s1'), end(turn, 'completed', turn * 10 + 1))
    }
    const route = mounted[0]
    if (route === undefined) throw new Error('feed route missing')
    const { res, state } = response()
    await route.handler(request('GET', NOTIFY_FEED_PATH), res)
    const body = JSON.parse(state.text) as { latest: number; notices: RunNotice[] }
    expect(body.latest).toBe(2)
    expect(body.notices.map(item => item.id)).toEqual([1])
  })
})