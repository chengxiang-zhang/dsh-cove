/**
 * Kernel claim (T12). Fixtures: FX/ledger.ts, FX/memdb.ts seedInbound, a stub ClaimPolicy.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createClaim } from '../src/host/services/superagent/kernel/claim.ts'
import { createLedger } from '../src/host/services/superagent/kernel/ledger.ts'
import type { ClaimDecision, ClaimPolicy } from '../src/host/services/superagent/kernel/ports.ts'
import { migrate } from '../src/host/services/superagent/protocol/db.ts'
import { inboundEvent, openTestLedger, seedAttempt, seedCommitment, seedSubscription, type TestLedger } from './fixtures/superagent/ledger.ts'
import { createManualClock } from './fixtures/superagent/manual-clock.ts'
import { INBOX_EVENTS_DDL, INBOX_EVENTS_INDEXES, seedInbound } from './fixtures/superagent/memdb.ts'

const policy = (decision: ClaimDecision): ClaimPolicy => ({ decide: () => decision })
const JUDGE = policy({ owner: 'superagent', route: 'judge' })
const count = (t: TestLedger, sql: string, ...p: Array<string | number>): number =>
  (t.db.prepare(`SELECT count(*) AS n FROM ${sql}`).get(...p) as { n: number }).n
const ownerOf = (t: TestLedger, id: string): unknown =>
  (t.db.prepare('SELECT owner FROM inbox_events WHERE event_id = ?').get(id) as { owner: unknown }).owner

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup() {
  const t = openTestLedger()
  return { t, claim: createClaim(t.ledger) }
}

describe('kernel claim', () => {
  it('1. superagent + judge: owner=superagent and one pending shadow=0 intake', () => {
    const { t, claim } = setup()
    const e = inboundEvent()
    seedInbound(t.db, { event_id: e.event_id })
    const r = claim.claim(e, JUDGE, 'superagent')
    expect(r).toMatchObject({ status: 'claimed', owner: 'superagent', route: 'judge', deskId: 'p2p:oc_1', threadKey: `p2p:oc_1:${e.thread}` })
    expect(ownerOf(t, e.event_id)).toBe('superagent')
    expect(t.db.prepare('SELECT shadow, state, owner, sender FROM sa_intake').all()).toEqual([{ shadow: 0, state: 'pending', owner: 'superagent', sender: 'on_owner' }])
  })

  it('2. a second claim of the same event is already_claimed and leaves one intake row', () => {
    const { t, claim } = setup()
    const e = inboundEvent()
    seedInbound(t.db, { event_id: e.event_id })
    expect(claim.claim(e, JUDGE, 'superagent').status).toBe('claimed')
    expect(claim.claim(e, JUDGE, 'superagent')).toEqual({ status: 'already_claimed' })
    expect(count(t, 'sa_intake')).toBe(1)
  })

  it('3. two ledgers on two connections to one file claim once between them (CAS)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-claim-'))
    dirs.push(dir)
    const file = join(dir, 'inbox.sqlite')
    const open = () => {
      const db = new DatabaseSync(file)
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA busy_timeout = 5000')
      return db
    }
    const a = open()
    a.exec(INBOX_EVENTS_DDL)
    for (const sql of INBOX_EVENTS_INDEXES) a.exec(sql)
    migrate(a)
    const b = open()
    const clock = createManualClock(1_000)
    const e = inboundEvent()
    seedInbound(a, { event_id: e.event_id })
    const results = [createClaim(createLedger(a, clock)), createClaim(createLedger(b, clock))].map(c => c.claim(e, JUDGE, 'superagent').status)
    expect(results.filter(s => s === 'claimed')).toHaveLength(1)
    expect(results.filter(s => s === 'already_claimed')).toHaveLength(1)
    expect((b.prepare('SELECT count(*) AS n FROM sa_intake').get() as { n: number }).n).toBe(1)
    a.close(); b.close()
  })

  it('4. fastpath release disposes the intake immediately', () => {
    const { t, claim } = setup()
    const e = inboundEvent()
    seedInbound(t.db, { event_id: e.event_id })
    const r = claim.claim(e, policy({ owner: 'superagent', route: 'fastpath', disposition: 'release' }), 'superagent')
    expect(r).toMatchObject({ status: 'claimed', route: 'fastpath', disposition: 'release' })
    expect(t.db.prepare('SELECT state, disposition FROM sa_intake').get()).toEqual({ state: 'disposed', disposition: 'release' })
  })

  it('5. passthrough writes one journal row and bumps input_seq; no commitment, attempt or turn', () => {
    const { t, claim } = setup()
    const c = seedCommitment(t)
    const a = seedAttempt(t, c.commitment_id)
    const e = inboundEvent()
    const tk = `p2p:oc_1:${e.thread}`
    seedSubscription(t, tk, c.commitment_id, a.attempt_id)
    seedInbound(t.db, { event_id: e.event_id })
    const before = { c: count(t, 'sa_commitment'), a: count(t, 'sa_attempt') }
    const r = claim.claim(e, policy({ owner: 'superagent', route: 'passthrough' }), 'superagent')
    expect(r).toMatchObject({ status: 'claimed', route: 'passthrough', disposition: 'passthrough' })
    expect(t.db.prepare('SELECT kind, request_id FROM sa_journal').all()).toEqual([{ kind: 'passthrough', request_id: `pt:${e.event_id}` }])
    expect(t.db.prepare('SELECT input_seq FROM sa_subscription').get()).toEqual({ input_seq: 1 })
    expect({ c: count(t, 'sa_commitment'), a: count(t, 'sa_attempt') }).toEqual(before)
    expect(count(t, 'sa_deliberation')).toBe(0)
    expect(t.db.prepare('SELECT state, disposition FROM sa_intake').get()).toEqual({ state: 'disposed', disposition: 'passthrough' })
  })

  it('6. responder mode: owner=responder, no intake row, policy not consulted', () => {
    const { t, claim } = setup()
    const e = inboundEvent()
    seedInbound(t.db, { event_id: e.event_id })
    let asked = 0
    const r = claim.claim(e, { decide: () => { asked += 1; return { owner: 'superagent', route: 'judge' } } }, 'responder')
    expect(r).toMatchObject({ status: 'claimed', owner: 'responder' })
    expect(ownerOf(t, e.event_id)).toBe('responder')
    expect(count(t, 'sa_intake')).toBe(0)
    expect(asked).toBe(0)
  })

  it('7. shadow mode: owner=responder, one shadow=1 intake, no outbox and no commitment', () => {
    const { t, claim } = setup()
    const e = inboundEvent()
    seedInbound(t.db, { event_id: e.event_id })
    expect(claim.claim(e, JUDGE, 'shadow')).toMatchObject({ status: 'shadowed' })
    expect(ownerOf(t, e.event_id)).toBe('responder')
    expect(t.db.prepare('SELECT shadow, state FROM sa_intake').all()).toEqual([{ shadow: 1, state: 'pending' }])
    claim.shadow(e)
    expect(count(t, 'sa_intake')).toBe(1)
    expect(count(t, 'sa_outbox') + count(t, 'sa_commitment')).toBe(0)
  })

  it('8. after a shadow claim, a superagent claim of the same event is already_claimed', () => {
    const { t, claim } = setup()
    const e = inboundEvent()
    seedInbound(t.db, { event_id: e.event_id })
    claim.claim(e, JUDGE, 'shadow')
    expect(claim.claim(e, JUDGE, 'superagent')).toEqual({ status: 'already_claimed' })
    expect(ownerOf(t, e.event_id)).toBe('responder')
    expect(count(t, 'sa_intake WHERE shadow = 0')).toBe(0)
  })

  it('9. unowned returns events older than the window with no owner', () => {
    const { t, claim } = setup()
    const now = 1_000_000
    seedInbound(t.db, { event_id: 'old', received_at: now - 61_000 })
    seedInbound(t.db, { event_id: 'young', received_at: now - 59_000 })
    seedInbound(t.db, { event_id: 'owned', received_at: now - 120_000 })
    t.db.prepare(`UPDATE inbox_events SET owner = 'responder' WHERE event_id = 'owned'`).run()
    expect(claim.unowned(now, 60_000)).toEqual(['old'])
  })

  it('10. snapshot returns the live commitment and subscription of the thread, nothing for another', () => {
    const { t, claim } = setup()
    const e = inboundEvent()
    const tk = `p2p:oc_1:${e.thread}`
    const c = seedCommitment(t, { thread_key: tk })
    const a = seedAttempt(t, c.commitment_id)
    seedSubscription(t, tk, c.commitment_id, a.attempt_id)
    expect(claim.snapshot(e)).toEqual({
      liveCommitmentOnThread: c.commitment_id,
      liveSubscription: { commitment_id: c.commitment_id, attempt_id: a.attempt_id },
      openProposalsOnDesk: [],
    })
    expect(claim.snapshot(inboundEvent())).toEqual({ openProposalsOnDesk: [] })
  })

  it('11. the 03 I2 reading is 0 once every claimed event is disposed', () => {
    const { t, claim } = setup()
    const events = [inboundEvent(), inboundEvent(), inboundEvent()]
    for (const e of events) seedInbound(t.db, { event_id: e.event_id, received_at: 1 })
    claim.claim(events[0], JUDGE, 'superagent')
    claim.claim(events[1], policy({ owner: 'superagent', route: 'fastpath', disposition: 'acknowledge' }), 'superagent')
    claim.claim(events[2], JUDGE, 'shadow')
    t.ledger.open(tx => tx.disposeIntake(events[0].event_id, 0, { disposition: 'answer' }))
    const i2 = t.db.prepare(`SELECT count(*) AS n FROM inbox_events e LEFT JOIN sa_intake i ON i.event_id = e.event_id AND i.shadow = 0
      WHERE e.owner = 'superagent' AND (i.state IS NULL OR i.state <> 'disposed') AND e.received_at < ? - 600000`).get(t.clock.now()) as { n: number }
    expect(i2.n).toBe(0)
  })
})
