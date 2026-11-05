/**
 * Rule engine (T06): fixed predicates, three-layer resolution, deterministic
 * conflict detection.
 *
 * The engine is pure: no database, no clock, no ledger, no kernel import. Every
 * expectation below is copied from docs/superagent/plan/spec/T-06-rules.md, so a
 * regression shows up as a red line instead of a silent behavior change.
 */

import { describe, expect, it } from 'vitest'
import { RULE_PREDICATES, type RulePredicate, type RuleRow } from '../src/host/services/superagent/protocol/objects.ts'
import { findConflicts } from '../src/host/services/superagent/rules/conflict.ts'
import { LAYER_RANK, evaluate } from '../src/host/services/superagent/rules/engine.ts'
import {
  RuleError,
  matches,
  parseWhen,
  type Condition,
  type Facts,
  type When,
} from '../src/host/services/superagent/rules/predicates.ts'

const SCOPE = 'local/~/code/dsh-web'

function makeRule(rule_id: string, patch: Partial<RuleRow> = {}): RuleRow {
  return {
    rule_id,
    scope_path: 'local/',
    layer: 'policy',
    when_json: '{}',
    then: 'allow',
    exceptions_json: null,
    priority: 0,
    provenance: 'config',
    version: 1,
    state: 'active',
    approved_by: 'owner',
    rollback_if: null,
    weight: null,
    hits: 0,
    last_hit_at: null,
    created_at: 0,
    updated_at: null,
    ...patch,
  }
}

function whenOf(when: When): string {
  return JSON.stringify(when)
}

function exceptionsOf(items: { when: When; then: RuleRow['then'] }[]): string {
  return JSON.stringify(items)
}

