/**
 * Inbound-path contracts: what must happen when the platform hands the bot a
 * message, and what the agent may conclude from the queue.
 *
 * These tests exist because each of them corresponds to a way the old path lost
 * a message silently: a storage failure swallowed before the SDK could return a
 * non-200 ACK, an "any mention is me" rule, a stale settings snapshot, a claim
 * that could be handed out twice, and a body the agent could not read.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { gateEvent, mentionsBot } from '../src/core/lark-inbox/gating.ts'
import { describeContent, toEnvelope } from '../src/core/lark-inbox/queue.ts'
import { bindFamilyConfig, notifyFamilyConfigChange } from '../src/host/services/family-config.ts'
import { LarkGateway, extractMentionOpenIds, type GatewaySdk } from '../src/host/services/superagent/channels/feishu/gateway.ts'
import { register } from '../src/host/services/superagent/channels/feishu/index.ts'
import { InboxStore } from '../src/host/services/superagent/channels/feishu/inbox-store.ts'
import { createInboxTools, replyToInboxMessage, type InboxReplySender } from '../src/host/services/superagent/channels/feishu/tools.ts'

/** The optional third argument a reply may carry, taken from the contract itself. */
type SenderTarget = Parameters<InboxReplySender['send']>[2]

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  bindFamilyConfig(undefined)
})

/** Whether a mocked logger was handed this text in any argument position. */
function logged(spy: ReturnType<typeof vi.fn>, needle: string): boolean {
  return spy.mock.calls.some(call => (call as unknown[]).some(argument => String(argument).includes(needle)))
}

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'web-all-lark-inbound-'))
  roots.push(root)
  return root
}

const FEISHU = { appId: 'cli_test', appSecret: 'secret-value', domain: 'feishu' as const }

/** The connection object the SDK hands back; the fake has to match its call shapes. */
type FakeClient = ReturnType<GatewaySdk['createClient']>

/** State shared with a fake SDK so a test can drive the connection callbacks. */
interface FakeSdkState {
  handler?: (data: unknown) => void | Promise<void>
  clientOptions?: Record<string, unknown>
  // Typed as the SDK's own signatures rather than plain `vi.fn()`: the fake is
  // assigned to `GatewaySdk`, and a bare mock has no call signature the interface
  // accepts. The mock methods the tests assert on survive either way.
  close: Mock<FakeClient['close']>
  start: Mock<FakeClient['start']>
  botOpenId?: string
  botFailure?: string
}

function fakeSdk(state: Partial<FakeSdkState> = {}): GatewaySdk & { state: FakeSdkState } {
  const resolved: FakeSdkState = {
    close: vi.fn(),
    start: vi.fn(async () => undefined),
    botOpenId: 'ou_bot',
    ...state,
  }
  const sdk: GatewaySdk = {
    domain: { Feishu: 'feishu', Lark: 'lark' },
    createApiClient: () => ({
      botOpenId: async () => {
        if (resolved.botFailure !== undefined) throw new Error(resolved.botFailure)
        return resolved.botOpenId ?? ''
      },
    }),
    createDispatcher: () => ({
      register(handlers) {
        resolved.handler = handlers['im.message.receive_v1']
        return {}
      },
    }),
    createClient: options => {
      resolved.clientOptions = options as unknown as Record<string, unknown>
      return { start: resolved.start, close: resolved.close }
    },
  }
  return Object.assign(sdk, { state: resolved })
}

/** A minimal host context: only what the inbox domain touches. */
function context() {
  const definitions: Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }> = []
  const warn = vi.fn()
  const info = vi.fn()
  const error = vi.fn()
  const ctx = {
    logger: () => ({ info, warn, error }),
    settings: { get: () => ({}) },
    tools: { register: (definition: { name: string; execute: Function }) => { definitions.push(definition as never); return vi.fn() } },
    systemPrompt: { section: () => vi.fn() },
    webServer: { register: () => vi.fn() },
    // The answer path subscribes to session events; a fake context without `on`
    // would fail this domain's whole registration.
    on: () => vi.fn(),
  }
  return { ctx, definitions, warn, info, error }
}

