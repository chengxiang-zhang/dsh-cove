/**
 * SQLite claim/cursor index over the durable daily JSONL queue.
 *
 * Single-instance constraint: the database file lives under `$DSH_HOME` and is
 * opened without any inter-process coordination. Exactly one `dsh-web` process
 * may consume one `$DSH_HOME` at a time. That is a deliberate deployment
 * decision, not an oversight: two consumers would need a shared claim protocol
 * and a lease owner, and the bot's message flow is small enough that the cost of
 * that machinery is not worth paying. Starting a second consumer on the same
 * home is an operator error; WAL plus the partial unique index at least make it
 * a loud one instead of a silent double-delivery.
 *
 * Reliability choices worth knowing:
 *
 * - `journal_mode = WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`: the
 *   queue is written from the platform's event thread while agent tools read it,
 *   so readers must not block a writer and a short lock wait must not fail a
 *   message.
 * - `event_id` is the primary idempotency key and `message_id` a second one
 *   (partial unique index, so the empty value never collides): the platform
 *   redelivers on a non-200 ACK, and the same message can arrive again under a
 *   new event id after a reconnect.
 * - `pop()` claims atomically (`UPDATE ... WHERE status = 'pending'` and check
 *   the row count): two tool calls interleaved on the same connection must not
 *   both receive one message.
 * - `recoverStale()` sends an exhausted row to `dead`, never back to `pending`:
 *   a message that poisoned every attempt must not loop forever.
 * - `routed` is the one status this file never writes: the reply ledger owns a
 *   message once an agent turn is responsible for answering it, and no claim path
 *   here selects that status. It exists so `pop()` cannot hand an in-progress
 *   turn's message to a tool halfway through, which the stale-claim sweep would
 *   otherwise do after `staleTimeoutMs`.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { envelopeToLine, inboxFilePath, type LarkInboxEnvelope } from '../../../../../core/lark-inbox/queue.ts'
import { ReplyStore } from './reply-store.ts'

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

/** What settling one claimed message did. */
export type InboxSettleStatus = 'done' | 'pending' | 'dead' | 'not-found'

export interface InboxStoreStats {
  pending: number
  processing: number
  /** Messages an agent turn is currently responsible for answering. */
  routed: number
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
  /**
   * Cached answer to "does this database carry the claim `owner` column".
   *
   * Probed on the first claim rather than at construction, because the column is
   * added by the protocol migration that runs *after* this store opens (the
   * ledger refuses to create the channel's table itself), so a probe in `open()`
   * would always answer no and the filter would never engage.
   */
  private ownerColumn: boolean | undefined

  /**
   * The reply ledger, on this store's connection.
   *
   * Attaching a message to an agent turn and creating that turn must commit
   * together; a second connection to the same file could interleave and leave a
   * `routed` message belonging to no job, which no consumer would ever see again.
   * The handle therefore stays private to this file and the ledger is handed the
   * same one at construction.
   */
  readonly reply: ReplyStore

  private constructor(db: DatabaseSync, options: InboxStoreOptions) {
    this.db = db
    this.rootDir = options.rootDir
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS
    this.reply = new ReplyStore(db)
  }

