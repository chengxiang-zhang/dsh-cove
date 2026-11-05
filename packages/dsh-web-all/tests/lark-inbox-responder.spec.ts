/**
 * Answer-path contracts: what must happen between a stored message and a reply.
 *
 * Every case here is a way the old build failed a person: it read their message
 * and answered none, or would have answered twice, or would have left them with
 * silence when the turn broke. The harness uses the real SQLite ledger because
 * half of what this file asserts (one turn per conversation, idempotent
 * attachment) is enforced by schema constraints rather than by the code above
 * them - a fake store would test the wrong thing.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { INBOX_EVENT_TYPE, type LarkInboxEnvelope } from '../src/core/lark-inbox/queue.ts'
import { replyJobId, replySessionId } from '../src/core/lark-inbox/reply-machine.ts'
import type { AutoReplyConfig } from '../src/host/services/lark-inbox/config.ts'
import { InboxStore } from '../src/host/services/lark-inbox/inbox-store.ts'
import { ReplyResponder } from '../src/host/services/lark-inbox/responder.ts'
import { createAutoReplyStatusTool } from '../src/host/services/lark-inbox/tools.ts'
import { clearBotSessions, isBotSession, markBotSession } from '../src/host/services/feishu/bot-sessions.ts'

/**
 * The execution context the tool registry hands a tool.
 *
 * `ToolCallId` has a runtime constructor, so the call id is a real one; `token` is a
 * symbol brand with no constructor outside the registry, so the fixture asserts the
 * single value it cannot mint. The tools under test read only their arguments, and
 * this is deliberately one narrow assertion on a value the test invents - not the
 * per-call `as never` that switches the checker off for the whole expression.
 * @returns a context the tool's signature accepts.
 */
function toolContext(): ToolRunContext {
  const callId = ToolCallId('call-lark-inbox-test')
  return {
    callId,
    rootCallId: callId,
    name: 'lark_autoreply_status',
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol('token') as ToolExecutionToken,
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

const OWNER = 'ou_owner'
const CHAT = 'oc_chat'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'web-all-lark-reply-'))
  roots.push(root)
  return root
}

/** One inbound message as the gateway would have stored it. */
function message(index: number, body: string, overrides: Partial<LarkInboxEnvelope> = {}): LarkInboxEnvelope {
  return {
    envelopeVersion: 1,
    eventId: `evt-${index}`,
    receivedAt: new Date(1_700_000_000_000 + index).toISOString(),
    eventType: INBOX_EVENT_TYPE,
    chatType: 'p2p',
    chatId: CHAT,
    senderOpenId: OWNER,
    messageId: `om_${index}`,
    messageType: 'text',
    content: body,
    mentionBot: false,
    ...overrides,
  }
}

/** Set by a test that needs the engine to act before `prompt` resolves. */
interface EngineHooks {
  beforePromptResolves?: (sessionId: string, requestId: string) => void
  promptFails?: Error
  /** Makes `prompt` pend forever, as a stalled engine does. */
  promptHangs?: boolean
  /** Makes the session bind pend forever, as a stalled engine does. */
  bindHangs?: boolean
  /** Makes the reaction call throw, as a missing scope does. */
  receiptFails?: boolean
  /** Makes the heartbeat sink throw, as a read-only home does. */
  heartbeatFails?: boolean
}

interface Harness {
  store: InboxStore
  responder: ReplyResponder
  prompts: Array<{ requestId: string; sessionId: string; text: string }>
  sessions: Array<{ sessionId: string; cwd: string }>
  cancels: string[]
  receipts: Array<{ messageId: string; emojiType: string }>
  heartbeats: Array<Record<string, unknown>>
  sent: Array<{ to: string; text: string; target?: { replyToMessageId?: string; idempotencyKey?: string } }>
  sendResult: { ok: boolean; error?: string; retryable?: boolean }
  /** Knobs for the races a real engine can produce. */
  engineHooks: EngineHooks
  /** The live config object; mutating it is what a settings change looks like. */
  config: AutoReplyConfig
  /** A second responder over the same ledger, as a settings-driven rebuild makes. */
  rebuild(): ReplyResponder
  advance(ms: number): void
  flush(): Promise<void>
  /** Store a message and run admission, as the gateway callback does. */
  deliver(envelope: LarkInboxEnvelope): void
}

/**
 * Noon and three in the morning, in the machine's own time: the two sides of the
 * quiet-hours gate. The gate reads `new Date(now).getHours()` - local wall clock, which is
 * the right answer for a bot running on the person's own machine - so a fixture pinned to
 * a fixed offset (+08:00) only means "noon" on a host in that zone. Built from local
 * components, "local noon" and "local 3am" stay the same test on a UTC runner.
 */