function groupEvent(options: { mention?: string; eventId?: string; text?: string } = {}) {
  const mention = options.mention
  return {
    header: { event_id: options.eventId ?? 'evt-group' },
    event: {
      sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
      message: {
        message_id: `om_${options.eventId ?? 'evt-group'}`,
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: options.text ?? 'hello' }),
        ...(mention === undefined ? {} : { mentions: [{ key: '@_user_1', name: 'Someone', id: { open_id: mention } }] }),
      },
    },
  }
}

function directEvent(options: { eventId?: string } = {}) {
  return {
    header: { event_id: options.eventId ?? 'evt-dm' },
    event: {
      sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
      message: {
        message_id: `om_${options.eventId ?? 'evt-dm'}`,
        chat_id: 'oc_dm',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi bot' }),
      },
    },
  }
}

/** Mount the domain over a fake queue, and return the SDK seam a test drives. */
async function mountInbox(options: {
  sdk?: GatewaySdk & { state: FakeSdkState }
  store?: InboxStore
  dshHome?: string
  createStore?: (input: { rootDir: string; maxAttempts: number; staleTimeoutMs: number }) => InboxStore
  createGateway?: (input: ConstructorParameters<typeof LarkGateway>[0]) => Pick<LarkGateway, 'start' | 'stop' | 'isRunning'>
  mailbox?: { appended: unknown[] }
}) {
  const { ctx, definitions, warn, info, error } = context()
  const mailbox = options.mailbox ?? { appended: [] }
  const created: Array<Pick<LarkGateway, 'start' | 'stop' | 'isRunning'>> = []
  // Narrowed into a local so the factory's return type is `InboxStore` rather than
// `InboxStore | undefined`: the optional property does not stay narrowed inside a
// closure, and the store factory is declared as always returning one.
  const providedStore = options.store
  const createStore = options.createStore
    ?? (providedStore === undefined ? undefined : () => providedStore)
  const dispose = register(ctx as never, {}, {
    dshHome: options.dshHome ?? tempDir(),
    gatewaySdk: options.sdk,
    ...(createStore === undefined ? {} : { createStore }),
    createGateway: options.createGateway ?? (gatewayOptions => {
      const gateway = new LarkGateway(gatewayOptions)
      created.push(gateway)
      return gateway
    }),
  })
  return { ctx, definitions, warn, info, error, dispose, mailbox, created }
}

describe('queue write failures reach the platform', () => {
  it('propagates a store.append failure to the SDK event handler', async () => {
    const sdk = fakeSdk()
    const append = vi.fn(() => { throw new Error('disk full') })
    const store = { append, close: vi.fn() } as unknown as InboxStore
    bindFamilyConfig({ feishu: FEISHU, 'lark-inbox': { enabled: true } })
    const { dispose } = await mountInbox({ sdk, store })
    await vi.waitFor(() => { expect(sdk.state.handler).toBeTypeOf('function') })

    // A swallowed failure here is a message the platform believes was delivered.
    expect(() => sdk.state.handler!(directEvent())).toThrow('disk full')
    expect(append).toHaveBeenCalledOnce()
    await dispose()
  })
})

