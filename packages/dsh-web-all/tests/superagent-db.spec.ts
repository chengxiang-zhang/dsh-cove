/**
 * Protocol DDL, migration and self-check (T04).
 *
 * Each case is a counterexample the schema itself must refuse: the constraints
 * are mechanism, not advice (02). Fixture: tests/fixtures/superagent/memdb.ts.
 */

import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { PHYSICAL, SA_TABLES, migrate, selfCheck } from '../src/host/services/superagent/protocol/db.ts'
import { openInboxOnlyDb, openTestLedgerDb, seedInbound } from './fixtures/superagent/memdb.ts'

type Row = Record<string, string | number | null>

function insert(db: DatabaseSync, table: string, row: Row): void {
  const cols = Object.keys(row)
  db.prepare(`INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...Object.values(row))
}

function saTables(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sa\\_%' ESCAPE '\\'").all() as Array<{ name: string }>
  return rows.map(r => r.name).sort()
}

const commitment = (over: Row = {}): Row => ({
  commitment_id: 'C-1', n: 1, kind: 'deliver', debtor: 'me', creditor: 'u1', ball: 'me', thread_key: 't1',
  origin_kind: 'event', origin_ref: 'e1', what: 'w', intent: 'i', check_kind: 'command', done_when: 'd',
  state: 'open', next_look_at: 10, budget_wall_ms: 60_000, budget_turns: 5, created_at: 1, ...over,
})

const outbox = (over: Row = {}): Row => ({
  outbox_id: 'o1', idem_key: 'k1', chat_id: 'oc_1', event_id: 'e1', payload: 'text', body: 'hi', moment: 'answer',
  tier: 'reply', audience: 'requester', words: 1, lease_epoch: 1, state: 'queued', created_at: 1, ...over,
})

const journal = (over: Row = {}): Row => ({
  commitment_id: 'C-1', seq: 1, actor: 'kernel', kind: 'note', body_json: '{}', created_at: 1, ...over,
})

const memory = (over: Row = {}): Row => ({
  memory_id: 'm1', kind: 'preference', topic: 'tone', body: 'short', authority: 'owner-said', source_event: 'e1',
  source_quote: 'keep it short', state: 'active', created_at: 1, ...over,
})

const mandate = (over: Row = {}): Row => ({
  mandate_id: 'md1', principal: 'owner', scope_path: '/repo', capability: 'read', strength: 'allow',
  policy_version: 1, granted_by: 'config', granted_at: 1, created_at: 1, ...over,
})

const rule = (over: Row = {}): Row => ({
  rule_id: 'r1', scope_path: '/', layer: 'technique', when_json: '{}', then: 'allow', provenance: 'inferred',
  state: 'proposed', created_at: 1, ...over,
})

const attempt = (over: Row = {}): Row => ({
  attempt_id: 'a1', commitment_id: 'C-1', n: 1, executor: 'codex', reason: 'repo work', lifetime: 'oneshot',
  state: 'pending', created_at: 1, ...over,
})

describe('superagent protocol DDL', () => {
  it('1. creates exactly the 25 sa_ tables named by PHYSICAL', () => {
    const db = openTestLedgerDb()
    const expected = Object.values(PHYSICAL).filter(name => name !== 'inbox_events').sort()
    expect(expected).toHaveLength(25)
    expect(saTables(db)).toEqual(expected)
    expect([...SA_TABLES].sort()).toEqual(expected)
  })

  it('2. a second migrate is a no-op: added=[] and the table count is unchanged', () => {
    const db = openTestLedgerDb()
    const before = saTables(db).length
    const second = migrate(db)
    const after = saTables(db).length
    console.log(`[T04 idempotence] second migrate added=${JSON.stringify(second.added)} sa_tables before=${before} after=${after}`)
    expect(second.added).toEqual([])
    expect(after).toBe(before)
    expect(selfCheck(db)).toEqual({ ok: true })
  })

  it('3. upgrades a legacy inbox_events in place: owner added as NULL, other columns untouched', () => {
    const db = openInboxOnlyDb()
    seedInbound(db, { event_id: 'evt-old', file: '/tmp/a.jsonl', status: 'done', attempts: 2, received_at: 7, updated_at: 9, payload: '{"x":1}', message_id: 'om_1' })
    const before = db.prepare('SELECT * FROM inbox_events').get()
    const { added } = migrate(db)
    expect(added).toContain('inbox_events.owner')
    const after = db.prepare('SELECT * FROM inbox_events').get() as Row
    expect(after.owner).toBeNull()
    const { owner: _owner, ...rest } = after
    expect(rest).toEqual(before)
  })

  it('4. inbox_events.owner is compare-and-set: NULL to superagent passes, then any change aborts', () => {
    const db = openTestLedgerDb()
    seedInbound(db, { event_id: 'e1' })
    db.prepare("UPDATE inbox_events SET owner = 'superagent' WHERE event_id = 'e1'").run()
    expect(() => db.prepare("UPDATE inbox_events SET owner = 'responder' WHERE event_id = 'e1'").run()).toThrow(/OWNER_ALREADY_SET/)
    expect(() => db.prepare("UPDATE inbox_events SET owner = 'nobody' WHERE event_id = 'e1'").run()).toThrow()
  })

  it('5. sa_outbox refuses words over 100, react rows with words, and a second reply text per event', () => {
    const db = openTestLedgerDb()
    expect(() => insert(db, 'sa_outbox', outbox({ words: 101 }))).toThrow(/CHECK/)
    expect(() => insert(db, 'sa_outbox', outbox({ payload: 'react', words: 1 }))).toThrow(/CHECK/)
    insert(db, 'sa_outbox', outbox({ words: 100 }))
    expect(() => insert(db, 'sa_outbox', outbox({ outbox_id: 'o2', idem_key: 'k2' }))).toThrow(/UNIQUE/)
  })

  it('6. sa_commitment table-level constraints each refuse a counterexample', () => {
    const db = openTestLedgerDb()
    expect(() => insert(db, 'sa_commitment', commitment({ next_look_at: null }))).toThrow(/CHECK/)
    expect(() => insert(db, 'sa_commitment', commitment({ state: 'fulfilled', closed_at: 5, evidence_json: null }))).toThrow(/CHECK/)
    expect(() => insert(db, 'sa_commitment', commitment({ kind: 'watch', target: null }))).toThrow(/CHECK/)
    expect(() => insert(db, 'sa_commitment', commitment({ budget_turns: null }))).toThrow(/CHECK/)
    insert(db, 'sa_commitment', commitment())
  })

  it('7. one open top-level deliver per thread and debtor; a child commitment is allowed', () => {
    const db = openTestLedgerDb()
    insert(db, 'sa_commitment', commitment())
    expect(() => insert(db, 'sa_commitment', commitment({ commitment_id: 'C-2', n: 2, origin_ref: 'e2' }))).toThrow(/UNIQUE/)
    insert(db, 'sa_commitment', commitment({ commitment_id: 'C-2', n: 2, origin_ref: 'e2', parent_id: 'C-1' }))
  })

  it('8. a terminal commitment rejects every update', () => {
    const db = openTestLedgerDb()
    insert(db, 'sa_commitment', commitment({ state: 'fulfilled', evidence_json: '{}', closed_at: 5 }))
    expect(() => db.prepare("UPDATE sa_commitment SET what = 'x' WHERE commitment_id = 'C-1'").run()).toThrow(/TERMINAL/)
    expect(() => db.prepare("UPDATE sa_commitment SET state = 'open' WHERE commitment_id = 'C-1'").run()).toThrow(/TERMINAL/)
  })

  it('9. sa_journal is append-only except consumed_turn NULL to a value, and body_json is at most 8000', () => {
    const db = openTestLedgerDb()
    insert(db, 'sa_journal', journal())
    expect(() => db.prepare('DELETE FROM sa_journal').run()).toThrow(/APPEND_ONLY/)
    expect(() => db.prepare(`UPDATE sa_journal SET body_json = '{"a":1}'`).run()).toThrow(/APPEND_ONLY/)
    db.prepare('UPDATE sa_journal SET consumed_turn = 3').run()
    expect(() => db.prepare('UPDATE sa_journal SET consumed_turn = 4').run()).toThrow(/APPEND_ONLY/)
    expect(() => insert(db, 'sa_journal', journal({ seq: 2, body_json: 'x'.repeat(8001) }))).toThrow(/CHECK/)
    insert(db, 'sa_journal', journal({ seq: 3, body_json: 'x'.repeat(8000) }))
  })

  it('10. sa_memory rejects delete, a second active row per topic and kind, and owner-said without a quote', () => {
    const db = openTestLedgerDb()
    insert(db, 'sa_memory', memory())
    expect(() => db.prepare('DELETE FROM sa_memory').run()).toThrow(/APPEND_ONLY/)
    expect(() => insert(db, 'sa_memory', memory({ memory_id: 'm2' }))).toThrow(/UNIQUE/)
    expect(() => insert(db, 'sa_memory', memory({ memory_id: 'm3', topic: 'other', source_quote: null }))).toThrow(/CHECK/)
    expect(() => db.prepare(`UPDATE sa_memory SET body = 'long'`).run()).toThrow(/APPEND_ONLY/)
    db.prepare(`UPDATE sa_memory SET state = 'superseded', last_used_at = 5`).run()
  })

  it('11. sa_mandate refuses self-grant, a second revocation write and delete', () => {
    const db = openTestLedgerDb()
    expect(() => insert(db, 'sa_mandate', mandate({ granted_by: 'superagent' }))).toThrow(/CHECK/)
    insert(db, 'sa_mandate', mandate())
    db.prepare(`UPDATE sa_mandate SET revoked_at = 5, revoked_by = 'owner'`).run()
    expect(() => db.prepare('UPDATE sa_mandate SET revoked_at = 6').run()).toThrow(/IMMUTABLE/)
    expect(() => db.prepare(`UPDATE sa_mandate SET strength = 'deny'`).run()).toThrow(/IMMUTABLE/)
    expect(() => db.prepare('DELETE FROM sa_mandate').run()).toThrow(/APPEND_ONLY/)
  })

  it('12. sa_world_entity: a discovered entity cannot be enrolled', () => {
    const db = openTestLedgerDb()
    const entity = { entity_id: 'w1', canonical: 'host:a', kind: 'host', realm: 'local', path: '/a', source: 'discover', created_at: 1 }
    expect(() => insert(db, 'sa_world_entity', { ...entity, state: 'enrolled' })).toThrow(/CHECK/)
    insert(db, 'sa_world_entity', { ...entity, state: 'proposed' })
  })

  it('13. sa_autonomy: never-auto capabilities cannot be allow', () => {
    const db = openTestLedgerDb()
    expect(() => insert(db, 'sa_autonomy', { class_id: 'c', capability: 'publish', strength: 'allow', created_at: 1 })).toThrow(/CHECK/)
    insert(db, 'sa_autonomy', { class_id: 'c', capability: 'publish', strength: 'draft', created_at: 1 })
    insert(db, 'sa_autonomy', { class_id: 'c', capability: 'read', strength: 'allow', created_at: 1 })
  })

  it('14. sa_rule: inferred stays technique and never active; constitution needs owner approval', () => {
    const db = openTestLedgerDb()
    expect(() => insert(db, 'sa_rule', rule({ layer: 'policy' }))).toThrow(/CHECK/)
    expect(() => insert(db, 'sa_rule', rule({ state: 'active' }))).toThrow(/CHECK/)
    expect(() => insert(db, 'sa_rule', rule({ rule_id: 'r2', layer: 'constitution', provenance: 'config', approved_by: 'lead' }))).toThrow(/CHECK/)
    insert(db, 'sa_rule', rule())
  })

  it('15. selfCheck reports a dropped column', () => {
    const db = openTestLedgerDb()
    expect(selfCheck(db)).toEqual({ ok: true })
    db.exec('ALTER TABLE sa_outbox DROP COLUMN words')
    const check = selfCheck(db)
    expect(check.ok).toBe(false)
    expect(check.ok ? [] : check.missing).toContain('sa_outbox.words')
  })

  it('16. sa_attempt: running needs a budgeted deliver, and one live attempt per commitment', () => {
    const db = openTestLedgerDb()
    // A deliver row without a budget cannot be written through the CHECK; force one in
    // to prove the trigger is an independent second line (I3).
    db.exec('PRAGMA ignore_check_constraints = ON')
    insert(db, 'sa_commitment', commitment({ budget_wall_ms: null, budget_turns: null }))
    db.exec('PRAGMA ignore_check_constraints = OFF')
    insert(db, 'sa_attempt', attempt())
    expect(() => db.prepare(`UPDATE sa_attempt SET state = 'running' WHERE attempt_id = 'a1'`).run()).toThrow(/NO_BUDGET/)
    expect(() => insert(db, 'sa_attempt', attempt({ attempt_id: 'a2', n: 2 }))).toThrow(/UNIQUE/)
  })
})