const NOON = new Date(2023, 10, 15, 12, 0, 0).getTime()
const THREE_AM = new Date(2023, 10, 15, 3, 0, 0).getTime()

function harness(overrides: Partial<AutoReplyConfig> = {}, startClock = 1_700_000_000_000): Harness {
  const store = InboxStore.open({ rootDir: tempDir() })
  let clock = startClock
  const prompts: Harness['prompts'] = []
  const sessions: Harness['sessions'] = []
  const cancels: string[] = []
  const sent: Harness['sent'] = []
  const sendResult: Harness['sendResult'] = { ok: true }
  const receipts: Array<{ messageId: string; emojiType: string }> = []
  const heartbeats: Array<Record<string, unknown>> = []
  const hooks: EngineHooks = { receiptFails: false }
  const config: AutoReplyConfig = {
    mode: 'self',
    openIds: [OWNER],
    debounceMs: 1000,
    turnTimeoutMs: 60_000,
    tickMs: 1000,
    cwd: '/tmp/bot-repo',
    preamble: 'PREAMBLE',
    maxSendAttempts: 3,
    maxSubmitAttempts: 3,
    receipt: false,
    proactive: false,
    // The two answer-path switches, spelled out rather than left undefined: the
    // heartbeat publishes them, so a fixture without them would report a switch the
    // process can never actually be in.
    steer: 'off',
    router: 'off',
    ...overrides,
  }
  const ports: ConstructorParameters<typeof ReplyResponder>[1] = {
    engine: {
      async ensureSession(input) {
        sessions.push(input)
        if (hooks.bindHangs === true) await new Promise<void>(() => {})
      },
      async prompt(input) {
        prompts.push(input)
        // The real engine can open and finish the turn before this promise
        // settles, which is exactly the ordering the responder must survive.
        hooks.beforePromptResolves?.(input.sessionId, input.requestId)
        if (hooks.promptFails !== undefined) throw hooks.promptFails
        if (hooks.promptHangs === true) await new Promise<void>(() => {})
      },
      cancel(sessionId) { cancels.push(sessionId) },
    },
    sender: () => ({
      async react(messageId, emojiType) {
        receipts.push({ messageId, emojiType })
        if (hooks.receiptFails === true) throw new Error('reaction rejected')
        return true
      },
      async send(to, text, target) {
        sent.push({ to, text, ...(target === undefined ? {} : { target }) })
        return sendResult.ok
          ? { ok: true, messageId: `om_sent_${sent.length}` }
          : { ok: false, error: sendResult.error ?? 'failed', retryable: sendResult.retryable === true }
      },
    }),
    config: () => config,
    heartbeat: state => {
      if (hooks.heartbeatFails === true) throw new Error('read-only home')
      heartbeats.push(state as unknown as Record<string, unknown>)
    },
    now: () => clock,
    log: { info() {}, warn() {}, error() {} },
  }
  const responder = new ReplyResponder(store, ports)
  return {
    store,
    responder,
    prompts,
    sessions,
    cancels,
    sent,
    receipts,
    heartbeats,
    sendResult,
    engineHooks: hooks,
    config,
    rebuild: () => new ReplyResponder(store, { ...ports, setInterval: () => 0 }),
    advance: ms => { clock += ms },
    // The submit half is async by design; one macrotask turn drains it.
    flush: () => new Promise<void>(resolve => { setImmediate(resolve) }),
    deliver: (envelope) => {
      if (store.append(envelope) !== 'appended') return
      responder.kick(envelope)
    },
  }
}

/** Drive the turn lifecycle the engine would report for one completed turn. */
function runTurn(
  harnessed: Harness,
  turn: number,
  options: { requestIdFrom?: number; text?: string; reason?: Record<string, unknown>; interrupted?: boolean } = {},
): void {
  const { responder, prompts } = harnessed
  const sessionId = prompts[prompts.length - 1]?.sessionId ?? ''
  const requestId = options.requestIdFrom === undefined
    ? prompts[prompts.length - 1]?.requestId ?? ''
    : replyJobId(`om_${options.requestIdFrom}`, `evt-${options.requestIdFrom}`)
  responder.handleSessionEvent(sessionId, { type: 'turn/start', data: { turn } })
  responder.handleSessionEvent(sessionId, { type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } })
  if (options.text !== undefined) {
    responder.handleSessionEvent(sessionId, {
      type: 'assistant/message',
      data: {
        turn,
        step: 1,
        message: { content: [{ type: 'text', text: options.text }] },
        ...(options.interrupted === true ? { interrupted: true } : {}),
      },
    })
  }
  responder.handleSessionEvent(sessionId, {
    type: 'turn/end',
    data: { turn, reason: options.reason ?? { kind: 'completed' } },
  })
}