describe('mention detection', () => {
  it('matches the bot by its own open id, not by "any mention"', () => {
    expect(extractMentionOpenIds(groupEvent({ mention: 'ou_bot' }))).toEqual(['ou_bot'])
    expect(mentionsBot(['ou_bot'], 'ou_bot')).toBe(true)
    expect(mentionsBot(['ou_other'], 'ou_bot')).toBe(false)
    // No identity means no claim: fail-closed, never "somebody was mentioned".
    expect(mentionsBot(['ou_bot'], '')).toBe(false)
    expect(mentionsBot(['ou_bot'], undefined)).toBe(false)
  })

  it('refuses a group message that mentions a colleague instead of the bot', async () => {
    const sdk = fakeSdk()
    const append = vi.fn(() => 'appended' as const)
    const store = { append, close: vi.fn() } as unknown as InboxStore
    bindFamilyConfig({ feishu: FEISHU, 'lark-inbox': { enabled: true } })
    const { dispose, warn } = await mountInbox({ sdk, store })
    await vi.waitFor(() => { expect(sdk.state.handler).toBeTypeOf('function') })

    sdk.state.handler!(groupEvent({ mention: 'ou_somebody_else' }))
    expect(append).not.toHaveBeenCalled()
    expect(logged(warn, 'group-without-mention')).toBe(true)

    // The same group message does reach us once the bot is the mentioned party.
    sdk.state.handler!(groupEvent({ mention: 'ou_bot', eventId: 'evt-mentioned' }))
    expect(append).toHaveBeenCalledOnce()
    await dispose()
  })

  it('refuses every group message while the bot identity is unknown, and keeps direct messages', async () => {
    const sdk = fakeSdk({ botFailure: 'bot/v3/info unavailable' })
    const append = vi.fn(() => 'appended' as const)
    const store = { append, close: vi.fn() } as unknown as InboxStore
    bindFamilyConfig({ feishu: FEISHU, 'lark-inbox': { enabled: true } })
    const { dispose, warn, info } = await mountInbox({ sdk, store })
    await vi.waitFor(() => { expect(sdk.state.handler).toBeTypeOf('function') })

    sdk.state.handler!(groupEvent({ mention: 'ou_bot' }))
    expect(append).not.toHaveBeenCalled()
    expect(logged(warn, 'group-without-bot-identity')).toBe(true)
    // The missing identity is reported once, at startup, not per event.
    expect(logged(info, 'bot identity')).toBe(false)

    sdk.state.handler!(directEvent())
    expect(append).toHaveBeenCalledOnce()
    await dispose()
  })

  it('reports a gate failure reason for each rule', () => {
    const config = { dropAppMessages: true, requireMentionInGroup: true, allowedOpenIds: [] }
    expect(gateEvent({ chatType: 'group', botOpenId: 'ou_bot' }, config)).toEqual({ accept: false, reason: 'group-without-mention' })
    expect(gateEvent({ chatType: 'group' }, config)).toEqual({ accept: false, reason: 'group-without-bot-identity' })
    expect(gateEvent({ chatType: 'group', botOpenId: 'ou_bot', mentionBot: true }, config)).toEqual({ accept: true })
  })

  it('does not need the bot identity when the mention rule is off', () => {
    // Turning the mention rule off means "every group message is wanted", so an
    // identity lookup that failed must not stop the group from being ingested.
    const config = { dropAppMessages: true, requireMentionInGroup: false, allowedOpenIds: [] }
    expect(gateEvent({ chatType: 'group' }, config)).toEqual({ accept: true })
  })
})

