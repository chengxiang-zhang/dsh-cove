/**
 * Rule predicates: the closed condition language of `docs/superagent/06`.
 *
 * `when` may only be built from the eleven protocol predicates (`02` P4); every
 * other key is a hard error. Rules are data, never code: a condition that cannot
 * be evaluated mechanically would be a prompt again, and a prompt can neither be
 * replayed nor audited. Unknown keys therefore fail loudly instead of being
 * ignored, because a silently dropped "ask me before touching prod" turns into
 * "go ahead".
 *
 * Condition shapes (06 "规则的数据形状"):
 *   { eq: string | number }         exact value
 *   { in: (string | number)[] }     one of
 *   { gte: number }, { lt: number } numeric threshold
 *   { prefix: ScopePath }           path_prefix only, 04 segment semantics
 *   { between: [hh:mm, hh:mm] }     time_window only, half-open [start, end),
 *                                   wrapping midnight ('22:00'..'08:00' means
 *                                   22:00 up to but excluding 08:00)
 *
 * Predicates inside one `when` are ANDed. A fact the caller did not observe
 * never matches: a rule cannot fire on facts that were not established.
 *
 * This file is a pure function module. It depends on the protocol only; it must
 * not reach the kernel, the ledger or the database.
 */

import {
  RULE_PREDICATES,
  RULE_THENS,
  parseEnum,
  type Capability,
  type CommitmentKind,
  type RulePredicate,
  type RuleThen,
} from '../protocol/objects.ts'

/** A world-model scope path (`04`). Kept structural so rules stay free of the world store. */
export type ScopePath = string

/**
 * Observed facts a judgment passes in. Absent keys mean "not established" and
 * never match; `path` is the judged scope, `eta_minutes` backs `eta_bucket`.
 */
export type Facts = Partial<{
  sender_class: string
  party: string
  audience_class: string
  capability: Capability
  path: ScopePath
  commitment_kind: CommitmentKind
  prior_count: number
  eta_minutes: number
  budget_state: 'ok' | 'near' | 'over'
  now_local_hhmm: string
  repo_visibility: 'public' | 'private'
}>

export type Condition =
  | { eq: string | number }
  | { in: (string | number)[] }
  | { gte: number }
  | { lt: number }
  | { prefix: ScopePath }
  | { between: [string, string] }

/** Eleven optional predicates; every present one must hold. */
export type When = { [P in RulePredicate]?: Condition }

/** Which fact a predicate reads. `eta_bucket` thresholds read raw minutes. */
export const PREDICATE_FACT: Readonly<Record<RulePredicate, keyof Facts>> = {
  sender_class: 'sender_class',
  party: 'party',
  audience_class: 'audience_class',
  capability: 'capability',
  path_prefix: 'path',
  commitment_kind: 'commitment_kind',
  prior_count: 'prior_count',
  eta_bucket: 'eta_minutes',
  budget_state: 'budget_state',
  time_window: 'now_local_hhmm',
  repo_visibility: 'repo_visibility',
}

export type RuleErrorCode = 'PREDICATE_UNKNOWN' | 'RULE_MALFORMED' | 'RULE_CONFLICT'

/** One error type for the module; `code` is what callers branch on. */
export class RuleError extends Error {
  readonly code: RuleErrorCode

  constructor(code: RuleErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'RuleError'
    this.code = code
  }
}

/** Scalar comparison without coercion: a number fact only matches a number condition. */
export function sameScalar(a: string | number, b: string | number): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (typeof a === 'string' && typeof b === 'string') return a === b
  return false
}

/** Minutes since local midnight for a validated 'hh:mm'. */
export function hhmmMinutes(hhmm: string): number {
  const [hours, minutes] = hhmm.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/** Half-open window membership; a wrapped window is tested as two ranges. */
export function inTimeWindow(hhmm: string, window: readonly [string, string]): boolean {
  const value = hhmmMinutes(hhmm)
  const start = hhmmMinutes(window[0])
  const end = hhmmMinutes(window[1])
  return start <= end ? value >= start && value < end : value >= start || value < end
}

/** Scope path split into segments; trailing slashes and empty segments are dropped. */
export function scopeSegments(path: ScopePath): string[] {
  return path.split('/').filter((segment) => segment.length > 0)
}

/**
 * Segment-wise prefix (`04`): `local/~/code/dsh` is not a prefix of
 * `local/~/code/dsh-web`, and `local/` covers everything under the local realm.
 */
export function isScopePrefix(ancestor: ScopePath, path: ScopePath): boolean {
  const prefix = scopeSegments(ancestor)
  const target = scopeSegments(path)
  if (prefix.length > target.length) return false
  return prefix.every((segment, index) => segment === target[index])
}

const CONDITION_KINDS = ['eq', 'in', 'gte', 'lt', 'prefix', 'between'] as const
type ConditionKind = (typeof CONDITION_KINDS)[number]

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const NUMERIC_PREDICATES: readonly RulePredicate[] = ['prior_count', 'eta_bucket']

function isPredicate(key: string): key is RulePredicate {
  return (RULE_PREDICATES as readonly string[]).includes(key)
}

/** Which shapes each predicate may carry; anything else is malformed data. */
function allowedKinds(predicate: RulePredicate): readonly ConditionKind[] {
  if (predicate === 'time_window') return ['between', 'eq', 'in']
  if (predicate === 'path_prefix') return ['prefix', 'eq', 'in']
  if (NUMERIC_PREDICATES.includes(predicate)) return ['gte', 'lt', 'eq', 'in']
  return ['eq', 'in']
}

function isScalar(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function isHhMm(value: unknown): value is string {
  return typeof value === 'string' && HHMM.test(value)
}

/** A path-shaped string: no whitespace, no leading slash, no '..' segment. */
function isPathShaped(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (/\s/.test(value) || value.startsWith('/')) return false
  return !value.split('/').includes('..')
}

function decode(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new RuleError('PREDICATE_UNKNOWN',
      'when is not a JSON object; natural-language conditions are forbidden')
  }
}

/**
 * Parses a `when` into the closed condition language. Accepts the row's raw
 * JSON string as well as an already-parsed value. Unknown predicates, unknown
 * shapes and invalid condition values raise PREDICATE_UNKNOWN.
 */
export function parseWhen(raw: unknown): When {
  const decoded = decode(raw)
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new RuleError('PREDICATE_UNKNOWN', 'when must be an object mapping predicates to conditions')
  }
  const when: When = {}
  for (const [key, value] of Object.entries(decoded as Record<string, unknown>)) {
    if (!isPredicate(key)) {
      throw new RuleError('PREDICATE_UNKNOWN', `unknown predicate '${key}'; the set is closed (02 P4)`)
    }
    when[key] = parseCondition(key, value)
  }
  return when
}