describe('reply admission', () => {
  it('answers one direct message once and binds it to a deterministic session', async () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()

    expect(harnessed.prompts).toHaveLength(1)
    expect(harnessed.prompts[0].requestId).toBe('fj_om_1')
    expect(harnessed.prompts[0].sessionId).toBe(replySessionId(CHAT, 1))
    expect(harnessed.prompts[0].text).toContain('PREAMBLE')
    expect(harnessed.prompts[0].text).toContain('你好')
    expect(harnessed.sessions[0]).toEqual({ sessionId: replySessionId(CHAT, 1), cwd: '/tmp/bot-repo' })

    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()

    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0]).toMatchObject({
      to: CHAT,
      text: '在的',
      target: { replyToMessageId: 'om_1', idempotencyKey: 'fj_om_1' },
    })
    // One attempt means one attempt, including the one that worked.
    expect(harnessed.store.reply.job('fj_om_1')?.sendAttempts).toBe(1)
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('replied')
    // The message's own queue row is settled as answered, not left for a tool.
    expect(harnessed.store.stats()).toMatchObject({ done: 1, pending: 0, routed: 0 })
  })

  it('answers nothing while the mode is off, and leaves the message queueable', () => {
    const harnessed = harness({ mode: 'off' })
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(5000)
    harnessed.responder.tick()
    expect(harnessed.prompts).toHaveLength(0)
    expect(harnessed.store.reply.stats().total).toBe(0)
    expect(harnessed.store.stats().pending).toBe(1)
  })

  it('refuses a sender outside the allowlist', () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '你好', { senderOpenId: 'ou_stranger' }))
    harnessed.advance(5000)
    harnessed.responder.tick()
    expect(harnessed.prompts).toHaveLength(0)
    expect(harnessed.store.stats().pending).toBe(1)
  })

  it('answers a group message only when the bot is named', async () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '问个事', { chatType: 'group', chatId: 'oc_group', mentionBot: false }))
    harnessed.advance(5000)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.prompts).toHaveLength(0)

    harnessed.deliver(message(2, '@bot 问个事', { chatType: 'group', chatId: 'oc_group', mentionBot: true }))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.prompts).toHaveLength(1)
    // One conversation key per room, so a second question in the same room
    // continues the same session instead of starting over.
    expect(harnessed.store.reply.binding('oc_group')).toMatchObject({ chatType: 'group' })
  })

  it('admits everyone the operator allows when the allowlist is empty', async () => {
    const harnessed = harness({ openIds: [] })
    harnessed.deliver(message(1, '你好', { senderOpenId: 'ou_stranger' }))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.prompts).toHaveLength(1)
  })
})

describe('idempotency', () => {
  it('opens no second batch when the same event is admitted again', async () => {
    const harnessed = harness()
    const envelope = message(1, '你好')
    harnessed.deliver(envelope)
    // A redelivery that somehow reached admission again must not open a second
    // job: the ledger's message mapping is what refuses it.
    harnessed.responder.kick(envelope)
    harnessed.responder.kick(envelope)
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()

    expect(harnessed.prompts).toHaveLength(1)
    expect(harnessed.store.reply.stats().total).toBe(1)

    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.store.stats()).toMatchObject({ done: 1, routed: 0 })
  })

  it('treats the same message under a new event id as the same batch message', async () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(100)
    // Feishu redelivers under a fresh event id after a reconnect; the message id
    // is the key that survives that, so the second copy is not a second question.
    harnessed.deliver(message(1, '你好', { eventId: 'evt-1-retry' }))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.prompts).toHaveLength(1)
    expect(harnessed.store.reply.messagesOf('fj_om_1')).toHaveLength(1)
  })
})

describe('batching', () => {
  it('folds consecutive messages into one turn and answers each batch', async () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '第一句'))
    harnessed.advance(500)
    harnessed.deliver(message(2, '第二句'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()

    expect(harnessed.prompts).toHaveLength(1)
    expect(harnessed.prompts[0].text).toContain('1. 第一句')
    expect(harnessed.prompts[0].text).toContain('2. 第二句')

    runTurn(harnessed, 1, { text: '一起答' })
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].target?.replyToMessageId).toBe('om_2')

    // A message arriving after the batch was answered starts a new one.
    harnessed.advance(5000)
    harnessed.deliver(message(3, '第三句'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.prompts).toHaveLength(2)
    runTurn(harnessed, 2, { text: '再答' })
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(2)
    expect(harnessed.sent[1].target?.replyToMessageId).toBe('om_3')
  })
})

