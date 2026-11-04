/**
 * Folding a message into the turn that is already running.
 *
 * Every case here is a way a person waits for an answer that does not cover what
 * they said. The failure this feature can introduce is not "the bot ignores you" -
 * that is visible - but "the bot answers, and the line you added never reached the
 * answer": a turn that ended one step too early, a steer that never left the queue,
 * a second turn nobody claimed. The harness is the real SQLite ledger for the same
 * reason the answer-path spec uses it - half of these invariants are schema
 * constraints, and a fake store would test the wrong thing.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { INBOX_EVENT_TYPE, type LarkInboxEnvelope } from '../src/core/lark-inbox/queue.ts'
import { replyJobId, replySessionId, steerRequestId } from '../src/core/lark-inbox/reply-machine.ts'
import {
  REPLY_CARRY_GRACE_MS,
  REPLY_STEER_MAX_PER_JOB,
  type AutoReplyConfig,
} from '../src/host/services/lark-inbox/config.ts'
import { InboxStore } from '../src/host/services/lark-inbox/inbox-store.ts'
import { ReplyResponder } from '../src/host/services/lark-inbox/responder.ts'
import { ReplyStore } from '../src/host/services/lark-inbox/reply-store.ts'

const OWNER = 'ou_owner'
const CHAT = 'oc_chat'
const SESSION = replySessionId(CHAT, 1)

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'web-all-lark-steer-'))
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

interface PromptCall {
  requestId: string
  sessionId: string
  text: string
  mode: 'queue' | 'steer'
}

interface Harness {
  root: string
  store: InboxStore
  responder: ReplyResponder
  prompts: PromptCall[]
  sent: Array<{ to: string; text: string; target?: { replyToMessageId?: string; idempotencyKey?: string } }>
  cancels: string[]
  /** Fails the next N steer deliveries, as a busy or unavailable engine does. */
  steerFailures: { remaining: number }
  config: AutoReplyConfig
  advance(ms: number): void
  /** The fake clock, so an assertion can be exact about a deadlined value. */
  now(): number
  flush(): Promise<void>
  deliver(envelope: LarkInboxEnvelope): void
  /** Read one member's steer state straight from the ledger. */
  steerStateOf(eventId: string): string
  /** Read the queue row status a member's message ended up in. */
  queueStatusOf(eventId: string): string
  close(): void
}

const START = 1_700_000_000_000

function harness(overrides: Partial<AutoReplyConfig> = {}): Harness {
  const root = tempDir()
  const store = InboxStore.open({ rootDir: root })
  let clock = START
  const prompts: PromptCall[] = []
  const sent: Harness['sent'] = []
  const cancels: string[] = []
  const steerFailures = { remaining: 0 }
  const config: AutoReplyConfig = {
    mode: 'self',
    openIds: [OWNER],
    debounceMs: 1000,
    turnTimeoutMs: 600_000,
    tickMs: 1000,
    cwd: '/tmp/bot-repo',
    preamble: 'PREAMBLE',
    maxSendAttempts: 3,
    maxSubmitAttempts: 3,
    receipt: false,
    proactive: false,
    steer: 'on',
    ...overrides,
  }
  const ports: ConstructorParameters<typeof ReplyResponder>[1] = {
    engine: {
      async ensureSession() {},
      async prompt(input) {
        prompts.push(input)
        if (input.mode === 'steer' && steerFailures.remaining > 0) {
          steerFailures.remaining -= 1
          throw new Error('session/agent-busy')
        }
      },
      cancel(sessionId) { cancels.push(sessionId) },
    },
    sender: () => ({
      async send(to, text, target) {
        sent.push({ to, text, ...(target === undefined ? {} : { target }) })
        return { ok: true, messageId: `om_sent_${sent.length}` }
      },
    }),
    config: () => config,
    now: () => clock,
    log: { info() {}, warn() {}, error() {} },
    // The retry backoff is the one real wait on this path; a test does not need it.
    sleep: async () => {},
  }
  const responder = new ReplyResponder(store, ports)
  const db = new DatabaseSync(join(root, 'inbox.sqlite'))
  return {
    root,
    store,
    responder,
    prompts,
    sent,
    cancels,
    steerFailures,
    config,
    advance: ms => { clock += ms },
    now: () => clock,
    // The steer path is async by design; a couple of turns drains its awaits.
    flush: async () => {
      await new Promise<void>(resolve => { setImmediate(resolve) })
      await new Promise<void>(resolve => { setImmediate(resolve) })
    },
    deliver: (envelope) => {
      if (store.append(envelope) !== 'appended') return
      responder.kick(envelope)
    },
    steerStateOf: (eventId) => {
      const row = db.prepare('SELECT steer_state FROM reply_job_messages WHERE event_id = ?')
        .get(eventId) as { steer_state?: string } | undefined
      return row?.steer_state ?? 'missing'
    },
    queueStatusOf: (eventId) => {
      const row = db.prepare('SELECT status FROM inbox_events WHERE event_id = ?')
        .get(eventId) as { status?: string } | undefined
      return row?.status ?? 'missing'
    },
    close: () => { try { db.close() } catch { /* the store owns the other handle */ } },
  }
}

