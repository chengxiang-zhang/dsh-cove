/**
 * Rule replay (T17): the impact measurement a rule change must survive (`06`
 * "回放验证").
 *
 * The replay runs the SAME judgment entry point as the runtime — `evaluate` from
 * engine.ts — twice per historical event: once over the current snapshot and
 * once over the snapshot plus the candidate rule. Writing a second judging path
 * for the replay would measure something other than what will run, which is the
 * "回放自欺" failure the design names explicitly.
 *
 * Sample: the most recent 100 disposals (`intake.shadow = 0`), newest first. The
 * ledger does not store a rule's work class, so the class filter is optional
 * (`workClass`); the fixed part of the sample — "most recent 100" — is what the
 * hard gate depends on and is not tunable.
 *
 * Facts are reconstructed from the ledger: the desk's cwd is the judged scope and
 * path, the party row supplies the sender class, the desk supplies the audience
 * class, and the intake's predicted minutes back `eta_bucket`. Fields the ledger
 * does not record for an intake (capability, budget state, repo visibility, the
 * wall clock at judgment time) stay absent, so a rule conditioned on them cannot
 * fire on this sample — that is visible in the report rather than guessed.
 *
 * Gate: `changed_ratio` above 10% fails, and `activate` refuses a rule without a
 * passing report.
 */

import type { RuleRow, RuleThen } from '../protocol/objects.ts'
import { PHYSICAL, type LedgerTx } from '../protocol/db.ts'
import { evaluate } from './engine.ts'
import { parseWhen, type Facts, type ScopePath } from './predicates.ts'
import { RuleStoreError, type RuleTxSource } from './registry.ts'

const RP = PHYSICAL.rule_replay
const INTAKE = PHYSICAL.intake
const DESK = PHYSICAL.desk
const PARTY = PHYSICAL.party

/** The fixed sample size; "最近 100 条" is part of the gate, not a tuning knob. */
export const REPLAY_SAMPLE_SIZE = 100
/** `06` impact ceiling: more than one in ten historical conclusions changing fails the replay. */
export const REPLAY_MAX_CHANGED_RATIO = 0.1

/** An intake has no scope of its own; a deskless event is judged at the local root. */
export const REPLAY_DEFAULT_SCOPE: ScopePath = 'local/'

export interface ReplayEvent {
  scope: ScopePath
  subject: string
  facts: Facts
}

export interface ReplayDirection {
  from: RuleThen | null
  to: RuleThen | null
  count: number
}

export interface ReplayReport {
  sample_size: number
  changed: number
  changed_ratio: number
  passed: boolean
  direction: ReplayDirection[]
}

export interface Replay {
  run(ruleId: string, sample: 'last100', workClass?: string): ReplayReport
}

export type SampleProvider = (tx: LedgerTx, rule: RuleRow, limit: number, workClass?: string) => ReplayEvent[]

export interface ReplayOptions {
  /** Current rule set (the "old" arm). Defaults to the registry snapshot when wired by the host. */
  snapshot?: () => readonly RuleRow[]
  /** Overrides the ledger reconstruction, for hosts whose facts live elsewhere. */
  sample?: SampleProvider
}

interface IntakeSampleRow {
  event_id: string
  thread_key: string
  pred_eta_min: number | null
  created_at: number
  intake_rowid: number
  desk_cwd: string | null
  desk_audience: string | null
  sender_class: string | null
}

/**
 * Default reconstruction: the last `limit` formal disposals, newest first. The
 * desk join yields the scope/path and audience class, the party join yields the
 * sender class, and `prior_count` counts earlier events on the same thread.
 */
