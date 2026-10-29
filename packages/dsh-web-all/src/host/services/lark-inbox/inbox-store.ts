/** SQLite cursor/dedup index over the durable daily JSONL queue. */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { envelopeToLine, inboxFilePath, type LarkInboxEnvelope } from '../../../core/lark-inbox/queue.ts'

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_STALE_TIMEOUT_MS = 300_000

export interface InboxStoreOptions {
  rootDir: string
  maxAttempts?: number
  staleTimeoutMs?: number
}

export interface InboxItem {
  envelope: LarkInboxEnvelope
  status: 'pending' | 'processing'
  attempts: number
  file: string
}

export interface InboxStoreStats {
  pending: number
  processing: number
  done: number
  dead: number
  total: number
}

interface InboxRow {
  event_id: string | number | bigint | Uint8Array | null
  file: string | number | bigint | Uint8Array | null
  status: string | number | bigint | Uint8Array | null
  attempts: number | bigint | null
  payload: string | number | bigint | Uint8Array | null
}

export class InboxStore {
  private readonly db: DatabaseSync
  private readonly rootDir: string
  private readonly maxAttempts: number
  private readonly staleTimeoutMs: number
  private closed = false

  private constructor(db: DatabaseSync, options: InboxStoreOptions) {
    this.db = db
    this.rootDir = options.rootDir
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS
  }

  static open(options: InboxStoreOptions): InboxStore {
    let db: DatabaseSync
    try {
      mkdirSync(options.rootDir, { recursive: true, mode: 0o700 })
      db = new DatabaseSync(join(options.rootDir, 'inbox.sqlite'))
      db.exec(`CREATE TABLE IF NOT EXISTS inbox_events (
        event_id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      )`)
      db.exec('CREATE INDEX IF NOT EXISTS idx_inbox_events_claim ON inbox_events(status, received_at)')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`lark-inbox: failed to open inbox store at "${options.rootDir}": node:sqlite requires Node >= 22.13 or a DSH Host runtime with node:sqlite support. ${detail}`)
    }
    return new InboxStore(db, options)
  }

  append(envelope: LarkInboxEnvelope): 'appended' | 'duplicate' {
    const now = Date.now()
    const file = inboxFilePath(this.rootDir, envelope.eventType, now)
    const line = envelopeToLine(envelope)
    const result = this.db.prepare(`INSERT OR IGNORE INTO inbox_events
      (event_id, file, status, attempts, received_at, updated_at, payload)
      VALUES (?, ?, 'pending', 0, ?, ?, ?)`)
      .run(envelope.eventId, file, now, now, line)
    if (Number(result.changes) === 0) return 'duplicate'
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      this.db.prepare('DELETE FROM inbox_events WHERE event_id = ?').run(envelope.eventId)
      throw error
    }
    return 'appended'
  }

  peek(limit = 1): InboxItem[] {
    const rows = this.db.prepare(`SELECT event_id, file, status, attempts, payload
      FROM inbox_events WHERE status = 'pending'
      ORDER BY received_at ASC, rowid ASC LIMIT ?`).all(limit) as unknown as InboxRow[]
    return rows.map(row => this.rowToItem(row))
  }

  pop(): InboxItem | null {
    const row = this.db.prepare(`SELECT event_id, file, attempts, payload
      FROM inbox_events WHERE status = 'pending'
      ORDER BY received_at ASC, rowid ASC LIMIT 1`).get() as unknown as InboxRow | undefined
    if (!row) return null
    const eventId = String(row.event_id)
    const attempts = Number(row.attempts) + 1
    this.db.prepare(`UPDATE inbox_events SET status = 'processing', attempts = attempts + 1, updated_at = ?
      WHERE event_id = ?`).run(Date.now(), eventId)
    return { envelope: JSON.parse(String(row.payload)) as LarkInboxEnvelope, status: 'processing', attempts, file: String(row.file) }
  }

  ack(eventId: string): void {
    this.db.prepare(`UPDATE inbox_events SET status = 'done', updated_at = ?
      WHERE event_id = ? AND status = 'processing'`).run(Date.now(), eventId)
  }

  nack(eventId: string): void {
    const row = this.db.prepare(`SELECT attempts FROM inbox_events
      WHERE event_id = ? AND status = 'processing'`).get(eventId) as unknown as { attempts: number | bigint } | undefined
    if (!row) return
    const nextStatus = Number(row.attempts) >= this.maxAttempts ? 'dead' : 'pending'
    this.db.prepare('UPDATE inbox_events SET status = ?, updated_at = ? WHERE event_id = ?')
      .run(nextStatus, Date.now(), eventId)
  }

  recoverStale(): number {
    const threshold = Date.now() - this.staleTimeoutMs
    const result = this.db.prepare(`UPDATE inbox_events SET status = 'pending', updated_at = ?
      WHERE status = 'processing' AND updated_at < ?`).run(Date.now(), threshold)
    return Number(result.changes)
  }

  stats(): InboxStoreStats {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS cnt FROM inbox_events GROUP BY status')
      .all() as unknown as Array<{ status: string | number | bigint | Uint8Array | null; cnt: number | bigint }>
    const counts = { pending: 0, processing: 0, done: 0, dead: 0 }
    for (const row of rows) {
      const status = String(row.status)
      if (status in counts) counts[status as keyof typeof counts] = Number(row.cnt)
    }
    return { ...counts, total: counts.pending + counts.processing + counts.done + counts.dead }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private rowToItem(row: InboxRow): InboxItem {
    return {
      envelope: JSON.parse(String(row.payload)) as LarkInboxEnvelope,
      status: row.status === 'processing' ? 'processing' : 'pending',
      attempts: Number(row.attempts),
      file: String(row.file),
    }
  }
}
