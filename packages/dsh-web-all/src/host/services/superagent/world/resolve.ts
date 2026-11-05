/**
 * From a mention to an entity: matching and scoring only.
 *
 * `04` "名字在注册时定，不在查询时猜" - the names of a machine live in the alias
 * table and are written when the entity is registered. This file therefore never
 * invents a name; it either recognizes one, or returns the reason to ask. That
 * asymmetry is the point: attaching an authorization decision to the wrong
 * machine is worse than asking, because the wrong answer looks like an answer.
 *
 * Order, from the frozen spec (T-05): alias exact (case and spacing insensitive)
 * then canonical exact, then the mention as a literal scope path, then fuzzy.
 * A fuzzy reading becomes the answer only when it is plausible (`>= 70`) and
 * clearly ahead of the runner-up (`gap >= 30`); otherwise the result is a
 * question. Only `enrolled` entities take part: `proposed` was merely seen on the
 * network, and `stale`/`gone`/`revoked` must not receive work.
 *
 * `filterHosts` is step 2 of `04`'s placement: given a need, keep the entities
 * that are enrolled, still leased (or from configuration, which carries no
 * lease), and that declared they can carry this executor class.
 */

import type { WorldEntityRow } from '../protocol/objects.ts'
import { isPrefix, normalizePath, type ScopePath } from './paths.ts'

/** An exact alias, canonical or path match. */
const EXACT_SCORE = 100
/** Below this a name is not offered as a candidate at all. */
const CANDIDATE_FLOOR = 60
/** A fuzzy match becomes the answer only at or above this. */
const FUZZY_HIT_MIN = 70
/** Two candidates closer than this are indistinguishable, so the answer is a question. */
const CLOSE_GAP = 30

export interface AliasEntry {
  readonly alias: string
  readonly entity_id: string
}

export interface ResolveInput {
  mention: string
  entities: readonly WorldEntityRow[]
  aliases: readonly AliasEntry[]
  /** Scope paths this principal may act under. A hit outside them is a question. */
  authorizedPaths: readonly ScopePath[]
}

export interface ResolveCandidate {
  readonly entity_id: string
  readonly score: number
}

export interface ResolveResult {
  entity?: WorldEntityRow
  scopePath?: ScopePath
  candidates: ResolveCandidate[]
  ask: null | 'unregistered' | 'close_scores' | 'outside_scope'
}

/**
 * Case and spacing are noise in a spoken name: `那台 mac` and `那台mac` are one
 * name. NFKC folds full-width characters, which arrive from mobile keyboards.
 */
function foldMention(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
}

/** The canonical path form of a mention, or null when the mention is not a path. */
function pathOf(raw: string): ScopePath | null {
  try {
    return normalizePath(raw)
  } catch {
    return null
  }
}

/** Levenshtein distance over code points, two rows of memory. */
function editDistance(left: readonly string[], right: readonly string[]): number {
  const cols = right.length + 1
  let previous = new Array<number>(cols)
  for (let c = 0; c < cols; c += 1) previous[c] = c
  for (let r = 1; r <= left.length; r += 1) {
    const current = new Array<number>(cols)
    current[0] = r
    for (let c = 1; c < cols; c += 1) {
      const substitution = previous[c - 1] + (left[r - 1] === right[c - 1] ? 0 : 1)
      current[c] = Math.min(previous[c] + 1, current[c - 1] + 1, substitution)
    }
    previous = current
  }
  return previous[cols - 1]
}

/** Similarity on the 0-100 scale the resolution rules are written in. */
function similarity(left: string, right: string): number {
  const a = Array.from(left)
  const b = Array.from(right)
  if (a.length === 0 || b.length === 0) return 0
  const longest = Math.max(a.length, b.length)
  const distance = editDistance(a, b)
  return Math.max(0, Math.round((100 * (longest - distance)) / longest))
}

/**
 * Scores one entity against a folded mention. Exact matches return `EXACT_SCORE`;
 * otherwise the best fuzzy reading over every registered name of the entity.
 */
