/**
 * Startup conflict detection: the pure core of `06 Registry.checkConflicts`.
 *
 * Two rules conflict when one judgment could satisfy both and yet receive two
 * different conclusions: same `scope_path`, same layer, same `priority`,
 * overlapping `when` (every predicate conjunction intersects non-empty) and a
 * different `then`. Anything the engine can resolve on its own — different
 * scope length, layer, priority — is not a conflict; it is a decision.
 *
 * The report is deterministic. Pairs are oriented by rule_id and sorted, and a
 * detail line names the predicates whose intersections had to be non-empty, so
 * the same rule table always yields the same conflict rows and the same log.
 *
 * A malformed row raises (unknown predicate, unknown enum): conflict detection
 * runs once at startup, and a rule table that cannot be read is a read failure
 * that falls back to the last good snapshot (T17), never a silently skipped
 * pair.
 *
 * Pure module: protocol plus engine/predicates, no kernel, no ledger.
 */

import { RULE_PREDICATES, type RulePredicate, type RuleRow } from '../protocol/objects.ts'
import { readRuleEnums } from './engine.ts'
import {
  conditionHolds,
  hhmmMinutes,
  isScopePrefix,
  parseWhen,
  sameScalar,
  scopeSegments,
  type Condition,
  type When,
} from './predicates.ts'

export interface RuleConflict {
  rule_a: string
  rule_b: string
  detail: string
}

type Scalar = string | number

interface ParsedRule {
  rule: RuleRow
  when: When
  scopeKey: string
  layer: string
  priority: number
  then: string
}

/**
 * Returns every conflicting pair among the loadable rules. Rows that are not
 * active — or that claim to be active while being `inferred` (NEEDS-DECISION
 * N21) — are not loaded, so they cannot conflict either.
 */
export function findConflicts(rules: readonly RuleRow[]): RuleConflict[] {
  const parsed: ParsedRule[] = []
  for (const rule of rules) {
    const enums = readRuleEnums(rule)
    if (enums.state !== 'active' || enums.provenance === 'inferred') continue
    parsed.push({
      rule,
      when: parseWhen(rule.when_json),
      scopeKey: scopeSegments(rule.scope_path).join('/'),
      layer: enums.layer,
      priority: enums.priority,
      then: enums.then,
    })
  }

  const conflicts: RuleConflict[] = []
  for (let i = 0; i < parsed.length; i += 1) {
    for (let j = i + 1; j < parsed.length; j += 1) {
      const first = parsed[i]
      const second = parsed[j]
      if (first.scopeKey !== second.scopeKey) continue
      if (first.layer !== second.layer) continue
      if (first.priority !== second.priority) continue
      if (first.then === second.then) continue
      const overlap = overlappingPredicates(first.when, second.when)
      if (overlap === null) continue
      const [left, right] = first.rule.rule_id <= second.rule.rule_id ? [first, second] : [second, first]
      conflicts.push({
        rule_a: left.rule.rule_id,
        rule_b: right.rule.rule_id,
        detail: describe(left, right, overlap),
      })
    }
  }
  return conflicts.sort((a, b) => {
    if (a.rule_a !== b.rule_a) return a.rule_a < b.rule_a ? -1 : 1
    if (a.rule_b !== b.rule_b) return a.rule_b < b.rule_b ? -1 : 1
    return 0
  })
}

/** Predicates needing a non-empty intersection, or null when the whens cannot both hold. */
function overlappingPredicates(left: When, right: When): RulePredicate[] | null {
  const shared: RulePredicate[] = []
  for (const predicate of RULE_PREDICATES) {
    const a = left[predicate]
    const b = right[predicate]
    if (a === undefined || b === undefined) continue
    if (!intersects(a, b)) return null
    shared.push(predicate)
  }
  return shared
}

function finiteValues(condition: Condition): Scalar[] | null {
  if ('eq' in condition) return [condition.eq]
  if ('in' in condition) return [...condition.in]
  return null
}

/**
 * Do two conditions on the same predicate share at least one value? A finite
 * side (`eq`/`in`) is checked value by value; two open constraints are compared
 * directly. Fields the shapes cannot share space with never intersect.
 */
function intersects(a: Condition, b: Condition): boolean {
  const left = finiteValues(a)
  const right = finiteValues(b)
  if (left !== null && right !== null) {
    return left.some((x) => right.some((y) => sameScalar(x, y)))
  }
  if (left !== null) return left.some((value) => conditionHolds(b, value))
  if (right !== null) return right.some((value) => conditionHolds(a, value))
  return openIntersects(a, b)
}

function openIntersects(a: Condition, b: Condition): boolean {
  if ('gte' in a && 'gte' in b) return true
  if ('lt' in a && 'lt' in b) return true
  if ('gte' in a && 'lt' in b) return a.gte < b.lt
  if ('lt' in a && 'gte' in b) return b.gte < a.lt
  if ('prefix' in a && 'prefix' in b) return isScopePrefix(a.prefix, b.prefix) || isScopePrefix(b.prefix, a.prefix)
  if ('between' in a && 'between' in b) {
    return timeRanges(a.between).some(([start, end]) =>
      timeRanges(b.between).some(([otherStart, otherEnd]) => start < otherEnd && otherStart < end))
  }
  // parseWhen keeps thresholds on numeric predicates, `prefix` on path_prefix
  // and `between` on time_window, so a mixed pair here cannot share a value.
  return false
}

function timeRanges(window: readonly [string, string]): [number, number][] {
  const start = hhmmMinutes(window[0])
  const end = hhmmMinutes(window[1])
  return start <= end ? [[start, end]] : [[start, 1440], [0, end]]
}

function describe(left: ParsedRule, right: ParsedRule, overlap: readonly RulePredicate[]): string {
  const keys = overlap.length === 0 ? 'unconditional' : overlap.join(',')
  return `same scope='${left.rule.scope_path}', layer=${left.layer}, priority=${left.priority}; `
    + `overlapping when=[${keys}]; then '${left.then}' vs '${right.then}'`
}