describe('engine ordering', () => {
  it('captures a turn that finishes before the prompt call returns', async () => {
    const harnessed = harness()
    harnessed.engineHooks.beforePromptResolves = (sessionId, requestId) => {
      harnessed.responder.handleSessionEvent(sessionId, { type: 'turn/start', data: { turn: 1 } })
      harnessed.responder.handleSessionEvent(sessionId, { type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } })
      harnessed.responder.handleSessionEvent(sessionId, {
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '立刻答完' }] } },
      })
      harnessed.responder.handleSessionEvent(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    }
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()

    // Those events must land on a running job, or the answer is dropped and the
    // person waits for a timeout sentence instead of their reply.
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].text).toBe('立刻答完')
    expect(harnessed.store.reply.job('fj_om_1')).toMatchObject({ outcome: 'answer' })
  })

  it('puts a job whose prompt threw before binding a turn back into the batch', async () => {
    const harnessed = harness()
    harnessed.engineHooks.promptFails = new Error('gateway down')
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()

    const job = harnessed.store.reply.job('fj_om_1')
    expect(job?.state).toBe('collecting')
    expect(job?.lastError).toContain('gateway down')
    // Retried rather than reported as a broken turn: nothing ran, so there is
    // nothing to explain to the person yet.
    expect(harnessed.sent).toHaveLength(0)
  })
})

describe('stalled engine calls', () => {
  it('closes a prompt that never opens a turn as a timeout instead of waiting forever', async () => {
    const harnessed = harness({ turnTimeoutMs: 1000 })
    harnessed.engineHooks.promptHangs = true
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    // Running with no bound turn: the engine accepted nothing observable.
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('running')

    harnessed.advance(1500)
    harnessed.responder.tick()
    expect(harnessed.cancels).toHaveLength(1)

    harnessed.advance(16_000)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].text).toContain('超时')
    expect(harnessed.store.reply.job('fj_om_1')).toMatchObject({ state: 'replied', outcome: 'timeout' })
  })

  it('retries a session bind that hangs, then explains itself when attempts run out', async () => {
    const harnessed = harness({ turnTimeoutMs: 1000, maxSubmitAttempts: 2 })
    harnessed.engineHooks.bindHangs = true
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('submitting')

    // The submission deadline, not the turn deadline, is what notices here.
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('collecting')
    expect(harnessed.sent).toHaveLength(0)

    harnessed.advance(60_000)
    harnessed.responder.tick()
    await harnessed.flush()
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    harnessed.advance(60_000)
    harnessed.responder.tick()
    await harnessed.flush()

    expect(harnessed.sent.length).toBeGreaterThanOrEqual(1)
    expect(harnessed.sent[0].text).toContain('出错')
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('replied')
  })
})

describe('failure is never silence', () => {
  it('sends a sentence naming the failure when the turn errors', async () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()

    runTurn(harnessed, 1, { reason: { kind: 'error', error: { code: 'PROVIDER_DOWN', message: 'boom' } } })
    await harnessed.flush()

    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].text).toContain('PROVIDER_DOWN')
    expect(harnessed.store.reply.job('fj_om_1')).toMatchObject({ state: 'replied', outcome: 'error' })
  })

  it('sends a sentence when the turn completes with no text', async () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1)
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].text).toContain('没有可回复的内容')
    expect(harnessed.store.reply.job('fj_om_1')).toMatchObject({ state: 'replied', outcome: 'empty' })
  })

  it('ignores an interrupted assistant message instead of forwarding a half stream', async () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1, { text: '半截', interrupted: true, reason: { kind: 'aborted', reason: 'user' } })
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].text).toContain('被中断')
    expect(harnessed.store.reply.job('fj_om_1')).toMatchObject({ outcome: 'interrupted' })
  })
})

describe('timeouts', () => {
  it('cancels an expired turn, closes it as a timeout, and ignores its late end', async () => {
    const harnessed = harness({ turnTimeoutMs: 1000 })
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()

    harnessed.advance(1500)
    harnessed.responder.tick()
    expect(harnessed.cancels).toHaveLength(1)
    expect(harnessed.sent).toHaveLength(0)

    // Grace expires without the engine reporting an end.
    harnessed.advance(16_000)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].text).toContain('超时')
    expect(harnessed.store.reply.job('fj_om_1')).toMatchObject({ state: 'replied', outcome: 'timeout' })

    // The cancelled turn's own end arrives late; it must not answer twice.
    runTurn(harnessed, 1, { text: '太晚了' })
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
  })

  it('still delivers the answer when the aborted end arrives inside the grace period', async () => {
    const harnessed = harness({ turnTimeoutMs: 1000 })
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()

    harnessed.advance(1500)
    harnessed.responder.tick()
    expect(harnessed.cancels).toHaveLength(1)

    // The engine reports the cancelled turn and the text already streamed.
    runTurn(harnessed, 1, { text: '其实算完了', reason: { kind: 'aborted', reason: 'cancel' } })
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].text).toBe('其实算完了')
    expect(harnessed.store.reply.job('fj_om_1')).toMatchObject({ outcome: 'answer' })
  })
})

