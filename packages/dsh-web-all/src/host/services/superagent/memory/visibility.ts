/**
 * Visibility: who may use a memory to judge, and who may hear it said (05).
 *
 * The append-only table stores only the atoms: the `use_set` and `say_set`
 * principal lists, serialized as JSON string arrays. Whether a given audience may
 * use or say a row is a function of that audience and is never stored, so adding
 * an audience costs no migration while adding a column would.
 *
 * This module also owns the two read-side helpers the rest of the memory service
 * needs: the per-kind default visibility table that extractors resolve at write
 * time, and the scoring that picks at most five private-only facts a day for the
 * promote-to-public batch question.
 *
 * Pure functions: no clock, no database, no network, no module state.
 */

import {
  AUTHORITIES,
  type AudienceClass,
  type Authority,
  type MemoryKind,
  type MemoryRow,
} from '../protocol/objects.ts'

/**
 * The audience of one desk: the party ids present and the class that names them.
 * `cls` travels with the snapshot so a dossier fingerprint can record it; the
 * visibility functions themselves read only `principals`.
 */
export interface Audience { principals: readonly string[]; cls: AudienceClass }

/**
 * Reads a stored visibility atom.
 *
 * The column is a JSON array of party ids. Anything else (null, empty, malformed
 * JSON, non-string members) yields an empty list: a row whose atom cannot be read
 * is neither usable nor sayable, which is the safe direction for a privacy gate.
 */
export function parsePrincipals(raw: string | null): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const principals: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id.length > 0 && !principals.includes(id)) principals.push(id)
  }
  return principals
}

/** Serializes a visibility atom for storage. One format, one writer shape. */
export function serializePrincipals(principals: readonly string[]): string {
  const unique: string[] = []
  for (const principal of principals) {
    const id = principal.trim()
    if (id.length > 0 && !unique.includes(id)) unique.push(id)
  }
  return JSON.stringify(unique)
}

/** May this audience enter the memory into its dossier for judging? */
export function canUse(memory: Pick<MemoryRow, 'use_set' | 'state'>, audience: Audience): boolean {
  if (memory.state !== 'active') return false
  const allowed = parsePrincipals(memory.use_set)
  return audience.principals.some((principal) => allowed.includes(principal))
}

/** May this memory be said out loud to every member of this audience? */
export function canSay(memory: Pick<MemoryRow, 'say_set' | 'state'>, audience: Audience): boolean {
  if (memory.state !== 'active') return false
  if (audience.principals.length === 0) return false
  const allowed = parsePrincipals(memory.say_set)
  return audience.principals.every((principal) => allowed.includes(principal))
}

/**
 * A role reference, not an id: extractors declare defaults before the ids of the
 * audience are known, and the composition root resolves them from the trigger.
 */
export type PrincipalRef = 'owner' | 'group_members' | 'commitment_audience'

/** Default visibility of one memory kind, written as role references. */
export interface DefaultVisibility { use: readonly PrincipalRef[]; say: readonly PrincipalRef[] }

/**
 * Defaults per kind (05 five-memory table, resolved by the extractor at write
 * time). The group case of the owner-said kinds is expressed in the resolver:
 * a sentence the owner said in a group is still only his to hear said back.
 */
export const DEFAULT_VISIBILITY: Readonly<Record<MemoryKind, DefaultVisibility>> = {
  constraint: { use: ['owner'], say: ['owner'] },
  preference: { use: ['owner'], say: ['owner'] },
  precedent: { use: ['commitment_audience'], say: ['commitment_audience'] },
  person: { use: ['owner'], say: [] },
  standing: { use: ['owner'], say: ['owner'] },
}

/** What the resolver needs from the trigger to turn role references into ids. */
export interface DefaultVisibilityContext {
  owner: string
  where: 'p2p' | 'group'
  groupMembers?: readonly string[]
  commitmentAudience?: readonly string[]
}

function uniqueIds(ids: readonly string[]): string[] {
  const unique: string[] = []
  for (const id of ids) {
    const trimmed = id.trim()
    if (trimmed.length > 0 && !unique.includes(trimmed)) unique.push(trimmed)
  }
  return unique
}

function resolveRefs(refs: readonly PrincipalRef[], context: DefaultVisibilityContext): string[] {
  const ids: string[] = []
  for (const ref of refs) {
    if (ref === 'owner') ids.push(context.owner)
    else if (ref === 'group_members') ids.push(...(context.groupMembers ?? []))
    else ids.push(...(context.commitmentAudience ?? []))
  }
  return uniqueIds(ids)
}

