/**
 * The secretary's own empty-running guard (09 防空跑, G9).
 *
 * An empty turn — one that costs a model round and produces no operation — is a
 * system fault, not news. So this module only ever answers questions: it never
 * proposes a message, and `tighten` returning true is deliberately silent outside
 * `status` and the brief.
 *
 * Three readings, all from the ledger:
 *
 * - turns today against the daily cap (default 200): over the cap only host
 *   templates and fast paths remain.
 * - the share of turns in the last day that produced no operation: over thirty
 *   percent is empty running.
 * - tightening means raising the signal threshold and pushing the next look time
 *   out, which the caller applies; this guard only reports the verdict.
 */

import type { LedgerReader } from '../protocol/db.ts'
import { PHYSICAL } from '../protocol/db.ts'

/** Daily secretary turn cap (09: 每日秘书回合上限，默认 200). */
export const TURNS_PER_DAY_CAP = 200
/** Empty-turn share above which the guard tightens (09: >30% 自愈). */
export const IDLE_RATE_THRESHOLD = 0.3
/** Window for the empty-running reading. */
export const IDLE_WINDOW_MS = 24 * 3_600_000

export interface IdleGuard {
  turnsToday(now: number): number
  overCap(now: number): boolean
  idleRate24h(now: number): number
  tighten(now: number): boolean
}

/** Local midnight for the desk's local day; the cap is a calendar-day reading. */
export function localMidnight(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function createIdleGuard(deps: {
  read: LedgerReader
  capPerDay?: number
  threshold?: number
}): IdleGuard {
  const cap = deps.capPerDay ?? TURNS_PER_DAY_CAP
  const threshold = deps.threshold ?? IDLE_RATE_THRESHOLD
  const read = deps.read

  function turnsSince(since: number): number {
    const row = read.get<{ c: number }>(
      `SELECT count(*) AS c FROM ${PHYSICAL.deliberation} WHERE created_at >= ?`,
      since,
    )
    return row?.c ?? 0
  }

  return {
    turnsToday(now) {
      return turnsSince(localMidnight(now))
    },

    overCap(now) {
      return turnsSince(localMidnight(now)) >= cap
    },

    idleRate24h(now) {
      const total = read.get<{ c: number }>(
        `SELECT count(*) AS c FROM ${PHYSICAL.deliberation} WHERE created_at >= ?`,
        now - IDLE_WINDOW_MS,
      )?.c ?? 0
      if (total === 0) return 0
      const idle = read.get<{ c: number }>(
        `SELECT count(*) AS c FROM ${PHYSICAL.deliberation} WHERE created_at >= ? AND ops = 0`,
        now - IDLE_WINDOW_MS,
      )?.c ?? 0
      return idle / total
    },

    tighten(now) {
      const total = read.get<{ c: number }>(
        `SELECT count(*) AS c FROM ${PHYSICAL.deliberation} WHERE created_at >= ?`,
        now - IDLE_WINDOW_MS,
      )?.c ?? 0
      if (total === 0) return false
      const idle = read.get<{ c: number }>(
        `SELECT count(*) AS c FROM ${PHYSICAL.deliberation} WHERE created_at >= ? AND ops = 0`,
        now - IDLE_WINDOW_MS,
      )?.c ?? 0
      return idle / total > threshold
    },
  }
}