describe('manual control', () => {
  it('cancels the running turn on /stop and reports it stopped', async () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '跑个长任务'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()

    harnessed.deliver(message(2, '/stop'))
    expect(harnessed.cancels).toHaveLength(1)

    runTurn(harnessed, 1, { reason: { kind: 'aborted', reason: 'cancel' } })
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].text).toContain('已停止')
    expect(harnessed.store.reply.job('fj_om_1')).toMatchObject({ outcome: 'stopped' })
    // The control word itself never became a question.
    expect(harnessed.store.reply.job('fj_om_2')).toBeUndefined()
  })

  it('keeps the notification path away from a session opened by /new', async () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '/new'))
    const replacement = replySessionId(CHAT, 2)
    expect(harnessed.store.reply.binding(CHAT)?.sessionId).toBe(replacement)
    // Every session this path drives must be marked, including the replacement:
    // a `/new` that forgot it would double-notify from its first turn on.
    expect(isBotSession(replacement)).toBe(true)
    clearBotSessions()
  })

  it('rotates the session on /new without answering anything', async () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '/new'))
    harnessed.advance(5000)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.prompts).toHaveLength(0)
    expect(harnessed.store.reply.binding(CHAT)).toMatchObject({ generation: 2 })
    expect(harnessed.store.reply.binding(CHAT)?.sessionId).toBe(replySessionId(CHAT, 2))
  })
})

describe('notification path hand-off', () => {
  it('re-registers bound sessions when a replacement responder starts', async () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    const sessionId = replySessionId(CHAT, 1)
    expect(isBotSession(sessionId)).toBe(true)

    // A settings change tears the responder down and builds another one over the
    // same ledger. The replacement must reclaim the sessions, or the notification
    // path would start pushing run-finished notices for answered conversations.
    harnessed.responder.dispose()
    expect(isBotSession(sessionId)).toBe(false)
    const replacement = harnessed.rebuild()
    replacement.start()
    expect(isBotSession(sessionId)).toBe(true)
    // And a teardown releases the claim: a session whose bot is gone must go back
    // to being ordinary rather than staying silently exempt from notifications.
    replacement.dispose()
    expect(isBotSession(sessionId)).toBe(false)
    clearBotSessions()
  })
})

describe('restart recovery', () => {
  /** Build a job and walk it to the state under test, using the ledger directly. */
  function seed(harnessed: Harness, state: 'submitting' | 'running' | 'replying', attempted = false): void {
    const now = 1_700_000_000_000
    harnessed.store.append(message(9, '旧消息'))
    harnessed.store.reply.ensureBinding({ convKey: CHAT, chatId: CHAT, chatType: 'p2p', sessionId: replySessionId(CHAT, 1), now })
    harnessed.store.reply.attach({
      eventId: 'evt-9',
      messageId: 'om_9',
      jobId: 'fj_om_9',
      convKey: CHAT,
      replyToMessageId: 'om_9',
      now,
      debounceMs: 0,
    })
    harnessed.store.reply.claimSubmit('fj_om_9', replySessionId(CHAT, 1), now, now + 60_000)
    if (state === 'submitting') return
    harnessed.store.reply.markRunning('fj_om_9', now + 60_000, now)
    harnessed.store.reply.bindTurn('fj_om_9', 1, now)
    if (state === 'running') return
    harnessed.store.reply.finishTurn('fj_om_9', 'answer', '答案', 'completed', now)
    // A reply that was mid-send has one attempt on the clock; a reply that never got
    // that far is a different case and is covered separately below.
    if (attempted) harnessed.store.reply.bumpSendAttempt('fj_om_9')
  }

  it('closes a turn that was running when the process died as interrupted, without re-running it', async () => {
    const harnessed = harness()
    seed(harnessed, 'running')
    // Recovery runs synchronously in start(); the sweep below is driven by hand so
    // the assertion does not depend on the timer.
    harnessed.responder.start()
    harnessed.responder.tick()
    await harnessed.flush()

    expect(harnessed.prompts).toHaveLength(0)
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].text).toContain('被中断')
    expect(harnessed.store.reply.job('fj_om_9')).toMatchObject({ state: 'replied', outcome: 'interrupted' })
  })

  it('retries a submission that never reached the engine', async () => {
    const harnessed = harness()
    seed(harnessed, 'submitting')
    harnessed.responder.start()
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.store.reply.job('fj_om_9')?.state).toBe('running')
    expect(harnessed.prompts).toHaveLength(1)
    expect(harnessed.prompts[0].requestId).toBe('fj_om_9')
  })

  it('retries a send that was in flight inside the platform idempotency window', async () => {
    const harnessed = harness()
    seed(harnessed, 'replying')
    harnessed.responder.start()
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].target?.idempotencyKey).toBe('fj_om_9')
    expect(harnessed.store.reply.job('fj_om_9')?.state).toBe('replied')
  })

  it('treats a send older than the platform window as uncertain instead of resending', async () => {
    const harnessed = harness()
    seed(harnessed, 'replying', true)
    harnessed.advance(51 * 60_000)
    harnessed.responder.start()
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(0)
    expect(harnessed.store.reply.job('fj_om_9')?.state).toBe('reply_uncertain')
  })

  it('still sends a reply the previous process never attempted, however old it is', async () => {
    const harnessed = harness()
    seed(harnessed, 'replying', false)
    // Long past the platform's idempotency window, but nothing was ever sent, so
    // there is nothing to duplicate - the person is still owed this answer.
    harnessed.advance(5 * 3_600_000)
    harnessed.responder.start()
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.store.reply.job('fj_om_9')?.state).toBe('replied')
  })
})

