/**
 * Rule engine: one deterministic judgment over the three layers (`06`).
 *
 * Resolution order, reproducible by construction:
 *   exception over body -> longer scope_path -> higher layer
 *   (constitution > policy > technique) -> higher priority
 *   -> still tied with different conclusions: RULE_CONFLICT.
 *
 * Runtime never answers "it depends": an unresolved tie is an error, because a
 * real tie should have been blocked at startup by conflict.ts. Every call
 * returns the full hit chain so `deliberation.rule_trace` is never empty
 * (reading R-trace) and "why did it not ask me" has one answer.
 *
 * Only `state='active'` rules take part. An `inferred` row never does, even when
 * it claims to be active: NEEDS-DECISION N21 reads `06`'s "inferred stays
 * proposed" stricter than the technique auto-activation sentence, and the T04
 * DDL CHECK should have rejected such a row already. This is the pure layer of
 * that promise; auto-tuning lands through calibration and autonomy, never
 * through an inferred rule row.
 *
 * Pure module: protocol plus predicates.ts, no kernel, no ledger, no clock.
 */

import {
  PROVENANCES,
  RULE_LAYERS,
  RULE_STATES,
  parseEnum,
  type Provenance,
  type RuleLayer,
  type RuleRow,
  type RuleState,
  type RuleThen,
} from '../protocol/objects.ts'
import {
  RuleError,
  isScopePrefix,
  matches,
  parseThen,
  parseWhen,
  scopeSegments,
  type Facts,
  type ScopePath,
  type When,
} from './predicates.ts'

export interface RuleTrace {
  /** Every rule that contributed an outcome, exception first, then by rule_id. */
  candidates: string[]
  winner?: string
  reason: 'exception' | 'longer_scope' | 'layer' | 'priority' | 'only' | 'none'
  layer?: RuleLayer
}

/** Layer authority from `06`; higher wins. Kept as data so the order is testable. */
export const LAYER_RANK: Readonly<Record<RuleLayer, number>> = {
  constitution: 3,
  policy: 2,
  technique: 1,
}

/** Validated enum and scalar fields of a rule row. */
export interface RuleEnums {
  state: RuleState
  provenance: Provenance
  layer: RuleLayer
  then: RuleThen
  priority: number
}

/**
 * Reads the row against the closed sets. An unknown value is a failure, not a
 * guess (02: enum drift is handled as failure) — silently skipping a row with a
 * misspelled layer would drop a boundary without telling anyone.
 */
export function readRuleEnums(rule: RuleRow): RuleEnums {
  const state = parseEnum(RULE_STATES, rule.state)
  if (state === undefined) throw new RuleError('RULE_MALFORMED', `${rule.rule_id}: unknown state '${String(rule.state)}'`)
  const provenance = parseEnum(PROVENANCES, rule.provenance)
  if (provenance === undefined) {
    throw new RuleError('RULE_MALFORMED', `${rule.rule_id}: unknown provenance '${String(rule.provenance)}'`)
  }
  const layer = parseEnum(RULE_LAYERS, rule.layer)
  if (layer === undefined) throw new RuleError('RULE_MALFORMED', `${rule.rule_id}: unknown layer '${String(rule.layer)}'`)
  const then = parseThen(rule.then, rule.rule_id)
  if (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority)) {
    throw new RuleError('RULE_MALFORMED', `${rule.rule_id}: priority must be a finite number`)
  }
  return { state, provenance, layer, then, priority: rule.priority }
}

interface Outcome {
  ruleId: string
  then: RuleThen
  isException: boolean
  depth: number
  rank: number
  priority: number
  layer: RuleLayer
}

interface ExceptionOutcome {
  when: When
  then: RuleThen
}

