/**
 * Rule registry (T17): the only writer of the rule tables (`06` "三条注册通路").
 *
 * The model never writes rules; it can only propose. Three provenances, three
 * outcomes:
 *   config    -> active immediately; the constitution layer exists only here and
 *                only when `owner` is the approver.
 *   extracted -> proposed; `activate` needs an approver AND a passing replay.
 *   inferred  -> proposed forever and technique-only (NEEDS-DECISION N21, read
 *                stricter than `06`'s technique auto-activation: auto-tuning lands
 *                through calibration and autonomy, never through an inferred row).
 *
 * Guards that live here rather than in the caller: the 120-active-rule budget,
 * the self-grant ban (a technique rule may never conclude `allow`; expansion goes
 * through `Autonomy.apply`), the replay gate at activation, and the conflict
 * sweep that keeps the snapshot consistent.
 *
 * Load discipline: a malformed row is never silently dropped. Validation failure
 * of any row aborts the whole load and the previous snapshot stays in place
 * (`06` failure mode); rows that violate a table invariant (an inferred row that
 * claims active, a constitution rule nobody owns) are excluded and counted.
 *
 * Snapshot contract: a snapshot holds every validated row, whatever its state —
 * `evaluate` skips non-active rows by itself, so the snapshot can be handed to
 * the engine unchanged. Publication happens inside the caller's transaction:
 * call `checkConflicts`/`reload` in a transaction that will commit (startup), or
 * call it again after a rollback. The snapshot is a cache of the table, never a
 * second source of truth.
 *
 * Pure store module: it depends on the protocol, the predicate layer and its own
 * module only. It never imports the kernel; the ledger transaction arrives as
 * `LedgerTx`.
 */

import {
  PROVENANCES,
  RULE_LAYERS,
  RULE_PREDICATES,
  parseEnum,
  type Provenance,
  type RuleLayer,
  type RuleRow,
  type RuleThen,
} from '../protocol/objects.ts'
import { PHYSICAL, type LedgerReader, type LedgerTx, type OwnerModule } from '../protocol/db.ts'
import { findConflicts } from './conflict.ts'
import { readRuleEnums } from './engine.ts'
import { parseThen, parseWhen, type When } from './predicates.ts'
import { createRuleSnapshot, type RuleSnapshot } from './snapshot.ts'

const R = PHYSICAL.rule
const RP = PHYSICAL.rule_replay
const RC = PHYSICAL.rule_conflict
const DAY_MS = 86_400_000

/** `06` hard cap: the rule table rots faster than code because it has no compiler. */
export const MAX_ACTIVE_RULES = 120
/** A rule with no hit for this long is a retirement candidate. */
export const RETIRE_AFTER_MS = 30 * DAY_MS

export type RuleStoreErrorCode =
  | 'RULE_BUDGET'
  | 'SELF_GRANT_FORBIDDEN'
  | 'REPLAY_FAILED'
  | 'RULE_CONFLICT'
  | 'RULE_MISSING'
  | 'APPROVE_REQUIRED'
  | 'CONSTITUTION_OWNER_ONLY'
  | 'INFERRED_TECHNIQUE_ONLY'
  | 'INFERRED_NEVER_ACTIVE'
  | 'RULE_MALFORMED'

export class RuleStoreError extends Error {
  readonly code: RuleStoreErrorCode

  constructor(code: RuleStoreErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'RuleStoreError'
    this.code = code
  }
}

/** A ledger that can open a write transaction. Satisfied by the kernel `Ledger`, never imported from it. */
export interface RuleTxSource {
  open<T>(fn: (tx: LedgerTx) => T, opts?: { module?: OwnerModule }): T
  read: LedgerReader
}

export interface RuleInput {
  scope_path: string
  layer: RuleLayer
  /** Parsed predicates or the raw `when` JSON. Unknown predicates raise PREDICATE_UNKNOWN. */
  when: When | string
  then: RuleThen
  /** Explicit exceptions; each beats the rule body when it matches. */
  exceptions?: { when: When | string; then: RuleThen }[]
  priority?: number
  rollback_if?: string | null
  weight?: number | null
}