describe('status tool', () => {
  it('reports mode, counts and the text that would have been sent', async () => {
    const harnessed = harness({ mode: 'probe' })
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()
    // A pending message nothing is answering is the reading that separates "we are
    // waiting for a message" from "a message is waiting for us".
    harnessed.deliver(message(2, '另一个问题', { senderOpenId: 'ou_stranger' }))

    const tool = createAutoReplyStatusTool(() => harnessed.store, {
      autoReply: () => harnessed.responder.status(),
      gatewayStatus: () => ({ status: 'connected' }),
    })
    const value = await tool.execute({ limit: 5 }, toolContext()) as Record<string, unknown>
    expect(value).toMatchObject({ mode: 'probe', answered: 1, open: 0, failed: 0, unattended: 1, gateway: 'connected' })
    const jobs = value.jobs as Array<Record<string, unknown>>
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ state: 'replied', outcome: 'answer', replyPreview: '在的' })
  })

  it('reports the not-running reason instead of an empty ledger', async () => {
    const tool = createAutoReplyStatusTool(() => undefined)
    await expect(tool.execute({}, toolContext())).resolves.toMatchObject({ error: expect.stringContaining('未运行') })
  })
})

describe('conversation freshness', () => {
  it('remembers the chat the person is actually using', async () => {
    const harnessed = harness()
    const olderSession = replySessionId('oc_older', 1)
    harnessed.store.reply.ensureBinding({
      convKey: 'oc_older',
      chatId: 'oc_older',
      chatType: 'p2p',
      sessionId: olderSession,
      now: 1_700_000_000_000,
    })
    harnessed.advance(60_000)
    // Activity in the second chat must make it the current one: a notice has no
    // message behind it to name a target, so it relies on this being right.
    harnessed.deliver(message(1, '你好', { chatId: CHAT }))
    expect(harnessed.store.reply.latestDirectBinding()?.convKey).toBe(CHAT)
  })
})

describe('proactive notice', () => {
  /** Establish the direct conversation a notice could be sent into. */
  function seedConversation(harnessed: Harness): string {
    const sessionId = replySessionId(CHAT, 1)
    harnessed.store.reply.ensureBinding({
      convKey: CHAT,
      chatId: CHAT,
      chatType: 'p2p',
      sessionId,
      now: 1_700_000_000_000,
    })
    // The responder marks its own sessions when it admits a message; this test
    // creates the conversation directly, so it marks the id the same way.
    markBotSession(sessionId)
    return sessionId
  }

  /** Let a run in someone else's session finish, which is the trigger. */
  function finishedForeignRun(harnessed: Harness, minutes: number): void {
    harnessed.responder.handleSessionEvent('human-1', { type: 'turn/start', data: { turn: 1 } })
    harnessed.advance(minutes * 60_000)
    harnessed.responder.handleSessionEvent('human-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }

  it('asks the model to decide after a long run elsewhere, and honours silence', async () => {
    // Midday: outside the quiet hours the gates enforce.
    const harnessed = harness({ proactive: true }, NOON)
    seedConversation(harnessed)

    finishedForeignRun(harnessed, 5)
    harnessed.responder.tick()
    await harnessed.flush()

    expect(harnessed.prompts).toHaveLength(1)
    expect(harnessed.prompts[0].text).toContain('SILENT')

    runTurn(harnessed, 1, { text: 'SILENT' })
    await harnessed.flush()

    // Silence is the delivered outcome here: nothing is sent, and the ledger says
    // the turn chose not to speak rather than that it never ran.
    expect(harnessed.sent).toHaveLength(0)
    const job = harnessed.store.reply.recent(1)[0]
    expect(job).toMatchObject({ kind: 'proactive', state: 'replied', outcome: 'empty' })
    clearBotSessions()
  })

  it('sends what the model decided to say', async () => {
    const harnessed = harness({ proactive: true }, NOON)
    seedConversation(harnessed)

    finishedForeignRun(harnessed, 5)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1, { text: '你让我跑的那批任务全过了。' })
    await harnessed.flush()

    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].text).toContain('全过了')
    clearBotSessions()
  })

  it('stays out of a short run, a disabled switch, and the quiet hours', async () => {
    const short = harness({ proactive: true }, NOON)
    seedConversation(short)
    finishedForeignRun(short, 0.2)
    short.responder.tick()
    await short.flush()
    expect(short.prompts).toHaveLength(0)

    const disabled = harness({ proactive: false }, NOON)
    seedConversation(disabled)
    finishedForeignRun(disabled, 5)
    disabled.responder.tick()
    await disabled.flush()
    expect(disabled.prompts).toHaveLength(0)

    // 03:00 local: the gate refuses before the model is ever asked.
    const night = harness({ proactive: true }, THREE_AM)
    seedConversation(night)
    finishedForeignRun(night, 5)
    night.responder.tick()
    await night.flush()
    expect(night.prompts).toHaveLength(0)
    clearBotSessions()
  })
})