/** Drive the engine events one turn produces, in the order the engine emits them. */
function turnStart(h: Harness, turn: number): void {
  h.responder.handleSessionEvent(SESSION, { type: 'turn/start', data: { turn } })
}

function userMessage(h: Harness, requestId: string): void {
  h.responder.handleSessionEvent(SESSION, {
    type: 'user/message',
    data: { source: { kind: 'user', rpcId: requestId } },
  })
}

function answer(h: Harness, turn: number, text: string): void {
  h.responder.handleSessionEvent(SESSION, {
    type: 'assistant/message',
    data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
  })
}

function turnEnd(h: Harness, turn: number, reason: Record<string, unknown> = { kind: 'completed' }): void {
  h.responder.handleSessionEvent(SESSION, { type: 'turn/end', data: { turn, reason } })
}

/**
 * Submit the first message and bind its turn.
 *
 * The ordering mirrors the real engine: the job is marked running before the prompt
 * is handed over, and the turn number is learned from the events afterwards.
 */
async function runningFirstTurn(h: Harness): Promise<void> {
  h.deliver(message(1, '帮我看下测试为什么挂了'))
  h.advance(1500)
  h.responder.tick()
  await h.flush()
  turnStart(h, 1)
  userMessage(h, replyJobId('om_1', 'evt-1'))
}

const firstJob = 'fj_om_1'

