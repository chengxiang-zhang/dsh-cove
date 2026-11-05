/**
 * Kernel clock (T13). Fixtures: FX/ledger.ts, FX/manual-clock.ts, a stub TickSignal.
 */

import { describe, expect, it } from 'vitest'
import { createClock, MIN_PUSH_MS, TICK_MS } from '../src/host/services/superagent/kernel/clock.ts'
import type { TickSignal, TurnRequest } from '../src/host/services/superagent/kernel/ports.ts'
import { openTestLedger, seedCommitment, type TestLedger } from './fixtures/superagent/ledger.ts'

const MIN = 60_000
const NONE: TickSignal = { has: () => null }
const ALWAYS: TickSignal = { has: () => ({ kind: 'report', detail: {} }) }
const deliberations = (t: TestLedger): number => (t.db.prepare('SELECT count(*) AS n FROM sa_deliberation').get() as { n: number }).n
const lookOf = (t: TestLedger, id: string): number =>
  (t.db.prepare('SELECT next_look_at FROM sa_commitment WHERE commitment_id = ?').get(id) as { next_look_at: number }).next_look_at

/** A commitment due now: created with a look one minute out, then the clock moves past it. */
function dueCommitment(t: TestLedger, over: Parameters<typeof seedCommitment>[1] = {}) {
  return seedCommitment(t, { next_look_at: t.clock.now() + MIN, ...over })
}

describe('kernel clock', () => {
  it('1. nothing due: no requests and no writes', () => {
    const t = openTestLedger()
    const c = seedCommitment(t, { next_look_at: t.clock.now() + 10 * MIN })
    const clock = createClock(t.ledger)
    expect(clock.tick(t.clock.now(), ALWAYS)).toEqual({ requested: [], deferred: [] })
    expect(deliberations(t)).toBe(0)
    expect(lookOf(t, c.commitment_id)).toBe(t.clock.now() + 10 * MIN)
  })

  it('2. due without a signal: no turn; pushed by max(5 min, remaining/2)', () => {
    const t = openTestLedger()
    const start = t.clock.now()
    const overdue = dueCommitment(t, { eta_at: start })                 // eta already passed at tick time
    const later = dueCommitment(t, { eta_at: start + MIN + 40 * MIN })  // 40 minutes remain at tick time
    t.clock.advance(MIN)
    const now = t.clock.now()
    const clock = createClock(t.ledger)
    expect(clock.tick(now, NONE)).toEqual({ requested: [], deferred: [] })
    expect(deliberations(t)).toBe(0)
    expect(lookOf(t, overdue.commitment_id)).toBe(now + MIN_PUSH_MS)
    expect(lookOf(t, later.commitment_id)).toBe(now + 20 * MIN)
  })

  it('3. due with a signal: one requested deliberation and one TurnRequest', () => {
    const t = openTestLedger()
    const c = dueCommitment(t)
    t.clock.advance(MIN)
    const round = createClock(t.ledger).tick(t.clock.now(), ALWAYS)
    expect(round.requested).toEqual([{ deliberation_id: `D:tick:${c.commitment_id}:${t.clock.now()}`, request_id: `tick:${c.commitment_id}:${t.clock.now()}`,
      commitment_id: c.commitment_id, trigger_kind: 'agenda' }])
    expect(t.db.prepare('SELECT state, trigger_kind FROM sa_deliberation').all()).toEqual([{ state: 'requested', trigger_kind: 'agenda' }])
  })

  it('4. an open turn defers the next round instead of requesting again', () => {
    const t = openTestLedger()
    const c = dueCommitment(t)
    t.clock.advance(MIN)
    const clock = createClock(t.ledger)
    clock.tick(t.clock.now(), ALWAYS)
    t.clock.advance(MIN)
    expect(clock.tick(t.clock.now(), ALWAYS)).toEqual({ requested: [], deferred: [c.commitment_id] })
    expect(deliberations(t)).toBe(1)
  })

  it('5. a throwing signal is treated as no signal; the rest of the round proceeds', () => {
    const t = openTestLedger()
    const bad = dueCommitment(t)
    const good = dueCommitment(t)
    t.clock.advance(MIN)
    const signal: TickSignal = { has: id => { if (id === bad.commitment_id) throw new Error('broken'); return { kind: 'x', detail: {} } } }
    const round = createClock(t.ledger).tick(t.clock.now(), signal)
    expect(lookOf(t, bad.commitment_id)).toBe(t.clock.now() + MIN_PUSH_MS)
    expect(round.requested.map(r => r.commitment_id)).toEqual([good.commitment_id])
  })

  it('6. start runs exactly 3 rounds in 180 seconds; lastTickAt is the last round', () => {
    const t = openTestLedger()
    const c = dueCommitment(t, { next_look_at: t.clock.now() })
    const clock = createClock(t.ledger)
    const start = t.clock.now()
    const roundsAt: number[] = []
    // Each round requests one turn; closing it at once lets the next round request again.
    const stop = clock.start(t.clock, ALWAYS, r => {
      roundsAt.push(t.clock.now())
      clock.finish(r.deliberation_id, { ops: 0, tool_errors: 0, tokens: 0, end_reason: 'completed', rule_trace: [] })
    })
    t.clock.advance(3 * TICK_MS)
    expect(roundsAt).toEqual([start + TICK_MS, start + 2 * TICK_MS, start + 3 * TICK_MS])
    expect(clock.lastTickAt()).toBe(start + 3 * TICK_MS)
    expect(t.db.prepare("SELECT count(*) AS n FROM sa_deliberation WHERE state = 'done' AND ops = 0 AND end_reason = 'completed' AND commitment_id = ?").get(c.commitment_id)).toEqual({ n: 3 })
    stop()
    t.clock.advance(TICK_MS)
    expect(roundsAt).toHaveLength(3)
  })

  it('7. a throwing onRequest does not stop the next round', () => {
    const t = openTestLedger()
    const first = dueCommitment(t)
    const second = seedCommitment(t, { next_look_at: t.clock.now() + 90_000 })
    const seen: TurnRequest[] = []
    const stop = createClock(t.ledger).start(t.clock, ALWAYS, r => { seen.push(r); throw new Error('desk down') })
    t.clock.advance(2 * TICK_MS)
    stop()
    expect(seen.map(r => r.commitment_id)).toEqual([first.commitment_id, second.commitment_id])
  })

  it('8. terminal commitments are never selected, even with an old next_look_at', () => {
    const t = openTestLedger()
    const c = dueCommitment(t)
    t.ledger.open(tx => tx.transition(c.commitment_id, 'released'))
    t.clock.advance(10 * MIN)
    expect(createClock(t.ledger).tick(t.clock.now(), ALWAYS)).toEqual({ requested: [], deferred: [] })
    expect(deliberations(t)).toBe(0)
  })
})