describe('live settings', () => {
  it('applies a settings change to the next event without waiting for a rebuild', async () => {
    const sdk = fakeSdk()
    const append = vi.fn(() => 'appended' as const)
    const store = { append, close: vi.fn() } as unknown as InboxStore
    bindFamilyConfig({ feishu: FEISHU, 'lark-inbox': { enabled: true } })
    const { dispose, warn } = await mountInbox({ sdk, store })
    await vi.waitFor(() => { expect(sdk.state.handler).toBeTypeOf('function') })

    sdk.state.handler!(directEvent({ eventId: 'evt-first' }))
    expect(append).toHaveBeenCalledOnce()

    // Rebind only: no rebuild notification, so the gate must read the document
    // per event. A startup snapshot would keep admitting this sender.
    bindFamilyConfig({ feishu: FEISHU, 'lark-inbox': { enabled: true, allowedOpenIds: ['ou_someone_else'] } })
    sdk.state.handler!(directEvent({ eventId: 'evt-second' }))
    expect(append).toHaveBeenCalledOnce()
    expect(logged(warn, 'sender-not-allowed')).toBe(true)
    await dispose()
  })

  it('rebuilds the runtime when a relevant setting changes, and only then', async () => {
    const sdk = fakeSdk()
    const createGateway = vi.fn((gatewayOptions: ConstructorParameters<typeof LarkGateway>[0]) => new LarkGateway(gatewayOptions))
    const createStore = vi.fn(() => ({ append: vi.fn(() => 'appended' as const), close: vi.fn() }) as unknown as InboxStore)
    bindFamilyConfig({ feishu: FEISHU, 'lark-inbox': { enabled: true } })
    const { dispose } = await mountInbox({ sdk, createStore, createGateway })
    expect(createGateway).toHaveBeenCalledTimes(1)

    // An unrelated namespace in the same aggregate document must not reconnect the bot.
    bindFamilyConfig({ feishu: FEISHU, 'lark-inbox': { enabled: true }, 'dsh-ssh': { enabled: true } })
    notifyFamilyConfigChange()
    expect(createGateway).toHaveBeenCalledTimes(1)

    // Moving the queue is a real change: the socket must be rebuilt around it.
    bindFamilyConfig({ feishu: FEISHU, 'lark-inbox': { enabled: true, queueDir: join(tempDir(), 'elsewhere') } })
    notifyFamilyConfigChange()
    expect(createGateway).toHaveBeenCalledTimes(2)
    expect(createStore).toHaveBeenCalledTimes(2)
    await dispose()
  })

  it('changes the answer-path settings without rebuilding the socket', async () => {
    const sdk = fakeSdk()
    const createGateway = vi.fn((gatewayOptions: ConstructorParameters<typeof LarkGateway>[0]) => new LarkGateway(gatewayOptions))
    const createStore = vi.fn(() => ({ append: vi.fn(() => 'appended' as const), close: vi.fn() }) as unknown as InboxStore)
    bindFamilyConfig({ feishu: FEISHU, 'lark-inbox': { enabled: true, autoReplyMode: 'probe' } })
    const { dispose } = await mountInbox({ sdk, createStore, createGateway })
    expect(createGateway).toHaveBeenCalledTimes(1)

    // Turning answering on, and choosing who it answers, are read live on every
    // call. Rebuilding the gateway for them used to drop the bot's connection for
    // a change that never touched it - and it is the very change an operator makes
    // right after a restart.
    bindFamilyConfig({
      feishu: FEISHU,
      'lark-inbox': {
        enabled: true,
        autoReplyMode: 'self',
        autoReplyOpenIds: ['ou_owner'],
        autoReplyCwd: '/tmp/elsewhere',
        autoReplyPreamble: '另一段前言',
      },
    })
    notifyFamilyConfigChange()
    expect(createGateway).toHaveBeenCalledTimes(1)
    expect(createStore).toHaveBeenCalledTimes(1)

    // Gate rules are read per event for the same reason.
    bindFamilyConfig({ feishu: FEISHU, 'lark-inbox': { enabled: true, allowedOpenIds: ['ou_a'], dropAppMessages: false } })
    notifyFamilyConfigChange()
    expect(createGateway).toHaveBeenCalledTimes(1)
    await dispose()
  })

  it('drops a running runtime when the feature is switched off', async () => {
    const sdk = fakeSdk()
    const createGateway = vi.fn((gatewayOptions: ConstructorParameters<typeof LarkGateway>[0]) => new LarkGateway(gatewayOptions))
    bindFamilyConfig({ feishu: FEISHU, 'lark-inbox': { enabled: true } })
    const { dispose, definitions } = await mountInbox({ sdk, createGateway })
    const gateway = createGateway.mock.results[0]?.value as LarkGateway
    expect(gateway.isRunning()).toBe(true)

    bindFamilyConfig({ feishu: FEISHU, 'lark-inbox': { enabled: false } })
    notifyFamilyConfigChange()
    await vi.waitFor(() => { expect(gateway.isRunning()).toBe(false) })

    // A disabled domain must not keep an outbound path alive behind the switch.
    const reply = definitions.find(tool => tool.name === 'lark_inbox_reply')!
    await expect(reply.execute({ chat_id: 'oc_1', text: 'hi' }, { signal: new AbortController().signal }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('已停用') })
    await dispose()
  })
})