export const sampleFromIntakes: SampleProvider = (tx, _rule, limit, workClass) => {
  const rows = tx.all<IntakeSampleRow>(
    `SELECT i.event_id AS event_id, i.thread_key AS thread_key, i.pred_eta_min AS pred_eta_min,
            i.created_at AS created_at, i.rowid AS intake_rowid,
            d.cwd AS desk_cwd, d.audience_class AS desk_audience, p.class AS sender_class
       FROM ${INTAKE} i
       LEFT JOIN ${DESK} d ON d.desk_id = i.desk_id
       LEFT JOIN ${PARTY} p ON p.party_id = i.sender
      WHERE i.shadow = 0${workClass === undefined ? '' : ' AND i.class = ?'}
      ORDER BY i.created_at DESC, i.rowid DESC
      LIMIT ?`,
    ...(workClass === undefined ? [limit] : [workClass, limit]),
  )
  return rows.map((row) => {
    const facts: Facts = {
      prior_count: tx.get<{ n: number }>(
        `SELECT count(*) AS n FROM ${INTAKE}
          WHERE thread_key = ? AND shadow = 0
            AND (created_at < ? OR (created_at = ? AND rowid < ?))`,
        row.thread_key, row.created_at, row.created_at, row.intake_rowid)?.n ?? 0,
    }
    if (row.sender_class !== null) facts.sender_class = row.sender_class
    if (row.desk_audience !== null) facts.audience_class = row.desk_audience
    if (row.desk_cwd !== null) facts.path = row.desk_cwd
    if (row.pred_eta_min !== null) facts.eta_minutes = row.pred_eta_min
    return { scope: row.desk_cwd ?? REPLAY_DEFAULT_SCOPE, subject: row.event_id, facts }
  })
}

const EMPTY_REPORT: ReplayReport = { sample_size: 0, changed: 0, changed_ratio: 0, passed: true, direction: [] }

function directionKey(from: RuleThen | null, to: RuleThen | null): string {
  return `${from ?? 'null'}>${to ?? 'null'}`
}

export function createReplay(source: RuleTxSource, options: ReplayOptions = {}): Replay {
  const sample = options.sample ?? sampleFromIntakes
  const snapshotOf = options.snapshot ?? (() => [])

  return {
    run(ruleId, kind, workClass) {
      if (kind !== 'last100') throw new RuleStoreError('RULE_MALFORMED', `unknown replay sample '${String(kind)}'`)
      return source.open((tx) => {
        const rule = tx.get<RuleRow>(`SELECT * FROM ${PHYSICAL.rule} WHERE rule_id = ?`, ruleId)
        if (rule === undefined) throw new RuleStoreError('RULE_MISSING', `rule ${ruleId}`)
        if (rule.provenance === 'config') return { ...EMPTY_REPORT, direction: [] }
        parseWhen(rule.when_json)

        const rules = snapshotOf()
        const before = rules.filter((row) => row.rule_id !== ruleId)
        const after = [...before, { ...rule, state: 'active' as const }]
        const events = sample(tx, rule, REPLAY_SAMPLE_SIZE, workClass)

        let changed = 0
        const buckets = new Map<string, ReplayDirection>()
        for (const event of events) {
          const old = evaluate(before, event.scope, event.subject, event.facts).then
          const next = evaluate(after, event.scope, event.subject, event.facts).then
          if (old === next) continue
          changed += 1
          const key = directionKey(old, next)
          const bucket = buckets.get(key)
          if (bucket === undefined) buckets.set(key, { from: old, to: next, count: 1 })
          else bucket.count += 1
        }
        const direction = [...buckets.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([, value]) => value)
        const changedRatio = events.length === 0 ? 0 : changed / events.length
        const passed = changedRatio <= REPLAY_MAX_CHANGED_RATIO

        const ordinal = (tx.get<{ n: number }>(
          `SELECT count(*) AS n FROM ${RP} WHERE rule_id = ?`, ruleId)?.n ?? 0) + 1
        tx.run(
          `INSERT INTO ${RP} (replay_id, rule_id, sample_size, changed, changed_ratio, direction_json, passed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          `RP:${ruleId}:${ordinal}`,
          ruleId,
          events.length,
          changed,
          changedRatio,
          JSON.stringify(direction),
          passed ? 1 : 0,
          tx.now,
        )
        return { sample_size: events.length, changed, changed_ratio: changedRatio, passed, direction }
      }, { module: 'rules' })
    },
  }
}