describe('heartbeat', () => {
  it('writes one when it starts and again when a turn settles', async () => {
    const harnessed = harness()
    harnessed.responder.start()
    expect(harnessed.heartbeats.length).toBeGreaterThanOrEqual(1)
    const started = harnessed.heartbeats[0]
    expect(started).toMatchObject({ mode: 'self', answered: 0, open: 0, failed: 0 })
    expect(typeof started.startedAt).toBe('number')

    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()
    // A settle writes immediately rather than waiting for the throttle: the
    // reader outside the process should see the answer land.
    expect(harnessed.heartbeats.at(-1)).toMatchObject({ answered: 1 })
  })

  it('keeps sweeping when the heartbeat cannot be written', async () => {
    const harnessed = harness()
    harnessed.engineHooks.heartbeatFails = true
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    // A read-only home is not a reason to stop answering people.
    expect(harnessed.prompts).toHaveLength(1)
  })

  it('reports which switches are in force, and follows a settings change', async () => {
    const harnessed = harness({ steer: 'shadow', router: 'off' })
    harnessed.responder.start()
    // The file is the only reading an operator has on a host whose logs do not reach
    // disk: "I edited the profile" and "the process uses it" are different facts.
    expect(harnessed.heartbeats.at(-1)).toMatchObject({ steer: 'shadow', router: 'off' })

    harnessed.config.steer = 'on'
    harnessed.config.router = 'on'
    // One throttle window, then the next sweep: no rebuild, no restart.
    harnessed.advance(30_000)
    harnessed.responder.tick()
    expect(harnessed.heartbeats.at(-1)).toMatchObject({ steer: 'on', router: 'on' })
  })

  it('does not report a switch that is off as if it were on', async () => {
    const harnessed = harness()
    harnessed.responder.start()
    // The default is off for both: a heartbeat that said otherwise would be the
    // reason someone believed a feature was live when it was not.
    expect(harnessed.heartbeats.at(-1)).toMatchObject({ steer: 'off', router: 'off' })
  })
})

describe('receipt', () => {
  it('reacts as soon as the message is accepted, before any turn runs', async () => {
    const harnessed = harness({ receipt: true })
    harnessed.deliver(message(1, '你好'))
    // No tick yet: the receipt means "I have your message", and a person waiting
    // behind another turn needs that before the turn, not after it.
    expect(harnessed.receipts).toEqual([{ messageId: 'om_1', emojiType: 'SMILE' }])
  })

  it('reacts to a message that has to queue behind a running turn', async () => {
    const harnessed = harness({ receipt: true })
    harnessed.deliver(message(1, '第一句'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    // The first turn is now running; this second message cannot start for a while.
    harnessed.deliver(message(2, '第二句'))
    expect(harnessed.receipts.map(item => item.messageId)).toEqual(['om_1', 'om_2'])
  })

  it('does not react while the receipt is off, or in probe mode', async () => {
    const off = harness({ receipt: false })
    off.deliver(message(1, '你好'))
    expect(off.receipts).toHaveLength(0)

    const probe = harness({ receipt: true, mode: 'probe' })
    probe.deliver(message(1, '你好'))
    // Probe mode exists to touch nothing a person can see.
    expect(probe.receipts).toHaveLength(0)
  })

  it('still answers when the reaction is refused', async () => {
    const harnessed = harness({ receipt: true })
    harnessed.engineHooks.receiptFails = true
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()
    // A missing scope is a cosmetic loss; losing the answer over it would not be.
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].text).toBe('在的')
  })
})

