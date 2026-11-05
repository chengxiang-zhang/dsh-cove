/**
 * The `now` projection: one ledger state, two layers, two fingerprints (07 单一在场, T11).
 *
 * `pub(now)` is the public core every desk must see identically inside one judge
 * window. `aud(now)` is that core plus whatever this audience may use. The split
 * exists because two different things are asked of the same state: the owner's
 * private chat and a group chat have to agree about the same public fact, and the
 * private chat must not leak into the group one.
 *
 * Pure functions only: no clock, no database, no network, no module state. The
 * caller reads the ledger and hands a snapshot in, so the fingerprint of one
 * window can be recomputed from the same input and compared across desks.
 *
 * A memory the audience may use but not hear arrives as `derivedHint` text, never
 * as its body or its source quote. That is the whole reason the two layers exist:
 * the projection can carry a conclusion shape such as "reply short" without
 * carrying the sentence that produced it.
 */

import { createHash } from 'node:crypto'

import type { HintCarrier } from '../memory/disclose.ts'
import { derivedHint } from '../memory/disclose.ts'
import type { Audience } from '../memory/visibility.ts'
import { canSay, canUse, parsePrincipals } from '../memory/visibility.ts'
import {
  AUDIENCE_CLASSES,
  type AudienceClass,
  type CommitmentRow,
  type CommitmentState,
  type MemoryKind,
  type MemoryRow,
  type WorkClassRow,
} from '../protocol/objects.ts'

/** At most this many open commitments enter the public core (07: ≤8 条). */
export const PUB_OPEN_MAX = 8
/** At most this many public conclusions enter the public core (07: 最近 12 次判断). */
export const PUB_CONCLUSIONS_MAX = 12

/** Ledger snapshot the caller reads before compiling a projection. */
export interface LedgerView {
  /** Open commitments (`proposed`/`open`/`at_risk`) for this desk. */
  open: CommitmentRow[]
  /** Commitments whose ball is on the owner, with the question that put it there. */
  waiting: (CommitmentRow & { question?: string, default?: string, prepared?: string })[]
  /** The most recent judgements; only `public` ones leave this module. */
  recentConclusions: { deliberation_id: string, conclusion: string, public: boolean }[]
  /** Active memory rows reachable from this desk. */
  memories: MemoryRow[]
  /** Work classes with their calibration (judge precedents). */
  workClasses: WorkClassRow[]
  /** Recently closed commitments (judge precedents). */
  recentClosed: CommitmentRow[]
  /** Attention counters for the attention section of the dossier. */
  attention: {
    interruptsToday: number
    quota: number
    quiet: string
    ownerLastSpokeAt?: number
  }
}

/** One open commitment as the public core spells it: identity, claim, ball, next look. */
export interface PubOpenEntry {
  commitment_id: string
  what: string
  ball: string
  state: CommitmentState
  next_look_at: number | null
}

/** A question the owner must answer, with the default the system would take. */
export interface PubQuestion {
  commitment_id: string
  question: string
  default: string | null
}

/** The public core: identical for every desk inside one judge window. */
export interface PubNow {
  open: PubOpenEntry[]
  conclusions: { deliberation_id: string, conclusion: string }[]
  questions: PubQuestion[]
  constraints: { memory_id: string, body: string }[]
}

/** One usable memory as this audience sees it. */
export interface AudMemory {
  memory_id: string
  kind: MemoryKind
  topic: string
  /**
   * `body` when the audience may hear it, `derivedHint(...)` when it may only use
   * it. A hinted entry never contains the stored sentence or the source quote.
   */
  text: string
  derived: boolean
}

/** The audience layer: the public core plus entries this audience may use. */
export interface AudNow extends PubNow {
  audience: { cls: AudienceClass, principals: string[] }
  use: AudMemory[]
}

export interface NowProjection {
  pub: PubNow
  aud: AudNow
  pubHash: string
  audHash: string
  audienceClass: AudienceClass
  /**
   * True when a layer could not be compiled and the projection fell back to the
   * public core alone. `audHash === pubHash` in that case, so a degraded
   * projection can never claim a distinct audience fingerprint.
   */
  degraded: boolean
}

function fail(what: string): never {
  throw new TypeError(`now: ${what}`)
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`${what} must be a string`)
  return value
}

function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) fail(`${what} must be an array`)
  return value
}