/** Returns the RuleError code thrown by `fn`, or a marker for a wrong throw. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof RuleError ? error.code : `unexpected:${String(error)}`
  }
  return undefined
}

function messageOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return 'no error'
}

describe('superagent rule engine', () => {
  it('1. parseWhen accepts known predicates and rejects unknown predicates or free text', () => {
    expect(parseWhen({ sender_class: { eq: 'owner' } })).toEqual({ sender_class: { eq: 'owner' } })
    expect(parseWhen('{"sender_class":{"eq":"owner"}}')).toEqual({ sender_class: { eq: 'owner' } })
    expect(parseWhen({})).toEqual({})

    // Unknown predicate: an error, never an ignored key.
    expect(codeOf(() => parseWhen({ mood: { eq: 'x' } }))).toBe('PREDICATE_UNKNOWN')
    // Natural-language condition: an error, never a prompt.
    expect(codeOf(() => parseWhen('if he is busy'))).toBe('PREDICATE_UNKNOWN')
    // Malformed shapes are errors too.
    expect(codeOf(() => parseWhen({ sender_class: 'owner' }))).toBe('PREDICATE_UNKNOWN')
    expect(codeOf(() => parseWhen({ sender_class: { eq: 'owner', in: ['owner'] } }))).toBe('PREDICATE_UNKNOWN')
    expect(codeOf(() => parseWhen({ capability: { prefix: 'local/x' } }))).toBe('PREDICATE_UNKNOWN')
    expect(codeOf(() => parseWhen({ time_window: { between: ['24:00', '08:00'] } }))).toBe('PREDICATE_UNKNOWN')
    expect(codeOf(() => parseWhen({ sender_class: { in: [] } }))).toBe('PREDICATE_UNKNOWN')

    // The engine fails closed on a bad row instead of treating it as unconditional.
    const bad = makeRule('R-bad', { when_json: '{"mood":{"eq":"x"}}' })
    expect(codeOf(() => evaluate([bad], SCOPE, 'S-1', {}))).toBe('PREDICATE_UNKNOWN')
  })

  it('2. all eleven predicates: one hit and one miss each', () => {
    const cases: { predicate: RulePredicate; condition: Condition; hit: Facts; miss: Facts }[] = [
      { predicate: 'sender_class', condition: { eq: 'owner' }, hit: { sender_class: 'owner' }, miss: { sender_class: 'colleague' } },
      { predicate: 'party', condition: { eq: 'P-1' }, hit: { party: 'P-1' }, miss: { party: 'P-2' } },
      { predicate: 'audience_class', condition: { eq: 'owner_p2p' }, hit: { audience_class: 'owner_p2p' }, miss: { audience_class: 'group_with_owner' } },
      { predicate: 'capability', condition: { eq: 'write_repo' }, hit: { capability: 'write_repo' }, miss: { capability: 'read' } },
      { predicate: 'path_prefix', condition: { prefix: 'local/~/code' }, hit: { path: 'local/~/code/dsh-web' }, miss: { path: 'local/~/codex' } },
      { predicate: 'commitment_kind', condition: { eq: 'deliver' }, hit: { commitment_kind: 'deliver' }, miss: { commitment_kind: 'goal' } },
      { predicate: 'prior_count', condition: { gte: 3 }, hit: { prior_count: 3 }, miss: { prior_count: 2 } },
      { predicate: 'eta_bucket', condition: { lt: 30 }, hit: { eta_minutes: 29 }, miss: { eta_minutes: 30 } },
      { predicate: 'budget_state', condition: { in: ['near', 'over'] }, hit: { budget_state: 'over' }, miss: { budget_state: 'ok' } },
      { predicate: 'time_window', condition: { between: ['09:00', '18:00'] }, hit: { now_local_hhmm: '12:00' }, miss: { now_local_hhmm: '18:00' } },
      { predicate: 'repo_visibility', condition: { eq: 'private' }, hit: { repo_visibility: 'private' }, miss: { repo_visibility: 'public' } },
    ]
    expect(cases).toHaveLength(11)
    expect(cases.map((c) => c.predicate).sort()).toEqual([...RULE_PREDICATES].sort())

    for (const testCase of cases) {
      const when = parseWhen({ [testCase.predicate]: testCase.condition } as When)
      expect(matches(when, testCase.hit), `${testCase.predicate} hit`).toBe(true)
      expect(matches(when, testCase.miss), `${testCase.predicate} miss`).toBe(false)
    }

    // Missing facts never match, and several predicates are ANDed.
    expect(matches(parseWhen({ sender_class: { eq: 'owner' } }), {})).toBe(false)
    expect(matches(parseWhen({ sender_class: { eq: 'owner' }, capability: { eq: 'read' } }), { sender_class: 'owner' })).toBe(false)
    expect(matches(
      parseWhen({ sender_class: { eq: 'owner' }, capability: { eq: 'read' } }),
      { sender_class: 'owner', capability: 'read' },
    )).toBe(true)
  })

  it('3. time_window between 22:00 and 08:00 wraps midnight as a half-open range', () => {
    const when = parseWhen({ time_window: { between: ['22:00', '08:00'] } })
    expect(matches(when, { now_local_hhmm: '23:30' })).toBe(true)
    expect(matches(when, { now_local_hhmm: '07:59' })).toBe(true)
    expect(matches(when, { now_local_hhmm: '08:00' })).toBe(false)
    // The start edge is inside the window, the minute before it is not.
    expect(matches(when, { now_local_hhmm: '22:00' })).toBe(true)
    expect(matches(when, { now_local_hhmm: '21:59' })).toBe(false)
  })

  it('4. a matching exception beats its own body', () => {
    const rule = makeRule('R-1', {
      when_json: whenOf({ sender_class: { eq: 'owner' } }),
      then: 'allow',
      exceptions_json: exceptionsOf([{ when: { capability: { eq: 'write_repo' } }, then: 'deny' }]),
    })
    const result = evaluate([rule], SCOPE, 'S-1', { sender_class: 'owner', capability: 'write_repo' })
    expect(result.then).toBe('deny')
    expect(result.trace.reason).toBe('exception')
    expect(result.trace.winner).toBe('R-1')
    expect(result.trace.candidates).toEqual(['R-1'])
    expect(result.trace.layer).toBe('policy')
  })

  it('5. the longer scope_path wins', () => {
    const broad = makeRule('R-broad', { scope_path: 'local/', then: 'deny' })
    const narrow = makeRule('R-narrow', { scope_path: SCOPE, then: 'allow' })
    // A sibling directory with a higher priority must not apply: prefix is per segment.
    const trap = makeRule('R-trap', { scope_path: 'local/~/code/dsh', then: 'deny', priority: 99 })
    const result = evaluate([broad, narrow, trap], SCOPE, 'S-1', {})
    expect(result.then).toBe('allow')
    expect(result.trace.reason).toBe('longer_scope')
    expect(result.trace.winner).toBe('R-narrow')
    expect(result.trace.candidates).toEqual(['R-broad', 'R-narrow'])
  })

  it('6. the higher layer wins at equal scope and priority', () => {
    const constitution = makeRule('R-con', { scope_path: SCOPE, layer: 'constitution', then: 'deny' })
    const technique = makeRule('R-tec', { scope_path: SCOPE, layer: 'technique', then: 'allow' })
    const result = evaluate([technique, constitution], SCOPE, 'S-1', {})
    expect(result.then).toBe('deny')
    expect(result.trace.reason).toBe('layer')
    expect(result.trace.winner).toBe('R-con')
    expect(result.trace.layer).toBe('constitution')
    // The order itself, not only the outcome: constitution outranks technique.
    expect(LAYER_RANK.constitution).toBeGreaterThan(LAYER_RANK.policy)
    expect(LAYER_RANK.policy).toBeGreaterThan(LAYER_RANK.technique)
  })

  it('7. the higher priority wins at equal scope and layer', () => {
    const high = makeRule('R-high', { scope_path: SCOPE, then: 'draft', priority: 5 })
    const low = makeRule('R-low', { scope_path: SCOPE, then: 'allow', priority: 1 })
    const result = evaluate([low, high], SCOPE, 'S-1', {})
    expect(result.then).toBe('draft')
    expect(result.trace.reason).toBe('priority')
    expect(result.trace.winner).toBe('R-high')
  })

  it('8. a full tie with different conclusions raises RULE_CONFLICT, deterministically', () => {
    const allow = makeRule('R-allow', { scope_path: SCOPE, then: 'allow' })
    const deny = makeRule('R-deny', { scope_path: SCOPE, then: 'deny' })

    const error = (() => {
      try {
        evaluate([allow, deny], SCOPE, 'S-9', {})
        return undefined
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(RuleError)
    expect((error as RuleError).code).toBe('RULE_CONFLICT')
    expect(messageOf(() => evaluate([allow, deny], SCOPE, 'S-9', {}))).toContain('R-allow')
    expect(messageOf(() => evaluate([deny, allow], SCOPE, 'S-9', {}))).toBe(messageOf(() => evaluate([allow, deny], SCOPE, 'S-9', {})))

    // A tie that agrees is not a conflict: one conclusion, no guessing needed.
    const sameAllow = makeRule('R-same', { scope_path: SCOPE, then: 'allow' })
    const agreed = evaluate([allow, sameAllow], SCOPE, 'S-9', {})
    expect(agreed.then).toBe('allow')
    expect(agreed.trace.reason).toBe('only')
    expect(agreed.trace.candidates).toEqual(['R-allow', 'R-same'])
  })

  it('9. rules that are not active do not participate, and inferred is never active', () => {
    const active = makeRule('R-active', { scope_path: SCOPE, then: 'deny' })
    const retired = makeRule('R-retired', { scope_path: SCOPE, then: 'allow', state: 'retired' })
    const proposed = makeRule('R-proposed', { scope_path: SCOPE, then: 'allow', state: 'proposed' })
    // N21 stricter read: a row claiming active while inferred is not loaded at all.
    const inferred = makeRule('R-inferred', {
      scope_path: SCOPE,
      layer: 'technique',
      provenance: 'inferred',
      state: 'active',
      then: 'allow',
    })
    const result = evaluate([retired, proposed, inferred, active], SCOPE, 'S-1', {})
    expect(result.then).toBe('deny')
    expect(result.trace.winner).toBe('R-active')
    expect(result.trace.candidates).toEqual(['R-active'])
  })

  it('10. findConflicts reports only pairs whose whens can both hold', () => {
    const ownerAllow = makeRule('R-1', { scope_path: SCOPE, when_json: whenOf({ sender_class: { eq: 'owner' } }), then: 'allow' })
    const colleagueDeny = makeRule('R-2', { scope_path: SCOPE, when_json: whenOf({ sender_class: { eq: 'colleague' } }), then: 'deny' })
    const ownerDraft = makeRule('R-3', { scope_path: SCOPE, when_json: whenOf({ sender_class: { eq: 'owner' } }), then: 'draft' })

    // Disjoint sender classes: different conclusions, but the same message can
    // never satisfy both, so this is not a conflict.
    expect(findConflicts([ownerAllow, colleagueDeny])).toEqual([])

    // Overlapping whens with different conclusions: one conflict, oriented by id.
    const reported = findConflicts([ownerAllow, colleagueDeny, ownerDraft])
    expect(reported).toHaveLength(1)
    expect(reported[0].rule_a).toBe('R-1')
    expect(reported[0].rule_b).toBe('R-3')
    expect(reported[0].detail).toContain('sender_class')
    expect(reported[0].detail).toContain("'allow'")
    expect(reported[0].detail).toContain("'draft'")
    // The report does not depend on input order.
    expect(findConflicts([ownerDraft, colleagueDeny, ownerAllow])).toEqual(reported)

    // Different layer or priority is resolvable by the engine, so not a conflict.
    expect(findConflicts([ownerAllow, makeRule('R-4', {
      scope_path: SCOPE, layer: 'constitution', when_json: whenOf({ sender_class: { eq: 'owner' } }), then: 'deny',
    })])).toEqual([])
    expect(findConflicts([ownerAllow, makeRule('R-5', {
      scope_path: SCOPE, priority: 3, when_json: whenOf({ sender_class: { eq: 'owner' } }), then: 'deny',
    })])).toEqual([])

    // Predicate intersection is per predicate, not by string equality.
    const towerPrefix = makeRule('R-6', { scope_path: SCOPE, when_json: whenOf({ path_prefix: { prefix: 'netbird/pc-tower' } }), then: 'allow' })
    const codePrefix = makeRule('R-7', { scope_path: SCOPE, when_json: whenOf({ path_prefix: { prefix: 'netbird/pc-tower/~/code/x' } }), then: 'deny' })
    const otherHost = makeRule('R-8', { scope_path: SCOPE, when_json: whenOf({ path_prefix: { prefix: 'netbird/other' } }), then: 'deny' })
    expect(findConflicts([towerPrefix, codePrefix])).toHaveLength(1)
    expect(findConflicts([towerPrefix, otherHost])).toEqual([])

    const manyTurns = makeRule('R-9', { scope_path: SCOPE, when_json: whenOf({ prior_count: { gte: 3 } }), then: 'ask' })
    const fewTurns = makeRule('R-10', { scope_path: SCOPE, when_json: whenOf({ prior_count: { lt: 3 } }), then: 'draft' })
    const someTurns = makeRule('R-11', { scope_path: SCOPE, when_json: whenOf({ prior_count: { gte: 1 } }), then: 'draft' })
    expect(findConflicts([manyTurns, fewTurns])).toEqual([])
    expect(findConflicts([manyTurns, someTurns])).toHaveLength(1)

    const nightA = makeRule('R-12', { scope_path: SCOPE, when_json: whenOf({ time_window: { between: ['22:00', '08:00'] } }), then: 'deny' })
    const nightB = makeRule('R-13', { scope_path: SCOPE, when_json: whenOf({ time_window: { between: ['23:30', '02:00'] } }), then: 'draft' })
    const day = makeRule('R-14', { scope_path: SCOPE, when_json: whenOf({ time_window: { between: ['09:00', '18:00'] } }), then: 'draft' })
    expect(findConflicts([nightA, nightB])).toHaveLength(1)
    expect(findConflicts([nightA, day])).toEqual([])

    // Non-active and inferred rows are not loaded, so they cannot conflict.
    expect(findConflicts([
      { ...ownerAllow, rule_id: 'R-15', state: 'retired' },
      { ...ownerDraft, rule_id: 'R-16', state: 'retired' },
    ])).toEqual([])
    expect(findConflicts([
      { ...ownerAllow, rule_id: 'R-17' },
      { ...ownerDraft, rule_id: 'R-18', provenance: 'inferred', layer: 'technique' },
    ])).toEqual([])
  })

  it('11. every evaluate returns a non-empty trace, including the no-hit case', () => {
    const none = evaluate([], SCOPE, 'S-1', {})
    expect(none.then).toBeNull()
    expect(none.trace).toEqual({ candidates: [], reason: 'none' })

    const noMatch = evaluate(
      [makeRule('R-1', { when_json: whenOf({ sender_class: { eq: 'owner' } }) })],
      SCOPE,
      'S-1',
      { sender_class: 'colleague' },
    )
    expect(noMatch.then).toBeNull()
    expect(noMatch.trace.reason).toBe('none')
    expect(noMatch.trace.candidates).toEqual([])
    expect(noMatch.trace.winner).toBeUndefined()

    // A rule whose scope does not cover the judged path is not a candidate either.
    const outside = evaluate([makeRule('R-2', { scope_path: 'netbird/pc-tower' })], SCOPE, 'S-1', {})
    expect(outside.trace.reason).toBe('none')

    const hit = evaluate([makeRule('R-3', { scope_path: SCOPE, then: 'draft' })], SCOPE, 'S-1', {})
    expect(hit.then).toBe('draft')
    expect(hit.trace.reason).toBe('only')
    expect(hit.trace.winner).toBe('R-3')
    expect(hit.trace.layer).toBe('policy')
    // deliberation.rule_trace stores this object as JSON; it must round-trip.
    expect(JSON.parse(JSON.stringify(hit.trace))).toEqual(hit.trace)
  })
})