describe('mode changes apply to new messages only', () => {
  it('still delivers a reply that was accepted while sending was on', async () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    // The operator switches to probe while this turn is still running.
    harnessed.config.mode = 'probe'
    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()
    // The message was already promised an answer; switching off must not retract it.
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.store.reply.job('fj_om_1')?.outcome).toBe('answer')
  })

  it('keeps a message accepted in probe out of Feishu even after the switch to self', async () => {
    const harnessed = harness({ mode: 'probe' })
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    harnessed.config.mode = 'self'
    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()
    // That message was accepted under probe, so it stays recorded and unsent.
    expect(harnessed.sent).toHaveLength(0)
    expect(harnessed.store.reply.job('fj_om_1')?.replyText).toBe('在的')
  })
})

describe('live settings', () => {
  it('starts sending when the mode is changed to self, without a rebuild', async () => {
    const harnessed = harness({ mode: 'probe' })
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(0)

    // An operator flipping probe to self in the settings page is a config write,
    // not a rebuild: the same running responder must pick it up on its next turn.
    harnessed.config.mode = 'self'
    harnessed.deliver(message(2, '再来一句'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.prompts).toHaveLength(2)
    runTurn(harnessed, 2, { text: '这次真发了' })
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.sent[0].text).toBe('这次真发了')
  })
})

describe('probe mode', () => {
  it('records what would have been sent without sending it', async () => {
    const harnessed = harness({ mode: 'probe' })
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()

    expect(harnessed.sent).toHaveLength(0)
    expect(harnessed.store.reply.job('fj_om_1')).toMatchObject({ state: 'replied', outcome: 'answer', replyText: '在的' })
    expect(harnessed.store.reply.job('fj_om_1')?.replyMessageId).toBeUndefined()
  })
})

describe('send serialisation', () => {
  it('does not let the next sweep re-send a reply that is already in flight', async () => {
    const harnessed = harness()
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)

    // A second batch is what makes the race visible: the first job's send is only
    // protected while its retry time is in the future.
    harnessed.advance(100)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('replied')
  })

  it('leaves a stalled send retryable once its grace expires', async () => {
    const harnessed = harness()
    harnessed.sendResult.ok = false
    harnessed.sendResult.error = 'rate limited'
    harnessed.sendResult.retryable = true
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('replying')

    harnessed.sendResult.ok = true
    harnessed.advance(31_000)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(2)
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('replied')
  })
})

describe('send failures', () => {
  it('retries a retryable failure with the same idempotency token', async () => {
    const harnessed = harness()
    harnessed.sendResult.ok = false
    harnessed.sendResult.error = 'rate limited'
    harnessed.sendResult.retryable = true
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(1)
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('replying')

    harnessed.sendResult.ok = true
    harnessed.advance(5000)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(2)
    expect(harnessed.sent[1].target?.idempotencyKey).toBe(harnessed.sent[0].target?.idempotencyKey)
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('replied')
  })

  it('keeps retrying slowly while the failure still looks temporary', async () => {
    const harnessed = harness({ maxSendAttempts: 1 })
    harnessed.sendResult.ok = false
    harnessed.sendResult.error = 'network down'
    harnessed.sendResult.retryable = true
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()
    // The fast budget is spent; a dead network must not become permanent silence.
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('replying')

    harnessed.sendResult.ok = true
    harnessed.advance(31 * 60_000)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('replied')
    expect(harnessed.sent.length).toBeGreaterThanOrEqual(2)
  })

  it('gives up once the answer has clearly gone stale', async () => {
    const harnessed = harness({ maxSendAttempts: 1 })
    harnessed.sendResult.ok = false
    harnessed.sendResult.error = 'network down'
    harnessed.sendResult.retryable = true
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()
    // A day later the news is no longer worth delivering.
    harnessed.advance(25 * 3_600_000)
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('failed')
  })

  it('stops retrying a permanent failure and retires the message', async () => {
    const harnessed = harness()
    harnessed.sendResult.ok = false
    harnessed.sendResult.error = 'chat not found'
    harnessed.sendResult.retryable = false
    harnessed.deliver(message(1, '你好'))
    harnessed.advance(1500)
    harnessed.responder.tick()
    await harnessed.flush()
    runTurn(harnessed, 1, { text: '在的' })
    await harnessed.flush()
    expect(harnessed.store.reply.job('fj_om_1')?.state).toBe('failed')
    expect(harnessed.store.stats().dead).toBe(1)
  })
})