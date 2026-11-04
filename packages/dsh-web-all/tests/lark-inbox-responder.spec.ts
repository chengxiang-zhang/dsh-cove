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
import { afterEach, describe, expect, it } from 'vitest'
import { INBOX_EVENT_TYPE, type LarkInboxEnvelope } from '../src/core/lark-inbox/queue.ts'
import { replyJobId, replySessionId } from '../src/core/lark-inbox/reply-machine.ts'
import type { AutoReplyConfig } from '../src/host/services/lark-inbox/config.ts'
import { InboxStore } from '../src/host/services/lark-inbox/inbox-store.ts'
import { ReplyResponder } from '../src/host/services/lark-inbox/responder.ts'
import { createAutoReplyStatusTool } from '../src/host/services/lark-inbox/tools.ts'

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

interface Harness {
  store: InboxStore
  responder: ReplyResponder
  prompts: Array<{ requestId: string; sessionId: string; text: string }>
  sessions: Array<{ sessionId: string; cwd: string }>
  cancels: string[]
  sent: Array<{ to: string; text: string; target?: { replyToMessageId?: string; idempotencyKey?: string } }>
  sendResult: { ok: boolean; error?: string; retryable?: boolean }
  advance(ms: number): void
  flush(): Promise<void>
  /** Store a message and run admission, as the gateway callback does. */
  deliver(envelope: LarkInboxEnvelope): void
}

function harness(overrides: Partial<AutoReplyConfig> = {}): Harness {
  const store = InboxStore.open({ rootDir: tempDir() })
  let clock = 1_700_000_000_000
  const prompts: Harness['prompts'] = []
  const sessions: Harness['sessions'] = []
  const cancels: string[] = []
  const sent: Harness['sent'] = []
  const sendResult: Harness['sendResult'] = { ok: true }
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
    ...overrides,
  }
  const responder = new ReplyResponder(store, {
    engine: {
      async ensureSession(input) { sessions.push(input) },
      async prompt(input) { prompts.push(input) },
      cancel(sessionId) { cancels.push(sessionId) },
    },
    sender: () => ({
      async send(to, text, target) {
        sent.push({ to, text, ...(target === undefined ? {} : { target }) })
        return sendResult.ok
          ? { ok: true, messageId: `om_sent_${sent.length}` }
          : { ok: false, error: sendResult.error ?? 'failed', retryable: sendResult.retryable === true }
      },
    }),
    config: () => config,
    now: () => clock,
    log: { info() {}, warn() {}, error() {} },
  })
  return {
    store,
    responder,
    prompts,
    sessions,
    cancels,
    sent,
    sendResult,
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

describe('restart recovery', () => {
  /** Build a job and walk it to the state under test, using the ledger directly. */
  function seed(harnessed: Harness, state: 'submitting' | 'running' | 'replying'): void {
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
    harnessed.store.reply.claimSubmit('fj_om_9', replySessionId(CHAT, 1), now)
    if (state === 'submitting') return
    harnessed.store.reply.markRunning('fj_om_9', now + 60_000, now)
    harnessed.store.reply.bindTurn('fj_om_9', 1, now)
    if (state === 'running') return
    harnessed.store.reply.finishTurn('fj_om_9', 'answer', '答案', 'completed', now)
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
    seed(harnessed, 'replying')
    harnessed.advance(51 * 60_000)
    harnessed.responder.start()
    harnessed.responder.tick()
    await harnessed.flush()
    expect(harnessed.sent).toHaveLength(0)
    expect(harnessed.store.reply.job('fj_om_9')?.state).toBe('reply_uncertain')
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
    const value = await tool.execute({ limit: 5 }) as Record<string, unknown>
    expect(value).toMatchObject({ mode: 'probe', answered: 1, open: 0, failed: 0, unattended: 1, gateway: 'connected' })
    const jobs = value.jobs as Array<Record<string, unknown>>
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ state: 'replied', outcome: 'answer', replyPreview: '在的' })
  })

  it('reports the not-running reason instead of an empty ledger', async () => {
    const tool = createAutoReplyStatusTool(() => undefined)
    await expect(tool.execute({})).resolves.toMatchObject({ error: expect.stringContaining('未运行') })
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