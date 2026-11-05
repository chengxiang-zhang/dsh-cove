/**
 * Judgment fast paths (T09). Fixtures are inline events and snapshots: the
 * policy takes ledger facts from the kernel and nothing else, so no database is
 * needed here.
 *
 * The ten cases follow the T-09 spec list one to one.
 */

import { describe, expect, it } from 'vitest'
import type { ClaimSnapshot } from '../src/host/services/superagent/kernel/ports.ts'
import type { InboundEvent } from '../src/host/services/superagent/protocol/events.ts'
import { createRoutePolicy, type RouteDeps } from '../src/host/services/superagent/judgment/route.ts'
import {
  ROUTE_RULES,
  normalizeForMatch,
  parseOrdinals,
  type RouteRule,
  type SenderClass,
} from '../src/host/services/superagent/judgment/route-rules.ts'

type Sender = { open_id: string; union_id?: string }

const event = (text: string, extra: Partial<InboundEvent> = {}): InboundEvent => ({
  event_id: 'ev-1',
  chat: { id: 'oc_1', type: 'p2p' },
  sender: { open_id: 'ou_owner' },
  thread: 'p2p:oc_1:m1',
  text,
  message_id: 'm1',
  received_at: 1_760_000_000_000,
  ...extra,
})

const snapshot = (extra: Partial<ClaimSnapshot> = {}): ClaimSnapshot => ({ openProposalsOnDesk: [], ...extra })

const deps = (cls: SenderClass = 'owner', _sender: Sender = { open_id: 'ou_owner' }): RouteDeps => ({
  senderClass: () => cls,
})

const policy = (cls: SenderClass = 'owner') => createRoutePolicy(deps(cls))
const liveThread = { liveCommitmentOnThread: 'C-1' }