/**
 * Turns a kind's default into concrete ids.
 *
 * In a group, the owner-said kinds widen `use` to the members present (the owner
 * included) while `say` stays the owner alone; a precedent stays bound to the
 * audience of the promise it was learned from, and an observed person fact never
 * leaves the owner. A missing list resolves to nothing, so the row is unusable
 * rather than visible to everyone.
 */
export function resolveDefaultVisibility(
  kind: MemoryKind,
  context: DefaultVisibilityContext,
): { use: string[]; say: string[] } {
  const table = DEFAULT_VISIBILITY[kind]
  const say = resolveRefs(table.say, context)
  const ownerSaid = table.say.length === 1 && table.say[0] === 'owner' && table.use.includes('owner')
  const use = context.where === 'group' && ownerSaid
    ? uniqueIds([context.owner, ...(context.groupMembers ?? [])])
    : resolveRefs(table.use, context)
  return { use, say }
}

/** At most five promote-to-public candidates a day (05 upgrade flooding guard). */
export const PROMOTION_LIMIT = 5

/**
 * Ordering weight per kind: a constraint first (it is what prevents a public
 * mistake), then a preference, a standing instruction, a precedent, an observed
 * person fact last. The weight only orders candidates; eligibility is decided by
 * the visibility atom alone.
 */
export const PROMOTION_KIND_WEIGHT: Readonly<Record<MemoryKind, number>> = {
  constraint: 5,
  preference: 4,
  standing: 3,
  precedent: 2,
  person: 1,
}

const DAY_MS = 86_400_000

/** A row as the promotion scorer sees it. */
export interface PromotionRow
  extends Pick<MemoryRow, 'memory_id' | 'kind' | 'state' | 'use_set' | 'say_set' | 'last_used_at'> {
  created_at: number
}

/**
 * Score of a promote-to-public candidate, or null when the row is not one.
 *
 * Eligibility is the visibility atom: the row must be active, sayable to the
 * owner alone (a fact already public has nothing to widen) and usable by him.
 * The score is `kind weight * 100 + freshness`, freshness counting down one per
 * day from the last use within a 99-day window, so it only orders the batch.
 */
export function promotionScore(row: PromotionRow, owner: string, now: number): number | null {
  if (row.state !== 'active') return null
  const say = parsePrincipals(row.say_set)
  if (say.length !== 1 || say[0] !== owner) return null
  if (!parsePrincipals(row.use_set).includes(owner)) return null
  const lastActivity = row.last_used_at ?? row.created_at
  const ageDays = Math.max(0, Math.floor((now - lastActivity) / DAY_MS))
  const freshness = ageDays >= 99 ? 0 : 99 - ageDays
  return PROMOTION_KIND_WEIGHT[row.kind] * 100 + freshness
}

/**
 * The day's promotion candidates, at most `limit` and never more than five.
 *
 * Ties are broken by memory id so the batch question is stable across runs. An
 * empty input returns an empty list: the daily question is asked only when there
 * is something to widen.
 */
export function promotionCandidates(
  rows: readonly PromotionRow[],
  owner: string,
  now: number,
  limit = PROMOTION_LIMIT,
): string[] {
  const cap = Math.max(0, Math.min(limit, PROMOTION_LIMIT))
  if (cap === 0) return []
  const scored: Array<{ memory_id: string; score: number }> = []
  for (const row of rows) {
    const score = promotionScore(row, owner, now)
    if (score !== null) scored.push({ memory_id: row.memory_id, score })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.memory_id === b.memory_id) return 0
    return a.memory_id < b.memory_id ? -1 : 1
  })
  return scored.slice(0, cap).map((entry) => entry.memory_id)
}

/**
 * Rank of an authority, `owner-said` highest at 0. The order is the array order
 * of the protocol's `AUTHORITIES`, so the two cannot drift. An unknown value
 * ranks last rather than guessing (02 "未知枚举一律当失败处理").
 */
export function authorityRank(authority: Authority): number {
  const rank = AUTHORITIES.indexOf(authority)
  return rank === -1 ? AUTHORITIES.length : rank
}

/** May `next` supersede `prev`? Equal authority may; a lower one may not. */
export function mayOverride(next: Authority, prev: Authority): boolean {
  return authorityRank(next) <= authorityRank(prev)
}