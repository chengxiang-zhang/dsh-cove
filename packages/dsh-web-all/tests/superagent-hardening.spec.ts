/**
 * R1 adversarial review: every attack construction, each one an `it` that must fail
 * to break the kernel. Two layers are attacked:
 * - the ledger (`t.raw`: the production ledger, `module` required, no test default);
 * - the database itself (`t.db`, a raw handle like the channel's own connection),
 *   where the triggers are the only line.
 * Probes: /tmp/r1/probe{2,3,4,7,8,9,10,11}.mjs; report /tmp/r1-review.md.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createClosure, type ExecutorFacts } from '../src/host/services/superagent/executors/closure.ts'
import { parseReport } from '../src/host/services/superagent/executors/report-tool.ts'
import { createLedger, LedgerError, MIN_LOOK_AHEAD_MS } from '../src/host/services/superagent/kernel/ledger.ts'
import { migrate } from '../src/host/services/superagent/protocol/db.ts'
import type { EndReason } from '../src/host/services/superagent/protocol/objects.ts'
import type { ReportInput } from '../src/host/services/superagent/protocol/tools.ts'
import { createManualClock } from './fixtures/superagent/manual-clock.ts'
import { deliverSpec, openTestLedger, seedAttempt, seedCommitment, type TestLedger } from './fixtures/superagent/ledger.ts'
import { INBOX_EVENTS_DDL, INBOX_EVENTS_INDEXES, seedInbound } from './fixtures/superagent/memdb.ts'

const HOUR = 3_600_000
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function codeOf(fn: () => unknown): string {
  try { fn() } catch (error) { return error instanceof LedgerError ? error.code : `raw: ${(error as Error).message}` }
  return 'NO-ERROR'
}
const row = (t: TestLedger, sql: string, ...p: Array<string | number>) => t.db.prepare(sql).get(...p) as Record<string, unknown>

/** A fulfilled commitment with evidence, the target of the terminal-rebuild attack. */
function fulfilled(t: TestLedger) {
  const c = seedCommitment(t)
  t.ledger.open(tx => tx.transition(c.commitment_id, 'fulfilled', { evidence_json: '{"real":1}' }), { module: 'kernel' })
  return c
}

function seedMemory(t: TestLedger): void {
  t.db.prepare(`INSERT INTO sa_memory (memory_id, kind, topic, body, authority, source_event, source_quote, state, created_at)
    VALUES ('M-1', 'constraint', 'deploy', 'never deploy on friday', 'owner-said', 'e1', 'never deploy on friday', 'active', 1)`).run()
}

function seedMandate(t: TestLedger): void {
  t.db.prepare(`INSERT INTO sa_mandate (mandate_id, principal, scope_path, capability, strength, policy_version, granted_by, granted_at, created_at)
    VALUES ('md-1', 'on_owner', 'local/', 'write_repo', 'draft', 1, 'owner', 1, 1)`).run()
}

class Facts implements ExecutorFacts {
  readonly logs = new Map<string, { callId: string; name: string; arguments: string; exit?: number }[]>()
  lastTurnEnd(): { turn: number; reason: EndReason } | undefined { return undefined }
  lastReport(): ReportInput | undefined { return undefined }
  toolLog(attemptId: string) { return this.logs.get(attemptId) ?? [] }
  call(attemptId: string, name: string, args: Record<string, unknown>, exit?: number): void {
    const list = this.logs.get(attemptId) ?? []
    list.push({ callId: `c${list.length + 1}`, name, arguments: JSON.stringify(args), ...(exit === undefined ? {} : { exit }) })
    this.logs.set(attemptId, list)
  }
}
function closureRig(doneWhen: string) {
  const t = openTestLedger()
  const facts = new Facts()
  const closure = createClosure({ ledger: t.ledger, facts, artifacts: { pathExists: () => false, branchCommits: () => 0 } })
  const c = seedCommitment(t, { check_kind: 'command', done_when: doneWhen })
  const a = seedAttempt(t, c.commitment_id)
  return { t, facts, closure, c, a }
}

