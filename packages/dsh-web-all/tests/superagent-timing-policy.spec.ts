/**
 * Timing and wording contracts (T10).
 *
 * `09` decides when to speak and how loudly; `02` decides which moments are true.
 * The expectations here are the independent second copy of that contract: the
 * tier a message gets, the words a template renders, and the four mechanical
 * checks the outlet performs before anything leaves the process. Fixtures are
 * inline because every case is a single message, not a ledger state.
 */

import { describe, expect, it } from 'vitest'
import type { OutboxMoment } from '../src/host/services/superagent/protocol/objects.ts'
import type { SpeechProposal } from '../src/host/services/superagent/kernel/ports.ts'
import {
  DEFAULT_QUIET,
  inQuietHours,
  tier,
  type AttentionContext,
} from '../src/host/services/superagent/timing/attention.ts'
import {
  createOutletPolicy,
  identityPrefix,
  type OutletPolicyDeps,
} from '../src/host/services/superagent/timing/outlet-policy.ts'
import { MAX_WORDS, countWords } from '../src/host/services/superagent/surface/words.ts'
import { TemplateError, render } from '../src/host/services/superagent/surface/templates.ts'
import { promiseHits } from '../src/host/services/superagent/surface/promise-scan.ts'
import { momentAllowed, type MomentFacts } from '../src/host/services/superagent/surface/moment.ts'

const NOW = 1_700_000_000_000

/** An attention context that would interrupt if the message wanted to. */
function attention(overrides: Partial<AttentionContext> = {}): AttentionContext {
  return {
    moment: 'ask',
    ballToOwnerWithClock: false,
    irreversible: false,
    isReplyToInbound: false,
    interruptsToday: 0,
    quotaPerDay: 3,
    localHHMM: '10:00',
    quiet: DEFAULT_QUIET,
    ...overrides,
  }
}

/** Facts for a turn that did everything a message could claim. */
function facts(overrides: Partial<MomentFacts> = {}): MomentFacts {
  return {
    committedInThisTurn: true,
    commitmentTerminal: true,
    dispositionAnswersInbound: true,
    hasAskedAssumptionOrRoute: true,
    brokenOrAtRiskOrDispatchFailed: true,
    isAgendaTurnWithSignal: true,
    byPushbackTool: false,
    byHost: true,
    ...overrides,
  }
}

/** A proposal whose body promises nothing and fits the ceiling. */
function proposal(overrides: Partial<SpeechProposal> = {}): SpeechProposal {
  return {
    chat_id: 'oc_owner',
    moment: 'answer',
    audience: 'owner',
    payload: 'text',
    text: '改完了；跑了 vitest；退出码 0；读数 13 passed。',
    idem_key: 'k-1',
    ...overrides,
  }
}

/** The outlet policy with permissive stubs, so a case only states what it tests. */
function policy(overrides: Partial<OutletPolicyDeps> = {}) {
  return createOutletPolicy({
    attentionCtx: () => attention(),
    momentFacts: () => facts(),
    disclosures: () => [],
    mayPromise: () => false,
    identityNeeded: () => false,
    ownerLabel: () => '张老板',
    ...overrides,
  })
}

/** The error code a render throws, or `''` when it does not throw. */
function renderCode(moment: OutboxMoment, data: Parameters<typeof render>[1]): string {
  try {
    render(moment, data)
    return ''
  } catch (error) {
    return error instanceof TemplateError ? error.code : 'unexpected'
  }
}

