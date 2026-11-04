/**
 * Letting the conversation decide how to answer, and the one thing code still decides.
 *
 * Three behaviours share one switch. The model may answer with a reaction instead of
 * prose; every turn carries a line of conversation metadata; and a conversation is
 * told which instructions are in force, so a contract that changed reaches
 * conversations that started before it existed.
 *
 * The guard is what makes the first of those safe: a reaction may only stand in for
 * an answer when every message in the batch is a closed acknowledgement. The cases
 * below are the ones where a wrong answer is silent - a question answered with a
 * thumbs-up looks, from the outside, exactly like a bot doing what it was told.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INBOX_EVENT_TYPE, type LarkInboxEnvelope } from '../src/core/lark-inbox/queue.ts'
import {
  ACK_REPLY_TOKEN,
  fallbackReplyText,
  mayAcknowledgeOnly,
  replyJobId,
  replySessionId,
  steerRequestId,
} from '../src/core/lark-inbox/reply-machine.ts'
import {
  DEFAULT_REPLY_PREAMBLE,
  ROUTER_PREAMBLE_LINES,
  autoReplyConfig,
  effectiveConfig,
  withRouterContract,
  type AutoReplyConfig,
} from '../src/host/services/lark-inbox/config.ts'
import { InboxStore } from '../src/host/services/lark-inbox/inbox-store.ts'
import { ACK_FALLBACK_TEXT, REPLY_ACK_EMOJI, ReplyResponder } from '../src/host/services/lark-inbox/responder.ts'

const OWNER = 'ou_owner'
const CHAT = 'oc_chat'
const SESSION = replySessionId(CHAT, 1)
const FIRST_JOB = replyJobId('om_1', 'evt-1')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'web-all-lark-router-'))
  roots.push(root)
  return root
}

/**
 * The standing instructions exactly as the previous build shipped them.
 *
 * Written out rather than imported so "switched off changes nothing" is asserted
 * against bytes, not against the constant it is comparing to: a test that reads the
 * value it is checking would stay green through an accidental edit.
 */
const HEAD_PREAMBLE = [
  '你在通过飞书和一个人对话。从这里收到的内容来自飞书私聊，不是本机终端。',
  '直接输出你要发给对方的那段纯文本，不要解释你在做什么，不要用 Markdown 表格。',
  '你现在的工作目录是一个代码仓库：可以读、可以改、可以跑命令。仓库里有未提交的改动属于别人，不要提交或回退它。',
  '除非对方在这条消息里明确要求，不要执行 git push、不要重写历史、不要动 main 分支、不要推 tag。',
  '需要很长的分析时，先给结论，再给必要的过程。',
].join('\n')

function message(index: number, body: string): LarkInboxEnvelope {
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
  }
}

interface Harness {
  store: InboxStore
  responder: ReplyResponder
  prompts: Array<{ requestId: string; sessionId: string; text: string; mode: 'queue' | 'steer' }>
  sent: Array<{ text: string; target?: { replyToMessageId?: string; idempotencyKey?: string } }>
  reactions: Array<{ messageId: string; emojiType: string }>
  reactFails: { value: boolean }
  config: AutoReplyConfig
  advance(ms: number): void
  now(): number
  flush(): Promise<void>
  deliver(envelope: LarkInboxEnvelope): void
  /** Drive one complete turn: start, bind, answer, end. */
  runTurn(turn: number, draft: string, requestId?: string): Promise<void>
}

const START = 1_700_000_000_000