describe('folding a message into the running turn', () => {
  it('holds the job for the turn that consumes a steer the first turn missed', async () => {
    const h = harness()
    await runningFirstTurn(h)
    h.deliver(message(2, '只看 responder 那个文件就行'))
    await h.flush()

    // The steer was delivered as a steer, under its own request id.
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[1]).toMatchObject({ mode: 'steer', requestId: steerRequestId('om_2') })
    expect(h.prompts[1].text).toContain('只看 responder 那个文件就行')
    expect(h.prompts[1].text).toContain('补充')
    expect(h.steerStateOf('evt-2')).toBe('pending')

    // The turn reaches its last step before the steer is picked up.
    answer(h, 1, '我先跑一遍全量测试')
    turnEnd(h, 1, { kind: 'completed' })

    // Held, not answered: the reply is still owed to a turn that is coming.
    expect(h.sent).toHaveLength(0)
    expect(h.store.reply.job(firstJob)).toMatchObject({ state: 'running' })
    expect(h.store.reply.job(firstJob)?.carryUntil).toBe(h.now() + REPLY_CARRY_GRACE_MS)

    // The engine opens the next turn to consume it.
    turnStart(h, 2)
    userMessage(h, steerRequestId('om_2'))
    expect(h.store.reply.job(firstJob)?.turn).toBe(2)
    expect(h.store.reply.job(firstJob)?.carryUntil).toBeUndefined()
    expect(h.steerStateOf('evt-2')).toBe('consumed')

    answer(h, 2, '只跑了 responder 那个文件，问题在批次绑定')
    turnEnd(h, 2, { kind: 'completed' })
    await h.flush()

    // One reply, covering both turns.
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('我先跑一遍全量测试')
    expect(h.sent[0].text).toContain('只跑了 responder 那个文件')
    expect(h.store.reply.job(firstJob)?.state).toBe('replied')
    // The steered message is settled with the job that answered it.
    expect(h.queueStatusOf('evt-2')).toBe('done')
    h.close()
  })

  it('gives up on the wait, and says so, when no turn ever comes', async () => {
    const h = harness()
    await runningFirstTurn(h)
    h.deliver(message(2, '只看 responder 那个文件就行'))
    await h.flush()
    answer(h, 1, '我先跑一遍全量测试')
    turnEnd(h, 1, { kind: 'completed' })
    expect(h.sent).toHaveLength(0)

    h.advance(REPLY_CARRY_GRACE_MS)
    h.responder.tick()
    await h.flush()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('我先跑一遍全量测试')
    expect(h.sent[0].text).toContain('没赶上这一轮')
    expect(h.steerStateOf('evt-2')).toBe('stranded')
    expect(h.store.reply.job(firstJob)?.state).toBe('replied')
    h.close()
  })

  it('does not steer a turn that has not bound yet', async () => {
    const h = harness()
    h.deliver(message(1, '帮我看下测试为什么挂了'))
    h.advance(1500)
    h.responder.tick()
    await h.flush()
    // Submitted, running, but the engine has not reported the turn yet: a steer now
    // would be delivered ahead of the question it belongs to.
    h.deliver(message(2, '补一句'))
    await h.flush()

    expect(h.prompts.filter(call => call.mode === 'steer')).toHaveLength(0)
    const open = h.store.reply.collectingIn(CHAT)
    expect(open).toBe(1)
    h.close()
  })

  it('joins the open batch instead of overtaking it', async () => {
    const h = harness()
    h.deliver(message(1, '帮我看下测试为什么挂了'))
    h.advance(1500)
    h.responder.tick()
    await h.flush()
    // A batch opens while the turn is unbound, then the turn binds.
    h.deliver(message(2, '第二条'))
    await h.flush()
    turnStart(h, 1)
    userMessage(h, replyJobId('om_1', 'evt-1'))
    h.deliver(message(3, '第三条'))

    expect(h.prompts.filter(call => call.mode === 'steer')).toHaveLength(0)
    // Both late messages must be answered in the order they arrived, so the third
    // joins the batch the second one opened rather than jumping into the turn.
    expect(h.store.reply.messagesOf(replyJobId('om_2', 'evt-2')).map(row => row.messageId))
      .toEqual(['om_2', 'om_3'])
    h.close()
  })

  it('never steers a turn that is not answering a request', async () => {
    const h = harness()
    const now = START
    h.store.reply.ensureBinding({ convKey: CHAT, chatId: CHAT, chatType: 'p2p', sessionId: SESSION, now })
    // A proactive turn decides whether to speak and may answer with SILENT, which
    // would swallow whatever was folded into it.
    h.store.reply.openProactive({
      jobId: 'fp_proactive_1',
      convKey: CHAT,
      sessionId: SESSION,
      now,
      windowMs: 3_600_000,
      max: 3,
    })
    h.store.reply.claimSubmit('fp_proactive_1', SESSION, now, now + 600_000)
    h.store.reply.markRunning('fp_proactive_1', now + 600_000, now)
    turnStart(h, 1)
    userMessage(h, 'fp_proactive_1')

    h.deliver(message(2, '补一句'))
    await h.flush()

    expect(h.prompts.filter(call => call.mode === 'steer')).toHaveLength(0)
    expect(h.store.reply.collectingIn(CHAT)).toBe(1)
    h.close()
  })

  it('returns a steer the engine never took to the next batch', async () => {
    const h = harness()
    await runningFirstTurn(h)
    h.steerFailures.remaining = 99
    h.deliver(message(2, '只看 responder 那个文件就行'))
    await h.flush()

    // Three attempts, one request id: a retry must not queue the same text twice.
    const steers = h.prompts.filter(call => call.mode === 'steer')
    expect(steers).toHaveLength(3)
    expect(new Set(steers.map(call => call.requestId)).size).toBe(1)

    // The message keeps the answer it was owed, in a batch of its own.
    expect(h.steerStateOf('evt-2')).toBe('returned')
    const batch = h.store.reply.collectingIn(CHAT)
    expect(batch).toBe(1)
    expect(h.store.reply.messagesOf(replyJobId('om_2', 'evt-2')).map(row => row.messageId)).toEqual(['om_2'])

    // The running turn still answers once, and the batch answers once.
    answer(h, 1, '全量测试的结果是')
    turnEnd(h, 1, { kind: 'completed' })
    // The send is issued asynchronously; the job must stop holding the slot before
    // the batch behind it can be submitted.
    await h.flush()
    expect(h.sent).toHaveLength(1)
    // A returned member stays routed until the batch that owns it is answered.
    expect(h.queueStatusOf('evt-2')).toBe('routed')

    h.advance(1500)
    h.responder.tick()
    await h.flush()
    turnStart(h, 2)
    userMessage(h, replyJobId('om_2', 'evt-2'))
    answer(h, 2, '只看了 responder')
    turnEnd(h, 2, { kind: 'completed' })
    await h.flush()
    expect(h.sent).toHaveLength(2)
    expect(h.queueStatusOf('evt-2')).toBe('done')
    h.close()
  })

  it('steers once for one message, however often it is delivered', async () => {
    const h = harness()
    await runningFirstTurn(h)
    const envelope = message(2, '只看 responder 那个文件就行')
    h.store.append(envelope)
    // A redelivery that reached admission twice must not add the same line twice.
    h.responder.kick(envelope)
    h.responder.kick(envelope)
    await h.flush()

    expect(h.prompts.filter(call => call.mode === 'steer')).toHaveLength(1)
    h.close()
  })

  it('leaves a steer stranded by a stop inside the next job alone', async () => {
    const h = harness()
    await runningFirstTurn(h)
    h.deliver(message(2, '只看 responder 那个文件就行'))
    await h.flush()
    expect(h.steerStateOf('evt-2')).toBe('pending')

    // A stop ends the exchange: nothing will consume the steer.
    h.deliver(message(3, '/stop'))
    turnEnd(h, 1, { kind: 'aborted' })
    expect(h.sent).toHaveLength(1)
    expect(h.steerStateOf('evt-2')).toBe('stranded')

    // The next question runs on its own, and the stranded steer surfaces inside it.
    h.deliver(message(4, '换个问题'))
    h.advance(1500)
    h.responder.tick()
    await h.flush()
    turnStart(h, 2)
    userMessage(h, replyJobId('om_4', 'evt-4'))
    expect(h.store.reply.job(replyJobId('om_4', 'evt-4'))?.turn).toBe(2)
    userMessage(h, steerRequestId('om_2'))
    // It must not re-bind the job that is running now: that job's own turn is right.
    expect(h.store.reply.job(replyJobId('om_4', 'evt-4'))?.turn).toBe(2)

    answer(h, 2, '新问题的答案')
    turnEnd(h, 2, { kind: 'completed' })
    // One reply for the stopped turn, one for this one - never a third.
    expect(h.sent).toHaveLength(2)
    h.close()
  })

  it('strands pending steers when a restart interrupts the turn', () => {
    const store = InboxStore.open({ rootDir: tempDir() })
    const now = START
    store.reply.ensureBinding({ convKey: CHAT, chatId: CHAT, chatType: 'p2p', sessionId: SESSION, now })
    // The queue rows exist before the ledger points at them: a member is a claim on
    // a stored message, not a free-standing row.
    store.append(message(1, '帮我看下测试为什么挂了'))
    store.append(message(2, '只看 responder 那个文件就行'))
    store.reply.attach({
      eventId: 'evt-1', messageId: 'om_1', jobId: firstJob, convKey: CHAT, replyToMessageId: 'om_1', now, debounceMs: 1,
    })
    store.reply.claimSubmit(firstJob, SESSION, now, now + 600_000)
    store.reply.markRunning(firstJob, now + 600_000, now)
    expect(store.reply.attachSteer({
      eventId: 'evt-2', messageId: 'om_2', jobId: firstJob, steerRequestId: steerRequestId('om_2'), now,
    })).toBe(true)

    const recovered = store.reply.recoverInflight(now, 50 * 60_000)
    expect(recovered.interrupted).toBe(1)
    expect(store.reply.job(firstJob)?.state).toBe('replying')
    // Nothing in this process will consume it, so it must not look like work to come.
    expect(store.reply.pendingSteerCount(firstJob)).toBe(0)
    store.close()
  })

  it('does not extend the turn deadline by taking a steer', async () => {
    const h = harness()
    await runningFirstTurn(h)
    const before = h.store.reply.job(firstJob)?.deadlineAt
    h.deliver(message(2, '只看 responder 那个文件就行'))
    await h.flush()
    // The cap covers both turns: a turn that keeps accepting work must still end.
    expect(h.store.reply.job(firstJob)?.deadlineAt).toBe(before)
    h.close()
  })

  it('keeps settling a steer already taken after the switch is turned off', async () => {
    const h = harness()
    await runningFirstTurn(h)
    h.deliver(message(2, '只看 responder 那个文件就行'))
    await h.flush()
    expect(h.steerStateOf('evt-2')).toBe('pending')

    // Turning the feature off must not abandon what it already took.
    h.config.steer = 'off'
    answer(h, 1, '我先跑一遍全量测试')
    turnEnd(h, 1, { kind: 'completed' })
    turnStart(h, 2)
    userMessage(h, steerRequestId('om_2'))
    answer(h, 2, '只看了 responder')
    turnEnd(h, 2, { kind: 'completed' })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('只看了 responder')

    // New messages go back to waiting for the next turn.
    h.deliver(message(3, '那再补一句'))
    await h.flush()
    expect(h.prompts.filter(call => call.mode === 'steer')).toHaveLength(1)
    expect(h.store.reply.collectingIn(CHAT)).toBe(1)
    h.close()
  })

  it('stops steering a turn that has taken its limit', async () => {
    const h = harness()
    await runningFirstTurn(h)
    for (let index = 2; index <= REPLY_STEER_MAX_PER_JOB + 2; index += 1) {
      h.deliver(message(index, `第 ${index} 条补充`))
      await h.flush()
    }

    const steers = h.prompts.filter(call => call.mode === 'steer')
    // A turn that accepts steer after steer never has to end, so the cap is real.
    expect(steers).toHaveLength(REPLY_STEER_MAX_PER_JOB)
    expect(h.store.reply.steerCount(firstJob)).toBe(REPLY_STEER_MAX_PER_JOB)
    // The message past the limit keeps its own answer waiting in a batch.
    expect(h.store.reply.collectingIn(CHAT)).toBe(1)
    h.close()
  })

  it('reports what it would have done in shadow mode, and touches nothing', async () => {
    const h = harness({ steer: 'shadow' })
    await runningFirstTurn(h)
    h.deliver(message(2, '只看 responder 那个文件就行'))
    await h.flush()

    // No steer, and no steered member: the message is an ordinary batch member, the
    // same row shape every message had before this feature existed.
    expect(h.prompts.filter(call => call.mode === 'steer')).toHaveLength(0)
    expect(h.steerStateOf('evt-2')).toBe('none')
    expect(h.store.reply.collectingIn(CHAT)).toBe(1)

    // The running turn finishes, and the waiting message then gets a turn of its own.
    answer(h, 1, '全量测试的结果是')
    turnEnd(h, 1, { kind: 'completed' })
    await h.flush()
    expect(h.sent).toHaveLength(1)

    h.advance(1500)
    h.responder.tick()
    await h.flush()
    turnStart(h, 2)
    userMessage(h, replyJobId('om_2', 'evt-2'))
    answer(h, 2, '只看了 responder')
    turnEnd(h, 2, { kind: 'completed' })
    await h.flush()
    // Each message still gets its own answer, which is the old behaviour.
    expect(h.sent).toHaveLength(2)
    h.close()
  })

  it('does not steer at all when the switch is off', async () => {
    const h = harness({ steer: 'off' })
    await runningFirstTurn(h)
    h.deliver(message(2, '只看 responder 那个文件就行'))
    await h.flush()
    expect(h.prompts.filter(call => call.mode === 'steer')).toHaveLength(0)
    expect(h.store.reply.collectingIn(CHAT)).toBe(1)
    h.close()
  })
})

