/**
 * Stop-loss lines (10, T19). Host-computed; the desk may only ask for a scale <= 4.
 *
 * wall  = clamp(eta x factor x 2.5, 5, 120) minutes x scale
 * turns = p90 known ? ceil(p90 x 1.5) : 12, x scale   (p90 is undefined below 12 samples)
 * Tokens are bookkeeping only and never appear here (G4).
 */

export interface Budget { wall_ms: number; turns: number }

export const MIN_WALL_MIN = 5
export const MAX_WALL_MIN = 120
export const DEFAULT_TURNS = 12
export const MAX_SCALE = 4
export const ONESHOT_WALL_MS = 10 * 60_000
/** A progress window; "two windows" is the stall and extension horizon. */
export const PROGRESS_WINDOW_MS = 5 * 60_000
/** An extension adds at most this share of the original line, once per commitment. */
export const EXTENSION_SHARE = 0.5

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function budget(etaMin: number, etaFactor: number, p90Turns: number | undefined, scale = 1): Budget {
  const s = clamp(Number.isFinite(scale) ? scale : 1, 0.25, MAX_SCALE)
  const wallMin = clamp(etaMin * etaFactor * 2.5, MIN_WALL_MIN, MAX_WALL_MIN)
  const turns = p90Turns === undefined ? DEFAULT_TURNS : Math.ceil(p90Turns * 1.5)
  return { wall_ms: Math.round(wallMin * 60_000 * s), turns: Math.ceil(turns * s) }
}

/** The extended line: original + at most 50%. */
export function extended(b: Budget): Budget {
  return { wall_ms: Math.round(b.wall_ms * (1 + EXTENSION_SHARE)), turns: Math.ceil(b.turns * (1 + EXTENSION_SHARE)) }
}

export type BudgetVerdict = 'ok' | 'extend' | 'stop'

/**
 * Over a line: extend once when the last two windows show progress (a new tool call
 * and a changing signature), otherwise stop. Under both lines: ok.
 */
export function judgeBudget(input: {
  now: number; startedAt: number; turns: number; line: Budget; alreadyExtended: boolean
  lastToolAt: number | null; repeatCount: number
}): BudgetVerdict {
  const over = input.now - input.startedAt >= input.line.wall_ms || input.turns >= input.line.turns
  if (!over) return 'ok'
  const progress = input.lastToolAt !== null && input.lastToolAt >= input.now - 2 * PROGRESS_WINDOW_MS && input.repeatCount < 3
  return progress && !input.alreadyExtended ? 'extend' : 'stop'
}