function harness(overrides: Partial<AutoReplyConfig> = {}): Harness {
  const store = InboxStore.open({ rootDir: tempDir() })
  let clock = START
  const prompts: Harness['prompts'] = []
  const sent: Harness['sent'] = []
  const reactions: Harness['reactions'] = []
  const reactFails = { value: false }
  const config: AutoReplyConfig = {
    mode: 'self',
    openIds: [OWNER],
    debounceMs: 1000,
    turnTimeoutMs: 600_000,
    tickMs: 1000,
    cwd: '/tmp/bot-repo',
    preamble: DEFAULT_REPLY_PREAMBLE,
    maxSendAttempts: 3,
    maxSubmitAttempts: 3,
    receipt: false,
    proactive: false,
    steer: 'off',
    router: 'off',
    ...overrides,
  }
  // The projection composes the contract, so the harness has to as well: a test that
  // set the switch without the instructions it implies would be testing nothing.
  config.preamble = config.router === 'on' ? withRouterContract(config.preamble) : config.preamble
  const responder = new ReplyResponder(store, {
    engine: {
      async ensureSession() {},
      async prompt(input) { prompts.push(input) },
      cancel() {},
    },
    sender: () => ({
      async react(messageId, emojiType) {
        if (reactFails.value) throw new Error('reaction rejected')
        reactions.push({ messageId, emojiType })
        return true
      },
      async send(_to, text, target) {
        sent.push({ text, ...(target === undefined ? {} : { target }) })
        return { ok: true, messageId: `om_sent_${sent.length}` }
      },
    }),
    config: () => config,
    now: () => clock,
    log: { info() {}, warn() {}, error() {} },
    sleep: async () => {},
  })
  return {
    store,
    responder,
    prompts,
    sent,
    reactions,
    reactFails,
    config,
    advance: ms => { clock += ms },
    now: () => clock,
    flush: async () => {
      await new Promise<void>(resolve => { setImmediate(resolve) })
      await new Promise<void>(resolve => { setImmediate(resolve) })
    },
    deliver: (envelope) => {
      if (store.append(envelope) !== 'appended') return
      responder.kick(envelope)
    },
    runTurn: async (turn, draft, requestId) => {
      const sessionId = SESSION
      responder.handleSessionEvent(sessionId, { type: 'turn/start', data: { turn } })
      responder.handleSessionEvent(sessionId, {
        type: 'user/message',
        data: { source: { kind: 'user', rpcId: requestId ?? FIRST_JOB } },
      })
      responder.handleSessionEvent(sessionId, {
        type: 'assistant/message',
        data: { turn, step: 1, message: { content: [{ type: 'text', text: draft }] } },
      })
      responder.handleSessionEvent(sessionId, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
      await new Promise<void>(resolve => { setImmediate(resolve) })
      await new Promise<void>(resolve => { setImmediate(resolve) })
    },
  }
}

/** Submit the first message and leave it running, waiting for its turn. */
async function submitFirst(h: Harness, body: string): Promise<void> {
  h.deliver(message(1, body))
  h.advance(1500)
  h.responder.tick()
  await h.flush()
}

describe('the acknowledgement guard', () => {
  it('permits a reaction only for a batch made entirely of closed acknowledgements', () => {
    for (const text of ['好', '好的', '好滴', 'ok', 'OK', '收到', '嗯嗯', '谢谢', '多谢', 'thx', '知道了', '明白', '了解', '辛苦了', '好的。', '谢谢！']) {
      expect(mayAcknowledgeOnly([text]), text).toBe(true)
    }
    // Anything that asks for something must be answered in words.
    for (const text of ['这个能用吗', '怎么样', '为什么', '多少', '是否完成', '要不要现在做', '行不行', '好的，我看看', 'ok?', '谢谢，那接下来呢']) {
      expect(mayAcknowledgeOnly([text]), text).toBe(false)
    }
    // A batch is acknowledged only when every message in it is one.
    expect(mayAcknowledgeOnly(['好', '这个能用吗'])).toBe(false)
    expect(mayAcknowledgeOnly(['好', '好'])).toBe(true)
    // Nothing to acknowledge is not an acknowledgement, and neither is a paragraph.
    expect(mayAcknowledgeOnly([])).toBe(false)
    expect(mayAcknowledgeOnly([''])).toBe(false)
    expect(mayAcknowledgeOnly(['好的我知道了谢谢你的帮助'])).toBe(false)
  })
})

describe('answering with a reaction', () => {
  it('reacts instead of speaking when the model chose to acknowledge', async () => {
    const h = harness({ router: 'on' })
    await submitFirst(h, '谢谢')
    await h.runTurn(1, ACK_REPLY_TOKEN)

    expect(h.reactions).toEqual([{ messageId: 'om_1', emojiType: REPLY_ACK_EMOJI }])
    expect(h.sent).toHaveLength(0)
    expect(h.store.reply.job(FIRST_JOB)).toMatchObject({ state: 'replied', outcome: 'answer', replyVia: 'reaction' })
    // The message is settled as answered even though no text was sent.
    expect(h.store.stats()).toMatchObject({ done: 1, routed: 0 })
    h.store.close()
  })

  it('vetoes the reaction and answers in words when the batch asked something', async () => {
    const h = harness({ router: 'on' })
    await submitFirst(h, '这个能用吗')
    await h.runTurn(1, ACK_REPLY_TOKEN)

    // The model tried to answer a question with a thumbs-up; the guard refused.
    expect(h.reactions).toHaveLength(0)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toBe(fallbackReplyText('empty'))
    expect(h.store.reply.job(FIRST_JOB)).toMatchObject({ state: 'replied', outcome: 'empty' })
    h.store.close()
  })

  it('falls back to a sentence when the reaction cannot be given', async () => {
    const h = harness({ router: 'on' })
    h.reactFails.value = true
    await submitFirst(h, '谢谢')
    await h.runTurn(1, ACK_REPLY_TOKEN)

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toBe(ACK_FALLBACK_TEXT)
    expect(h.store.reply.job(FIRST_JOB)).toMatchObject({ state: 'replied', replyVia: 'text' })
    h.store.close()
  })

  it('still treats the silent token as an instruction, not as an answer', async () => {
    // The regression the steer slice fixed: a request job that emits SILENT must
    // never send that word to a person.
    const h = harness({ router: 'on' })
    await submitFirst(h, '帮我看下这个')
    await h.runTurn(1, 'SILENT')

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).not.toContain('SILENT')
    h.store.close()
  })
})

