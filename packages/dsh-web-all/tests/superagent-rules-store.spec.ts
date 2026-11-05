/**
 * Rule store (T17): registration paths, merge, replay gate, conflict sweep,
 * calibration and autonomy.
 *
 * Fixtures: FX/ledger.ts (kernel ledger over the in-memory protocol database).
 * Every expectation is copied from docs/superagent/plan/spec/T-06-rules.md; the
 * reading queries at the bottom of the design document become assertions where a
 * zero was promised.
 */

import { describe, expect, it } from 'vitest'
import type { RuleRow, RuleThen } from '../src/host/services/superagent/protocol/objects.ts'
import type { LedgerTx } from '../src/host/services/superagent/protocol/db.ts'
import { createAutonomy } from '../src/host/services/superagent/rules/autonomy.ts'
import { createCalibration } from '../src/host/services/superagent/rules/calibration.ts'
import {
  createRuleRegistry,
  type RuleInput,
  type RuleRegistry,
} from '../src/host/services/superagent/rules/registry.ts'
import { createReplay, type Replay } from '../src/host/services/superagent/rules/replay.ts'
import { openTestLedger, seedCommitment, type TestLedger } from './fixtures/superagent/ledger.ts'

const DAY = 86_400_000
const LOCAL = 'local/'

interface Ctx {
  t: TestLedger
  registry: RuleRegistry
  replay: Replay
}

function setup(): Ctx {
  const t = openTestLedger()
  const registry = createRuleRegistry(t.ledger)
  const replay = createReplay(t.ledger, { snapshot: () => registry.snapshot() })
  return { t, registry, replay }
}

/** Runs one write transaction as the `rules` module, which is what owns the rule tables. */
function inRules<T>(t: TestLedger, fn: (tx: LedgerTx) => T): T {
  return t.ledger.open((tx) => fn(tx), { module: 'rules' })
}

function ruleInput(over: Partial<RuleInput> = {}): RuleInput {
  return { scope_path: LOCAL, layer: 'policy', when: {}, then: 'allow', ...over }
}

function registerConfig(ctx: Ctx, over: Partial<RuleInput> = {}): string {
  return inRules(ctx.t, (tx) => ctx.registry.register(tx, ruleInput(over), 'config', 'owner'))
}

function registerExtracted(ctx: Ctx, over: Partial<RuleInput> = {}): string {
  return inRules(ctx.t, (tx) => ctx.registry.register(tx, ruleInput(over), 'extracted', 'me'))
}

function readRule(t: TestLedger, ruleId: string): RuleRow {
  return t.db.prepare(`SELECT * FROM sa_rule WHERE rule_id = ?`).get(ruleId) as unknown as RuleRow
}

