/**
 * Calibration (T17): the technique layer's one auto-tuning mechanism, computed by
 * the host and never by the model (`06` "校准：技巧层的特例，全部由宿主算").
 *
 * The model cannot see or change these numbers: they are derived from closed
 * commitments and ended attempts, which are ledger facts. A class with too few
 * samples keeps its previous value instead of moving on noise.
 *
 * Updated here: sample count, `eta_factor` (median of actual/model minutes,
 * clamped 0.5-4, needs >= 5 samples), `p90_turns`, `misjudge_rate` plus
 * `ask_mode`, and `preferred_executor` (>= 4 ended attempts, >= 80% success).
 *
 * Deferred, on purpose: `pushback_mode`. "Overturned pushback" is a judgment
 * signal recorded by the timing module (05), which does not exist yet; inventing
 * a proxy from journal text would make the mute decision unauditable. The value
 * stays as stored until T10/T21 supplies the signal.
 */

import type { WorkClassRow } from '../protocol/objects.ts'
import { PHYSICAL, type LedgerTx } from '../protocol/db.ts'
import { RuleStoreError } from './registry.ts'

const WC = PHYSICAL.work_class
const C = PHYSICAL.commitment
const A = PHYSICAL.attempt
const AS = PHYSICAL.assumption

/** `06`: a class needs five paired samples before the factor moves. */
export const CALIBRATION_MIN_SAMPLES = 5
export const ETA_FACTOR_MIN = 0.5
export const ETA_FACTOR_MAX = 4
/** Executor preference needs at least this many ended attempts... */
export const EXECUTOR_MIN_ATTEMPTS = 4
/** ...and this success rate. */
export const EXECUTOR_MIN_SUCCESS = 0.8
export const MISJUDGE_ASK_THRESHOLD = 0.3
/** "近 5 次干净" window for returning to declare-first. */
export const RECENT_WINDOW = 5
/** Recent-sample window per class. */
export const SAMPLE_WINDOW = 100

export interface Calibration {
  recompute(tx: LedgerTx, day: string): { classes: number }
}

