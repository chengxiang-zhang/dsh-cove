/**
 * Agenda source 3: a promise made to someone else, before it is due (09 提醒).
 *
 * A reminder fires once. "Once" is read from the journal rather than from a
 * column, because the journal is the append-only record of what was said and a
 * second reminder is the failure this source exists to prevent.
 */

import type { Signal } from '../../kernel/ports.ts'
import type { AgendaSource } from './index.ts'

/** How far before `due_at` the reminder is raised. */
export const REMIND_LEAD_MS = 30 * 60_000

function alreadyReminded(read: Parameters<AgendaSource['due']>[2], commitmentId: string): boolean {
  const rows = read.all<{ body_json: string | null }>(
    `SELECT body_json FROM sa_journal WHERE commitment_id = ? AND kind = 'note'`,
    commitmentId,
  )
  for (const row of rows) {
    if (typeof row.body_json !== 'string') continue
    if (row.body_json.includes('"reminded"') || row.body_json.includes('reminded')) return true
  }
  return false
}

export const remind: AgendaSource = {
  name: 'remind',
  due(commitment, now, read) {
    if (commitment.kind !== 'remind') return null
    if (typeof commitment.due_at !== 'number') return null
    if (commitment.due_at - now > REMIND_LEAD_MS) return null
    if (alreadyReminded(read, commitment.commitment_id)) return null
    return { kind: 'remind', detail: { due_at: commitment.due_at, lead_ms: commitment.due_at - now } } satisfies Signal
  },
}