describe('reply text a person must never be shown', () => {
  it('answers a request instead of forwarding the silent token', async () => {
    const h = harness({ steer: 'off' })
    await runningFirstTurn(h)
    // `SILENT` is an instruction to the answer path, not a sentence for a person.
    answer(h, 1, 'SILENT')
    turnEnd(h, 1, { kind: 'completed' })

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text.trim()).not.toBe('SILENT')
    expect(h.sent[0].text).not.toContain('SILENT')
    expect(h.store.reply.job(firstJob)?.outcome).toBe('empty')
    h.close()
  })

  it('still lets a proactive turn choose silence', async () => {
    const store = InboxStore.open({ rootDir: tempDir() })
    const now = START
    const sent: string[] = []
    store.reply.ensureBinding({ convKey: CHAT, chatId: CHAT, chatType: 'p2p', sessionId: SESSION, now })
    store.reply.openProactive({
      jobId: 'fp_proactive_1', convKey: CHAT, sessionId: SESSION, now, windowMs: 3_600_000, max: 3,
    })
    const responder = new ReplyResponder(store, {
      engine: {
        async ensureSession() {},
        async prompt() {},
        cancel() {},
      },
      sender: () => ({
        async send(_to, text) { sent.push(text); return { ok: true, messageId: 'om_out' } },
      }),
      config: () => ({
        mode: 'self', openIds: [OWNER], debounceMs: 1000, turnTimeoutMs: 600_000, tickMs: 1000,
        cwd: '/tmp/bot-repo', preamble: 'PREAMBLE', maxSendAttempts: 3, maxSubmitAttempts: 3,
        receipt: false, proactive: true, steer: 'off',
      }),
      now: () => now,
      log: { info() {}, warn() {}, error() {} },
    })
    store.reply.claimSubmit('fp_proactive_1', SESSION, now, now + 600_000)
    store.reply.markRunning('fp_proactive_1', now + 600_000, now)
    responder.handleSessionEvent(SESSION, { type: 'turn/start', data: { turn: 1 } })
    responder.handleSessionEvent(SESSION, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'fp_proactive_1' } } })
    responder.handleSessionEvent(SESSION, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'SILENT' }] } },
    })
    responder.handleSessionEvent(SESSION, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    expect(sent).toHaveLength(0)
    expect(store.reply.job('fp_proactive_1')?.outcome).toBe('empty')
    store.close()
  })
})

