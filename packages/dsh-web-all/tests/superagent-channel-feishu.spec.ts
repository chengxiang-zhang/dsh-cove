/**
 * The Feishu channel contract: five methods, one admission hook, one store filter.
 *
 * Each test corresponds to a way this layer can fail silently:
 *
 * - a sender key read from the wrong place, so a person is recorded as somebody
 *   else and the owner's authority never applies;
 * - an admission verdict the responder never hears about, so either two answers
 *   race for one message or nobody answers at all;
 * - a claimed message handed to a tool, so the queue and the secretary answer the
 *   same person twice;
 * - a retried send without the idempotency token, so a crash between "sent" and
 *   "recorded" answers twice;
 * - a missing history scope reported as an empty history instead of as
 *   unavailable.
 *
 * Fixtures: `tests/fixtures/superagent/memdb.ts` for the ledger shape, and a real
 * `InboxStore` for the claim filter, because the filter is SQL and a fake would
 * only test the fake.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toEnvelope } from '../src/core/lark-inbox/queue.ts'
import type { LarkInboxEnvelope } from '../src/core/lark-inbox/queue.ts'
import { migrate } from '../src/host/services/superagent/protocol/db.ts'
import { InboxStore } from '../src/host/services/superagent/channels/feishu/inbox-store.ts'
import { toInboundEvent, unionIdOf } from '../src/host/services/superagent/channels/feishu/inbound.ts'
import {
  createFeishuChannel,
  type AdmitResult,
  type ChannelSendPort,
  type FeishuChannelDeps,
} from '../src/host/services/superagent/channels/feishu/channel.ts'
import { register } from '../src/host/services/superagent/channels/feishu/index.ts'
import type { GatewaySdk } from '../src/host/services/superagent/channels/feishu/gateway.ts'
import { bindFamilyConfig } from '../src/host/services/family-config.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  bindFamilyConfig(undefined)
})

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'web-all-superagent-channel-'))
  roots.push(root)
  return root
}

/** A `im.message.receive_v1` payload in the v2 wrapper shape, with a union id. */
function wrappedEvent(options: { eventId?: string; unionId?: string; chatType?: 'p2p' | 'group' } = {}) {
  const eventId = options.eventId ?? 'evt-dm'
  const senderId: Record<string, string> = { open_id: 'ou_sender' }
  if (options.unionId !== undefined) senderId.union_id = options.unionId
  return {
    header: { event_id: eventId },
    event: {
      sender: { sender_id: senderId, sender_type: 'user' },
      message: {
        message_id: `om_${eventId}`,
        chat_id: options.chatType === 'group' ? 'oc_group' : 'oc_dm',
        chat_type: options.chatType ?? 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi bot' }),
      },
    },
  }
}

/** The same event in the flat shape: the body with no wrapper and no header. */
function flatEvent(unionId?: string) {
  const senderId: Record<string, string> = { open_id: 'ou_sender' }
  if (unionId !== undefined) senderId.union_id = unionId
  return {
    sender: { sender_id: senderId, sender_type: 'user' },
    message: {
      message_id: 'om_flat',
      chat_id: 'oc_dm',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hi bot' }),
    },
  }
}

function envelopeOf(raw: unknown): LarkInboxEnvelope {
  return toEnvelope(raw)
}

/** A channel over ports that do nothing, with per-test overrides. */
function channelOf(overrides: Partial<FeishuChannelDeps> = {}) {
  return createFeishuChannel({
    store: () => undefined,
    sender: () => undefined,
    reactor: () => undefined,
    members: async () => [],
    ownerUnionIds: () => [],
    ...overrides,
  })
}

function senderRecorder() {
  const calls: Array<{ to: string; text: string; target?: { replyToMessageId?: string; idempotencyKey?: string } }> = []
  const port: ChannelSendPort = {
    async send(to, text, target) {
      calls.push({ to, text, ...(target === undefined ? {} : { target }) })
      return { ok: true, messageId: `om_sent_${target?.idempotencyKey ?? ''}` }
    },
  }
  return { port, calls }
}