describe('switched off', () => {
  it('sends exactly the instructions the previous build sent', () => {
    const off = autoReplyConfig(effectiveConfig({ autoReplyRouter: 'off' }))
    expect(off.preamble).toBe(HEAD_PREAMBLE)
    expect(HEAD_PREAMBLE).toBe(DEFAULT_REPLY_PREAMBLE)
    // And with no instruction of its own, it is the same string the schema default is.
    expect(off.preamble).toBe(effectiveConfig({}).autoReplyPreamble)

    const on = autoReplyConfig(effectiveConfig({ autoReplyRouter: 'on' }))
    expect(on.preamble).toBe(`${HEAD_PREAMBLE}\n${ROUTER_PREAMBLE_LINES.join('\n')}`)
  })

  it('does not recognise the acknowledgement token', async () => {
    const h = harness({ router: 'off' })
    await submitFirst(h, '谢谢')
    await h.runTurn(1, ACK_REPLY_TOKEN)

    // Off means the token is just the text the model produced, as it always was.
    expect(h.reactions).toHaveLength(0)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toBe(ACK_REPLY_TOKEN)
    expect(h.store.reply.job(FIRST_JOB)?.replyVia).toBe('text')
    h.store.close()
  })

  it('adds no metadata line to the prompt', async () => {
    const h = harness({ router: 'off' })
    await submitFirst(h, '谢谢')
    expect(h.prompts[0].text.startsWith(HEAD_PREAMBLE)).toBe(true)
    expect(h.prompts[0].text).not.toContain('本批')
    h.store.close()
  })
})