  static open(options: InboxStoreOptions): InboxStore {
    let db: DatabaseSync
    try {
      mkdirSync(options.rootDir, { recursive: true, mode: 0o700 })
      db = new DatabaseSync(join(options.rootDir, 'inbox.sqlite'))
      // Durability and concurrency pragmas first: they apply to every later
      // statement, including the migrations below.
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('PRAGMA synchronous = NORMAL')
      db.exec(`CREATE TABLE IF NOT EXISTS inbox_events (
        event_id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        message_id TEXT NOT NULL DEFAULT ''
      )`)
      InboxStore.migrate(db)
      db.exec('CREATE INDEX IF NOT EXISTS idx_inbox_events_claim ON inbox_events(status, received_at)')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`lark-inbox: failed to open inbox store at "${options.rootDir}": node:sqlite requires Node >= 22.13 or a DSH Host runtime with node:sqlite support. ${detail}`)
    }
    return new InboxStore(db, options)
  }

  /**
   * Bring a store created by an older build up to the current schema.
   *
   * Idempotent by construction: the column is added only when `PRAGMA table_info`
   * does not already list it, and the index is `IF NOT EXISTS`. An existing
   * queue therefore upgrades in place on the next start instead of needing a
   * migration tool.
   * @param db - the open database handle.
   */
  private static migrate(db: DatabaseSync): void {
    const columns = db.prepare('PRAGMA table_info(inbox_events)').all() as unknown as Array<{ name?: unknown }>
    const hasMessageId = columns.some(column => String(column.name ?? '') === 'message_id')
    if (!hasMessageId) db.exec("ALTER TABLE inbox_events ADD COLUMN message_id TEXT NOT NULL DEFAULT ''")
    // A queue that predates the column still has the message id inside its stored
    // payload; recovering it keeps the second idempotency key useful for messages
    // that were already sitting in the queue when the upgrade happened.
    if (!hasMessageId) InboxStore.backfillMessageIds(db)
    // Partial index: `message_id` is empty for events that never carried one, and
    // those rows must not collide with each other.
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_events_message ON inbox_events(message_id) WHERE message_id <> ''")
  }

  /**
   * Fill `message_id` for rows written before the column existed.
   *
   * Duplicate message ids are skipped rather than merged: two stored events with
   * one message id are a redelivery that already happened, and collapsing them
   * here would silently delete a queued line the JSONL still holds.
   * @param db - the open database handle, after the column was added.
   */
  private static backfillMessageIds(db: DatabaseSync): void {
    const taken = new Set<string>()
    const existing = db.prepare("SELECT message_id FROM inbox_events WHERE message_id <> ''").all() as unknown as Array<{ message_id?: unknown }>
    for (const row of existing) taken.add(String(row.message_id ?? ''))
    const rows = db.prepare("SELECT event_id, payload FROM inbox_events WHERE message_id = ''").all() as unknown as Array<{ event_id?: unknown; payload?: unknown }>
    for (const row of rows) {
      let messageId = ''
      try {
        const parsed: unknown = JSON.parse(String(row.payload ?? ''))
        const candidate = typeof parsed === 'object' && parsed !== null ? (parsed as { messageId?: unknown }).messageId : undefined
        messageId = typeof candidate === 'string' ? candidate.trim() : ''
      } catch { continue }
      if (messageId === '' || taken.has(messageId)) continue
      taken.add(messageId)
      db.prepare('UPDATE inbox_events SET message_id = ? WHERE event_id = ?').run(messageId, String(row.event_id))
    }
  }

  append(envelope: LarkInboxEnvelope): 'appended' | 'duplicate' {
    const now = Date.now()
    const file = inboxFilePath(this.rootDir, envelope.eventType, now)
    const line = envelopeToLine(envelope)
    const messageId = (envelope.messageId ?? '').trim()
    const result = this.db.prepare(`INSERT OR IGNORE INTO inbox_events
      (event_id, file, status, attempts, received_at, updated_at, payload, message_id)
      VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)`)
      .run(envelope.eventId, file, now, now, line, messageId)
    if (Number(result.changes) === 0) return 'duplicate'
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      // The JSONL line is the durable artifact; a row without one would claim a
      // message the queue cannot produce, so undo the claim.
      this.db.prepare('DELETE FROM inbox_events WHERE event_id = ?').run(envelope.eventId)
      throw error
    }
    return 'appended'
  }

  /**
   * Pending messages no reply batch ever took ownership of.
   *
   * A message is stored before it is attached, so a crash - or a failure in that
   * gap - leaves a row that is durable, deduplicated, and belongs to nothing.
   * Redelivery cannot heal it: the platform's copy is dropped as a duplicate before
   * admission runs again. Only a scan can find these.
   * @param limit - how many to hand back.
   * @returns the envelopes, oldest first.
   */
  unattachedPending(limit: number): LarkInboxEnvelope[] {
    const rows = this.db.prepare(`SELECT event_id, file, attempts, payload, status FROM inbox_events
      WHERE status = 'pending' AND event_id NOT IN (SELECT event_id FROM reply_job_messages)
      ORDER BY received_at ASC, rowid ASC LIMIT ?`).all(Math.max(1, Math.min(50, limit))) as unknown as InboxRow[]
    return rows.map(row => JSON.parse(String(row.payload)) as LarkInboxEnvelope)
  }

  /**
   * Read one event by its id, whatever its status.
   * @param eventId - the platform event id (also the primary key).
   * @returns the item, or undefined when the queue never held it.
   */
  get(eventId: string): InboxItem | undefined {
    const row = this.db.prepare(`SELECT event_id, file, status, attempts, payload
      FROM inbox_events WHERE event_id = ?`).get(eventId) as unknown as InboxRow | undefined
    return row === undefined ? undefined : this.rowToItem(row)
  }

  peek(limit = 1): InboxItem[] {
    const rows = this.db.prepare(`SELECT event_id, file, status, attempts, payload
      FROM inbox_events WHERE status = 'pending'${this.claimFilter()}
      ORDER BY received_at ASC, rowid ASC LIMIT ?`).all(limit) as unknown as InboxRow[]
    return rows.map(row => this.rowToItem(row))
  }

  /**
   * The claim predicate that keeps the secretary's events out of the tool path.
   *
   * `inbox_events.owner` is written by the kernel's claim (F16). A message the
   * secretary claimed must not be handed to `lark_inbox_pop`, or two answers race
   * for one message; a message the old responder owns - or that nobody owns yet -
   * stays claimable, so the pre-secretary path keeps working unchanged. A
   * database the protocol has not migrated yet has no such column, and then the
   * query degrades to the original one instead of failing.
   * @returns the SQL fragment to append to a claim predicate, empty when absent.
   */
  private claimFilter(): string {
    if (this.ownerColumn === undefined) {
      const columns = this.db.prepare('PRAGMA table_info(inbox_events)').all() as unknown as Array<{ name?: unknown }>
      this.ownerColumn = columns.some(column => String(column.name ?? '') === 'owner')
    }
    return this.ownerColumn ? " AND (owner IS NULL OR owner = 'responder')" : ''
  }

  /**
   * Claim the oldest pending message.
   *
   * The read and the claim are separate statements, so the claim is guarded by
   * `status = 'pending'`: if another caller won the row in between, this call
   * sees zero changed rows and looks again instead of handing out a message that
   * is already being processed.
   * @returns the claimed item, or null when nothing is pending.
   */
  pop(): InboxItem | null {
    const filter = this.claimFilter()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const row = this.db.prepare(`SELECT event_id, file, attempts, payload, status
        FROM inbox_events WHERE status = 'pending'${filter}
        ORDER BY received_at ASC, rowid ASC LIMIT 1`).get() as unknown as InboxRow | undefined
      if (!row) return null
      const eventId = String(row.event_id)
      // The owner predicate repeats in the claim itself: a claim written between
      // this read and this update must not be overwritten by the tool path.
      const claimed = this.db.prepare(`UPDATE inbox_events SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE event_id = ? AND status = 'pending'${filter}`).run(Date.now(), eventId)
      if (Number(claimed.changes) === 1) {
        return {
          envelope: JSON.parse(String(row.payload)) as LarkInboxEnvelope,
          status: 'processing',
          attempts: Number(row.attempts) + 1,
          file: String(row.file),
        }
      }
      // Lost the race for this row; one more candidate, then give up.
    }
    return null
  }

  /**
   * Mark a claimed message finished.
   * @param eventId - the claimed event id.
   * @returns `done`, or `not-found` when no processing row has that id.
   */
  ack(eventId: string): InboxSettleStatus {
    const result = this.db.prepare(`UPDATE inbox_events SET status = 'done', updated_at = ?
      WHERE event_id = ? AND status = 'processing'`).run(Date.now(), eventId)
    return Number(result.changes) === 0 ? 'not-found' : 'done'
  }

  /**
   * Return a claimed message to the queue, or retire it.
   * @param eventId - the claimed event id.
   * @returns the status it now has, or `not-found` when no processing row matches.
   */
  nack(eventId: string): InboxSettleStatus {
    const row = this.db.prepare(`SELECT attempts FROM inbox_events
      WHERE event_id = ? AND status = 'processing'`).get(eventId) as unknown as { attempts: number | bigint } | undefined
    if (!row) return 'not-found'
    const next: InboxSettleStatus = Number(row.attempts) >= this.maxAttempts ? 'dead' : 'pending'
    this.db.prepare(`UPDATE inbox_events SET status = ?, updated_at = ? WHERE event_id = ? AND status = 'processing'`)
      .run(next, Date.now(), eventId)
    return next
  }

  /**
   * Reclaim claims abandoned by a consumer that stopped mid-message.
   *
   * A row that already exhausted its attempts becomes `dead` instead of
   * returning to `pending`: stale recovery must not be the loop that keeps a
   * poisoning message alive forever.
   * @returns how many rows changed status.
   */
  recoverStale(): number {
    const now = Date.now()
    const threshold = now - this.staleTimeoutMs
    const retired = this.db.prepare(`UPDATE inbox_events SET status = 'dead', updated_at = ?
      WHERE status = 'processing' AND updated_at < ? AND attempts >= ?`).run(now, threshold, this.maxAttempts)
    const requeued = this.db.prepare(`UPDATE inbox_events SET status = 'pending', updated_at = ?
      WHERE status = 'processing' AND updated_at < ?`).run(now, threshold)
    return Number(retired.changes) + Number(requeued.changes)
  }

  stats(): InboxStoreStats {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS cnt FROM inbox_events GROUP BY status')
      .all() as unknown as Array<{ status: string | number | bigint | Uint8Array | null; cnt: number | bigint }>
    const counts = { pending: 0, processing: 0, routed: 0, done: 0, dead: 0 }
    for (const row of rows) {
      const status = String(row.status)
      if (status in counts) counts[status as keyof typeof counts] = Number(row.cnt)
    }
    return {
      ...counts,
      total: counts.pending + counts.processing + counts.routed + counts.done + counts.dead,
    }
  }

  /**
   * Delete finished queue rows older than a cutoff.
   *
   * Only terminal rows, and only ones no reply batch still points at: the index
   * exists to answer "what is pending" and "what did we do", and neither question
   * needs a row from months ago. The JSONL shards are deliberately untouched - the
   * line on disk is the durable record of what the platform sent, and the SQLite
   * file is an index over it. Pruning the index is housekeeping; pruning the
   * shards would be deleting evidence.
   * @param olderThan - epoch milliseconds; rows last updated before this go.
   * @returns how many rows were removed.
   */
  pruneTerminal(olderThan: number): number {
    const result = this.db.prepare(`DELETE FROM inbox_events
      WHERE status IN ('done','dead') AND updated_at < ?
        AND event_id NOT IN (SELECT event_id FROM reply_job_messages)`).run(olderThan)
    return Number(result.changes)
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