function scoreEntity(entity: WorldEntityRow, aliases: readonly string[], mention: string, mentionPath: ScopePath | null): number {
  if (mention.length === 0) return 0
  if (foldMention(entity.canonical) === mention) return EXACT_SCORE
  for (const alias of aliases) {
    if (foldMention(alias) === mention) return EXACT_SCORE
  }
  const entityPath = pathOf(entity.path)
  if (mentionPath !== null && entityPath !== null && entityPath === mentionPath) return EXACT_SCORE
  let best = 0
  for (const name of [entity.canonical, entity.path, ...aliases]) {
    const score = similarity(mention, foldMention(name))
    if (score > best) best = score
  }
  return best
}

/**
 * Resolves a mention to at most one entity. `ask` names the reason when it does
 * not: the saying is not registered, two candidates are indistinguishable, or the
 * entity sits outside every authorized path.
 */
export function resolveMention(input: ResolveInput): ResolveResult {
  const mention = foldMention(input.mention)
  const mentionPath = pathOf(input.mention)

  const aliasesByEntity = new Map<string, string[]>()
  for (const { alias, entity_id } of input.aliases) {
    const known = aliasesByEntity.get(entity_id)
    if (known === undefined) aliasesByEntity.set(entity_id, [alias])
    else known.push(alias)
  }

  const enrolled: WorldEntityRow[] = []
  const scored: ResolveCandidate[] = []
  for (const entity of input.entities) {
    if (entity.state !== 'enrolled') continue
    enrolled.push(entity)
    const score = scoreEntity(entity, aliasesByEntity.get(entity.entity_id) ?? [], mention, mentionPath)
    if (score >= CANDIDATE_FLOOR) scored.push({ entity_id: entity.entity_id, score })
  }
  scored.sort((a, b) => (b.score - a.score) || (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0))

  const best = scored[0]
  if (best === undefined || best.score < FUZZY_HIT_MIN) return { candidates: scored, ask: 'unregistered' }
  const runnerUp = scored.length > 1 ? scored[1].score : 0
  if (best.score - runnerUp < CLOSE_GAP) return { candidates: scored, ask: 'close_scores' }

  const entity = enrolled.find((row) => row.entity_id === best.entity_id)
  if (entity === undefined) return { candidates: scored, ask: 'unregistered' }
  const scopePath = pathOf(entity.path)
  if (scopePath === null) return { entity, candidates: scored, ask: 'outside_scope' }
  const authorized = input.authorizedPaths.some((candidate) => {
    try {
      return isPrefix(candidate, scopePath)
    } catch {
      return false
    }
  })
  return authorized
    ? { entity, scopePath, candidates: scored, ask: null }
    : { entity, scopePath, candidates: scored, ask: 'outside_scope' }
}

export interface HostNeed {
  readonly tools: 'read' | 'full'
  /** Which executor class has to run there (`manifest_json.executors`). */
  readonly executorClass: string
}

interface HostManifest {
  executors?: unknown
  tools?: unknown
}

/** `manifest_json` is a raw string column; a row without a usable manifest declares nothing. */
function manifestOf(entity: WorldEntityRow): HostManifest | null {
  if (entity.manifest_json === null) return null
  try {
    const parsed: unknown = JSON.parse(entity.manifest_json)
    return typeof parsed === 'object' && parsed !== null ? (parsed as HostManifest) : null
  } catch {
    return null
  }
}

/**
 * Whether the declared manifest can carry the need. `executors` must name the
 * class - a host that does not say it can run this executor is not a candidate.
 * `tools` is not in the manifest key list of `04`; when a host does declare it,
 * the declaration has to cover the need (`full` covers `read`), and when it does
 * not the manifest simply says nothing about tools.
 */
function canCarry(manifest: HostManifest | null, need: HostNeed): boolean {
  if (manifest === null) return false
  const executors = manifest.executors
  if (!Array.isArray(executors) || !executors.includes(need.executorClass)) return false
  if (need.tools === 'full' && typeof manifest.tools === 'string' && manifest.tools !== 'full') return false
  return true
}

/**
 * Step 2 of placement: the hosts that may take this work, in input order.
 * Enrolled only; a lease that has expired means the machine went quiet, while no
 * lease at all is the configuration channel's normal shape.
 */
export function filterHosts(entities: readonly WorldEntityRow[], need: HostNeed, now: number): WorldEntityRow[] {
  return entities.filter((entity) => {
    if (entity.state !== 'enrolled') return false
    if (entity.lease_until !== null && entity.lease_until < now) return false
    return canCarry(manifestOf(entity), need)
  })
}