function countRows(t: TestLedger, table: string): number {
  return (t.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
}

/** Returns the `code` of the thrown named error, or a marker for a wrong throw. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : `unexpected: ${String(error)}`
  }
  return undefined
}

function seedIntakes(t: TestLedger, groups: { eta: number | null; count: number }[]): void {
  const base = t.clock.now() - 1_000_000
  let n = 0
  for (const group of groups) {
    for (let i = 0; i < group.count; i += 1) {
      n += 1
      t.db.prepare(
        `INSERT INTO sa_intake (event_id, shadow, owner, sender, desk_id, thread_key, state, class, pred_eta_min,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`evt-${n}`, 0, 'superagent', `party-${n}`, null, 'p2p:oc_test', 'pending', 'repo_change',
        group.eta, base + n, base + n)
    }
  }
}

function insertRawRule(t: TestLedger, ruleId: string, over: Record<string, unknown> = {}): void {
  const row = {
    rule_id: ruleId, scope_path: LOCAL, layer: 'policy', when_json: '{}', then: 'allow', exceptions_json: null,
    priority: 0, provenance: 'config', version: 1, state: 'active', approved_by: 'owner', rollback_if: null,
    weight: null, hits: 0, last_hit_at: null, created_at: t.clock.now(), updated_at: t.clock.now(), ...over,
  }
  t.db.prepare(
    `INSERT INTO sa_rule (rule_id, scope_path, layer, when_json, "then", exceptions_json, priority, provenance,
       version, state, approved_by, rollback_if, weight, hits, last_hit_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.rule_id, row.scope_path, row.layer, row.when_json, row.then, row.exceptions_json, row.priority,
    row.provenance, row.version, row.state, row.approved_by, row.rollback_if, row.weight, row.hits,
    row.last_hit_at, row.created_at, row.updated_at)
}

function seedClosedCommitment(
  t: TestLedger,
  sample: { workClass: string; etaModel: number; actualMin: number; turns: number },
): string {
  const commitment = seedCommitment(t)
  t.db.prepare(
    `UPDATE sa_commitment SET work_class = ?, eta_model_min = ?, actual_min = ?, used_turns = ?,
       state = 'fulfilled', evidence_json = '{}', closed_at = ? WHERE commitment_id = ?`,
  ).run(sample.workClass, sample.etaModel, sample.actualMin, sample.turns, t.clock.now(), commitment.commitment_id)
  return commitment.commitment_id
}

describe('superagent rule store', () => {
  it('1. config rules are active on write, extracted rules wait for an approver', () => {
    const ctx = setup()
    const configId = registerConfig(ctx, { scope_path: 'local/~/code' })
    const configRow = readRule(ctx.t, configId)
    expect(configRow.state).toBe('active')
    expect(configRow.provenance).toBe('config')
    expect(configRow.approved_by).toBe('owner')

    const extractedId = registerExtracted(ctx, { scope_path: 'local/~/code/dsh-web', then: 'draft' })
    const extractedRow = readRule(ctx.t, extractedId)
    expect(extractedRow.state).toBe('proposed')
    expect(extractedRow.provenance).toBe('extracted')
    expect(extractedRow.approved_by).toBeNull()

    expect(codeOf(() => inRules(ctx.t, (tx) => ctx.registry.activate(tx, extractedId, '')))).toBe('APPROVE_REQUIRED')
    expect(readRule(ctx.t, extractedId).state).toBe('proposed')
  })

  it('2. an inferred rule is technique-only and never becomes active', () => {
    const ctx = setup()
    expect(codeOf(() => inRules(ctx.t, (tx) => ctx.registry.register(tx, ruleInput(), 'inferred', 'system'))))
      .toBe('INFERRED_TECHNIQUE_ONLY')

    const inferredId = inRules(ctx.t, (tx) =>
      ctx.registry.register(tx, ruleInput({ layer: 'technique', then: 'draft' }), 'inferred', 'system'))
    const row = readRule(ctx.t, inferredId)
    expect(row.layer).toBe('technique')
    expect(row.state).toBe('proposed')
    expect(codeOf(() => inRules(ctx.t, (tx) => ctx.registry.activate(tx, inferredId, 'owner'))))
      .toBe('INFERRED_NEVER_ACTIVE')

    // 06 reading R-inferred: nothing inferred may sit outside technique or claim active.
    const outside = ctx.t.db.prepare(
      `SELECT count(*) AS n FROM sa_rule WHERE provenance = 'inferred' AND layer <> 'technique'`).get() as { n: number }
    const active = ctx.t.db.prepare(
      `SELECT count(*) AS n FROM sa_rule WHERE provenance = 'inferred' AND state = 'active'`).get() as { n: number }
    expect(outside.n).toBe(0)
    expect(active.n).toBe(0)
  })

  it('3. three same-scope same-conclusion extracted candidates merge into one weighted survivor', () => {
    const ctx = setup()
    const ids = [1, 2, 3].map(() => registerExtracted(ctx, { scope_path: 'local/~/code', then: 'draft' }))
    expect(new Set(ids).size).toBe(3)

    const merged = inRules(ctx.t, (tx) => ctx.registry.merge(tx, ids))
    expect(merged).toEqual([ids[0]])
    expect(readRule(ctx.t, ids[0]).weight).toBe(3)
    expect(readRule(ctx.t, ids[1]).state).toBe('retired')
    expect(readRule(ctx.t, ids[2]).state).toBe('retired')

    // Merging a lone candidate is a no-op, not an error.
    expect(inRules(ctx.t, (tx) => ctx.registry.merge(tx, [ids[0]]))).toEqual([])
  })

  it('4. the replay gate: 11 changed out of 100 fails, 10 passes, activation follows the report', () => {
    const ctx = setup()
    seedIntakes(ctx.t, [{ eta: 60, count: 10 }, { eta: 45, count: 1 }, { eta: 10, count: 89 }])

    const risky = registerExtracted(ctx, { when: { eta_bucket: { gte: 30 } }, then: 'deny' })
    const riskyReport = ctx.replay.run(risky, 'last100')
    expect(riskyReport.sample_size).toBe(100)
    expect(riskyReport.changed).toBe(11)
    expect(riskyReport.changed_ratio).toBeCloseTo(0.11, 10)
    expect(riskyReport.passed).toBe(false)
    expect(riskyReport.direction).toEqual([{ from: null, to: 'deny', count: 11 }])
    expect(codeOf(() => inRules(ctx.t, (tx) => ctx.registry.activate(tx, risky, 'owner')))).toBe('REPLAY_FAILED')
    expect(readRule(ctx.t, risky).state).toBe('proposed')

    const safe: RuleThen = 'deny'
    const safeId = registerExtracted(ctx, { when: { eta_bucket: { gte: 50 } }, then: safe })
    const safeReport = ctx.replay.run(safeId, 'last100')
    expect(safeReport.sample_size).toBe(100)
    expect(safeReport.changed).toBe(10)
    expect(safeReport.changed_ratio).toBeCloseTo(0.1, 10)
    expect(safeReport.passed).toBe(true)

    inRules(ctx.t, (tx) => ctx.registry.activate(tx, safeId, 'owner'))
    const activated = readRule(ctx.t, safeId)
    expect(activated.state).toBe('active')
    expect(activated.approved_by).toBe('owner')
    expect(activated.version).toBe(2)
    // 06 reading R-replay: every replayed rule leaves exactly one report row.
    expect(countRows(ctx.t, 'sa_rule_replay')).toBe(2)
  })

  it('5. config rules are never replayed and leave no replay row', () => {
    const ctx = setup()
    seedIntakes(ctx.t, [{ eta: 60, count: 20 }])
    const id = registerConfig(ctx, { when: { eta_bucket: { gte: 30 } }, then: 'deny' })
    const report = ctx.replay.run(id, 'last100')
    expect(report.sample_size).toBe(0)
    expect(report.changed).toBe(0)
    expect(countRows(ctx.t, 'sa_rule_replay')).toBe(0)
  })

  it('6. the 121st active rule is refused with RULE_BUDGET', () => {
    const ctx = setup()
    for (let i = 1; i <= 120; i += 1) {
      insertRawRule(ctx.t, `R-${i}`, { scope_path: `local/~/code/p${i}` })
    }
    expect(countRows(ctx.t, 'sa_rule')).toBe(120)
    expect(codeOf(() => registerConfig(ctx, { scope_path: 'local/~/code/one-more' }))).toBe('RULE_BUDGET')
    // A proposed rule does not consume the budget.
    expect(registerExtracted(ctx, { scope_path: 'local/~/code/proposed', then: 'draft' })).toBe('R-121')
  })

  it('7. a technique rule may never conclude allow, whatever sender class it names', () => {
    const ctx = setup()
    expect(codeOf(() => inRules(ctx.t, (tx) => ctx.registry.register(tx, ruleInput({
      layer: 'technique',
      when: { sender_class: { eq: 'colleague' }, capability: { eq: 'write_repo' } },
      then: 'allow',
    }), 'extracted', 'me')))).toBe('SELF_GRANT_FORBIDDEN')

    // Adding friction from the technique layer is allowed.
    const id = inRules(ctx.t, (tx) => ctx.registry.register(tx, ruleInput({
      layer: 'technique',
      when: { sender_class: { eq: 'colleague' }, capability: { eq: 'write_repo' } },
      then: 'draft',
    }), 'extracted', 'me'))
    expect(readRule(ctx.t, id).state).toBe('proposed')
  })

  it('8. checkConflicts writes the conflict rows and keeps both sides out of the snapshot', () => {
    const ctx = setup()
    const allow = registerConfig(ctx, { when: { sender_class: { eq: 'owner' } }, then: 'allow' })
    const deny = registerConfig(ctx, { when: { sender_class: { eq: 'owner' } }, then: 'deny' })
    const clean = registerConfig(ctx, { scope_path: 'netbird/pc-tower', when: { sender_class: { eq: 'colleague' } }, then: 'deny' })

    const result = inRules(ctx.t, (tx) => ctx.registry.checkConflicts(tx))
    expect(result.conflicts).toBe(1)
    expect(countRows(ctx.t, 'sa_rule_conflict')).toBe(1)
    const conflict = ctx.t.db.prepare(`SELECT rule_a, rule_b FROM sa_rule_conflict`).get() as { rule_a: string; rule_b: string }
    expect([conflict.rule_a, conflict.rule_b].sort()).toEqual([allow, deny].sort())

    const snapshotIds = ctx.registry.snapshot().map((row) => row.rule_id)
    expect(snapshotIds).toContain(clean)
    expect(snapshotIds).not.toContain(allow)
    expect(snapshotIds).not.toContain(deny)
    expect(ctx.registry.status().conflicts).toBe(1)
    expect(ctx.registry.status().loaded).toBe(1)

    // A row that no longer validates aborts the load: the previous snapshot stays
    // in place and the failure is reported instead of the bad row being dropped.
    ctx.t.db.prepare(`UPDATE sa_rule SET when_json = '{"mood":{"eq":"x"}}' WHERE rule_id = ?`).run(clean)
    const afterBreak = inRules(ctx.t, (tx) => ctx.registry.checkConflicts(tx))
    expect(afterBreak.conflicts).toBe(0)
    expect(ctx.registry.status().ok).toBe(false)
    expect(ctx.registry.status().error).toMatch(/PREDICATE_UNKNOWN/)
    expect(ctx.registry.snapshot().map((row) => row.rule_id)).toEqual([clean])
  })

  it('9. calibration holds below five samples, takes the median at five, and clamps at four', () => {
    const ctx = setup()
    const calibration = createCalibration()
    const day = new Date(ctx.t.clock.now()).toISOString().slice(0, 10)
    const recompute = (): { classes: number } => inRules(ctx.t, (tx) => calibration.recompute(tx, day))

    const seed = (actualMin: number): void => {
      seedClosedCommitment(ctx.t, { workClass: 'repo_change', etaModel: 1, actualMin, turns: 2 })
    }
    seed(1)
    seed(2)
    seed(2.1)
    seed(2.2)
    expect(recompute()).toEqual({ classes: 1 })
    let row = ctx.t.db.prepare(`SELECT * FROM sa_work_class WHERE class_id = 'repo_change'`).get() as
      { samples: number; eta_factor: number }
    expect(row.samples).toBe(4)
    expect(row.eta_factor).toBe(1)

    seed(3)
    recompute()
    row = ctx.t.db.prepare(`SELECT * FROM sa_work_class WHERE class_id = 'repo_change'`).get() as
      { samples: number; eta_factor: number }
    expect(row.samples).toBe(5)
    expect(row.eta_factor).toBeCloseTo(2.1, 10)

    // A median above the ceiling is clamped, not stored raw.
    for (let i = 0; i < 5; i += 1) {
      seedClosedCommitment(ctx.t, { workClass: 'release_notes', etaModel: 1, actualMin: 9, turns: 1 })
    }
    expect(recompute()).toEqual({ classes: 2 })
    const clamped = ctx.t.db.prepare(`SELECT eta_factor FROM sa_work_class WHERE class_id = 'release_notes'`)
      .get() as { eta_factor: number }
    expect(clamped.eta_factor).toBe(4)
  })

  it('10. autonomy promotes after five approvals across two days and demotes on the first rewrite', () => {
    const ctx = setup()
    const autonomy = createAutonomy()
    const dayOne = Date.UTC(2026, 0, 5, 10, 0, 0)
    const dayTwo = dayOne + DAY
    const apply = (kind: 'approved_as_is' | 'rejected' | 'rewritten', at: number): { strength: string; promoted: boolean; demoted: boolean } =>
      inRules(ctx.t, (tx) => autonomy.apply(tx, 'repo_change', 'write_repo', { kind, at }))

    let last = apply('approved_as_is', dayOne)
    for (let i = 2; i <= 5; i += 1) last = apply('approved_as_is', dayOne + i * 60_000)
    expect(last.strength).toBe('draft')
    expect(last.promoted).toBe(false)

    last = apply('approved_as_is', dayTwo)
    expect(last.promoted).toBe(true)
    expect(last.strength).toBe('allow')
    const promoted = ctx.t.db.prepare(
      `SELECT strength FROM sa_autonomy WHERE class_id = 'repo_change' AND capability = 'write_repo'`).get() as { strength: string }
    expect(promoted.strength).toBe('allow')

    const demoted = apply('rewritten', dayTwo + 60_000)
    expect(demoted.strength).toBe('draft')
    expect(demoted.demoted).toBe(true)
    expect(demoted.promoted).toBe(false)
  })

  it('11. a never-auto capability stays draft however many approvals it collects', () => {
    const ctx = setup()
    const autonomy = createAutonomy()
    const start = Date.UTC(2026, 0, 5, 9, 0, 0)
    let last = { strength: 'draft', promoted: false, demoted: false }
    for (let i = 0; i < 5; i += 1) {
      last = inRules(ctx.t, (tx) =>
        autonomy.apply(tx, 'release', 'publish', { kind: 'approved_as_is', at: start + i * DAY }))
    }
    expect(last.strength).toBe('draft')
    expect(last.promoted).toBe(false)
    const row = ctx.t.db.prepare(
      `SELECT strength, streak FROM sa_autonomy WHERE class_id = 'release' AND capability = 'publish'`).get() as
      { strength: string; streak: number }
    expect(row.strength).toBe('draft')
    expect(row.streak).toBe(5)
  })

  it('12. retireCandidates returns rules unhit for thirty days and leaves the twenty-nine-day rule alone', () => {
    const ctx = setup()
    const now = ctx.t.clock.now()
    const old = registerConfig(ctx, { scope_path: 'local/~/code/old' })
    const recent = registerConfig(ctx, { scope_path: 'local/~/code/recent' })
    ctx.t.db.prepare(`UPDATE sa_rule SET last_hit_at = ? WHERE rule_id = ?`).run(now - 30 * DAY, old)
    ctx.t.db.prepare(`UPDATE sa_rule SET last_hit_at = ? WHERE rule_id = ?`).run(now - 29 * DAY, recent)

    expect(ctx.registry.retireCandidates(now)).toEqual([old])
  })
})