describe('inbound: envelope to protocol event', () => {
  it('reads identity, chat, message and thread from either raw shape, and leaves union_id absent when the event had none', () => {
    const wrapped = toInboundEvent(envelopeOf(wrappedEvent({ unionId: 'on_sender' })), 1_700_000_000_000)
    expect(wrapped.sender).toEqual({ open_id: 'ou_sender', union_id: 'on_sender' })
    expect(wrapped.chat).toEqual({ id: 'oc_dm', type: 'p2p' })
    expect(wrapped.message_id).toBe('om_evt-dm')
    expect(wrapped.thread).toBe('p2p:oc_dm:om_evt-dm')
    expect(wrapped.event_id).toBe('evt-dm')
    expect(wrapped.text).toBe('hi bot')
    expect(wrapped.received_at).toBe(1_700_000_000_000)

    const flat = toInboundEvent(envelopeOf(flatEvent('on_flat')), 1)
    expect(flat.sender).toEqual({ open_id: 'ou_sender', union_id: 'on_flat' })
    expect(flat.message_id).toBe('om_flat')
    expect(unionIdOf(flatEvent('on_flat'))).toBe('on_flat')

    const weak = toInboundEvent(envelopeOf(flatEvent()), 1)
    expect(weak.sender).toEqual({ open_id: 'ou_sender' })
    expect(weak.sender.union_id).toBeUndefined()
    expect(unionIdOf(flatEvent())).toBeUndefined()
  })
})

describe('admission: who answers an appended event', () => {
  it('keeps the responder out of the answer when the secretary owns the event or already claimed it', () => {
    for (const verdict of ['superagent', 'already_claimed'] as const) {
      const kick = vi.fn()
      const channel = channelOf({ hooks: { admit: () => verdict } })
      const event = channel.deliver(envelopeOf(wrappedEvent({ eventId: `evt-${verdict}` })), kick)
      expect(event?.event_id).toBe(`evt-${verdict}`)
      expect(kick).toHaveBeenCalledTimes(0)
    }
  })

  it('kicks the responder exactly once for a responder or shadow verdict', () => {
    for (const verdict of ['responder', 'shadow'] as const) {
      const kick = vi.fn()
      const channel = channelOf({ hooks: { admit: () => verdict } })
      channel.deliver(envelopeOf(wrappedEvent({ eventId: `evt-${verdict}` })), kick)
      expect(kick).toHaveBeenCalledTimes(1)
    }
  })

  it('kicks the responder when no hook is wired, which is the pre-secretary behaviour', () => {
    const kick = vi.fn()
    channelOf().deliver(envelopeOf(wrappedEvent()), kick)
    expect(kick).toHaveBeenCalledTimes(1)
  })

  it('kicks the responder and warns once when the admission hook throws', () => {
    const kick = vi.fn()
    const warn = vi.fn()
    const channel = channelOf({
      hooks: { admit: () => { throw new Error('judgment unavailable') } },
      log: { warn },
    })
    channel.deliver(envelopeOf(wrappedEvent()), kick)
    expect(kick).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('judgment unavailable')
  })
})

describe('claim filter: the secretary\'s messages are not a tool\'s to take', () => {
  it('hides an owner=superagent row from peek and pop and still hands out the unclaimed one', () => {
    const root = tempDir()
    const store = InboxStore.open({ rootDir: root })
    store.append(envelopeOf(wrappedEvent({ eventId: 'evt-claimed' })))
    store.append(envelopeOf(wrappedEvent({ eventId: 'evt-free' })))

    // Production order: the channel store opens first, then the protocol
    // migration adds the owner column on the same file.
    const ledger = new DatabaseSync(join(root, 'inbox.sqlite'))
    try {
      migrate(ledger)
      ledger.prepare("UPDATE inbox_events SET owner = 'superagent' WHERE event_id = ?").run('evt-claimed')

      expect(store.peek(10).map(item => item.envelope.eventId)).toEqual(['evt-free'])
      expect(store.pop()?.envelope.eventId).toBe('evt-free')
      expect(store.pop()).toBeNull()
    } finally {
      ledger.close()
      store.close()
    }
  })

  it('claims as before on a database the protocol has not migrated yet', () => {
    const store = InboxStore.open({ rootDir: tempDir() })
    try {
      store.append(envelopeOf(wrappedEvent({ eventId: 'evt-old' })))
      expect(store.peek(10).map(item => item.envelope.eventId)).toEqual(['evt-old'])
      expect(store.pop()?.envelope.eventId).toBe('evt-old')
    } finally {
      store.close()
    }
  })
})

/** A gateway SDK whose dispatcher hands the test the event handler it registered. */
function fakeGatewaySdk() {
  const state: {
    handler?: (data: unknown) => void | Promise<void>
    start: () => Promise<void>
    close: () => Promise<void>
  } = { start: async () => undefined, close: async () => undefined }
  const sdk: GatewaySdk = {
    domain: { Feishu: 'feishu', Lark: 'lark' },
    createApiClient: () => ({ botOpenId: async () => 'ou_bot' }),
    createDispatcher: () => ({
      register(handlers) {
        state.handler = handlers['im.message.receive_v1']
        return {}
      },
    }),
    createClient: () => ({ start: vi.fn(state.start), close: vi.fn(state.close) }),
  }
  return { sdk, state }
}