function requireTime(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${what} must be epoch milliseconds`)
  return value
}

/** Deterministic JSON: object keys sorted, so equal values always hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')
  return `{${body}}`
}

/** sha256 of the deterministic serialization; the fingerprint recorded on a deliberation row. */
export function hashOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function readAudienceClass(audience: Audience): AudienceClass {
  const raw = (audience as { cls?: unknown }).cls
  return (AUDIENCE_CLASSES as readonly unknown[]).includes(raw) ? (raw as AudienceClass) : 'external'
}

function readOpen(row: CommitmentRow): PubOpenEntry {
  return {
    commitment_id: requireString(row.commitment_id, 'open.commitment_id'),
    what: requireString(row.what, 'open.what'),
    ball: requireString(row.ball, 'open.ball'),
    state: row.state,
    next_look_at: requireTime(row.next_look_at, 'open.next_look_at'),
  }
}

/** The public core. Reads no memory body beyond a config-authority constraint. */
export function buildPub(view: LedgerView): PubNow {
  if (view === null || typeof view !== 'object') fail('view must be an object')
  const openRows = requireArray(view.open, 'view.open') as CommitmentRow[]
  const conclusions = requireArray(view.recentConclusions, 'view.recentConclusions') as LedgerView['recentConclusions']
  const waiting = requireArray(view.waiting, 'view.waiting') as LedgerView['waiting']
  const memories = requireArray(view.memories, 'view.memories') as MemoryRow[]

  const open = openRows
    .map(readOpen)
    .sort((a, b) => compare(a.commitment_id, b.commitment_id))
    .slice(0, PUB_OPEN_MAX)

  const publics = conclusions
    .filter((row) => row !== null && typeof row === 'object' && row.public === true)
    .map((row) => ({
      deliberation_id: requireString(row.deliberation_id, 'recentConclusions.deliberation_id'),
      conclusion: requireString(row.conclusion, 'recentConclusions.conclusion'),
    }))
    .sort((a, b) => compare(a.deliberation_id, b.deliberation_id))
    .slice(0, PUB_CONCLUSIONS_MAX)

  const questions: PubQuestion[] = waiting
    .filter((row) => typeof row.question === 'string' && row.question.length > 0)
    .map((row) => ({
      commitment_id: requireString(row.commitment_id, 'waiting.commitment_id'),
      question: requireString(row.question, 'waiting.question'),
      default: typeof row.default === 'string' && row.default.length > 0 ? row.default : null,
    }))
    .sort((a, b) => compare(a.commitment_id, b.commitment_id))

  // Constraints the whole deployment may see. `authority === 'config'` is the
  // "available to everyone" branch read here: at this layer there is no universe
  // of principals to prove "everyone" against, and config-authority memory is by
  // definition not private to one audience.
  const constraints = memories
    .filter((row) => row !== null && typeof row === 'object'
      && row.state === 'active' && row.authority === 'config')
    .map((row) => ({
      memory_id: requireString(row.memory_id, 'memory.memory_id'),
      body: requireString(row.body, 'memory.body'),
    }))
    .sort((a, b) => compare(a.memory_id, b.memory_id))

  return { open, conclusions: publics, questions, constraints }
}

/** The audience layer: the public core plus entries `canUse` admits. */
export function buildAud(pub: PubNow, view: LedgerView, audience: Audience): AudNow {
  const memories = requireArray(view.memories, 'view.memories') as MemoryRow[]
  const principals = Array.isArray(audience.principals) ? [...audience.principals] : []
  const use: AudMemory[] = []
  for (const row of memories) {
    if (row === null || typeof row !== 'object') fail('memory row must be an object')
    const memoryId = requireString(row.memory_id, 'memory.memory_id')
    requireString(row.body, `${memoryId}.body`)
    if (typeof row.source_quote === 'string' && row.source_quote.length > 0) {
      requireString(row.source_quote, `${memoryId}.source_quote`)
    }
    if (!canUse(row, audience)) continue
    const sayable = canSay(row, audience)
    use.push({
      memory_id: memoryId,
      kind: row.kind,
      topic: requireString(row.topic, `${memoryId}.topic`),
      text: sayable ? row.body : derivedHint(row as HintCarrier),
      derived: !sayable,
    })
  }
  use.sort((a, b) => compare(a.memory_id, b.memory_id))

  return {
    ...pub,
    audience: { cls: readAudienceClass(audience), principals: [...new Set(principals)].sort(compare) },
    use,
  }
}

/**
 * Compile the two layers and their fingerprints.
 *
 * Idempotent by construction: equal inputs give equal hashes because every
 * collection is sorted and every object is serialized with sorted keys. A layer
 * that throws falls back to the public core and sets `degraded`, which is the
 * "rather less information than two contradicting answers" rule from 07.
 */
export function compileNow(view: LedgerView, audience: Audience): NowProjection {
  const audienceClass = readAudienceClass(audience)
  let degraded = false

  let pub: PubNow
  try {
    pub = buildPub(view)
  } catch {
    pub = { open: [], conclusions: [], questions: [], constraints: [] }
    degraded = true
  }

  const pubHash = hashOf(pub)

  let aud: AudNow
  let audHash: string
  if (degraded) {
    aud = { ...pub, audience: { cls: audienceClass, principals: [] }, use: [] }
    audHash = pubHash
  } else {
    try {
      aud = buildAud(pub, view, audience)
      audHash = hashOf(aud)
    } catch {
      aud = { ...pub, audience: { cls: audienceClass, principals: [] }, use: [] }
      audHash = pubHash
      degraded = true
    }
  }

  return { pub, aud, pubHash, audHash, audienceClass, degraded }
}

/** Audience principals of the public core, for callers that need the sorted list. */
export function publicPrincipals(view: LedgerView): string[] {
  const memories = requireArray(view.memories, 'view.memories') as MemoryRow[]
  const seen = new Set<string>()
  for (const row of memories) {
    for (const principal of parsePrincipals(row.use_set)) seen.add(principal)
  }
  return [...seen].sort(compare)
}