/**
 * In-memory ledger database for superagent tests (T04).
 *
 * `inbox_events` is created with the same DDL InboxStore uses, so the protocol
 * migration runs against the shape it meets in production. The DDL is inlined
 * rather than imported: the channel store is owned by another module and moves.
 */

import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../../../src/host/services/superagent/protocol/db.ts'

export const INBOX_EVENTS_DDL = `CREATE TABLE IF NOT EXISTS inbox_events (
  event_id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  message_id TEXT NOT NULL DEFAULT ''
)`

/** The two indexes InboxStore creates next to the table (channels/feishu/inbox-store.ts). */
export const INBOX_EVENTS_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_events_message ON inbox_events(message_id) WHERE message_id <> ''",
  'CREATE INDEX IF NOT EXISTS idx_inbox_events_claim ON inbox_events(status, received_at)',
] as const

/** A database holding only the channel's `inbox_events`, as before any superagent migration. */
export function openInboxOnlyDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(INBOX_EVENTS_DDL)
  for (const sql of INBOX_EVENTS_INDEXES) db.exec(sql)
  return db
}

/** `inbox_events` plus the full protocol migration. */
export function openTestLedgerDb(): DatabaseSync {
  const db = openInboxOnlyDb()
  migrate(db)
  return db
}

export interface InboundSeed {
  event_id: string
  file?: string
  status?: string
  attempts?: number
  received_at?: number
  updated_at?: number
  payload?: string
  message_id?: string
}

/** Inserts one inbound row with defaults for every column not given. */
export function seedInbound(db: DatabaseSync, partial: InboundSeed): void {
  const row = {
    file: '/tmp/inbox.jsonl', status: 'pending', attempts: 0, received_at: 1, updated_at: 1,
    payload: '{}', message_id: '', ...partial,
  }
  db.prepare(`INSERT INTO inbox_events (event_id, file, status, attempts, received_at, updated_at, payload, message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.event_id, row.file, row.status, row.attempts, row.received_at, row.updated_at, row.payload, row.message_id)
}