describe('an installation that already holds jobs', () => {
  it('adds the steer columns in place and keeps the rows it finds', () => {
    const root = tempDir()
    // The shape this build finds on a host that has been running since before the
    // feature existed: no steer columns, no carry columns, real rows in both tables.
    const old = new DatabaseSync(join(root, 'inbox.sqlite'))
    old.exec(`CREATE TABLE inbox_events (
      event_id TEXT PRIMARY KEY, file TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '')`)
    old.exec(`CREATE TABLE conv_bindings (
      conv_key TEXT PRIMARY KEY, chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL CHECK (chat_type IN ('p2p','group')),
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
      session_id TEXT NOT NULL UNIQUE,
      preamble_sent INTEGER NOT NULL DEFAULT 0 CHECK (preamble_sent IN (0,1)),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    old.exec(`CREATE TABLE reply_jobs (
      job_id TEXT PRIMARY KEY CHECK (length(job_id) BETWEEN 4 AND 50),
      conv_key TEXT NOT NULL REFERENCES conv_bindings(conv_key),
      session_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN
        ('collecting','submitting','running','replying','replied','failed','cancelled','reply_uncertain')),
      outcome TEXT CHECK (outcome IN ('answer','empty','error','timeout','interrupted','stopped')),
      reply_to_message_id TEXT NOT NULL, collect_until INTEGER NOT NULL, submitted_at INTEGER,
      deadline_at INTEGER, turn INTEGER, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      submit_attempts INTEGER NOT NULL DEFAULT 0, send_attempts INTEGER NOT NULL DEFAULT 0,
      stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0,1)),
      reply_text TEXT, reply_message_id TEXT, end_reason TEXT, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    old.exec(`CREATE TABLE reply_job_messages (
      event_id TEXT PRIMARY KEY REFERENCES inbox_events(event_id),
      message_id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL REFERENCES reply_jobs(job_id),
      seq INTEGER NOT NULL, UNIQUE (job_id, seq))`)
    old.exec(`INSERT INTO conv_bindings (conv_key, chat_id, chat_type, generation, session_id, preamble_sent, created_at, updated_at)
      VALUES ('${CHAT}', '${CHAT}', 'p2p', 1, 'feishu-old', 1, 1, 1)`)
    old.exec(`INSERT INTO inbox_events (event_id, file, status, attempts, received_at, updated_at, payload, message_id)
      VALUES ('evt-old', 'f.jsonl', 'routed', 0, 1, 1, '{"content":"旧消息"}', 'om_old')`)
    old.exec(`INSERT INTO reply_jobs (job_id, conv_key, session_id, state, reply_to_message_id, collect_until,
      next_attempt_at, submit_attempts, send_attempts, stop_requested, created_at, updated_at)
      VALUES ('fj_old', '${CHAT}', 'feishu-old', 'running', 'om_old', 1, 0, 0, 0, 0, 1, 1)`)
    old.exec("INSERT INTO reply_job_messages (event_id, message_id, job_id, seq) VALUES ('evt-old', 'om_old', 'fj_old', 0)")
    old.exec(`INSERT INTO inbox_events (event_id, file, status, attempts, received_at, updated_at, payload, message_id)
      VALUES ('evt-new', 'f.jsonl', 'pending', 0, 2, 2, '{"content":"新消息"}', 'om_new')`)
    old.close()

    // Opening the store is the migration: it must not throw, and the old row must
    // read as an ordinary member that has never been steered.
    const store = InboxStore.open({ rootDir: root })
    const job = store.reply.job('fj_old')
    expect(job?.state).toBe('running')
    expect(job?.carryUntil).toBeUndefined()
    expect(job?.firstTurn).toBeUndefined()
    expect(store.reply.messagesOf('fj_old')).toMatchObject([
      { eventId: 'evt-old', messageId: 'om_old', steerState: 'none' },
    ])
    // The new columns are usable immediately on the migrated file.
    expect(store.reply.attachSteer({
      eventId: 'evt-new', messageId: 'om_new', jobId: 'fj_old', steerRequestId: 'fs_om_new', now: 2,
    })).toBe(true)
    expect(store.reply.pendingSteerCount('fj_old')).toBe(1)
    store.close()

    // The migration is idempotent: a second open over the same file changes nothing.
    const again = InboxStore.open({ rootDir: root })
    expect(again.reply.job('fj_old')?.state).toBe('running')
    again.close()
  })

  it('keeps the one-collecting-and-one-inflight rule while a steer is pending', () => {
    const store = InboxStore.open({ rootDir: tempDir() })
    const reply = store.reply
    const now = START
    reply.ensureBinding({ convKey: CHAT, chatId: CHAT, chatType: 'p2p', sessionId: SESSION, now })
    store.append(message(1, '帮我看下测试为什么挂了'))
    store.append(message(2, '只看 responder 那个文件就行'))
    reply.attach({
      eventId: 'evt-1', messageId: 'om_1', jobId: firstJob, convKey: CHAT, replyToMessageId: 'om_1', now, debounceMs: 1,
    })
    reply.claimSubmit(firstJob, SESSION, now, now + 600_000)
    reply.markRunning(firstJob, now + 600_000, now)
    expect(reply.attachSteer({
      eventId: 'evt-2', messageId: 'om_2', jobId: firstJob, steerRequestId: steerRequestId('om_2'), now,
    })).toBe(true)

    // A steer is a member of the running job, so it never opens a second in-flight
    // row: the conversation still has exactly one.
    expect(reply.inflightJob(CHAT)?.jobId).toBe(firstJob)
    expect(reply.collectingIn(CHAT)).toBe(0)
    // And the message it came from belongs to exactly one job.
    expect(reply.messagesOf(firstJob).map(row => row.messageId)).toEqual(['om_1', 'om_2'])
    store.close()
  })
})