describe('connection health', () => {
  it('starts as connecting, becomes connected on the SDK callback, and reports errors', async () => {
    const sdk = fakeSdk({ start: vi.fn(async () => undefined) })
    const dshHome = tempDir()
    bindFamilyConfig({ feishu: FEISHU, 'lark-inbox': { enabled: true } })
    const { definitions, dispose } = await mountInbox({ sdk, dshHome })
    const peek = definitions.find(tool => tool.name === 'lark_inbox_peek')!
    const exec = { signal: new AbortController().signal }

    // `start()` resolving is not proof of a connection: the SDK returns before
    // the handshake, which is exactly the state an operator sees as "no messages".
    expect(await peek.execute({ limit: 5 }, exec)).toMatchObject({ gateway: 'connecting' })

    const clientOptions = sdk.state.clientOptions as { onReady?: () => void; onError?: (error: Error) => void }
    clientOptions.onReady?.()
    expect(await peek.execute({ limit: 5 }, exec)).toMatchObject({ gateway: 'connected' })

    clientOptions.onError?.(new Error('socket closed'))
    expect(await peek.execute({ limit: 5 }, exec)).toMatchObject({ gateway: 'error', gatewayError: 'socket closed' })
    await dispose()
  })
})

describe('queue reliability', () => {
  it('claims each pending message once', async () => {
    const store = InboxStore.open({ rootDir: tempDir() })
    store.append(toEnvelope({ header: { event_id: 'evt-1' }, event: { message: { message_id: 'om_1', content: '{"text":"one"}' } } }))
    store.append(toEnvelope({ header: { event_id: 'evt-2' }, event: { message: { message_id: 'om_2', content: '{"text":"two"}' } } }))

    expect(store.pop()?.envelope.eventId).toBe('evt-1')
    // A claim is exclusive: the claimed row is no longer a candidate.
    expect(store.get('evt-1')?.status).toBe('processing')
    expect(store.pop()?.envelope.eventId).toBe('evt-2')
    expect(store.pop()).toBeNull()
    store.close()
  })

  it('uses message_id as a second idempotency key', () => {
    const store = InboxStore.open({ rootDir: tempDir() })
    const first = toEnvelope({ header: { event_id: 'evt-a' }, event: { message: { message_id: 'om_same', content: '{}' } } })
    // Same message, new event id: a reconnect can redeliver it that way.
    const again = toEnvelope({ header: { event_id: 'evt-b' }, event: { message: { message_id: 'om_same', content: '{}' } } })
    expect(store.append(first)).toBe('appended')
    expect(store.append(again)).toBe('duplicate')
    expect(store.stats().total).toBe(1)
    store.close()
  })

  it('upgrades a store created by the previous schema in place', () => {
    const root = tempDir()
    const legacy = new DatabaseSync(join(root, 'inbox.sqlite'))
    legacy.exec(`CREATE TABLE inbox_events (
      event_id TEXT PRIMARY KEY,
      file TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    )`)
    legacy.prepare(`INSERT INTO inbox_events (event_id, file, status, attempts, received_at, updated_at, payload)
      VALUES ('evt-old', '/tmp/old.jsonl', 'pending', 0, 1, 1, ?)`)
      .run(JSON.stringify(toEnvelope({ header: { event_id: 'evt-old' }, event: { message: { message_id: 'om_old', content: '{}' } } })))
    legacy.close()

    const store = InboxStore.open({ rootDir: root })
    expect(store.get('evt-old')?.envelope.eventId).toBe('evt-old')
    // The second idempotency key works on the migrated table.
    const sameMessage = toEnvelope({ header: { event_id: 'evt-new' }, event: { message: { message_id: 'om_old', content: '{}' } } })
    expect(store.append(sameMessage)).toBe('duplicate')
    store.close()
    // Reopening is idempotent: the migration must not fail a second time.
    const reopened = InboxStore.open({ rootDir: root })
    expect(reopened.stats().total).toBe(1)
    reopened.close()
  })

  it('retires an exhausted stale claim instead of requeueing it forever', () => {
    const root = tempDir()
    const store = InboxStore.open({ rootDir: root, maxAttempts: 1, staleTimeoutMs: 1 })
    store.append(toEnvelope({ header: { event_id: 'evt-stale' }, event: { message: { message_id: 'om_stale', content: '{}' } } }))
    expect(store.pop()?.envelope.eventId).toBe('evt-stale')
    const threshold = Date.now() + 5
    while (Date.now() < threshold) { /* wait out the stale window */ }
    expect(store.recoverStale()).toBe(1)
    expect(store.stats().dead).toBe(1)
    expect(store.stats().pending).toBe(0)
    store.close()
  })

  it('requeues a stale claim that still has attempts left', () => {
    const store = InboxStore.open({ rootDir: tempDir(), maxAttempts: 3, staleTimeoutMs: 1 })
    store.append(toEnvelope({ header: { event_id: 'evt-retry' }, event: { message: { message_id: 'om_retry', content: '{}' } } }))
    expect(store.pop()?.envelope.eventId).toBe('evt-retry')
    const threshold = Date.now() + 5
    while (Date.now() < threshold) { /* wait out the stale window */ }
    expect(store.recoverStale()).toBe(1)
    expect(store.stats()).toEqual({ pending: 1, processing: 0, routed: 0, done: 0, dead: 0, total: 1 })
    store.close()
  })

  it('reports not-found when settling a message nobody claimed', () => {
    const store = InboxStore.open({ rootDir: tempDir() })
    store.append(toEnvelope({ header: { event_id: 'evt-settle' }, event: { message: { message_id: 'om_settle', content: '{}' } } }))
    expect(store.ack('evt-settle')).toBe('not-found')
    expect(store.nack('evt-settle')).toBe('not-found')
    expect(store.pop()?.envelope.eventId).toBe('evt-settle')
    expect(store.ack('evt-settle')).toBe('done')
    expect(store.ack('evt-settle')).toBe('not-found')
    expect(store.get('unknown')).toBeUndefined()
    store.close()
  })
})

