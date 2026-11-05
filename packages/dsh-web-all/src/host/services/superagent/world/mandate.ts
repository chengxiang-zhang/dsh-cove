/**
 * The mandate decision: may this principal do this capability at this scope path.
 *
 * Three facts from `04` shape the file.
 *
 * 1. A mandate is an immutable record. A decision reads rows and never writes
 *    one; revocation is a `revoked_at` stamp on a row that stays in the table,
 *    so the same query before and after revocation differs only by which rows
 *    are still live.
 * 2. Inheritance is strict and downward. Among the live rows for this principal
 *    and capability, the most specific scope (the longest path) decides - not the
 *    first row in table order, which would make the answer depend on insertion
 *    history.
 * 3. Writes must be granted to the path level. The default table therefore never
 *    answers `allow` for a write capability: the ceiling is applied both to the
 *    shipped table and again here, so the guarantee survives an edit of that data.
 *
 * Two rows on the same path with different strengths cannot both be right. The
 * strictest wins (`deny` > `draft` > `allow`): the permissive reading would let a
 * stale `allow` outvote a fresh `deny`, which is the one failure this module
 * exists to prevent. Among equally strong rows the newest grant wins, and
 * `mandate_id` breaks the remaining tie so the answer is reproducible.
 */

import type { Capability, MandateRow, Strength } from '../protocol/objects.ts'
import type { DefaultTable, PartyClass } from './defaults.ts'
import { isPrefix, normalizePath, parsePath, type ScopePath } from './paths.ts'

/**
 * Capabilities whose default answer can never be `allow` (`04` "写必须显式给到
 * 路径级", N24). `commit_promise` and `steer_foreign` are not writes to a machine
 * but the shipped table already keeps them at `draft`/`deny`; only these five need
 * the ceiling here.
 */
export const WRITE_CAPABILITIES: readonly Capability[] = ['write_repo', 'write_host', 'change_prod', 'publish', 'provision']

/** Strictness order for the same-path tie. Higher is stricter. */
const STRICTNESS: Readonly<Record<Strength, number>> = { allow: 0, draft: 1, deny: 2 }

export interface MandateQuery {
  readonly principal: string
  readonly scopePath: ScopePath
  readonly capability: Capability
}

export interface MandateDecision {
  strength: Strength
  /** The row that decided. Absent when the default table answered. */
  mandateId?: string
  source: 'mandate' | 'default'
}

interface ScopeView {
  path: ScopePath
  depth: number
}

/**
 * A row whose `scope_path` is malformed can never match a legal query, so it is
 * dropped rather than fatal: one bad configuration row must not take the whole
 * decision path down. The configuration channel rejects such rows at write time.
 */
function scopeOf(raw: string): ScopeView | null {
  try {
    return { path: normalizePath(raw), depth: parsePath(raw).rest.length }
  } catch {
    return null
  }
}

/** Same specificity: strictest strength, then newest grant, then lowest id. */
function stricter(left: MandateRow, right: MandateRow): MandateRow {
  const byStrictness = STRICTNESS[left.strength] - STRICTNESS[right.strength]
  if (byStrictness !== 0) return byStrictness > 0 ? left : right
  if (left.granted_at !== right.granted_at) return left.granted_at > right.granted_at ? left : right
  return left.mandate_id <= right.mandate_id ? left : right
}

/**
 * The default answer for a party class and capability, with the write ceiling
 * applied. Fails closed (`deny`) for a class or capability this build does not
 * know, so a typo can never widen access.
 */
export function defaultStrength(defaults: DefaultTable, principalClass: PartyClass, capability: Capability): Strength {
  const strength = defaults[principalClass]?.[capability]
  if (strength === undefined) return 'deny'
  if (!WRITE_CAPABILITIES.includes(capability)) return strength
  // The ceiling: for a write capability the table may answer `draft` or `deny`,
  // never `allow`. Written as a demotion rather than as a comparison with the tie
  // order above, so changing that order cannot move the ceiling.
  return strength === 'deny' ? 'deny' : 'draft'
}

/**
 * Decides one query. Explicit rows win over the default table; revoked rows and
 * rows for another principal or capability are invisible; the longest matching
 * scope decides. The query's scope path must be legal (`PATH_INVALID` otherwise,
 * a caller bug), while a row with a malformed path is skipped rather than fatal.
 */
export function decideMandate(
  rows: readonly MandateRow[],
  q: MandateQuery,
  defaults: DefaultTable,
  principalClass: PartyClass,
): MandateDecision {
  const target = normalizePath(q.scopePath)

  let bestDepth = -1
  let winner: MandateRow | null = null
  for (const row of rows) {
    if (row.principal !== q.principal) continue
    if (row.capability !== q.capability) continue
    if (row.revoked_at !== null) continue
    const scope = scopeOf(row.scope_path)
    if (scope === null) continue
    if (!isPrefix(scope.path, target)) continue
    if (scope.depth > bestDepth) {
      bestDepth = scope.depth
      winner = row
      continue
    }
    if (scope.depth === bestDepth && winner !== null) winner = stricter(winner, row)
  }

  if (winner !== null) return { strength: winner.strength, mandateId: winner.mandate_id, source: 'mandate' }
  return { strength: defaultStrength(defaults, principalClass, q.capability), source: 'default' }
}