/** The minimum host context this domain touches (the inbound spec's harness). */
function fakeContext() {
  return {
    logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    settings: { get: () => ({}) },
    tools: { register: () => vi.fn() },
    systemPrompt: { section: () => vi.fn() },
    webServer: { register: () => vi.fn() },
    on: () => vi.fn(),
  }
}

describe('register: the admission hook on the path a stored event actually travels', () => {
  it('skips the responder when the hook claims the event, and keeps it when no hook is wired', async () => {
    // Counting the responder's own batching call, not a stand-in: `attach` is what
    // opens a reply job for one message, so its call count is the difference
    // between "the responder answered" and "the secretary owns it".
    const attachCalls = async (admit?: AdmitResult): Promise<number> => {
      const root = tempDir()
      const store = InboxStore.open({ rootDir: root })
      const attach = vi.spyOn(store.reply, 'attach')
      const { sdk, state } = fakeGatewaySdk()
      bindFamilyConfig({
        feishu: { appId: 'cli_test', appSecret: 'secret-value', domain: 'feishu' },
        'lark-inbox': { enabled: true, autoReplyMode: 'probe' },
      })
      const dispose = register(fakeContext() as never, {}, {
        dshHome: root,
        gatewaySdk: sdk,
        createStore: () => store,
        ...(admit === undefined ? {} : { admit: () => admit }),
      })
      await vi.waitFor(() => { expect(state.handler).toBeTypeOf('function') })
      state.handler!(wrappedEvent({ eventId: 'evt-integration', unionId: 'on_requester' }))
      const calls = attach.mock.calls.length
      attach.mockRestore()
      await dispose()
      return calls
    }

    // No hook: the responder keeps the event, which is this domain's behaviour
    // before the kernel's claim policy exists.
    expect(await attachCalls()).toBe(1)
    // The secretary owns it: the responder must not open a batch for it.
    expect(await attachCalls('superagent')).toBe(0)
  })
})
describe('send, history and audience', () => {
  it('sends the same vendor uuid for one idempotency key, bounded to the platform limit', async () => {
    const { port, calls } = senderRecorder()
    const channel = channelOf({ sender: () => port })

    const first = await channel.send('oc_dm', 'hi bot', 'om_1', 'job-1')
    const second = await channel.send('oc_dm', 'hi bot', 'om_1', 'job-1')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.target?.idempotencyKey).toBe('job-1')
    expect(calls[0]?.target?.idempotencyKey).toBe(calls[1]?.target?.idempotencyKey)
    expect(calls[0]?.target?.replyToMessageId).toBe('om_1')
    expect(first.messageId).toBe(second.messageId)

    const long = `job-${'x'.repeat(80)}`
    await channel.send('oc_dm', 'hi bot', undefined, long)
    await channel.send('oc_dm', 'hi bot', undefined, long)
    const tokens = calls.slice(2).map(call => call.target?.idempotencyKey ?? '')
    expect(tokens[0]).toBe(tokens[1])
    expect(tokens[0]?.length).toBeLessThanOrEqual(50)
  })

  it('rejects history with HISTORY_UNAVAILABLE when no reader is injected', async () => {
    const channel = channelOf()
    const failure = await channel.history('oc_dm', 5).then(
      () => { throw new Error('history resolved without a reader') },
      (error: unknown) => error as { code?: string; message?: string },
    )
    expect(failure.code).toBe('HISTORY_UNAVAILABLE')
    expect(String(failure.message)).toContain('HISTORY_UNAVAILABLE')
  })

  it('reports a direct chat\'s audience as the one person, with has_owner judged by union id', async () => {
    const requester = channelOf()
    requester.deliver(envelopeOf(wrappedEvent({ unionId: 'on_requester' })), vi.fn())
    expect(await requester.audience('oc_dm')).toEqual({ party_ids: ['on_requester'], has_owner: false })

    const withOwner = channelOf({ ownerUnionIds: () => ['on_requester'] })
    withOwner.deliver(envelopeOf(wrappedEvent({ unionId: 'on_requester' })), vi.fn())
    expect(await withOwner.audience('oc_dm')).toEqual({ party_ids: ['on_requester'], has_owner: true })

    // A weak identity is a different person, never the owner.
    const weak = channelOf({ ownerUnionIds: () => ['on_requester'] })
    weak.deliver(envelopeOf(flatEvent()), vi.fn())
    expect(await weak.audience('oc_dm')).toEqual({ party_ids: [], has_owner: false })
  })
})