describe('reply', () => {
  function replyFixture() {
    const store = InboxStore.open({ rootDir: tempDir() })
    store.append(toEnvelope(directEvent({ eventId: 'evt-reply' })))
    return store
  }

  function sender(result: { ok: boolean; messageId?: string; error?: string } = { ok: true, messageId: 'om_sent' }) {
    // The parameters are named so the mock's call tuple has a shape: a bare `vi.fn()`
    // records `calls` as `[]`, and a test asserting on the arguments it was given has
    // nothing to index.
    return { send: vi.fn(async (_to: string, _text: string, _target?: SenderTarget) => result) }
  }

  it('answers the original message in place', async () => {
    const store = replyFixture()
    const outbound = sender()
    const result = await replyToInboxMessage(store, { sender: outbound as InboxReplySender }, { eventId: 'evt-reply', text: '  on it  ' })
    expect(result).toEqual({ ok: true, messageId: 'om_sent' })
    expect(outbound.send).toHaveBeenCalledWith('oc_dm', 'on it', { replyToMessageId: 'om_evt-reply', idempotencyKey: 'evt-reply' })
    store.close()
  })

  it('starts a new message when threading is not wanted', async () => {
    const store = replyFixture()
    const outbound = sender({ ok: true })
    const result = await replyToInboxMessage(store, { sender: outbound as InboxReplySender }, { eventId: 'evt-reply', text: 'hi', replyInThread: false })
    expect(result).toEqual({ ok: true })
    expect(outbound.send).toHaveBeenCalledWith('oc_dm', 'hi', { idempotencyKey: 'evt-reply' })
    store.close()
  })

  it('prefers an explicit chat id over the stored conversation', async () => {
    const store = replyFixture()
    const outbound = sender()
    await replyToInboxMessage(store, { sender: outbound as InboxReplySender }, { eventId: 'evt-reply', chatId: 'oc_elsewhere', text: 'hi' })
    expect(outbound.send.mock.calls[0]![0]).toBe('oc_elsewhere')
    store.close()
  })

  it('reports an unknown event id and a missing target instead of throwing', async () => {
    const store = replyFixture()
    const outbound = sender()
    await expect(replyToInboxMessage(store, { sender: outbound as InboxReplySender }, { eventId: 'evt-missing', text: 'hi' }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('找不到') })
    await expect(replyToInboxMessage(store, { sender: outbound as InboxReplySender }, { text: 'hi' }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('event_id') })
    expect(outbound.send).not.toHaveBeenCalled()
    store.close()
  })

  it('explains missing credentials and surfaces a delivery failure', async () => {
    const store = replyFixture()
    await expect(replyToInboxMessage(store, { error: 'feishu: 未配置飞书应用凭据' }, { eventId: 'evt-reply', text: 'hi' }))
      .resolves.toEqual({ ok: false, error: 'feishu: 未配置飞书应用凭据' })
    const failing = sender({ ok: false, error: 'feishu code 230020: send too frequent' })
    await expect(replyToInboxMessage(store, { sender: failing as InboxReplySender }, { eventId: 'evt-reply', text: 'hi' }))
      .resolves.toEqual({ ok: false, error: 'feishu code 230020: send too frequent' })
    const throwing = { send: vi.fn(async () => { throw new Error('network down') }) }
    await expect(replyToInboxMessage(store, { sender: throwing as InboxReplySender }, { eventId: 'evt-reply', text: 'hi' }))
      .resolves.toEqual({ ok: false, error: 'feishu: 发送失败：network down' })
    store.close()
  })

  it('is exposed as a tool that answers a stored message', async () => {
    const store = replyFixture()
    const outbound = sender()
    const tools = Object.fromEntries(createInboxTools(() => store, { reply: () => ({ sender: outbound as InboxReplySender }) }).map(tool => [tool.name, tool]))
    const exec = { signal: new AbortController().signal } as never
    await expect(tools.lark_inbox_reply.execute({ event_id: 'evt-reply', text: 'on it' }, exec))
      .resolves.toEqual({ ok: true, messageId: 'om_sent' })
    await expect(tools.lark_inbox_reply.execute({ event_id: 'evt-nope', text: 'on it' }, exec))
      .resolves.toMatchObject({ ok: false })
    store.close()
  })

  it('reports why replying is unavailable when the domain has no sender', async () => {
    const store = replyFixture()
    const tools = Object.fromEntries(createInboxTools(() => store, { reply: () => ({ error: 'feishu: 未配置飞书应用凭据' }) }).map(tool => [tool.name, tool]))
    const exec = { signal: new AbortController().signal } as never
    await expect(tools.lark_inbox_reply.execute({ event_id: 'evt-reply', text: 'on it' }, exec))
      .resolves.toEqual({ ok: false, error: 'feishu: 未配置飞书应用凭据' })
    store.close()
  })
})