describe('telling a conversation which instructions are in force', () => {
  it('tells an older conversation the new contract once, not on every turn', async () => {
    const h = harness({ router: 'on' })
    h.store.reply.ensureBinding({ convKey: CHAT, chatId: CHAT, chatType: 'p2p', sessionId: SESSION, now: START })
    // A binding from before instructions were versioned: told something, hash unknown.
    h.store.reply.markPreambleSent(CHAT, '', START)
    h.store.reply.rotateBinding(CHAT, SESSION, START)
    h.store.reply.ensureBinding({ convKey: CHAT, chatId: CHAT, chatType: 'p2p', sessionId: SESSION, now: START })
    expect(h.store.reply.binding(CHAT)?.preambleSent).toBe(false)

    await submitFirst(h, '谢谢')
    expect(h.prompts[0].text).toContain(ROUTER_PREAMBLE_LINES[0])
    expect(h.store.reply.binding(CHAT)?.preambleHash).toBeDefined()
    const told = h.store.reply.binding(CHAT)?.preambleHash

    await h.runTurn(1, '好的')
    h.advance(5000)
    h.deliver(message(2, '再问一个'))
    h.advance(1500)
    h.responder.tick()
    await h.flush()
    // The second turn does not repeat the instructions it already sent.
    expect(h.prompts[1].text).not.toContain(ROUTER_PREAMBLE_LINES[0])
    expect(h.store.reply.binding(CHAT)?.preambleHash).toBe(told)
    h.store.close()
  })

  it('keeps the old one-shot rule while switched off', async () => {
    const h = harness({ router: 'off' })
    await submitFirst(h, '谢谢')
    expect(h.prompts[0].text.startsWith(HEAD_PREAMBLE)).toBe(true)
    await h.runTurn(1, '好的')
    h.advance(5000)
    h.deliver(message(2, '再问一个'))
    h.advance(1500)
    h.responder.tick()
    await h.flush()
    expect(h.prompts[1].text).not.toContain(HEAD_PREAMBLE)
    h.store.close()
  })
})

describe('the metadata line', () => {
  it('says how many messages this batch carries and how long since the last answer', async () => {
    const h = harness({ router: 'on' })
    await submitFirst(h, '谢谢')
    // Nothing has been answered yet, so there is no gap to report.
    expect(h.prompts[0].text.startsWith('[飞书私聊 · 本批 1 条]')).toBe(true)

    await h.runTurn(1, '好的')
    h.advance(5 * 60_000)
    h.deliver(message(2, '再问一个'))
    h.advance(1500)
    h.responder.tick()
    await h.flush()
    expect(h.prompts[1].text.startsWith('[飞书私聊 · 本批 1 条 · 距上次回复 5 分钟]')).toBe(true)
    h.store.close()
  })

  it('counts the messages of one batch', async () => {
    const h = harness({ router: 'on' })
    h.deliver(message(1, '第一句'))
    h.deliver(message(2, '第二句'))
    h.advance(1500)
    h.responder.tick()
    await h.flush()
    expect(h.prompts[0].text.startsWith('[飞书私聊 · 本批 2 条]')).toBe(true)
    h.store.close()
  })
})

describe('a duplicate steer identity', () => {
  it('refuses the second member instead of throwing through the sweep', () => {
    const store = InboxStore.open({ rootDir: tempDir() })
    const now = START
    store.reply.ensureBinding({ convKey: CHAT, chatId: CHAT, chatType: 'p2p', sessionId: SESSION, now })
    store.append(message(1, '帮我看下这个'))
    store.append(message(2, '补一句'))
    store.reply.attach({
      eventId: 'evt-1', messageId: 'om_1', jobId: FIRST_JOB, convKey: CHAT, replyToMessageId: 'om_1', now, debounceMs: 1,
    })
    store.reply.claimSubmit(FIRST_JOB, SESSION, now, now + 600_000)
    store.reply.markRunning(FIRST_JOB, now + 600_000, now)

    const requestId = steerRequestId('om_2')
    expect(store.reply.attachSteer({
      eventId: 'evt-2', messageId: 'om_2', jobId: FIRST_JOB, steerRequestId: requestId, now,
    })).toBe(true)
    // The unique index is the authority; the answer path's ordinary path is the
    // result, never an exception escaping through a sweep.
    expect(store.reply.attachSteer({
      eventId: 'evt-2', messageId: 'om_2', jobId: FIRST_JOB, steerRequestId: requestId, now,
    })).toBe(false)
    store.close()
  })
})