function parseExceptions(rule: RuleRow): ExceptionOutcome[] {
  const raw = rule.exceptions_json
  if (raw === null) return []
  let decoded: unknown
  try {
    decoded = JSON.parse(raw) as unknown
  } catch {
    throw new RuleError('RULE_MALFORMED', `${rule.rule_id}: exceptions_json is not JSON`)
  }
  if (!Array.isArray(decoded)) {
    throw new RuleError('RULE_MALFORMED', `${rule.rule_id}: exceptions_json must be an array`)
  }
  return decoded.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new RuleError('RULE_MALFORMED', `${rule.rule_id}: exception ${index} must be an object`)
    }
    const record = item as Record<string, unknown>
    return {
      when: parseWhen(record.when),
      then: parseThen(record.then, `${rule.rule_id} exception ${index}`),
    }
  })
}

function byRuleId(a: Outcome, b: Outcome): number {
  if (a.isException !== b.isException) return a.isException ? -1 : 1
  return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0
}

/**
 * Judges one subject inside `scope`. `subject` labels the judgment for
 * diagnostics only; the trace shape is frozen and carries rule ids, not subjects.
 */
export function evaluate(
  rules: readonly RuleRow[],
  scope: ScopePath,
  subject: string,
  facts: Facts,
): { then: RuleThen | null; trace: RuleTrace } {
  const outcomes: Outcome[] = []
  for (const rule of rules) {
    const enums = readRuleEnums(rule)
    if (enums.state !== 'active' || enums.provenance === 'inferred') continue
    if (!isScopePrefix(rule.scope_path, scope)) continue
    const when = parseWhen(rule.when_json)
    const base = {
      ruleId: rule.rule_id,
      depth: scopeSegments(rule.scope_path).length,
      rank: LAYER_RANK[enums.layer],
      priority: enums.priority,
      layer: enums.layer,
    }
    if (matches(when, facts)) outcomes.push({ ...base, then: enums.then, isException: false })
    for (const exception of parseExceptions(rule)) {
      if (matches(exception.when, facts)) outcomes.push({ ...base, then: exception.then, isException: true })
    }
  }

  if (outcomes.length === 0) return { then: null, trace: { candidates: [], reason: 'none' } }

  outcomes.sort(byRuleId)
  const candidates = [...new Set(outcomes.map((outcome) => outcome.ruleId))]

  const exceptions = outcomes.filter((outcome) => outcome.isException)
  const bodies = outcomes.filter((outcome) => !outcome.isException)
  // Exceptions beat the body (06): a matched exception removes every body
  // outcome from the race, whichever layer or scope the body came from.
  const exceptionWins = exceptions.length > 0
  let pool = exceptionWins ? exceptions : bodies
  let step: RuleTrace['reason'] = 'only'

  const maxDepth = Math.max(...pool.map((outcome) => outcome.depth))
  const deeper = pool.filter((outcome) => outcome.depth === maxDepth)
  if (deeper.length < pool.length) step = 'longer_scope'
  pool = deeper

  const maxRank = Math.max(...pool.map((outcome) => outcome.rank))
  const higherLayer = pool.filter((outcome) => outcome.rank === maxRank)
  if (higherLayer.length < pool.length) step = 'layer'
  pool = higherLayer

  const maxPriority = Math.max(...pool.map((outcome) => outcome.priority))
  const top = pool.filter((outcome) => outcome.priority === maxPriority)
  if (top.length < pool.length) step = 'priority'
  pool = top

  const conclusions = [...new Set(pool.map((outcome) => outcome.then))]
  if (conclusions.length > 1) {
    const detail = pool.map((outcome) => `${outcome.ruleId}=${outcome.then}`).join(', ')
    throw new RuleError('RULE_CONFLICT', `tie for subject '${subject}' at scope '${scope}': ${detail}`)
  }

  const winner = pool[0]
  // 'exception' names the step that removed the body; 'only' means the surviving
  // conclusion is unique (one rule, or several rules that agree).
  const reason: RuleTrace['reason'] = exceptionWins && bodies.length > 0
    ? 'exception'
    : pool.length > 1 ? 'only' : step
  return { then: winner.then, trace: { candidates, winner: winner.ruleId, reason, layer: winner.layer } }
}