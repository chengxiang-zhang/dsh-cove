/**
 * Kernel ledger (T08). Fixtures: FX/memdb.ts, FX/manual-clock.ts, FX/ledger.ts.
 */

import { describe, expect, it } from 'vitest'
import { LedgerError } from '../src/host/services/superagent/kernel/ledger.ts'
import { deliverSpec, openTestLedger, seedAttempt, seedCommitment, type TestLedger } from './fixtures/superagent/ledger.ts'

const HOUR = 3_600_000
const count = (t: TestLedger, table: string): number =>
  (t.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

function codeOf(fn: () => unknown): string | undefined {
  try { fn() } catch (error) { return error instanceof LedgerError ? error.code : `non-ledger: ${String(error)}` }
  return undefined
}

describe('kernel ledger', () => {
  it('1. a throwing callback rolls back every write of the transaction', () => {
    const t = openTestLedger()
    expect(() => t.ledger.open(tx => {
      tx.createCommitment({ ...deliverSpec(), next_look_at: tx.now + HOUR })
      throw new Error('boom')
    })).toThrow('boom')
    expect(count(t, 'sa_commitment')).toBe(0)
  })

  it('2. an async callback is refused with LEDGER_ASYNC_TX and leaves no write', async () => {
    const t = openTestLedger()
    let late: unknown
    const code = codeOf(() => t.ledger.open(async tx => {
      tx.createCommitment({ ...deliverSpec(), next_look_at: tx.now + HOUR })
      await Promise.resolve()
      try { tx.createCommitment({ ...deliverSpec(), next_look_at: tx.now + HOUR }) } catch (error) { late = error }
    }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(code).toBe('LEDGER_ASYNC_TX')
    expect(count(t, 'sa_commitment')).toBe(0)
    // Work resumed after the await cannot reach the closed transaction either.
    expect((late as LedgerError | undefined)?.code).toBe('LEDGER_ASYNC_TX')
    expect(count(t, 'sa_commitment')).toBe(0)
  })

  it('3. createCommitment numbers C-1 then C-2', () => {
    const t = openTestLedger()
    expect(seedCommitment(t).commitment_id).toBe('C-1')
    expect(seedCommitment(t).commitment_id).toBe('C-2')
  })

  it('4. open -> fulfilled needs evidence; with evidence closed_at and calibration fields are filled', () => {
    const t = openTestLedger()
    const c = seedCommitment(t)
    seedAttempt(t, c.commitment_id, { executor: 'codex' })
    t.ledger.open(tx => tx.updateAttempt(`${c.commitment_id}:A1`, { state: 'ended', end_reason: 'completed' }))
    seedAttempt(t, c.commitment_id, { executor: 'claude' })
    t.ledger.open(tx => tx.updateAttempt(`${c.commitment_id}:A2`, { state: 'ended', end_reason: 'completed' }))
    expect(codeOf(() => t.ledger.open(tx => tx.transition(c.commitment_id, 'fulfilled')))).toBe('ILLEGAL_TRANSITION')
    // The DDL is the second line: a raw kernel write without evidence is refused too.
    expect(() => t.ledger.open(tx => tx.run(`UPDATE sa_commitment SET state = 'fulfilled', closed_at = 1 WHERE commitment_id = ?`, c.commitment_id))).toThrow(/CHECK/)
    t.clock.advance(30 * 60_000)
    const done = t.ledger.open(tx => tx.transition(c.commitment_id, 'fulfilled', { evidence_json: '{"command":"pnpm test","exit":0}' }))
    expect(done.state).toBe('fulfilled')
    expect(done.closed_at).toBe(t.clock.now())
    expect(done.actual_min).toBe(30)
    expect(done.attempts).toBe(2)
    expect(done.executor_switched).toBe(1)
  })

  it('5. at_risk -> open and any move out of a terminal state are ILLEGAL_TRANSITION', () => {
    const t = openTestLedger()
    const c = seedCommitment(t)
    t.ledger.open(tx => tx.transition(c.commitment_id, 'at_risk'))
    expect(codeOf(() => t.ledger.open(tx => tx.transition(c.commitment_id, 'open')))).toBe('ILLEGAL_TRANSITION')
    t.ledger.open(tx => tx.transition(c.commitment_id, 'released'))
    expect(codeOf(() => t.ledger.open(tx => tx.transition(c.commitment_id, 'open')))).toBe('ILLEGAL_TRANSITION')
    expect(codeOf(() => t.ledger.open(tx => tx.transition(c.commitment_id, 'withdrawn')))).toBe('ILLEGAL_TRANSITION')
    // patchCommitment: only the six non-state columns, and never on a closed commitment.
    const live = seedCommitment(t)
    expect(t.ledger.open(tx => tx.patchCommitment(live.commitment_id, { slot: '1', used_turns: 3 }))).toMatchObject({ slot: '1', used_turns: 3, state: 'open' })
    expect(codeOf(() => t.ledger.open(tx => tx.patchCommitment(live.commitment_id, { what: 'x' } as never)))).toBe('BAD_COLUMN')
    expect(codeOf(() => t.ledger.open(tx => tx.patchCommitment(c.commitment_id, { used_turns: 1 })))).toBe('ILLEGAL_TRANSITION')
  })

  it('6. next_look_at is clamped: deliver to now+24h, goal to now+7d', () => {
    const t = openTestLedger()
    const now = t.clock.now()
    const deliver = seedCommitment(t, { next_look_at: now + 48 * HOUR })
    expect(deliver.next_look_at).toBe(now + 24 * HOUR)
    const goal = t.ledger.open(tx => tx.propose('host', {
      ...deliverSpec(), kind: 'goal', budget_wall_ms: null, budget_turns: null, next_look_at: now + 240 * HOUR,
    }))
    expect(goal.next_look_at).toBe(now + 7 * 24 * HOUR)
  })

  it('7. journal seq counts up per commitment; a 9000-character body becomes 2 rows of at most 8000', () => {
    const t = openTestLedger()
    const c = seedCommitment(t)
    const other = seedCommitment(t)
    expect(t.ledger.open(tx => tx.append(c.commitment_id, { actor: 'kernel', kind: 'note', body: { a: 1 } }))).toBe(1)
    expect(t.ledger.open(tx => tx.append(c.commitment_id, { actor: 'kernel', kind: 'note', body: { a: 2 } }))).toBe(2)
    expect(t.ledger.open(tx => tx.append(other.commitment_id, { actor: 'kernel', kind: 'note', body: {} }))).toBe(1)
    const big = 'x'.repeat(9000 - 2)
    expect(JSON.stringify(big)).toHaveLength(9000)
    const seq = t.ledger.open(tx => tx.append(c.commitment_id, { actor: 'kernel', kind: 'report', body: big }))
    const rows = t.db.prepare('SELECT seq, body_json FROM sa_journal WHERE commitment_id = ? AND seq >= ? ORDER BY seq').all(c.commitment_id, seq) as Array<{ seq: number; body_json: string }>
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.body_json.length <= 8000)).toBe(true)
    const rebuilt = rows.map(r => (JSON.parse(r.body_json) as { chunk: string }).chunk).join('')
    expect(JSON.parse(rebuilt)).toBe(big)
  })

  it('8. markConsumed is true once then false; a repeated request_id is refused (P3)', () => {
    const t = openTestLedger()
    const c = seedCommitment(t)
    t.ledger.open(tx => tx.append(c.commitment_id, { actor: 'desk', kind: 'amend', request_id: 'req-1', body: { text: 'also X' } }))
    expect(t.ledger.open(tx => tx.markConsumed('req-1', 3))).toBe(true)
    expect(t.ledger.open(tx => tx.markConsumed('req-1', 4))).toBe(false)
    expect(() => t.ledger.open(tx => tx.append(c.commitment_id, { actor: 'desk', kind: 'amend', request_id: 'req-1', body: {} }))).toThrow(/UNIQUE/)
    expect(count(t, 'sa_journal')).toBe(1)
  })

  it('9. propose refuses deliver with HOST_PROPOSE_KIND and accepts remind with origin_kind=host', () => {
    const t = openTestLedger()
    expect(codeOf(() => t.ledger.open(tx => tx.propose('host', { ...deliverSpec(), next_look_at: tx.now + HOUR })))).toBe('HOST_PROPOSE_KIND')
    expect(codeOf(() => t.ledger.open(tx => tx.createCommitment({ ...deliverSpec(), origin_kind: 'host', next_look_at: tx.now + HOUR })))).toBe('HOST_PROPOSE_KIND')
    const remind = t.ledger.open(tx => tx.propose('host', {
      ...deliverSpec(), kind: 'remind', origin_ref: 'host:brief:2026-11-05', budget_wall_ms: null, budget_turns: null, next_look_at: tx.now + HOUR,
    }))
    expect(remind.origin_kind).toBe('host')
    expect(remind.kind).toBe('remind')
  })

  it('10. tx.run outside the module whitelist is TABLE_NOT_OWNED', () => {
    const t = openTestLedger()
    const c = seedCommitment(t)
    expect(codeOf(() => t.ledger.open(tx => tx.run(`UPDATE sa_commitment SET what = 'x' WHERE commitment_id = ?`, c.commitment_id), { module: 'memory' }))).toBe('TABLE_NOT_OWNED')
    // Its own table is fine; the kernel may only touch the owner column of the channel table.
    t.ledger.open(tx => tx.run(`INSERT INTO sa_doc_index (doc_id, path, title, kind, added_by, added_at, created_at) VALUES ('d1', '/h.md', 'h', 'handoff', 'human', 1, 1)`), { module: 'memory' })
    expect(codeOf(() => t.ledger.open(tx => tx.run(`UPDATE inbox_events SET status = 'done'`)))).toBe('TABLE_NOT_OWNED')
    expect(t.db.prepare(`SELECT what FROM sa_commitment`).get()).toEqual({ what: 'do the thing' })
  })

  it('11. a shadow transaction cannot create commitments', () => {
    const t = openTestLedger()
    expect(codeOf(() => t.ledger.open(tx => tx.createCommitment({ ...deliverSpec(), next_look_at: tx.now + HOUR }), { shadow: true }))).toBe('SHADOW_NO_WRITE')
    expect(count(t, 'sa_commitment')).toBe(0)
  })

  it('12. requestTurn refuses a second open turn per commitment until finishTurn', () => {
    const t = openTestLedger()
    const c = seedCommitment(t)
    const first = t.ledger.open(tx => tx.requestTurn({ trigger_kind: 'agenda', commitment_id: c.commitment_id, request_id: 'tick:1' }))
    expect(first).toBe('D:tick:1')
    expect(t.ledger.open(tx => tx.requestTurn({ trigger_kind: 'agenda', commitment_id: c.commitment_id, request_id: 'tick:2' }))).toBeUndefined()
    t.ledger.open(tx => tx.finishTurn(first as string, { ops: 1, tool_errors: 0, tokens: 1200, end_reason: 'completed', rule_trace: [] }))
    expect(t.ledger.open(tx => tx.requestTurn({ trigger_kind: 'agenda', commitment_id: c.commitment_id, request_id: 'tick:3' }))).toBe('D:tick:3')
    expect(count(t, 'sa_deliberation')).toBe(2)
  })

  it('13. tx.run and reads refuse a second statement instead of silently dropping it', () => {
    const t = openTestLedger()
    const c = seedCommitment(t)
    const sql = `INSERT INTO sa_doc_index (doc_id, path, title, kind, added_by, added_at, created_at) VALUES ('d1', '/h.md', 'h', 'handoff', 'human', 1, 1); DELETE FROM sa_commitment`
    expect(codeOf(() => t.ledger.open(tx => tx.run(sql), { module: 'memory' }))).toBe('MULTI_STATEMENT')
    expect(count(t, 'sa_doc_index')).toBe(0)
    expect(count(t, 'sa_commitment')).toBe(1)
    // A semicolon inside a literal is refused too; a single trailing one is fine.
    expect(codeOf(() => t.ledger.open(tx => tx.run(`UPDATE sa_commitment SET what = 'a;b' WHERE commitment_id = ?`, c.commitment_id)))).toBe('MULTI_STATEMENT')
    expect(codeOf(() => t.ledger.read.all('SELECT 1; SELECT 2'))).toBe('MULTI_STATEMENT')
    t.ledger.open(tx => tx.run(`UPDATE sa_commitment SET what = 'ok' WHERE commitment_id = ?;`, c.commitment_id))
    expect(t.db.prepare('SELECT what FROM sa_commitment').get()).toEqual({ what: 'ok' })
  })
})
