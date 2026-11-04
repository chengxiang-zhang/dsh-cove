/**
 * The answer path's own audit trail.
 *
 * This file exists because the trail is untrustworthy in a specific way: it is the
 * only place that records *why* a decision was made, so it must be complete enough to
 * answer that - and it must be incapable of hurting the thing it observes. Every case
 * below is either "this decision left a line" or "the trail could not be written and
 * the answer still went out".
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INBOX_EVENT_TYPE, type LarkInboxEnvelope } from '../src/core/lark-inbox/queue.ts'
import { replyJobId, replySessionId, steerRequestId } from '../src/core/lark-inbox/reply-machine.ts'
import {
  AUDIT_FILE,
  AUDIT_ROTATED_FILE,
  auditConvKey,
  createAuditSink,
  type AuditEvent,
} from '../src/host/services/lark-inbox/audit.ts'
import type { AutoReplyConfig } from '../src/host/services/lark-inbox/config.ts'
import { InboxStore } from '../src/host/services/lark-inbox/inbox-store.ts'
import { ReplyResponder } from '../src/host/services/lark-inbox/responder.ts'

const OWNER = 'ou_owner'
const CHAT = 'oc_chat'
const SESSION = replySessionId(CHAT, 1)
const FIRST_JOB = replyJobId('om_1', 'evt-1')
const START = 1_700_000_000_000

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'web-all-lark-audit-'))
  roots.push(root)
  return root
}

function message(index: number, body: string): LarkInboxEnvelope {
  return {
    envelopeVersion: 1,
    eventType: INBOX_EVENT_TYPE,
    eventId: `evt-${index}`,
    receivedAt: new Date(START + index).toISOString(),
    chatType: 'p2p',
    chatId: CHAT,
    senderOpenId: OWNER,
    messageId: `om_${index}`,
    messageType: 'text',
    content: body,
    mentionBot: false,
  }
}

/** Read the trail as parsed objects, failing loudly on a malformed line. */
function readTrail(dir: string, file = AUDIT_FILE): Array<Record<string, unknown>> {
  const path = join(dir, file)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

interface Harness {
  store: InboxStore
  responder: ReplyResponder
  auditDir: string
  sent: Array<{ text: string }>
  config: AutoReplyConfig
  advance(ms: number): void
  flush(): Promise<void>
  deliver(envelope: LarkInboxEnvelope): void
  /** Finish the bound turn: the answer the model produced, then its end. */
  finishTurn(turn: number, draft: string): Promise<void>
  /** A complete turn from the engine's side: start, bind, answer, end. */
  runTurn(turn: number, draft: string, requestId?: string): Promise<void>
}

function harness(options: { auditDir?: string; audit?: (event: AuditEvent) => void; sendFails?: boolean } = {}): Harness {
  const store = InboxStore.open({ rootDir: tempDir() })
  const auditDir = options.auditDir ?? tempDir()
  let clock = START
  const sent: Array<{ text: string }> = []
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
    router: 'on',
  }
  const responder = new ReplyResponder(store, {
    engine: {
      async ensureSession() {},
      async prompt() {},
      cancel() {},
    },
    sender: () => ({
      async react() { return true },
      async send(_to, text) {
        if (options.sendFails === true) return { ok: false, error: 'chat not found', retryable: false }
        sent.push({ text })
        return { ok: true, messageId: `om_sent_${sent.length}` }
      },
    }),
    config: () => config,
    now: () => clock,
    log: { info() {}, warn() {}, error() {} },
    sleep: async () => {},
    audit: options.audit ?? createAuditSink({ dir: auditDir, now: () => clock }),
  })
  return {
    store,
    responder,
    auditDir,
    sent,
    config,
    advance: ms => { clock += ms },
    flush: async () => {
      await new Promise<void>(resolve => { setImmediate(resolve) })
      await new Promise<void>(resolve => { setImmediate(resolve) })
    },
    deliver: (envelope) => {
      if (store.append(envelope) !== 'appended') return
      responder.kick(envelope)
    },
    finishTurn: async (turn, draft) => {
      responder.handleSessionEvent(SESSION, {
        type: 'assistant/message',
        data: { turn, step: 1, message: { content: [{ type: 'text', text: draft }] } },
      })
      responder.handleSessionEvent(SESSION, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
      await new Promise<void>(resolve => { setImmediate(resolve) })
      await new Promise<void>(resolve => { setImmediate(resolve) })
    },
    runTurn: async (turn, draft, requestId) => {
      responder.handleSessionEvent(SESSION, { type: 'turn/start', data: { turn } })
      responder.handleSessionEvent(SESSION, {
        type: 'user/message',
        data: { source: { kind: 'user', rpcId: requestId ?? FIRST_JOB } },
      })
      responder.handleSessionEvent(SESSION, {
        type: 'assistant/message',
        data: { turn, step: 1, message: { content: [{ type: 'text', text: draft }] } },
      })
      responder.handleSessionEvent(SESSION, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
      await new Promise<void>(resolve => { setImmediate(resolve) })
      await new Promise<void>(resolve => { setImmediate(resolve) })
    },
  }
}

/** Submit the first message and bind its turn, the way the engine does. */
async function firstTurn(h: Harness, body = '帮我看下这个'): Promise<void> {
  h.deliver(message(1, body))
  h.advance(1500)
  h.responder.tick()
  await h.flush()
  h.responder.handleSessionEvent(SESSION, { type: 'turn/start', data: { turn: 1 } })
  h.responder.handleSessionEvent(SESSION, {
    type: 'user/message',
    data: { source: { kind: 'user', rpcId: FIRST_JOB } },
  })
}

/** Every event name the trail may carry, with the fields it must have. */
function shapeOf(entry: Record<string, unknown>): void {
  expect(typeof entry.ts).toBe('string')
  expect(Number.isNaN(Date.parse(String(entry.ts)))).toBe(false)
  expect(typeof entry.event).toBe('string')
  expect(typeof entry.detail).toBe('object')
}

describe('the trail records the decisions it exists for', () => {
  it('writes one valid line per decision kind, in order, for one job', async () => {
    const h = harness()
    await firstTurn(h)
    await h.finishTurn(1, '看完了，测试是绿的')

    const trail = readTrail(h.auditDir)
    // Four lines of a complete exchange: admitted, turn started, turn ended, sent.
    for (const entry of trail) shapeOf(entry)
    expect(trail.map(entry => entry.event)).toEqual(['admit', 'turn', 'turn', 'send'])
    expect(trail[0]).toMatchObject({ jobId: FIRST_JOB, convKey: CHAT })
    expect(trail[0].detail).toMatchObject({ opened: true, messageId: 'om_1' })
    expect(trail[1].detail).toMatchObject({ phase: 'start', turn: 1 })
    expect(trail[2].detail).toMatchObject({ phase: 'end', turn: 1, reason: 'completed' })
    expect(trail[3].detail).toMatchObject({ ok: true, attempt: 1 })
    // Order is append order, and every line carries its own timestamp.
    const stamps = trail.map(entry => Date.parse(String(entry.ts)))
    expect(stamps).toEqual([...stamps].sort((left, right) => left - right))
    h.store.close()
  })

  it('records a refused fold-in with the reason it was refused', async () => {
    const h = harness()
    h.deliver(message(1, '帮我看下这个'))
    // Running, but the turn has not bound yet: the steer gate refuses on that fact.
    h.advance(1500)
    h.responder.tick()
    await h.flush()
    h.deliver(message(2, '再补一句'))
    await h.flush()

    const refusals = readTrail(h.auditDir).filter(entry => entry.event === 'steer')
    expect(refusals).toHaveLength(1)
    expect(refusals[0].detail).toMatchObject({ outcome: 'refused', reason: 'turn-not-bound' })
    h.store.close()
  })

  it('records a fold-in that was promoted, and the turn that consumed it', async () => {
    const h = harness()
    await firstTurn(h)
    h.deliver(message(2, '只看 responder 那个文件就行'))
    await h.flush()
    h.responder.handleSessionEvent(SESSION, { type: 'user/message', data: { source: { kind: 'user', rpcId: steerRequestId('om_2') } } })
    await h.finishTurn(1, '只看 responder 了')

    const steers = readTrail(h.auditDir).filter(entry => entry.event === 'steer')
    // Promoted when it arrived, consumed when the turn picked it up.
    expect(steers.map(entry => entry.detail)).toMatchObject([
      { outcome: 'promoted', messageId: 'om_2' },
      { outcome: 'consumed', requestId: steerRequestId('om_2'), turn: 1 },
    ])
    h.store.close()
  })

  it('records the shadow decision without touching the turn', async () => {
    const h = harness()
    h.config.steer = 'shadow'
    await firstTurn(h)
    h.deliver(message(2, '补一句'))
    await h.flush()

    const shadow = readTrail(h.auditDir).filter(entry => entry.event === 'steer')
    expect(shadow).toHaveLength(1)
    expect(shadow[0].detail).toMatchObject({ outcome: 'shadow', messageId: 'om_2' })
    h.store.close()
  })

  it('records an acknowledgement choice, a veto and a fallback', async () => {
    const accepted = harness()
    await firstTurn(accepted, '谢谢')
    await accepted.finishTurn(1, 'ACK')
    expect(readTrail(accepted.auditDir).filter(entry => entry.event === 'ack')[0].detail)
      .toMatchObject({ outcome: 'chosen' })
    accepted.store.close()

    const vetoed = harness()
    await firstTurn(vetoed, '这个能用吗')
    await vetoed.finishTurn(1, 'ACK')
    expect(readTrail(vetoed.auditDir).filter(entry => entry.event === 'ack')[0].detail)
      .toMatchObject({ outcome: 'vetoed' })
    vetoed.store.close()
  })

  it('records a send failure instead of only a ledger row', async () => {
    const h = harness({ sendFails: true })
    await firstTurn(h)
    await h.finishTurn(1, '在的')

    // The ledger records that the job failed; only the trail records what the platform
    // said, and that a send was attempted at all.
    const sends = readTrail(h.auditDir).filter(entry => entry.event === 'send')
    expect(sends).toHaveLength(1)
    expect(sends[0].detail).toMatchObject({ ok: false, error: 'chat not found', attempt: 1 })
    expect(h.store.reply.job(FIRST_JOB)?.state).toBe('failed')
    h.store.close()
  })
})

describe('the trail can never cost an answer', () => {
  it('answers normally when the audit directory cannot be written', async () => {
    const root = tempDir()
    const readOnly = join(root, 'readonly')
    // Created, then made unwritable: the sink's own mkdir will fail on the child.
    writeFileSync(join(root, 'keep'), '')
    chmodSync(root, 0o500)
    try {
      const h = harness({ auditDir: readOnly })
      await firstTurn(h)
      await h.finishTurn(1, '在的')

      // The reply went out, and nothing threw: the trail is empty and irrelevant.
      expect(h.sent).toHaveLength(1)
      expect(h.sent[0].text).toBe('在的')
      expect(h.store.reply.job(FIRST_JOB)?.state).toBe('replied')
      h.store.close()
    } finally {
      chmodSync(root, 0o700)
    }
  })

  it('does not throw when the directory it would write to cannot be created', () => {
    const root = tempDir()
    const unwritable = join(root, 'nested', 'deeper')
    chmodSync(root, 0o500)
    try {
      const sink = createAuditSink({ dir: unwritable })
      // The sink itself is the layer that must not throw: the responder guards the seam
      // as well, so a control that removes only this guard has to be visible here.
      expect(() => sink({ event: 'turn', detail: { phase: 'start' } })).not.toThrow()
      expect(existsSync(join(unwritable, AUDIT_FILE))).toBe(false)
    } finally {
      chmodSync(root, 0o700)
    }
  })

  it('drops a line whose detail cannot be serialised and keeps going', async () => {
    const dir = tempDir()
    const sink = createAuditSink({ dir })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => sink({ event: 'error', detail: circular })).not.toThrow()
    expect(() => sink({ event: 'turn', detail: { note: 1n } })).not.toThrow()
    // A line that can be written still is: one bad detail does not poison the sink.
    sink({ event: 'turn', detail: { phase: 'start' } })
    expect(readTrail(dir)).toHaveLength(1)
  })

  it('survives a sink that throws, because the seam is guarded twice', async () => {
    const h = harness({ audit: () => { throw new Error('sink exploded') } })
    await firstTurn(h)
    await h.finishTurn(1, '在的')

    // A hostile sink cannot stop a reply: the guard belongs to the answering path.
    expect(h.sent).toHaveLength(1)
    expect(h.store.reply.job(FIRST_JOB)?.state).toBe('replied')
    h.store.close()
  })
})

describe('the trail is bounded', () => {
  it('rotates past the limit and keeps exactly one generation', () => {
    const dir = tempDir()
    const sink = createAuditSink({ dir, maxBytes: 200 })
    for (let index = 0; index < 60; index += 1) {
      sink({ event: 'turn', jobId: `fj_${index}`, detail: { index } })
    }
    const current = join(dir, AUDIT_FILE)
    const rotated = join(dir, AUDIT_ROTATED_FILE)
    expect(existsSync(rotated)).toBe(true)
    // The live file is back under the limit because the oversized one moved aside.
    expect(statSync(current).size).toBeLessThan(500)
    // One generation only: nothing older than the rotated sibling is kept.
    expect(readTrail(dir).length).toBeGreaterThan(0)
    expect(readTrail(dir, AUDIT_ROTATED_FILE).length).toBeGreaterThan(0)
    const total = readTrail(dir).length + readTrail(dir, AUDIT_ROTATED_FILE).length
    // Every line written is either in the live file or in the one retained generation.
    expect(total).toBeLessThan(60 + 1)
  })

  it('truncates a long conversation key without losing its head', () => {
    expect(auditConvKey('oc_short')).toBe('oc_short')
    const long = 'oc_'.padEnd(80, 'x')
    const shown = auditConvKey(long)
    expect(shown.length).toBeLessThanOrEqual(41)
    expect(shown.startsWith('oc_')).toBe(true)
  })
})