/** Outcome of the last full load; the loud channel for "the table is broken, using the old snapshot". */
export interface RuleLoadStatus {
  ok: boolean
  loaded: number
  /** Rows left out of the snapshot because they conflict; they are written to sa_rule_conflict. */
  conflicting: number
  /** Rows that violate a table invariant (N21 and the three DDL CHECKs) and are never loaded. */
  blocked: number
  conflicts: number
  error?: string
}

export interface RuleRegistry {
  register(tx: LedgerTx, rule: RuleInput, provenance: Provenance, by: string): string
  merge(tx: LedgerTx, candidateIds: string[]): string[]
  checkConflicts(tx: LedgerTx): { conflicts: number }
  snapshot(): readonly RuleRow[]
  activate(tx: LedgerTx, ruleId: string, approvedBy: string): void
  retireCandidates(now: number): string[]
  /** Republish the snapshot without writing conflict rows (host post-commit hook). */
  reload(tx: LedgerTx): RuleLoadStatus
  status(): RuleLoadStatus
}

const IDLE: RuleLoadStatus = { ok: true, loaded: 0, conflicting: 0, blocked: 0, conflicts: 0 }

function activeCount(tx: LedgerTx): number {
  return tx.get<{ n: number }>(`SELECT count(*) AS n FROM ${R} WHERE state = 'active'`)?.n ?? 0
}

function ruleOf(tx: LedgerTx, ruleId: string): RuleRow {
  const row = tx.get<RuleRow>(`SELECT * FROM ${R} WHERE rule_id = ?`, ruleId)
  if (row === undefined) throw new RuleStoreError('RULE_MISSING', `rule ${ruleId}`)
  return row
}

/** Validates `exceptions_json`; the engine parses the same shape at judgment time. */
function validateExceptions(row: RuleRow): { when: When; then: RuleThen }[] {
  if (row.exceptions_json === null) return []
  let decoded: unknown
  try {
    decoded = JSON.parse(row.exceptions_json) as unknown
  } catch {
    throw new RuleStoreError('RULE_MALFORMED', `${row.rule_id}: exceptions_json is not JSON`)
  }
  if (!Array.isArray(decoded)) throw new RuleStoreError('RULE_MALFORMED', `${row.rule_id}: exceptions_json must be an array`)
  return decoded.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new RuleStoreError('RULE_MALFORMED', `${row.rule_id}: exception ${index} must be an object`)
    }
    const record = item as Record<string, unknown>
    return { when: parseWhen(record.when), then: parseThen(record.then, `${row.rule_id} exception ${index}`) }
  })
}

/**
 * The four table invariants, checked on load. A row that violates one is never
 * loaded (N21 reads `inferred stays proposed` stricter than the auto-activation
 * sentence), and the DDL repeats the same CHECKs as the last line.
 */
function violatesInvariants(row: RuleRow): boolean {
  if (row.provenance === 'inferred' && (row.state === 'active' || row.layer !== 'technique')) return true
  if (row.layer === 'constitution' && row.approved_by !== 'owner') return true
  if (row.provenance === 'extracted' && row.state === 'active' && row.approved_by === null) return true
  return false
}

/** Canonical `when` text for the `merge` synonym check; key order must not matter. */
function canonicalWhen(when: When): string {
  return JSON.stringify(RULE_PREDICATES.filter((predicate) => when[predicate] !== undefined)
    .map((predicate) => [predicate, when[predicate]]))
}

function describeCell(when: When): string {
  const parts: string[] = []
  if (when.sender_class !== undefined) parts.push(`sender_class=${JSON.stringify(when.sender_class)}`)
  if (when.capability !== undefined) parts.push(`capability=${JSON.stringify(when.capability)}`)
  return parts.length === 0 ? 'unconditional' : parts.join(' ')
}