function parseCondition(predicate: RulePredicate, raw: unknown): Condition {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RuleError('PREDICATE_UNKNOWN',
      `${predicate}: condition must be one of ${CONDITION_KINDS.join('|')}, never a bare value`)
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  const [kind, value] = entries[0] ?? []
  if (entries.length !== 1 || kind === undefined) {
    throw new RuleError('PREDICATE_UNKNOWN', `${predicate}: condition must carry exactly one shape`)
  }
  if (!(CONDITION_KINDS as readonly string[]).includes(kind)) {
    throw new RuleError('PREDICATE_UNKNOWN', `${predicate}: unknown condition shape '${kind}'`)
  }
  if (!allowedKinds(predicate).includes(kind as ConditionKind)) {
    throw new RuleError('PREDICATE_UNKNOWN',
      `${predicate}: shape '${kind}' is not allowed here (allowed: ${allowedKinds(predicate).join('|')})`)
  }
  switch (kind as ConditionKind) {
    case 'eq':
      if (!isScalar(value)) throw new RuleError('PREDICATE_UNKNOWN', `${predicate}.eq must be a string or a finite number`)
      return { eq: value }
    case 'in':
      if (!Array.isArray(value) || value.length === 0 || !value.every(isScalar)) {
        throw new RuleError('PREDICATE_UNKNOWN', `${predicate}.in must be a non-empty array of scalars`)
      }
      return { in: [...(value as (string | number)[])] }
    case 'gte':
    case 'lt': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new RuleError('PREDICATE_UNKNOWN', `${predicate}.${kind} must be a finite number`)
      }
      return kind === 'gte' ? { gte: value } : { lt: value }
    }
    case 'prefix':
      if (!isPathShaped(value)) {
        throw new RuleError('PREDICATE_UNKNOWN', `${predicate}.prefix must be a scope path`)
      }
      return { prefix: value }
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2 || !value.every(isHhMm)) {
        throw new RuleError('PREDICATE_UNKNOWN', `${predicate}.between must be ['hh:mm', 'hh:mm']`)
      }
      const window = value as [string, string]
      if (hhmmMinutes(window[0]) === hhmmMinutes(window[1])) {
        throw new RuleError('PREDICATE_UNKNOWN', `${predicate}.between must not have equal ends`)
      }
      return { between: [window[0], window[1]] }
    }
  }
}

/** Holds a single condition against one observed value. */
export function conditionHolds(condition: Condition, fact: string | number): boolean {
  if ('eq' in condition) return sameScalar(fact, condition.eq)
  if ('in' in condition) return condition.in.some((value) => sameScalar(fact, value))
  if ('gte' in condition) return typeof fact === 'number' && fact >= condition.gte
  if ('lt' in condition) return typeof fact === 'number' && fact < condition.lt
  if ('prefix' in condition) return typeof fact === 'string' && isScopePrefix(condition.prefix, fact)
  return typeof fact === 'string' && inTimeWindow(fact, condition.between)
}

/** AND over every present predicate; a missing fact fails the whole `when`. */
export function matches(when: When, facts: Facts): boolean {
  for (const predicate of RULE_PREDICATES) {
    const condition = when[predicate]
    if (condition === undefined) continue
    const fact = facts[PREDICATE_FACT[predicate]]
    if (fact === undefined) return false
    if (!conditionHolds(condition, fact)) return false
  }
  return true
}

/** Validates a conclusion against the closed `then` set (02 P4). */
export function parseThen(raw: unknown, where: string): RuleThen {
  const then = parseEnum(RULE_THENS, raw)
  if (then === undefined) {
    throw new RuleError('RULE_MALFORMED', `${where}: then '${String(raw)}' is not a protocol conclusion`)
  }
  return then
}