describe('judgment fast paths', () => {
  it('1. stop words release a live thread and fall through when the thread is idle', () => {
    const view = policy()
    for (const text of ['停。', '先别做了！', 'STOP']) {
      const decision = view.decide(event(text), snapshot(liveThread))
      expect(decision.owner).toBe('superagent')
      expect(decision.route).toBe('fastpath')
      expect(decision.disposition).toBe('release')
      expect(decision.detail).toMatchObject({ commitment_id: 'C-1' })
    }
    // Punctuation and case are normalized away, so a bare word and a sentence
    // with a full stop are the same input.
    expect(normalizeForMatch('  STOP!! ')).toBe('stop')
    // No live commitment on the thread: nothing to release, so a model decides.
    for (const text of ['停。', '先别做了！', 'STOP']) {
      expect(view.decide(event(text), snapshot()).route).toBe('judge')
    }
  })

  it('2. /new and 新会话 acknowledge and rotate without calling a model', () => {
    const view = policy()
    for (const text of ['/new', '新会话']) {
      const decision = view.decide(event(text), snapshot(liveThread))
      expect(decision.route).toBe('fastpath')
      expect(decision.disposition).toBe('acknowledge')
      expect(decision.detail).toMatchObject({ rotate: true })
    }
    expect(normalizeForMatch('/NEW')).toBe('new')
  })

  it('3. bare ordinals commit the selected proposals and judge when there are none', () => {
    const view = policy()
    const decision = view.decide(event('1、3'), snapshot({ openProposalsOnDesk: ['C-1', 'C-2', 'C-3'] }))
    expect(decision.route).toBe('fastpath')
    expect(decision.disposition).toBe('commit')
    expect(decision.detail).toMatchObject({ ordinals: [1, 3], target: 'proposal' })
    expect(parseOrdinals('1,3')).toEqual([1, 3])
    // Nothing to select from: an ordinal alone carries no meaning, so judge.
    expect(view.decide(event('1、3'), snapshot()).route).toBe('judge')
  })

  it('4. an ordinal answering an open question amends the commitment that asked', () => {
    const decision = policy().decide(
      event('2'),
      snapshot({ openQuestionOnDesk: { commitment_id: 'C-9', ordinal: 2 } }),
    )
    expect(decision.route).toBe('fastpath')
    expect(decision.disposition).toBe('amend')
    expect(decision.detail).toMatchObject({ ordinals: [2], target: 'question', commitment_id: 'C-9' })
  })

  it('5. a short greeting is acknowledged unless a question is waiting', () => {
    const view = policy()
    const acknowledged = view.decide(event('谢谢'), snapshot())
    expect(acknowledged.route).toBe('fastpath')
    expect(acknowledged.disposition).toBe('acknowledge')
    expect(acknowledged.detail).toMatchObject({ react: true })
    // A greeting never answers a question: it must reach the desk instead.
    expect(view.decide(event('谢谢'), snapshot({ openQuestionOnDesk: { commitment_id: 'C-9', ordinal: 1 } })).route).toBe('judge')
  })

  it('6. a long greeting is not a greeting', () => {
    const view = policy()
    const long = view.decide(event('你好啊朋友们'), snapshot())
    expect(long.route).toBe('judge')
    expect(long.disposition).toBeUndefined()
    // 'hello' is listed in GREETINGS but runs five characters, and row 3 also
    // requires at most four, so the entry can never fire. That contradiction in
    // the spec is recorded rather than resolved here: the code implements the
    // literal rule, and the dead list entry is reported to the Lead.
    expect(view.decide(event('hello'), snapshot()).route).toBe('judge')
    expect(view.decide(event('你好'), snapshot()).disposition).toBe('acknowledge')
  })

  it('7. a sender outside the authorized range is declined with both R4 fields', () => {
    for (const cls of ['external', 'unknown'] as const) {
      const decision = policy(cls).decide(event('帮我看下这个'), snapshot())
      expect(decision.route).toBe('fastpath')
      expect(decision.disposition).toBe('decline')
      const detail = decision.detail as { reason?: string; alternative?: string }
      expect(detail.reason).toBeTruthy()
      expect(detail.alternative).toBeTruthy()
    }
    // The owner is not declined even with an empty snapshot.
    expect(policy('owner').decide(event('帮我看下这个'), snapshot()).disposition).not.toBe('decline')
  })

  it('8. a live subscription passes through unless the text carries a scope-change marker', () => {
    const view = policy()
    const subscribed = snapshot({ liveSubscription: { commitment_id: 'C-1', attempt_id: 'A-1' } })

    const direct = view.decide(event('跑完了吗'), subscribed)
    expect(direct.route).toBe('passthrough')
    expect(direct.disposition).toBe('passthrough')
    expect(direct.detail).toMatchObject({ commitment_id: 'C-1', attempt_id: 'A-1' })

    // The marker test is deliberately coarse (08): 顺便 alone has to be enough,
    // because dropping it from SCOPE_CHANGE_MARKERS must turn this case red.
    // This message carries no other marker, so it cannot ride on 也 or 改.
    const scope = view.decide(event('顺便看下日志'), subscribed)
    expect(scope.route).toBe('judge')
    expect(scope.disposition).toBeUndefined()

    // The same sentence from the design doc: several markers, still judge.
    expect(view.decide(event('顺便把 Z 也改了'), subscribed).route).toBe('judge')
    // No subscription: every one of these is judged anyway.
    expect(view.decide(event('跑完了吗'), snapshot()).route).toBe('judge')
  })

  it('9. rules are evaluated by order: a stop word beats passthrough', () => {
    const both = snapshot({ ...liveThread, liveSubscription: { commitment_id: 'C-1', attempt_id: 'A-1' } })
    const decision = policy().decide(event('停'), both)
    expect(decision.route).toBe('fastpath')
    expect(decision.disposition).toBe('release')
    expect(decision.detail).toMatchObject({ commitment_id: 'C-1' })
  })

  it('10. the rule table is data: orders increase, names are unique, a shorter table re-routes everything', () => {
    const orders = ROUTE_RULES.map(rule => rule.order)
    expect(orders).toEqual([...orders].sort((left, right) => left - right))
    expect(new Set(orders).size).toBe(orders.length)
    expect(new Set(ROUTE_RULES.map(rule => rule.name)).size).toBe(ROUTE_RULES.length)

    // The last row is the only one left: the design's row 6, "everything else
    // goes to the model". Nothing else may fire.
    const catchAll = ROUTE_RULES.filter(rule => rule.name === 'rest')
    expect(catchAll).toHaveLength(1)
    const narrowed: readonly RouteRule[] = catchAll
    const view = createRoutePolicy(deps(), narrowed)
    for (const text of ['停', '/new', '谢谢', '1、3', '跑完了吗']) {
      const decision = view.decide(event(text), snapshot({ ...liveThread, openProposalsOnDesk: ['C-1'] }))
      expect(decision.route).toBe('judge')
      expect(decision.disposition).toBeUndefined()
    }
    // A table with no catch-all still answers, and answers judge.
    expect(createRoutePolicy(deps(), []).decide(event('停'), snapshot(liveThread)).route).toBe('judge')
  })
})