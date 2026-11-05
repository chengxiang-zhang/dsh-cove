/**
 * Promote to public: the once-a-day batch question, and the write it authorises
 * (05 "扩大 say（升公共）只走批量批准").
 *
 * Three rules shape the file. Candidates are private-only facts created today, at
 * most five, scored by T07's ranking; nothing else is eligible, so the question
 * cannot grow into a weekly review of everything. Silence is the default: an
 * unapproved candidate simply expires with the day. Approval writes a new row
 * with the widened `say_set` and leaves the old row's every other column alone,
 * because the log is append-only.
 */

import { PHYSICAL, type LedgerReader, type LedgerTx } from '../protocol/db.ts'
import type { MemoryRow } from '../protocol/objects.ts'
import { MEMORY_TABLE, MemoryError, nextMemoryId } from './log.ts'
import { PROMOTION_LIMIT, parsePrincipals, promotionCandidates, serializePrincipals } from './visibility.ts'

const DAY_MS = 86_400_000

/** Day boundaries in UTC, so the batch question is the same on every host. */
export function dayBounds(day: string): { start: number; end: number } {
  const start = Date.parse(`${day}T00:00:00Z`)
  if (Number.isNaN(start)) throw new MemoryError('MISSING', `not a day: ${day}`)
  return { start, end: start + DAY_MS }
}

/**
 * The day's candidates, at most five, newest first within a kind.
 *
 * `owner` is supplied by the caller because "private" means "sayable to the owner
 * alone", and the log stores ids rather than roles.
 */
export function promoteCandidatesOf(
  read: LedgerReader,
  day: string,
  owner: string,
  limit = PROMOTION_LIMIT,
): string[] {
  const { start, end } = dayBounds(day)
  const rows = read.all<MemoryRow>(
    `SELECT * FROM ${MEMORY_TABLE} WHERE state = 'active' AND created_at >= ? AND created_at < ?`, start, end)
  return promotionCandidates(rows, owner, end, limit)
}

/**
 * Applies the owner's answer.
 *
 * `approved = false` writes nothing at all, which is the point of the default: the
 * day simply passes. Approval marks the old row superseded and inserts the same
 * fact with the widened audience; the public audience is every configured owner
 * and colleague, and an empty party table widens nothing.
 */
export function applyPromotion(tx: LedgerTx, memoryId: string, approved: boolean): void {
  if (!approved) return
  const row = tx.get<MemoryRow>(`SELECT * FROM ${MEMORY_TABLE} WHERE memory_id = ?`, memoryId)
  if (row === undefined) throw new MemoryError('MISSING', `memory ${memoryId}`)
  if (row.state !== 'active') throw new MemoryError('NOT_ACTIVE', `memory ${memoryId} is ${row.state}`)

  const humans = tx.all<{ party_id: string }>(
    `SELECT party_id FROM ${PHYSICAL.party} WHERE class IN ('owner', 'colleague')`)
  const say = serializePrincipals([...parsePrincipals(row.say_set), ...humans.map((party) => party.party_id)])

  tx.run(`UPDATE ${MEMORY_TABLE} SET state = 'superseded', updated_at = ? WHERE memory_id = ?`, tx.now, row.memory_id)
  const memoryId_new = nextMemoryId(tx)
  tx.run(`INSERT INTO ${MEMORY_TABLE} (memory_id, kind, topic, about, body, authority, source_event,
      source_quote, commitment_id, supersedes, state, use_set, say_set, last_used_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)`,
  memoryId_new, row.kind, row.topic, row.about, row.body, row.authority, row.source_event,
  row.source_quote, row.commitment_id, row.memory_id, row.use_set, say, tx.now, tx.now)
}