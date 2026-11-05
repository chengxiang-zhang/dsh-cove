/**
 * Recall: the only way a caller gets memory text, and it returns what the
 * audience is allowed to have (05).
 *
 * Two purposes, two filters. `judge` uses `canUse` and includes a private fact,
 * but only as a derived hint: a group dossier may reason with it and may not read
 * it. `speak` uses `canSay`, so a row that cannot be said is absent entirely.
 * Neither path ever hands back an unfiltered row, which is why the caller cannot
 * bypass the filter by mistake.
 */

import { PHYSICAL, type LedgerReader, type LedgerTx, type SqlParam } from '../protocol/db.ts'
import type { Authority, MemoryKind, MemoryRow } from '../protocol/objects.ts'
import { derivedHint, disclosures, type UnsayableMemory } from './disclose.ts'
import { canSay, canUse, type Audience } from './visibility.ts'

const MEMORY_TABLE = PHYSICAL.memory

export interface RecallQuery { topic?: string; about?: string; kind?: MemoryKind }

/**
 * One memory as the caller sees it.
 *
 * Exactly one of `body` or `hint` is present: text when the audience may hear the
 * fact, a shape-only hint when it may only use it.
 */
export interface MemoryView {
  memory_id: string
  kind: MemoryKind
  topic: string
  about: string | null
  authority: Authority
  body?: string
  source_quote?: string
  hint?: string
  /** The row this one replaced, so the caller can say "by your 11-06 note". */
  supersedes: string | null
}

function viewOf(row: MemoryRow, speakable: boolean): MemoryView {
  const base: MemoryView = {
    memory_id: row.memory_id,
    kind: row.kind,
    topic: row.topic,
    about: row.about,
    authority: row.authority,
    supersedes: row.supersedes,
  }
  if (!speakable) return { ...base, hint: derivedHint(row) }
  return { ...base, body: row.body, source_quote: row.source_quote ?? undefined }
}

/**
 * Active memories matching the query, newest first, stopping at `limit`.
 *
 * The limit applies after filtering, so a page of ten never comes back as three.
 */
export function recall(
  read: LedgerReader,
  query: RecallQuery,
  audience: Audience,
  purpose: 'judge' | 'speak',
  limit: number,
): MemoryView[] {
  if (limit <= 0) return []
  const where: string[] = [`state = 'active'`]
  const params: SqlParam[] = []
  if (query.topic !== undefined) { where.push('topic = ?'); params.push(query.topic) }
  if (query.about !== undefined) { where.push('about = ?'); params.push(query.about) }
  if (query.kind !== undefined) { where.push('kind = ?'); params.push(query.kind) }
  const rows = read.all<MemoryRow>(
    `SELECT * FROM ${MEMORY_TABLE} WHERE ${where.join(' AND ')} ORDER BY created_at DESC, memory_id ASC`, ...params)
  const views: MemoryView[] = []
  for (const row of rows) {
    if (views.length >= limit) break
    if (!canUse(row, audience)) continue
    const speakable = canSay(row, audience)
    if (purpose === 'speak' && !speakable) continue
    views.push(viewOf(row, speakable))
  }
  return views
}

/**
 * The pre-send literal gate: ids of this audience's unsayable memories whose text
 * the draft repeats (05 mechanical fallback, T07 `disclosures`).
 */
export function disclosuresOf(read: LedgerReader, text: string, audience: Audience): string[] {
  if (text.length === 0) return []
  const rows = read.all<MemoryRow>(`SELECT * FROM ${MEMORY_TABLE} WHERE state = 'active'`)
  const unsayable: UnsayableMemory[] = rows
    .filter((row) => !canSay(row, audience))
    .map((row) => ({ memory_id: row.memory_id, body: row.body, source_quote: row.source_quote }))
  return disclosures(text, unsayable)
}

/**
 * Stamps `last_used_at` on the rows a turn actually used.
 *
 * The contract's `recall` is a read and cannot stamp, but the aging rule in
 * `retireStale` needs a use signal; the desk calls this after a turn that put a
 * memory in the dossier. Only `last_used_at` and `updated_at` move, both permitted
 * by the append-only trigger.
 */
export function touch(tx: LedgerTx, memoryIds: readonly string[], now = tx.now): number {
  let changed = 0
  for (const memoryId of memoryIds) {
    changed += tx.run(`UPDATE ${MEMORY_TABLE} SET last_used_at = ?, updated_at = ? WHERE memory_id = ?`,
      now, now, memoryId).changes
  }
  return changed
}