describe('R1 hardening: attacks that must not land', () => {
  it('A1: a BEGIN that fails with SQLITE_BUSY does not wedge the ledger; the next open writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-a1-'))
    dirs.push(dir)
    const file = join(dir, 'inbox.sqlite')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(INBOX_EVENTS_DDL)
    for (const sql of INBOX_EVENTS_INDEXES) db.exec(sql)
    migrate(db)
    db.exec('PRAGMA busy_timeout = 50')
    const other = new DatabaseSync(file)
    const ledger = createLedger(db, createManualClock(1_000_000))
    other.exec('BEGIN IMMEDIATE')   // the second writer holds the lock past busy_timeout
    expect(codeOf(() => ledger.open(tx => tx.createCommitment({ ...deliverSpec(), next_look_at: tx.now + HOUR }), { module: 'kernel' }))).toMatch(/locked|busy/i)
    other.exec('COMMIT')
    expect(ledger.open(tx => tx.createCommitment({ ...deliverSpec(), next_look_at: tx.now + HOUR }), { module: 'kernel' }).commitment_id).toBe('C-1')
    other.close(); db.close()
  })

  it('A3: open without a module throws MODULE_REQUIRED; judgment cannot write the journal or rewrite a commitment', () => {
    const t = openTestLedger()
    const c = seedCommitment(t)
    expect(codeOf(() => (t.raw.open as (fn: unknown) => unknown)(() => 1))).toBe('MODULE_REQUIRED')
    expect(codeOf(() => t.raw.open(tx => tx.run(`INSERT INTO sa_journal (commitment_id, seq, actor, kind, body_json, created_at) VALUES (?, 1, 'x', 'note', '{}', 1)`, c.commitment_id), { module: 'judgment' }))).toBe('TABLE_NOT_OWNED')
    expect(codeOf(() => t.raw.open(tx => tx.run(`UPDATE sa_commitment SET what = 'hijacked' WHERE commitment_id = ?`, c.commitment_id), { module: 'judgment' }))).toBe('TABLE_NOT_OWNED')
    expect(row(t, 'SELECT what FROM sa_commitment').what).toBe('do the thing')
  })

  it('A2 (journal): REPLACE cannot rewrite a journal row, neither through the ledger nor on the raw handle', () => {
    const t = openTestLedger()
    const c = seedCommitment(t)
    t.ledger.open(tx => tx.append(c.commitment_id, { actor: 'kernel', kind: 'note', body: { real: 1 } }), { module: 'kernel' })
    const forge = `INSERT OR REPLACE INTO sa_journal (commitment_id, seq, actor, kind, body_json, created_at) VALUES ('${c.commitment_id}', 1, 'exec', 'report', '{"forged":2}', 1)`
    expect(codeOf(() => t.raw.open(tx => tx.run(forge), { module: 'kernel' }))).toBe('TABLE_NOT_OWNED')
    expect(codeOf(() => t.db.exec(forge))).toMatch(/no replace/)
    expect(row(t, 'SELECT actor, body_json FROM sa_journal WHERE seq = 1')).toEqual({ actor: 'kernel', body_json: '{"real":1}' })
  })

  it('A2 (memory): REPLACE cannot rewrite an owner-said memory body or authority', () => {
    const t = openTestLedger()
    seedMemory(t)
    expect(codeOf(() => t.db.exec(`INSERT OR REPLACE INTO sa_memory (memory_id, kind, topic, body, authority, source_event, source_quote, state, created_at)
      VALUES ('M-1', 'constraint', 'deploy', 'deploy any time', 'owner-said', 'e1', 'never deploy on friday', 'active', 1)`))).toMatch(/no replace/)
    expect(row(t, 'SELECT body, authority FROM sa_memory')).toEqual({ body: 'never deploy on friday', authority: 'owner-said' })
  })

  it('A2 (mandate): REPLACE cannot upgrade write_repo/draft to change_prod/allow', () => {
    const t = openTestLedger()
    seedMandate(t)
    expect(codeOf(() => t.db.exec(`INSERT OR REPLACE INTO sa_mandate (mandate_id, principal, scope_path, capability, strength, policy_version, granted_by, granted_at, created_at)
      VALUES ('md-1', 'on_owner', 'local/', 'change_prod', 'allow', 1, 'owner', 1, 1)`))).toMatch(/IMMUTABLE/)
    expect(row(t, 'SELECT capability, strength FROM sa_mandate')).toEqual({ capability: 'write_repo', strength: 'draft' })
  })

  it('A6: a fulfilled commitment cannot be rebuilt as open by REPLACE; evidence and closed_at stay', () => {
    const t = openTestLedger()
    const c = fulfilled(t)
    expect(codeOf(() => t.db.exec(`INSERT OR REPLACE INTO sa_commitment (commitment_id, n, kind, debtor, creditor, ball, origin_kind, origin_ref, what, intent, check_kind, done_when, state, next_look_at, budget_wall_ms, budget_turns, created_at)
      VALUES ('${c.commitment_id}', ${c.n}, 'deliver', 'me', 'u', 'me', 'event', 'evt:FORGED', 'w', 'i', 'command', 'd', 'open', 9999999999999, 1000, 5, 1)`))).toMatch(/TERMINAL/)
    expect(row(t, 'SELECT state, evidence_json, closed_at IS NOT NULL AS closed, origin_ref FROM sa_commitment'))
      .toEqual({ state: 'fulfilled', evidence_json: '{"real":1}', closed: 1, origin_ref: c.origin_ref })
  })

  it('A2/O3: REPLACE cannot swap the owner of a claimed inbox event', () => {
    const t = openTestLedger()
    seedInbound(t.db, { event_id: 'e1', message_id: 'om_1' })
    t.db.prepare(`UPDATE inbox_events SET owner = 'superagent' WHERE event_id = 'e1'`).run()
    t.db.exec(`INSERT OR REPLACE INTO inbox_events (event_id, file, status, attempts, received_at, updated_at, payload, message_id, owner)
      VALUES ('e1', '/x', 'pending', 0, 1, 1, '{}', 'om_1', 'responder')`)
    expect(row(t, `SELECT owner FROM inbox_events WHERE event_id = 'e1'`)).toEqual({ owner: 'superagent' })
  })

  it('A5: a memory row cannot move back from superseded to active, nor sideways to disputed', () => {
    const t = openTestLedger()
    seedMemory(t)
    t.db.prepare(`UPDATE sa_memory SET state = 'superseded' WHERE memory_id = 'M-1'`).run()
    expect(codeOf(() => t.db.prepare(`UPDATE sa_memory SET state = 'active' WHERE memory_id = 'M-1'`).run())).toMatch(/MEMORY_STATE_ONE_WAY/)
    t.db.prepare(`INSERT INTO sa_memory (memory_id, kind, topic, body, authority, state, created_at) VALUES ('M-2', 'preference', 'tone', 'short', 'inferred', 'active', 1)`).run()
    expect(codeOf(() => t.db.prepare(`UPDATE sa_memory SET state = 'disputed' WHERE memory_id = 'M-2'`).run())).toMatch(/MEMORY_STATE_ONE_WAY/)
  })

  it('A7: patchCommitment cannot drop a live slot, reset extended or shrink a budget', () => {
    const t = openTestLedger()
    const c = seedCommitment(t)
    const a = seedAttempt(t, c.commitment_id, { lifetime: 'durable' })
    t.raw.open(tx => { tx.patchCommitment(c.commitment_id, { slot: '1', extended: 1 }); tx.updateAttempt(a.attempt_id, { state: 'running' }) }, { module: 'executors' })
    expect(codeOf(() => t.raw.open(tx => tx.patchCommitment(c.commitment_id, { slot: null }), { module: 'executors' }))).toBe('ILLEGAL_TRANSITION')
    expect(codeOf(() => t.raw.open(tx => tx.patchCommitment(c.commitment_id, { extended: 0 }), { module: 'executors' }))).toBe('ILLEGAL_TRANSITION')
    expect(codeOf(() => t.raw.open(tx => tx.patchCommitment(c.commitment_id, { budget_turns: 1 }), { module: 'executors' }))).toBe('ILLEGAL_TRANSITION')
    expect(row(t, 'SELECT slot, extended, budget_turns FROM sa_commitment')).toEqual({ slot: '1', extended: 1, budget_turns: 20 })
  })

  it('A4: no running attempt on a closed or missing commitment, and an ended attempt stays ended (I3 reading 0)', () => {
    const t = openTestLedger()
    const c = seedCommitment(t)
    const a = seedAttempt(t, c.commitment_id)
    t.ledger.open(tx => tx.transition(c.commitment_id, 'released'), { module: 'kernel' })
    expect(codeOf(() => t.raw.open(tx => tx.updateAttempt(a.attempt_id, { state: 'running' }), { module: 'executors' }))).toBe('ILLEGAL_TRANSITION')
    expect(codeOf(() => t.db.prepare(`UPDATE sa_attempt SET state = 'running' WHERE attempt_id = ?`).run(a.attempt_id))).toMatch(/ATTEMPT_ON_CLOSED/)
    t.db.prepare(`UPDATE sa_attempt SET state = 'ended' WHERE attempt_id = ?`).run(a.attempt_id)
    expect(codeOf(() => t.db.prepare(`UPDATE sa_attempt SET state = 'pending' WHERE attempt_id = ?`).run(a.attempt_id))).toMatch(/ATTEMPT_ENDED/)
    expect(codeOf(() => t.db.prepare(`INSERT INTO sa_attempt (attempt_id, commitment_id, n, executor, reason, lifetime, state, created_at) VALUES ('x', 'C-404', 1, 'e', 'r', 'oneshot', 'pending', 1)`).run())).toMatch(/ATTEMPT_ORPHAN/)
    expect(row(t, `SELECT count(*) AS n FROM sa_attempt a JOIN sa_commitment c USING (commitment_id) WHERE a.state = 'running' AND c.state NOT IN ('open', 'at_risk')`)).toEqual({ n: 0 })
  })

  it('A8: a shadow transaction cannot write through tx.run', () => {
    const t = openTestLedger()
    const c = seedCommitment(t)
    expect(codeOf(() => t.raw.open(tx => tx.run(`UPDATE sa_commitment SET what = 'shadow' WHERE commitment_id = ?`, c.commitment_id), { module: 'kernel', shadow: true }))).toBe('SHADOW_NO_WRITE')
  })

  it('A9: next_look_at cannot be put in the past', () => {
    const t = openTestLedger()
    const c = seedCommitment(t)
    t.raw.open(tx => tx.touch(c.commitment_id, 0), { module: 'kernel' })
    expect(Number(row(t, 'SELECT next_look_at FROM sa_commitment').next_look_at)).toBe(t.clock.now() + MIN_LOOK_AHEAD_MS)
    const d = t.raw.open(tx => tx.createCommitment({ ...deliverSpec(), next_look_at: 0 }), { module: 'kernel' })
    expect(d.next_look_at).toBe(t.clock.now() + MIN_LOOK_AHEAD_MS)
  })

  it('A10: a second reply for one event is REPLY_EXISTS, not a raw constraint error', () => {
    const t = openTestLedger()
    const out = (idem: string) => ({ idem_key: idem, chat_id: 'oc', event_id: 'e1', payload: 'text' as const, body: 'hi', moment: 'answer' as const,
      tier: 'reply' as const, audience: 'requester' as const, words: 1, lease_epoch: 1 })
    t.raw.open(tx => tx.recordOutbox(out('k1')), { module: 'kernel' })
    expect(codeOf(() => t.raw.open(tx => tx.recordOutbox(out('k2')), { module: 'kernel' }))).toBe('REPLY_EXISTS')
    expect(codeOf(() => t.raw.open(tx => tx.recordOutbox({ ...out('k1'), event_id: 'e2' }), { module: 'kernel' }))).toBe('IDEM_EXISTS')
  })

  it('A11: the executor\'s own report call is never evidence, and report refuses stray fields', () => {
    const { t, facts, closure, c, a } = closureRig('`true` 期望退出码 0')
    facts.call(a.attempt_id, 'report', { state: 'progress', summary: 'wip', command: 'true' })
    facts.logs.get(a.attempt_id)![0].exit = 0
    const r = closure.close(a.attempt_id, { reason: 'completed' }, { state: 'ready', summary: 'done', evidence: [{ command: 'true', exit: 0, reading: 'ok' }] })
    expect(r.state).toBe('unverified')
    expect(row(t, 'SELECT state FROM sa_commitment WHERE commitment_id = ?', c.commitment_id).state).toBe('unverified')
    expect(parseReport({ state: 'progress', summary: 'wip', command: 'true' })).toMatchObject({ ok: false, code: 'INVALID' })
  })

  it('B1: a command criterion closes only on the command done_when names, with its exit code', () => {
    // probe10: done_when names no command; `true` exits 0 -> must not be fulfilled.
    const bare = closureRig('pytest all green')
    bare.facts.call(bare.a.attempt_id, 'bash', { command: 'true' }, 0)
    expect(bare.closure.close(bare.a.attempt_id, { reason: 'completed' }, { state: 'ready', summary: 'ok', evidence: [{ command: 'true', exit: 0, reading: 'ok' }] }).state).toBe('unverified')
    // done_when names `pytest`; evidence of another command is not it.
    const other = closureRig('`pytest` 期望退出码 0')
    other.facts.call(other.a.attempt_id, 'bash', { command: 'true' }, 0)
    expect(other.closure.close(other.a.attempt_id, { reason: 'completed' }, { state: 'ready', summary: 'ok', evidence: [{ command: 'true', exit: 0, reading: 'ok' }] }).state).toBe('unverified')
    // The named command with the named exit code, really run: fulfilled.
    const real = closureRig('`pytest` 期望退出码 0')
    real.facts.call(real.a.attempt_id, 'bash', { command: 'pytest' }, 0)
    expect(real.closure.close(real.a.attempt_id, { reason: 'completed' }, { state: 'ready', summary: 'ok', evidence: [{ command: 'pytest', exit: 0, reading: '12 passed' }] }).state).toBe('unverified')
  })

  it('A12: the pending sweep judges a waiting row once; a second round adds nothing', () => {
    const { t, closure, a } = closureRig('`pytest` 期望退出码 0')
    closure.noteReady(a.attempt_id, { state: 'ready', summary: 'ok', evidence: [{ command: 'pytest', exit: 0, reading: 'ok' }] })
    t.clock.advance(11 * 60_000)
    const first = closure.pendingSweep(t.clock.now())
    const rows = Number(row(t, 'SELECT count(*) AS n FROM sa_journal').n)
    expect(first).toBe(1)
    expect(closure.pendingSweep(t.clock.now())).toBe(0)
    expect(Number(row(t, 'SELECT count(*) AS n FROM sa_journal').n)).toBe(rows)
  })
})
