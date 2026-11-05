/**
 * The memory log: the append-only table, its three write paths, and the contract
 * the dossier binds (05).
 *
 * Nothing here deletes or rewrites a fact. Superseding marks the old row's state
 * and adds a new row; retirement marks a state; `last_used_at` is the only other
 * column that ever moves, and the protocol trigger allows exactly those three.
 *
 * `remember` is the only function in the module that can refuse a fact, and it
 * refuses for one of three reasons from 05: the quote is not in the batch, an
 * active row already holds the topic, or the new fact is weaker than the one it
 * would replace.
 */

import { PHYSICAL, type LedgerReader, type LedgerTx } from '../protocol/db.ts'
import type { MemoryRow } from '../protocol/objects.ts'
import { quoteInTrigger } from './disclose.ts'
import type { MemoryView, RecallQuery } from './recall.ts'
import { mayOverride, parsePrincipals, serializePrincipals, type Audience } from './visibility.ts'
import type { MemoryEntry, MemoryTrigger } from './types/index.ts'

export type MemoryErrorCode = 'QUOTE_NOT_IN_TRIGGER' | 'CONFLICTS' | 'SUPERSEDE_FORBIDDEN' | 'MISSING' | 'NOT_ACTIVE'

export class MemoryError extends Error {
  readonly code: MemoryErrorCode
  constructor(code: MemoryErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'MemoryError'
    this.code = code
  }
}

export interface RememberResult {
  memoryId: string
  /** Set when a write was folded into an existing row; the strict conflict policy never folds today. */
  mergedInto?: string
}

/** Physical name of the append-only memory table. */
export const MEMORY_TABLE = PHYSICAL.memory

const DAY_MS = 86_400_000

/** Sixty days without use retires an observed or inferred row (05 aging rule). */
export const STALE_DAYS = 60

/**
 * The six methods of the 05 contract.
 *
 * The composition root binds these functions to it - `remember`, `retireStale`
 * and `visibility` from this file, `recall` and `disclosures` from `recall.ts`,
 * `promoteCandidates` and `applyPromotion` from `promote.ts` - and supplies the
 * write port, the reader and the owner principal, which the contract leaves out
 * of the signatures because they are wiring, not judgement.
 */
export interface MemoryLog {
  remember(entry: MemoryEntry, trigger: MemoryTrigger): RememberResult
  recall(query: RecallQuery, audience: Audience, purpose: 'judge' | 'speak', limit: number): MemoryView[]
  visibility(memoryId: string): { use: string[]; say: string[] } | undefined
  promoteCandidates(day: string): string[]
  applyPromotion(memoryId: string, approved: boolean): void
  disclosures(text: string, audience: Audience): string[]
  retireStale(now: number): number
}

/** The next memory id: ids are sequence numbers over an append-only table. */
export function nextMemoryId(read: LedgerReader): string {
  const row = read.get<{ n: number }>(`SELECT count(*) AS n FROM ${MEMORY_TABLE}`)
  return `M-${(row?.n ?? 0) + 1}`
}

/** The single active row for a topic and kind, at most one by unique index. */
export function activeByTopicKind(read: LedgerReader, topic: string, kind: string): MemoryRow | undefined {
  return read.get<MemoryRow>(
    `SELECT * FROM ${MEMORY_TABLE} WHERE topic = ? AND kind = ? AND state = 'active'`, topic, kind)
}

/**
 * Writes one entry, or refuses it.
 *
 * An `owner-said` or `party-said` entry must carry a quote that occurs verbatim
 * in this batch and a trigger event to attribute it to; without both the write is
 * refused as un-attributable, which is the same failure class as a paraphrase.
 */
export function remember(tx: LedgerTx, entry: MemoryEntry, trigger: MemoryTrigger): RememberResult {
  const needsQuote = entry.authority === 'owner-said' || entry.authority === 'party-said'
  const quote = entry.quote ?? null
  const sourceEvent = trigger.event?.event_id ?? null
  if (needsQuote) {
    if (quote === null || sourceEvent === null || !quoteInTrigger(quote, trigger.batchTexts)) {
      throw new MemoryError('QUOTE_NOT_IN_TRIGGER',
        `${entry.authority} needs a verbatim quote from this batch and the event it came from`)
    }
  }

  const active = activeByTopicKind(tx, entry.topic, entry.kind)
  if (active === undefined) {
    if (entry.supersedes !== undefined) {
      throw new MemoryError('CONFLICTS',
        `supersedes ${entry.supersedes} but no active row holds ${entry.kind}/${entry.topic}`)
    }
  } else {
    if (entry.supersedes === undefined) {
      throw new MemoryError('CONFLICTS',
        `${active.memory_id} already holds ${entry.kind}/${entry.topic}; pass supersedes`)
    }
    if (entry.supersedes !== active.memory_id) {
      throw new MemoryError('CONFLICTS', `supersedes must name ${active.memory_id}, not ${entry.supersedes}`)
    }
    if (!mayOverride(entry.authority, active.authority)) {
      throw new MemoryError('SUPERSEDE_FORBIDDEN', `${entry.authority} may not supersede ${active.authority}`)
    }
    tx.run(`UPDATE ${MEMORY_TABLE} SET state = 'superseded', updated_at = ? WHERE memory_id = ?`,
      tx.now, active.memory_id)
  }

  const memoryId = nextMemoryId(tx)
  tx.run(`INSERT INTO ${MEMORY_TABLE} (memory_id, kind, topic, about, body, authority, source_event,
      source_quote, commitment_id, supersedes, state, use_set, say_set, last_used_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)`,
  memoryId, entry.kind, entry.topic, entry.about ?? null, entry.body, entry.authority, sourceEvent,
  quote, trigger.commitment?.commitment_id ?? null, entry.supersedes ?? null,
  serializePrincipals(entry.use), serializePrincipals(entry.say), tx.now, tx.now)
  return { memoryId }
}

/** The visibility atoms of one memory, as stored. */
export function visibility(read: LedgerReader, memoryId: string): { use: string[]; say: string[] } | undefined {
  const row = read.get<MemoryRow>(`SELECT * FROM ${MEMORY_TABLE} WHERE memory_id = ?`, memoryId)
  if (row === undefined) return undefined
  return { use: parsePrincipals(row.use_set), say: parsePrincipals(row.say_set) }
}

/**
 * Retires aged observation: observed and inferred rows unused for sixty days.
 *
 * Owner-said and config facts are not aged out; only a newer statement replaces
 * them, so a rule the owner gave last year still holds.
 */
export function retireStale(tx: LedgerTx, now: number): number {
  const cutoff = now - STALE_DAYS * DAY_MS
  const rows = tx.all<MemoryRow>(
    `SELECT * FROM ${MEMORY_TABLE} WHERE state = 'active' AND authority IN ('observed', 'inferred')`)
  let retired = 0
  for (const row of rows) {
    const lastActivity = row.last_used_at ?? row.created_at
    if (lastActivity > cutoff) continue
    tx.run(`UPDATE ${MEMORY_TABLE} SET state = 'retired', updated_at = ? WHERE memory_id = ?`, now, row.memory_id)
    retired += 1
  }
  return retired
}