export function createRuleRegistry(source: RuleTxSource): RuleRegistry {
  const snapshot: RuleSnapshot = createRuleSnapshot()
  let status: RuleLoadStatus = { ...IDLE }

  /** Reads and validates the whole table; throws on a malformed row so the caller keeps the old snapshot. */
  function readValidRows(tx: LedgerTx): { rows: RuleRow[]; blocked: number } {
    const rows: RuleRow[] = []
    let blocked = 0
    for (const row of tx.all<RuleRow>(`SELECT * FROM ${R} ORDER BY rule_id`)) {
      readRuleEnums(row)
      parseWhen(row.when_json)
      validateExceptions(row)
      if (violatesInvariants(row)) {
        blocked += 1
        continue
      }
      rows.push(row)
    }
    return { rows, blocked }
  }

  interface PublishResult {
    status: RuleLoadStatus
    conflicts: { rule_a: string; rule_b: string; detail: string }[]
  }

  /** Adopts a snapshot from validated rows, excluding both sides of every conflict. */
  function publish(tx: LedgerTx): PublishResult {
    let valid: { rows: RuleRow[]; blocked: number }
    try {
      valid = readValidRows(tx)
    } catch (error) {
      // Fall back to the last good snapshot; the status is the loud channel.
      status = { ...status, ok: false, error: error instanceof Error ? error.message : String(error) }
      return { status, conflicts: [] }
    }
    const conflicts = findConflicts(valid.rows)
    const conflicting = new Set<string>()
    for (const conflict of conflicts) {
      conflicting.add(conflict.rule_a)
      conflicting.add(conflict.rule_b)
    }
    const adopted = valid.rows.filter((row) => !conflicting.has(row.rule_id))
    snapshot.adopt(adopted)
    status = {
      ok: true,
      loaded: adopted.length,
      conflicting: conflicting.size,
      blocked: valid.blocked,
      conflicts: conflicts.length,
    }
    return { status, conflicts }
  }

  function nextRuleId(tx: LedgerTx): string {
    const max = tx.get<{ m: number | null }>(
      `SELECT max(CAST(substr(rule_id, 3) AS INTEGER)) AS m FROM ${R} WHERE rule_id LIKE 'R-%'`)?.m ?? 0
    return `R-${max + 1}`
  }

  function assertBudget(tx: LedgerTx, becomesActive: boolean): void {
    if (!becomesActive) return
    if (activeCount(tx) >= MAX_ACTIVE_RULES) {
      throw new RuleStoreError('RULE_BUDGET', `active rules already at the cap of ${MAX_ACTIVE_RULES}`)
    }
  }

  return {
    register(tx, input, provenance, by) {
      const prov = parseEnum(PROVENANCES, provenance)
      if (prov === undefined) throw new RuleStoreError('RULE_MALFORMED', `unknown provenance '${String(provenance)}'`)
      const layer = parseEnum(RULE_LAYERS, input.layer)
      if (layer === undefined) throw new RuleStoreError('RULE_MALFORMED', `unknown layer '${String(input.layer)}'`)
      const then = parseThen(input.then, 'register')
      const when = parseWhen(input.when)
      const priority = input.priority ?? 0
      if (!Number.isFinite(priority)) throw new RuleStoreError('RULE_MALFORMED', 'priority must be a finite number')
      const exceptions = input.exceptions?.map((exception, index) => ({
        when: parseWhen(exception.when),
        then: parseThen(exception.then, `register exception ${index}`),
      })) ?? []

      if (prov === 'inferred' && layer !== 'technique') {
        throw new RuleStoreError('INFERRED_TECHNIQUE_ONLY',
          `inferred rules are technique-only, got ${layer} (NEEDS-DECISION N21)`)
      }
      // A technique rule may never conclude allow: widening authority is the
      // autonomy gradient's job, and the rule engine must not be a shortcut.
      if (layer === 'technique' && then === 'allow') {
        throw new RuleStoreError('SELF_GRANT_FORBIDDEN',
          `technique rule may not conclude allow (${describeCell(when)})`)
      }
      const active = prov === 'config'
      if (active && layer === 'constitution' && by !== 'owner') {
        throw new RuleStoreError('CONSTITUTION_OWNER_ONLY', `constitution rules are owner-written, got '${by}'`)
      }
      assertBudget(tx, active)

      const ruleId = nextRuleId(tx)
      tx.run(
        `INSERT INTO ${R} (rule_id, scope_path, layer, when_json, "then", exceptions_json, priority, provenance,
          version, state, approved_by, rollback_if, weight, hits, last_hit_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ruleId,
        input.scope_path,
        layer,
        JSON.stringify(when),
        then,
        exceptions.length === 0 ? null : JSON.stringify(exceptions),
        priority,
        prov,
        1,
        active ? 'active' : 'proposed',
        active ? by : null,
        input.rollback_if ?? null,
        input.weight ?? null,
        0,
        null,
        tx.now,
        tx.now,
      )
      return ruleId
    },

    merge(tx, candidateIds) {
      if (candidateIds.length < 2) return []
      const rows = candidateIds.map((id) => ruleOf(tx, id))
      for (const row of rows) {
        if (row.provenance !== 'extracted') {
          throw new RuleStoreError('RULE_MALFORMED', `merge accepts extracted candidates only, ${row.rule_id} is ${row.provenance}`)
        }
      }
      const groups = new Map<string, RuleRow[]>()
      for (const row of rows) {
        const key = [row.scope_path, row.layer, row.then, row.priority, canonicalWhen(parseWhen(row.when_json))].join('\u0000')
        const group = groups.get(key)
        if (group === undefined) groups.set(key, [row])
        else group.push(row)
      }
      const survivors: string[] = []
      for (const group of groups.values()) {
        if (group.length < 2) continue
        group.sort((a, b) => (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0))
        const [survivor, ...retired] = group
        const weight = group.reduce((sum, row) => sum + (row.weight ?? 1), 0)
        tx.run(`UPDATE ${R} SET weight = ?, updated_at = ? WHERE rule_id = ?`, weight, tx.now, survivor.rule_id)
        for (const row of retired) {
          tx.run(`UPDATE ${R} SET state = 'retired', updated_at = ? WHERE rule_id = ?`, tx.now, row.rule_id)
        }
        survivors.push(survivor.rule_id)
      }
      return survivors.sort()
    },

    checkConflicts(tx) {
      const published = publish(tx)
      if (!published.status.ok) return { conflicts: 0 }
      for (const conflict of published.conflicts) {
        tx.run(
          `INSERT INTO ${RC} (conflict_id, rule_a, rule_b, detail, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(conflict_id) DO UPDATE SET detail = excluded.detail, updated_at = excluded.updated_at`,
          `RC:${conflict.rule_a}:${conflict.rule_b}`,
          conflict.rule_a,
          conflict.rule_b,
          conflict.detail,
          tx.now,
          tx.now,
        )
      }
      return { conflicts: published.conflicts.length }
    },

    reload(tx) {
      return publish(tx).status
    },

    status() {
      return status
    },

    snapshot() {
      return snapshot.current()
    },

    activate(tx, ruleId, approvedBy) {
      if (typeof approvedBy !== 'string' || approvedBy.length === 0) {
        throw new RuleStoreError('APPROVE_REQUIRED', `activating ${ruleId} needs a named approver`)
      }
      const row = ruleOf(tx, ruleId)
      const enums = readRuleEnums(row)
      parseWhen(row.when_json)
      validateExceptions(row)
      if (enums.provenance === 'inferred') {
        throw new RuleStoreError('INFERRED_NEVER_ACTIVE',
          `${ruleId} is inferred; it can never become active (NEEDS-DECISION N21)`)
      }
      if (enums.state === 'active') return
      if (enums.provenance === 'extracted') {
        const replay = tx.get<{ passed: 0 | 1 }>(
          `SELECT passed FROM ${RP} WHERE rule_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, ruleId)
        if (replay === undefined) {
          throw new RuleStoreError('REPLAY_FAILED', `${ruleId} has no replay report; 06 requires one before activation`)
        }
        if (replay.passed !== 1) {
          throw new RuleStoreError('REPLAY_FAILED', `${ruleId} failed its replay; the impact ceiling is 10%`)
        }
      }
      assertBudget(tx, true)
      tx.run(`UPDATE ${R} SET state = 'active', approved_by = ?, version = version + 1, updated_at = ? WHERE rule_id = ?`,
        approvedBy, tx.now, ruleId)
    },

    retireCandidates(now) {
      const cutoff = now - RETIRE_AFTER_MS
      const rows = source.read.all<RuleRow>(
        `SELECT * FROM ${R} WHERE state = 'active' AND coalesce(last_hit_at, created_at) <= ? ORDER BY rule_id`, cutoff)
      return rows.map((row) => row.rule_id)
    },
  }
}

/** The module name the host must pass when opening the write transaction. */
export const RULE_MODULE: OwnerModule = 'rules'