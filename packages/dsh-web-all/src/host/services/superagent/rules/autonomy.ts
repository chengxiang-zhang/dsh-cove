/**
 * Autonomy (T17): the only sanctioned way for a `(work class x capability)` cell
 * to climb from draft to allow, and the only way it falls back (`06` "自动度").
 *
 * Promotion needs evidence, demotion needs nothing: five consecutive
 * `approved_as_is` outcomes spread over at least two calendar days promote the
 * cell; a single rejected, rewritten or stopped outcome drops it back to draft on
 * the spot, keeps the record, and notifies nobody. The ceiling is closed: the
 * capabilities in `NEVER_AUTO_CAPABILITIES` (change_prod, publish,
 * commit_promise) can never be promoted here, and the DDL refuses such a row even
 * if this code were wrong.
 *
 * Days are UTC calendar days. The host may pass `at` from local midnight if the
 * product wants local days; UTC keeps the decision reproducible in a test.
 */

import {
  CAPABILITIES,
  NEVER_AUTO_CAPABILITIES,
  parseEnum,
  type AutonomyRow,
  type Capability,
  type Strength,
} from '../protocol/objects.ts'
import { PHYSICAL, type LedgerTx } from '../protocol/db.ts'
import { RuleStoreError } from './registry.ts'

const AU = PHYSICAL.autonomy

/** Five consecutive approvals... */
export const PROMOTE_STREAK = 5
/** ...spread over at least two distinct calendar days. */
export const PROMOTE_DAYS = 2
export const NEVER_AUTO: readonly string[] = NEVER_AUTO_CAPABILITIES

export type AutonomyEvidenceKind = 'approved_as_is' | 'rejected' | 'rewritten' | 'stopped'

export interface AutonomyEvidence {
  kind: AutonomyEvidenceKind
  /** Epoch milliseconds of the evidence; its UTC day is what the streak counts. */
  at: number
}

export interface AutonomyResult {
  strength: Strength
  demoted: boolean
  promoted: boolean
}

export interface Autonomy {
  apply(tx: LedgerTx, classId: string, capability: Capability, evidence: AutonomyEvidence): AutonomyResult
}

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

function parseDays(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const decoded = JSON.parse(raw) as unknown
    return Array.isArray(decoded) ? decoded.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

export function createAutonomy(): Autonomy {
  return {
    apply(tx, classId, capability, evidence) {
      if (typeof classId !== 'string' || classId.length === 0) {
        throw new RuleStoreError('RULE_MALFORMED', 'autonomy needs a work class id')
      }
      const cap = parseEnum(CAPABILITIES, capability)
      if (cap === undefined) throw new RuleStoreError('RULE_MALFORMED', `unknown capability '${String(capability)}'`)
      if (!Number.isFinite(evidence.at)) throw new RuleStoreError('RULE_MALFORMED', 'evidence.at must be epoch milliseconds')

      const current = tx.get<AutonomyRow>(`SELECT * FROM ${AU} WHERE class_id = ? AND capability = ?`, classId, cap)
      const base = {
        strength: (current?.strength ?? 'draft') as Strength,
        streak: current?.streak ?? 0,
        days: parseDays(current?.streak_days_json ?? null),
        demotedAt: current?.demoted_at ?? null,
      }

      if (evidence.kind === 'approved_as_is') {
        const streak = base.streak + 1
        const days = [...new Set([...base.days, dayKey(evidence.at)])]
        const neverAuto = NEVER_AUTO.includes(cap)
        // The ceiling wins over any streak: a never-auto capability stays closed.
        let strength: Strength = neverAuto && base.strength === 'allow' ? 'draft' : base.strength
        let promoted = false
        if (!neverAuto && strength !== 'allow' && streak >= PROMOTE_STREAK && days.length >= PROMOTE_DAYS) {
          strength = 'allow'
          promoted = true
        }
        tx.run(
          `INSERT INTO ${AU} (class_id, capability, strength, streak, streak_days_json, demoted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(class_id, capability) DO UPDATE SET strength = excluded.strength, streak = excluded.streak,
             streak_days_json = excluded.streak_days_json, demoted_at = excluded.demoted_at, updated_at = excluded.updated_at`,
          classId, cap, strength, streak, JSON.stringify(days), base.demotedAt, tx.now, tx.now,
        )
        return { strength, demoted: false, promoted }
      }

      // Any rejected / rewritten / stopped evidence: back to draft, immediately, silently.
      const demoted = base.strength !== 'draft'
      tx.run(
        `INSERT INTO ${AU} (class_id, capability, strength, streak, streak_days_json, demoted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(class_id, capability) DO UPDATE SET strength = excluded.strength, streak = excluded.streak,
           streak_days_json = excluded.streak_days_json, demoted_at = excluded.demoted_at, updated_at = excluded.updated_at`,
        classId, cap, 'draft', 0, '[]', evidence.at, tx.now, tx.now,
      )
      return { strength: 'draft', demoted, promoted: false }
    },
  }
}