export interface CalibrationOptions {
  /** Executor tiers, lowest first. Without it, tie-breaking falls back to the executor name. */
  executorRank?: readonly string[]
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Nearest-rank percentile; deterministic for any sample size. */
export function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

export function clampEtaFactor(value: number): number {
  return Math.min(ETA_FACTOR_MAX, Math.max(ETA_FACTOR_MIN, value))
}

function endOfDayUtc(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RuleStoreError('RULE_MALFORMED', `day must be YYYY-MM-DD, got '${day}'`)
  const end = Date.parse(`${day}T23:59:59.999Z`)
  if (Number.isNaN(end)) throw new RuleStoreError('RULE_MALFORMED', `day '${day}' is not a calendar date`)
  return end
}

interface TimerSample { work_class: string; ratio: number; turns: number }
interface AttemptSample { work_class: string; executor: string; completed: boolean }
interface AssumptionSample { work_class: string; overturned: boolean }

export function createCalibration(options: CalibrationOptions = {}): Calibration {
  const rank = options.executorRank ?? []

  const rankOf = (executor: string): number => {
    const index = rank.indexOf(executor)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }

  return {
    recompute(tx, day) {
      const cutoff = endOfDayUtc(day)

      // 1. Timer samples: closed commitments that recorded both a model estimate and an actual.
      const timers = new Map<string, TimerSample[]>()
      for (const row of tx.all<{ work_class: string; eta_model_min: number; actual_min: number; used_turns: number }>(
        `SELECT work_class, eta_model_min, actual_min, used_turns FROM (
           SELECT work_class, eta_model_min, actual_min, used_turns, closed_at, commitment_id,
                  ROW_NUMBER() OVER (PARTITION BY work_class ORDER BY closed_at DESC, commitment_id DESC) AS rn
             FROM ${C}
            WHERE work_class IS NOT NULL AND actual_min IS NOT NULL AND eta_model_min IS NOT NULL
              AND eta_model_min > 0 AND closed_at IS NOT NULL AND closed_at <= ?
         ) WHERE rn <= ?`,
        cutoff, SAMPLE_WINDOW,
      )) {
        const list = timers.get(row.work_class)
        const sample = { work_class: row.work_class, ratio: row.actual_min / row.eta_model_min, turns: row.used_turns }
        if (list === undefined) timers.set(row.work_class, [sample])
        else list.push(sample)
      }

      // 2. Assumption outcomes feed misjudge_rate and the ask/declare switch.
      const assumptions = new Map<string, AssumptionSample[]>()
      for (const row of tx.all<{ work_class: string; status: string }>(
        `SELECT c.work_class AS work_class, a.status AS status
           FROM ${AS} a JOIN ${C} c ON c.commitment_id = a.commitment_id
          WHERE c.work_class IS NOT NULL
          ORDER BY a.rowid ASC`,
      )) {
        const list = assumptions.get(row.work_class)
        const sample = { work_class: row.work_class, overturned: row.status === 'overturned' }
        if (list === undefined) assumptions.set(row.work_class, [sample])
        else list.push(sample)
      }

      // 3. Ended attempts feed the executor preference.
      const attempts = new Map<string, AttemptSample[]>()
      for (const row of tx.all<{ work_class: string; executor: string; end_reason: string | null }>(
        `SELECT c.work_class AS work_class, a.executor AS executor, a.end_reason AS end_reason
           FROM ${A} a JOIN ${C} c ON c.commitment_id = a.commitment_id
          WHERE c.work_class IS NOT NULL AND a.state = 'ended'
          ORDER BY a.rowid ASC`,
      )) {
        const list = attempts.get(row.work_class)
        const sample = { work_class: row.work_class, executor: row.executor, completed: row.end_reason === 'completed' }
        if (list === undefined) attempts.set(row.work_class, [sample])
        else list.push(sample)
      }

      const classes = new Set<string>([...timers.keys(), ...assumptions.keys(), ...attempts.keys()])
      let written = 0
      for (const classId of [...classes].sort()) {
        const current = tx.get<WorkClassRow>(`SELECT * FROM ${WC} WHERE class_id = ?`, classId)
        const timerSamples = timers.get(classId) ?? []
        const assumptionSamples = assumptions.get(classId) ?? []
        const attemptSamples = attempts.get(classId) ?? []

        const enoughSamples = timerSamples.length >= CALIBRATION_MIN_SAMPLES
        const etaFactor = enoughSamples
          ? clampEtaFactor(median(timerSamples.map((sample) => sample.ratio)))
          : (current?.eta_factor ?? 1)
        const p90Turns = enoughSamples
          ? percentile(timerSamples.map((sample) => sample.turns), 0.9)
          : (current?.p90_turns ?? null)

        let misjudgeRate = current?.misjudge_rate ?? null
        let askMode = current?.ask_mode ?? 'declare'
        if (assumptionSamples.length > 0) {
          const overturned = assumptionSamples.filter((sample) => sample.overturned).length
          misjudgeRate = overturned / assumptionSamples.length
          const recent = assumptionSamples.slice(-RECENT_WINDOW)
          const recentClean = recent.length >= RECENT_WINDOW && !recent.some((sample) => sample.overturned)
          if (misjudgeRate >= MISJUDGE_ASK_THRESHOLD) askMode = 'ask'
          else if (recentClean) askMode = 'declare'
        }

        let preferredExecutor = current?.preferred_executor ?? null
        if (attemptSamples.length > 0) {
          const byExecutor = new Map<string, { attempts: number; completed: number }>()
          for (const sample of attemptSamples) {
            const bucket = byExecutor.get(sample.executor) ?? { attempts: 0, completed: 0 }
            bucket.attempts += 1
            if (sample.completed) bucket.completed += 1
            byExecutor.set(sample.executor, bucket)
          }
          const eligible = [...byExecutor.entries()]
            .filter(([, bucket]) => bucket.attempts >= EXECUTOR_MIN_ATTEMPTS
              && bucket.completed / bucket.attempts >= EXECUTOR_MIN_SUCCESS)
            .sort(([left, a], [right, b]) => {
              const byRank = rankOf(left) - rankOf(right)
              if (byRank !== 0) return byRank
              if (a.attempts !== b.attempts) return b.attempts - a.attempts
              return left < right ? -1 : left > right ? 1 : 0
            })
          if (eligible.length > 0) preferredExecutor = eligible[0][0]
        }

        tx.run(
          `INSERT INTO ${WC} (class_id, samples, eta_factor, ask_mode, pushback_mode, preferred_executor,
             misjudge_rate, p90_turns, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(class_id) DO UPDATE SET samples = excluded.samples, eta_factor = excluded.eta_factor,
             ask_mode = excluded.ask_mode, preferred_executor = excluded.preferred_executor,
             misjudge_rate = excluded.misjudge_rate, p90_turns = excluded.p90_turns, updated_at = excluded.updated_at`,
          classId,
          timerSamples.length,
          etaFactor,
          askMode,
          current?.pushback_mode ?? 'on',
          preferredExecutor,
          misjudgeRate,
          p90Turns,
          tx.now,
          tx.now,
        )
        written += 1
      }
      return { classes: written }
    },
  }
}