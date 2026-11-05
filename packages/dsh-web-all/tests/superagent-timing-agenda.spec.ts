/**
 * Agenda, brief, speculation and the empty-running guard (T23).
 *
 * Contract: docs/superagent/09-时机与措辞.md (议程来源, 投机执行, 防空跑) and
 * plan/spec/T-10-timing-surface.md. Fixtures are the real in-memory ledger and the
 * manual clock: the point of this slice is that the secretary cannot open a turn
 * that is not attached to a commitment, and that has to hold against the same
 * ledger the kernel reads, not against a hand-made stub.
 *
 * Test 2 carries the negative control for the whole file: a stall is a system
 * fault, so `agendaMoment` must return null for it. Give `self_heal` the `alert`
 * moment and test 2 goes red, because a stuck job would start interrupting the
 * owner.
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createManualClock } from './fixtures/superagent/manual-clock.ts'
import { openTestLedger, seedAttempt, seedCommitment, type TestLedger } from './fixtures/superagent/ledger.ts'
import {
  AGENDA_SOURCES,
  AGENDA_SOURCE_NAMES,
  agendaDeferral,
  agendaMoment,
  agendaSignal,
  createTickSignal,
  selectAgendaSources,
} from '../src/host/services/superagent/timing/agenda/index.ts'
import { createBrief } from '../src/host/services/superagent/timing/brief.ts'
import { createSpeculation } from '../src/host/services/superagent/timing/speculation.ts'
import { createIdleGuard } from '../src/host/services/superagent/timing/idle-guard.ts'
import { tier } from '../src/host/services/superagent/timing/attention.ts'
import { DEFAULT_QUIET } from '../src/host/services/superagent/timing/attention.ts'

const NOW = 1_762_300_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function setup(): TestLedger {
  return openTestLedger(createManualClock(NOW))
}

function countOutbox(t: TestLedger): number {
  return (t.db.prepare('SELECT count(*) AS c FROM sa_outbox').get() as { c: number }).c
}

function insertDeliberation(t: TestLedger, id: string, createdAt: number, ops: number): void {
  t.db.prepare(
    `INSERT INTO sa_deliberation (deliberation_id, request_id, trigger_kind, state, created_at, updated_at, ops)
     VALUES (?, ?, 'agenda', 'done', ?, ?, ?)`,
  ).run(id, `req-${id}`, createdAt, createdAt, ops)
}

describe('agenda sources', () => {
  it('keeps a deliver commitment quiet before its ETA while tools are still running', () => {
    const t = setup()
    const row = seedCommitment(t, { kind: 'deliver', eta_at: NOW + 30 * MINUTE })
    seedAttempt(t, row.commitment_id, { last_tool_at: NOW - MINUTE, repeat_count: 0 })

    expect(agendaSignal(t.ledger.read, row.commitment_id, NOW)).toBeNull()
    expect(createTickSignal(t.ledger.read).has(row.commitment_id, NOW)).toBeNull()

    // The table is a closed enumeration, not a list the secretary can extend by
    // remembering something. Four names, and a fifth is an error, not a no-op.
    expect(AGENDA_SOURCES.map((source) => source.name)).toEqual([...AGENDA_SOURCE_NAMES])
    expect(AGENDA_SOURCE_NAMES.length).toBe(4)
    expect(() => selectAgendaSources(['deliver-warning', '自由联想'])).toThrow(/AGENDA_SOURCE_UNKNOWN/)
    expect(selectAgendaSources(['remind']).map((source) => source.name)).toEqual(['remind'])
  })

  it('turns ten silent minutes into a self-heal signal that speaks to nobody', () => {
    const t = setup()
    const row = seedCommitment(t, { kind: 'deliver', eta_at: NOW + 3 * HOUR })
    seedAttempt(t, row.commitment_id, { last_tool_at: NOW - 10 * MINUTE, repeat_count: 0 })

    const signal = agendaSignal(t.ledger.read, row.commitment_id, NOW)
    expect(signal?.kind).toBe('self_heal')
    expect((signal?.detail as { reason?: string }).reason).toBe('stall')
    // A stall is the executor's business. The whole anti-interrupt guarantee sits
    // on this line: no moment means no proposal, whatever the attention quota is.
    expect(agendaMoment(signal!)).toBeNull()
  })

  it('reports a first late delivery into the brief, never as an interrupt', () => {
    const t = setup()
    const row = seedCommitment(t, { kind: 'deliver', eta_at: NOW - MINUTE })
    seedAttempt(t, row.commitment_id, { last_tool_at: NOW - MINUTE, repeat_count: 0 })

    const signal = agendaSignal(t.ledger.read, row.commitment_id, NOW)
    expect(signal?.kind).toBe('late')
    const moment = agendaMoment(signal!)
    expect(moment).toBe('brief')
    const decision = tier({
      moment: moment!,
      ballToOwnerWithClock: true,
      irreversible: false,
      isReplyToInbound: false,
      interruptsToday: 0,
      quotaPerDay: 3,
      localHHMM: '12:05',
      quiet: DEFAULT_QUIET,
    })
    expect(decision.tier).toBe('brief')
    // Control: the same facts pushed through `alert` would have interrupted, which
    // is exactly the mapping this source refuses to take.
    expect(tier({
      moment: 'alert',
      ballToOwnerWithClock: true,
      irreversible: false,
      isReplyToInbound: false,
      interruptsToday: 0,
      quotaPerDay: 3,
      localHHMM: '12:05',
      quiet: DEFAULT_QUIET,
    }).tier).toBe('interrupt')

    // An agenda turn steps aside for live human traffic, five times.
    expect(agendaDeferral({ hasLiveHumanMessage: true, deferrals: 0 })).toEqual({ defer: true, nextDeferrals: 1 })
    expect(agendaDeferral({ hasLiveHumanMessage: true, deferrals: 4 })).toEqual({ defer: true, nextDeferrals: 5 })
    expect(agendaDeferral({ hasLiveHumanMessage: true, deferrals: 5 })).toEqual({ defer: false, nextDeferrals: 5 })
    expect(agendaDeferral({ hasLiveHumanMessage: false, deferrals: 0 })).toEqual({ defer: false, nextDeferrals: 0 })
  })

  it('probes a watched target every ten minutes, not more often', () => {
    const t = setup()
    const row = seedCommitment(t, { kind: 'watch', target: 'session:s-88' })
    seedAttempt(t, row.commitment_id, { last_tool_at: NOW - 9 * MINUTE, repeat_count: 0 })

    expect(agendaSignal(t.ledger.read, row.commitment_id, NOW)).toBeNull()
    expect(agendaSignal(t.ledger.read, row.commitment_id, NOW + MINUTE)?.kind).toBe('watch')
  })

  it('reminds once before the due time and never again', () => {
    const t = setup()
    const row = seedCommitment(t, { kind: 'remind', due_at: NOW + 10 * MINUTE })

    expect(agendaSignal(t.ledger.read, row.commitment_id, NOW)?.kind).toBe('remind')
    t.ledger.open((tx) => tx.append(row.commitment_id, { actor: 'host', kind: 'note', body: { reminded: true } }))
    expect(agendaSignal(t.ledger.read, row.commitment_id, NOW)).toBeNull()
  })

  it('does not ask for a goal round while proposals are still unanswered', () => {
    const t = setup()
    const goal = seedCommitment(t, { kind: 'goal' })
    // R1 A9: the ledger no longer writes a past look; the due state is set on the row directly.
    t.db.prepare('UPDATE sa_commitment SET next_look_at = ? WHERE commitment_id = ?').run(NOW - MINUTE, goal.commitment_id)
    expect(agendaSignal(t.ledger.read, goal.commitment_id, NOW)?.kind).toBe('goal')

    t.ledger.open((tx) => tx.createCommitment({
      kind: 'deliver', state: 'proposed', parent_id: goal.commitment_id, debtor: 'me', creditor: 'ou_owner',
      ball: 'ou_owner', origin_ref: `goal-proposal-${goal.commitment_id}`, what: 'proposal one',
      intent: 'proposal one', check_kind: 'answer', done_when: 'owner answers',
      next_look_at: NOW + DAY, budget_wall_ms: 3_600_000, budget_turns: 4,
    }))
    expect(agendaSignal(t.ledger.read, goal.commitment_id, NOW)).toBeNull()
  })
})

describe('brief', () => {
  it('is null on an empty day and stays within six lines when it has nine items', () => {
    const t = setup()
    const brief = createBrief({ read: t.ledger.read })
    expect(brief.build('2026-11-06', NOW)).toBeNull()

    for (let index = 1; index <= 9; index += 1) {
      const closed = seedCommitment(t, { kind: 'deliver', what: `任务 ${index}` })
      t.db.prepare(`UPDATE sa_commitment SET state = 'released', closed_at = ? WHERE commitment_id = ?`)
        .run(NOW - index * MINUTE, closed.commitment_id)
    }
    const body = brief.build('2026-11-06', NOW)
    expect(body).not.toBeNull()
    const lines = body!.body.split('\n')
    expect(lines.length).toBeLessThanOrEqual(6)
    expect(lines.length).toBe(6)
    expect(lines[5]).toContain('另有 4 件')
    expect(body!.body.length).toBeGreaterThan(0)
  })

  it('offers at most five promote candidates with one reply line', () => {
    const t = setup()
    seedCommitment(t, { kind: 'deliver' })
    const candidates = ['甲', '乙', '丙', '丁', '戊', '己', '庚'].map((topic, index) => ({ memory_id: `M-${index + 1}`, topic }))
    const brief = createBrief({ read: t.ledger.read, promoteCandidates: () => candidates })

    const body = brief.build('2026-11-06', NOW)
    expect(body).not.toBeNull()
    expect(body!.body).toContain('升公共 5 条')
    expect(body!.body).toContain('回 1、3')
    expect(body!.body).not.toContain('己')
  })
})

describe('speculation', () => {
  it('discards without a message, expires pending drafts, and keeps the row', () => {
    const t = setup()
    const root = mkdtempSync(join(tmpdir(), 'sa-spec-'))
    try {
      const speculation = createSpeculation({ read: t.ledger.read, root })
      const pendingId = t.ledger.open((tx) => speculation.start(tx, 'probe', { desk_id: 'desk:1' }), { module: 'timing' })
      const discardedId = t.ledger.open((tx) => speculation.start(tx, 'patrol', {}), { module: 'timing' })
      t.ledger.open((tx) => speculation.discard(tx, discardedId), { module: 'timing' })

      // A discarded draft is invisible outside its own row.
      expect(countOutbox(t)).toBe(0)
      expect(existsSync(join(root, discardedId))).toBe(true)

      t.clock.advance(3 * DAY)
      const expired = t.ledger.open((tx) => speculation.expire(tx, t.clock.now()), { module: 'timing' })
      expect(expired).toBe(1)
      const pendingRow = t.ledger.read.get<{ state: string }>('SELECT state FROM sa_speculation WHERE spec_id = ?', pendingId)
      expect(pendingRow?.state).toBe('expired')
      // Within seven days the discarded draft is still readable.
      expect(existsSync(join(root, discardedId))).toBe(true)
      const kept = t.ledger.read.get<{ state: string, path: string | null }>(
        'SELECT state, path FROM sa_speculation WHERE spec_id = ?',
        discardedId,
      )
      expect(kept?.state).toBe('discarded')
      expect(typeof kept?.path).toBe('string')

      t.clock.advance(5 * DAY)
      t.ledger.open((tx) => speculation.expire(tx, t.clock.now()), { module: 'timing' })
      expect(existsSync(join(root, discardedId))).toBe(false)
      const keptRow = t.ledger.read.get<{ state: string, path: string | null }>(
        'SELECT state, path FROM sa_speculation WHERE spec_id = ?',
        discardedId,
      )
      expect(keptRow?.state).toBe('discarded')
      expect(keptRow?.path).toBeNull()
      expect(countOutbox(t)).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('narrows the patrol class when most of the week is thrown away', () => {
    const t = setup()
    const speculation = createSpeculation({ read: t.ledger.read, root: tmpdir() })
    const insert = t.db.prepare(
      `INSERT INTO sa_speculation (spec_id, kind, state, created_at, updated_at) VALUES (?, 'patrol', ?, ?, ?)`,
    )
    for (let index = 0; index < 17; index += 1) {
      insert.run(`SP-d${index}`, 'discarded', NOW - HOUR, NOW - HOUR)
    }
    for (let index = 0; index < 3; index += 1) {
      insert.run(`SP-u${index}`, 'used', NOW - HOUR, NOW - HOUR)
    }
    expect(speculation.narrowPatrol(NOW)).toBe(true)

    // Control: 15/20 is under the threshold, so the reading is a ratio and not a count.
    t.db.prepare(`UPDATE sa_speculation SET state = 'used' WHERE spec_id IN ('SP-d0', 'SP-d1')`).run()
    expect(speculation.narrowPatrol(NOW)).toBe(false)
  })
})

describe('idle guard', () => {
  it('flags the day the secretary passes its turn cap', () => {
    const t = setup()
    const guard = createIdleGuard({ read: t.ledger.read })
    for (let index = 0; index < 199; index += 1) insertDeliberation(t, `D-${index}`, NOW - MINUTE, 1)
    expect(guard.turnsToday(NOW)).toBe(199)
    expect(guard.overCap(NOW)).toBe(false)

    insertDeliberation(t, 'D-199', NOW - MINUTE, 1)
    expect(guard.turnsToday(NOW)).toBe(200)
    expect(guard.overCap(NOW)).toBe(true)
  })

  it('tightens silently when forty percent of the last day produced nothing', () => {
    const t = setup()
    const guard = createIdleGuard({ read: t.ledger.read })
    for (let index = 0; index < 10; index += 1) {
      insertDeliberation(t, `D-${index}`, NOW - HOUR, index < 4 ? 0 : 2)
    }
    expect(guard.idleRate24h(NOW)).toBeCloseTo(0.4, 5)
    expect(guard.tighten(NOW)).toBe(true)
    // Empty running is healed by the system, so tightening must not send anything.
    expect(countOutbox(t)).toBe(0)
    expect(AGENDA_SOURCES.length).toBe(4)
  })
})