describe('timing and wording', () => {
  it('1. counts words the way the freeze defines them', () => {
    const sentence = '把 lark-inbox 的超时改成 30 秒'
    expect(countWords(sentence)).toBe(9)
    expect(countWords(sentence)).toBe(countWords(sentence))
    // A digit string is one fact, not one word per digit.
    expect(countWords('123456')).toBe(1)
  })

  it('2. a message answering inbound traffic is a reply', () => {
    expect(tier(attention({ moment: 'ack', isReplyToInbound: true }))).toEqual({ tier: 'reply', folded: false })
    expect(tier(attention({ moment: 'deliver', isReplyToInbound: true }))).toEqual({ tier: 'reply', folded: false })
  })

  it('3. the fourth interrupt of a quota-3 day folds into the brief', () => {
    const decision = tier(attention({
      moment: 'ask',
      ballToOwnerWithClock: true,
      interruptsToday: 3,
      quotaPerDay: 3,
      localHHMM: '10:00',
    }))
    expect(decision).toEqual({ tier: 'brief', folded: true })
    // One interrupt still available means the message still interrupts.
    expect(tier(attention({ moment: 'ask', ballToOwnerWithClock: true, interruptsToday: 2, quotaPerDay: 3 })))
      .toEqual({ tier: 'interrupt', folded: false })
  })

  it('4. the quiet window folds an interrupt, unless the risk is irreversible', () => {
    expect(inQuietHours('23:00', DEFAULT_QUIET)).toBe(true)
    expect(inQuietHours('07:59', DEFAULT_QUIET)).toBe(true)
    expect(inQuietHours('08:00', DEFAULT_QUIET)).toBe(false)
    const folded = tier(attention({ moment: 'ask', ballToOwnerWithClock: true, localHHMM: '23:00' }))
    expect(folded).toEqual({ tier: 'brief', folded: true })
    const irreversible = tier(attention({
      moment: 'ask',
      ballToOwnerWithClock: true,
      localHHMM: '23:00',
      irreversible: true,
    }))
    expect(irreversible).toEqual({ tier: 'interrupt', folded: false })
  })

  it('5. the daily brief is a brief, and internal progress is silent', () => {
    expect(tier(attention({ moment: 'brief' }))).toEqual({ tier: 'brief', folded: false })
    // Not a moment at all: progress, retries and internal checks never reach here.
    const progress = 'progress' as unknown as OutboxMoment
    expect(tier(attention({ moment: progress }))).toEqual({ tier: 'silent', folded: false })
    expect(tier(attention({ moment: 'deliver' }))).toEqual({ tier: 'silent', folded: false })
  })

  it('6. the acknowledgement offers one question or one closing line, never both', () => {
    const asked = render('ack', {
      commitmentId: 'C-12',
      understanding: '先把超时改短',
      etaMinutes: 30,
      question: '要不要同时改网关',
      questionDefault: '先不改',
    })
    expect(asked.text).toContain('不回按')
    expect(asked.words).toBeLessThanOrEqual(MAX_WORDS)
    expect(asked.expectsReply).toBe(true)
    const plain = render('ack', { commitmentId: 'C-12', understanding: '先把超时改短', etaMinutes: 30 })
    expect(plain.text).toContain('不对就说')
    expect(plain.text).not.toContain('不回按')
    expect(plain.words).toBeLessThanOrEqual(MAX_WORDS)
    expect(plain.expectsReply).toBe(false)
  })

  it('7. an unverified delivery says so before anything else', () => {
    const unverified = render('deliver', {
      verified: false,
      changed: 'scripts/superagent-check.mjs',
      ran: 'node --test',
      exitCode: 0,
      reading: '7 passed',
    })
    expect(unverified.text.startsWith('做完了，但没验证')).toBe(true)
    const verified = render('deliver', { verified: true, changed: 'x', ran: 'y', exitCode: 0, reading: 'z' })
    expect(verified.text.startsWith('做完了，但没验证')).toBe(false)
  })

  it('8. a brief of nine items is five lines plus one overflow line', () => {
    const items = Array.from({ length: 9 }, (_, index) => `第${String(index + 1)}件短事`)
    const brief = render('brief', { items })
    const lines = brief.text.split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[5]).toContain('另有 4 件')
    expect(brief.words).toBeLessThanOrEqual(MAX_WORDS)
    // The per-line ceiling is a template guarantee, not a rendering preference.
    const longLine = Array.from({ length: 16 }, (_, index) => `w${String(index)}`).join(' ')
    expect(renderCode('brief', { items: [longLine] })).toBe('BRIEF_LINE_TOO_LONG')
  })

  it('9. a template that would render over the ceiling refuses to render', () => {
    const long = Array.from({ length: MAX_WORDS + 1 }, (_, index) => `w${String(index)}`).join(' ')
    expect(countWords(long)).toBe(MAX_WORDS + 1)
    expect(renderCode('answer', { body: long })).toBe('TOO_LONG')
    // `pushback` never goes through say, so it has no template to render.
    expect(renderCode('pushback', { body: '不行' })).toBe('TEMPLATE_MISSING')
  })

  it('10. a promise word blocks the message unless this conversation may promise', () => {
    expect(promiseHits('明天上线')).toEqual(['明天', '上线'])
    const blocked = policy({ mayPromise: () => false }).check(proposal({ text: '明天上线' }), NOW)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.code).toBe('PROMISE_BLOCKED')
      expect(blocked.message).toContain('明天')
    }
    const allowed = policy({ mayPromise: () => true }).check(proposal({ text: '明天上线' }), NOW)
    expect(allowed.ok).toBe(true)
  })

  it('11. memory that may not be said out loud blocks the message', () => {
    const blocked = policy({ disclosures: () => ['老板的病历'] }).check(proposal(), NOW)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.code).toBe('DISCLOSE_BLOCKED')
      expect(blocked.message).toContain('老板的病历')
    }
    // A message with no promise words and no leaks passes the same policy.
    expect(policy().check(proposal(), NOW).ok).toBe(true)
  })

  it('12. a moment is false unless the turn really did it', () => {
    expect(momentAllowed('ack', facts({ committedInThisTurn: false, byHost: false }))).toBe(false)
    expect(momentAllowed('ack', facts({ committedInThisTurn: true }))).toBe(true)
    expect(momentAllowed('ack', facts({ committedInThisTurn: false, byHost: true }))).toBe(true)
    // `pushback` is produced by the pushback tool and never by say: the moment is
    // refused for a model-authored line and allowed for the tool's own line.
    expect(momentAllowed('pushback', facts())).toBe(false)
    expect(momentAllowed('pushback', facts({ byPushbackTool: true }))).toBe(true)
    expect(momentAllowed('deliver', facts({ commitmentTerminal: false }))).toBe(false)
    // A model-authored `cannot` still has to earn it; the host's own timeout line is
    // the exception (its idem key carries the `cannot:` prefix).
    expect(momentAllowed('cannot', facts({ brokenOrAtRiskOrDispatchFailed: false, byHost: false }))).toBe(false)
    expect(momentAllowed('cannot', facts({ brokenOrAtRiskOrDispatchFailed: true, byHost: false }))).toBe(true)
    expect(momentAllowed('cannot', facts({ brokenOrAtRiskOrDispatchFailed: false, byHost: true }))).toBe(true)
    expect(momentAllowed('alert', facts({ isAgendaTurnWithSignal: false, byHost: false }))).toBe(false)
    // The second-voice alarm is the host's own interruption (11), never the model's.
    expect(momentAllowed('alert', facts({ isAgendaTurnWithSignal: false, byHost: true }))).toBe(true)
    expect(momentAllowed('brief', facts({ byHost: false }))).toBe(false)
  })

  it('14. the two dispositions a live turn actually used both have a moment', () => {
    // judge(ask): the desk recorded "this needs the owner's decision"; asking is the
    // moment that disposition exists for. Without the fact it stays refused.
    expect(momentAllowed('ask', facts({ hasAskedAssumptionOrRoute: false }))).toBe(false)
    expect(momentAllowed('ask', facts({ hasAskedAssumptionOrRoute: true }))).toBe(true)
    // judge(decline): the identity notice is the answer to the inbound message.
    expect(momentAllowed('answer', facts({ dispositionAnswersInbound: false }))).toBe(false)
    expect(momentAllowed('answer', facts({ dispositionAnswersInbound: true }))).toBe(true)
    // A timeout turn with no commitment can still close itself (host authored).
    expect(momentAllowed('cannot', facts({ brokenOrAtRiskOrDispatchFailed: false, byHost: true }))).toBe(true)
  })

  it('13. a first message to a non-owner chat says who is speaking and still fits', () => {
    expect(countWords(identityPrefix('张老板'))).toBe(5)
    const first = policy({ identityNeeded: () => true }).check(proposal({ text: '改完了。' }), NOW)
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.text.startsWith(identityPrefix('张老板'))).toBe(true)
      expect(first.words).toBe(countWords(first.text))
    }
    // 99 words plus the five-word identity sentence is 104: refused, never cut.
    const body = Array.from({ length: 99 }, (_, index) => `w${String(index)}`).join(' ')
    const over = policy({ identityNeeded: () => true }).check(proposal({ text: body }), NOW)
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.code).toBe('TOO_LONG')
  })

  it('15. judge(answer) allows moment answer', () => {
    expect(momentAllowed('answer', facts({ dispositionAnswersInbound: true }))).toBe(true)
  })

  it('16. judge(ask) allows moment ask without a commitment', () => {
    // No commit was made; the route decision itself still makes `ask` truthful.
    expect(momentAllowed('ask', facts({
      committedInThisTurn: false,
      hasAskedAssumptionOrRoute: true,
    }))).toBe(true)
  })

  it('17. judge(acknowledge|decline) both allow moment answer', () => {
    expect(momentAllowed('answer', facts({ dispositionAnswersInbound: true }))).toBe(true)
    expect(momentAllowed('answer', facts({ dispositionAnswersInbound: true }))).toBe(true)
  })

  it('18. a terminal commitment without independent delivery evidence cannot report delivery', () => {
    expect(momentAllowed('deliver', facts({
      committedInThisTurn: true,
      commitmentTerminal: true,
    }))).toBe(false)
  })

  it('19. with no commit and none of the answer/ask gates, outlet refuses MOMENT_FORBIDDEN', () => {
    const blocked = policy({
      momentFacts: () => facts({
        committedInThisTurn: false,
        commitmentTerminal: false,
        dispositionAnswersInbound: false,
        hasAskedAssumptionOrRoute: false,
        byHost: false,
      }),
    }).check(proposal({ moment: 'answer' }), NOW)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.code).toBe('MOMENT_FORBIDDEN')
  })
})