describe('readable content', () => {
  it('replaces mention placeholders with the names the platform resolved', () => {
    expect(describeContent('text', JSON.stringify({ text: '@_user_1 看下这个' }), [{ key: '@_user_1', name: 'Alice', openIds: ['ou_a'] }]))
      .toBe('@Alice 看下这个')
    // An unnamed mention keeps its placeholder rather than inventing a name.
    expect(describeContent('text', JSON.stringify({ text: '@_user_2 hi' }), [{ key: '@_user_2', name: '', openIds: [] }]))
      .toBe('@_user_2 hi')
  })

  it('summarizes non-text bodies and keeps plain strings intact', () => {
    expect(describeContent('image', JSON.stringify({ image_key: 'img_v3_abc' }))).toBe('[image: img_v3_abc]')
    expect(describeContent('file', JSON.stringify({ file_key: 'file_1', file_name: 'report.pdf' }))).toBe('[file: report.pdf]')
    expect(describeContent('sticker', JSON.stringify({ file_key: 'sticker_1' }))).toBe('[sticker: sticker_1]')
    expect(describeContent('post', JSON.stringify({ title: 'Planning', content: [[{ tag: 'text', text: 'ship it' }, { tag: 'img', image_key: 'img_1' }]] })))
      .toBe('Planning\nship it[image: img_1]')
    // Backward compatibility: a body that is not JSON is delivered unchanged.
    expect(describeContent('text', 'message-evt-1')).toBe('message-evt-1')
    // A missing body must not cost the queue a message.
    expect(describeContent('text', undefined)).toBe('')
  })

  it('stores the readable text in the envelope and the raw event beside it', () => {
    const event = groupEvent({ mention: 'ou_bot', text: '@_user_1 hello' })
    const envelope = toEnvelope(event, { mentionBot: true })
    expect(envelope.content).toBe('@Someone hello')
    expect(envelope.chatId).toBe('oc_group')
    expect(envelope.raw).toBe(event)
    expect(() => toEnvelope({ header: { event_id: 'evt-bare' }, event: { message: { message_type: 'text' } } })).not.toThrow()
  })
})