/**
 * Protocol contracts (T01).
 *
 * The closed enumerations, the commitment state machine and the tool error sets
 * must match docs/superagent/02 verbatim. Expected values are inlined here on
 * purpose: the test is the second, independent copy of the contract.
 */

import { describe, expect, it } from 'vitest'
import {
  CANCEL_ORIGINS,
  CAPABILITIES,
  COMMITMENT_STATES,
  COMMITMENT_TRANSITIONS,
  DISPOSITIONS,
  END_REASONS,
  JOURNAL_KINDS,
  OPEN_STATES,
  OUTBOX_MOMENTS,
  RULE_PREDICATES,
  TERMINAL_STATES,
  TIERS,
  canTransition,
  parseEndReason,
  type CommitmentState,
} from '../src/host/services/superagent/protocol/objects.ts'
import { DESK_TOOL_NAMES, TOOL_ERROR_CODES } from '../src/host/services/superagent/protocol/tools.ts'
import { threadKey } from '../src/host/services/superagent/protocol/events.ts'
import { createFakeController } from './fixtures/superagent/fake-controller.ts'
import { createFakeChannel } from './fixtures/superagent/fake-channel.ts'
import { createManualClock } from './fixtures/superagent/manual-clock.ts'

describe('superagent protocol', () => {
  it('1. DISPOSITIONS has exactly the 12 values of 02', () => {
    const expected = ['answer', 'commit', 'amend', 'check', 'nudge', 'release', 'pushback',
      'decline', 'ask', 'acknowledge', 'route', 'passthrough']
    expect(DISPOSITIONS.length).toBe(12)
    expect([...DISPOSITIONS]).toEqual(expected)
  })

  it('2. commitment states split into open and terminal with no overlap and no gap', () => {
    expect(COMMITMENT_STATES.length).toBe(9)
    expect(TERMINAL_STATES.length).toBe(6)
    const open = new Set<string>(OPEN_STATES)
    const terminal = new Set<string>(TERMINAL_STATES)
    expect([...open].filter((s) => terminal.has(s))).toEqual([])
    const all = new Set<string>(COMMITMENT_STATES)
    expect(new Set([...open, ...terminal])).toEqual(all)
    expect(open.size + terminal.size).toBe(all.size)
  })

  it('3. enumeration cardinalities match 02', () => {
    expect(JOURNAL_KINDS.length).toBe(10)
    expect(OUTBOX_MOMENTS.length).toBe(8)
    expect(TIERS.length).toBe(4)
    expect(CAPABILITIES.length).toBe(8)
    expect(RULE_PREDICATES.length).toBe(11)
    expect(CANCEL_ORIGINS.length).toBe(8)
  })

  it('4. canTransition agrees with COMMITMENT_TRANSITIONS on the full 9x9 matrix', () => {
    for (const from of COMMITMENT_STATES) {
      for (const to of COMMITMENT_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(COMMITMENT_TRANSITIONS[from].includes(to))
      }
    }
    expect(canTransition('open', 'fulfilled')).toBe(true)
    expect(canTransition('at_risk', 'open')).toBe(false)
    for (const from of TERMINAL_STATES) {
      for (const to of COMMITMENT_STATES) expect(canTransition(from as CommitmentState, to), `${from} -> ${to}`).toBe(false)
    }
  })

  it('5. parseEndReason maps unknown to unknown and round-trips known values', () => {
    expect(parseEndReason('weird')).toBe('unknown')
    expect(parseEndReason(undefined)).toBe('unknown')
    expect(parseEndReason(42)).toBe('unknown')
    for (const reason of END_REASONS) expect(parseEndReason(reason)).toBe(reason)
  })

  it('6. desk tools and their error codes match the 02 tool table', () => {
    expect([...DESK_TOOL_NAMES]).toEqual(['judge', 'commit', 'amend', 'release', 'pushback', 'look', 'remember', 'propose', 'say'])
    const expected: Record<string, string[]> = {
      judge: ['ALREADY_DISPOSED', 'NOT_IN_BATCH', 'LIVE_THREAD_FORBIDS', 'ABOUT_NOT_VISIBLE', 'NEW_THREAD_REASON_REQUIRED'],
      commit: ['CHECK_MISSING', 'ASK_REQUIRED', 'TOO_MANY_ASSUMPTIONS', 'THREAD_BUSY', 'CLASS_UNKNOWN', 'SLOT_FULL',
        'BUDGET_OVER_CAP', 'BOUNDARY_DENIED', 'EXECUTOR_UNKNOWN', 'EXECUTOR_MISMATCH'],
      amend: ['TERMINAL', 'NOT_VISIBLE'],
      release: ['NOT_PERMITTED', 'TERMINAL'],
      pushback: ['NO_GROUNDS', 'PUSHBACK_REPEAT', 'PUSHBACK_QUIET'],
      look: ['NOT_VISIBLE', 'MISSING'],
      remember: ['QUOTE_NOT_IN_TRIGGER', 'CONFLICTS', 'SUPERSEDE_FORBIDDEN'],
      propose: ['NOT_GOAL', 'PROPOSAL_OPEN'],
      say: ['TOO_LONG', 'MOMENT_FORBIDDEN', 'REPLY_EXISTS', 'DISCLOSE_BLOCKED', 'PROMISE_BLOCKED', 'NO_LEASE'],
      report: ['QUESTION_REQUIRED'],
    }
    for (const [tool, codes] of Object.entries(expected)) {
      const actual = TOOL_ERROR_CODES[tool as keyof typeof TOOL_ERROR_CODES] as readonly string[]
      expect(new Set(actual), tool).toEqual(new Set(codes))
      expect(actual.length, tool).toBe(codes.length)
    }
    // Every desk tool plus the executor tool has an entry; nothing else besides the kernel scope.
    expect(new Set(Object.keys(TOOL_ERROR_CODES))).toEqual(new Set([...DESK_TOOL_NAMES, 'report', 'kernel']))
  })

  it('7. threadKey joins type, chat and root; rejects unknown chat types', () => {
    expect(threadKey('p2p', 'oc_x', 'm17')).toBe('p2p:oc_x:m17')
    expect(threadKey('group', 'oc_g', 'm1')).toBe('group:oc_g:m1')
    expect(() => threadKey('topic' as 'p2p', 'oc_x', 'm17')).toThrow()
  })

  it('8. fake controller replays emitted events in order and can fail create', async () => {
    const controller = createFakeController()
    const { sessionId } = await controller.create({ sessionId: 's-1', cwd: '/tmp/w' })
    expect(sessionId).toBe('s-1')
    controller.emit('s-1', { type: 'turn/start' })
    controller.emit('s-1', { type: 'turn/end', kind: 'completed' })
    const seen = await controller.inspect('s-1')
    expect(seen.events).toEqual([{ type: 'turn/start' }, { type: 'turn/end', kind: 'completed' }])
    expect(seen.meta?.cwd).toBe('/tmp/w')
    expect(controller.calls.map((c) => c.method)).toEqual(['create', 'inspect'])

    controller.failCreate(new Error('create boom'))
    await expect(controller.create({ sessionId: 's-2' })).rejects.toThrow('create boom')
  })

  it('9. fake channel records sends and is idempotent per idemKey', async () => {
    const channel = createFakeChannel()
    const first = await channel.send('oc_a', 'hello', 'om_root', 'idem-1')
    const second = await channel.send('oc_a', 'hello again', 'om_root', 'idem-1')
    expect(second.messageId).toBe(first.messageId)
    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0]).toMatchObject({ chatId: 'oc_a', text: 'hello', replyTo: 'om_root', idemKey: 'idem-1' })
    const history = await channel.history('oc_a', 10)
    expect(history.map((h) => h.message_id)).toEqual([first.messageId])
    expect(await channel.history('oc_b', 10)).toEqual([])

    channel.failSend(new Error('send boom'))
    await expect(channel.send('oc_a', 'x', undefined, 'idem-2')).rejects.toThrow('send boom')
  })

  it('10. manual clock fires a 60s interval exactly once per 60s advance', () => {
    const clock = createManualClock(1_000)
    let fired = 0
    const handle = clock.setInterval(() => { fired += 1 }, 60_000)
    clock.advance(60_000)
    expect(fired).toBe(1)
    expect(clock.now()).toBe(61_000)
    clock.advance(59_999)
    expect(fired).toBe(1)
    clock.advance(1)
    expect(fired).toBe(2)
    clock.clearInterval(handle)
    clock.advance(60_000)
    expect(fired).toBe(2)
  })
})
