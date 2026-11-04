/**
 * The reply ledger: one row per agent turn, sharing the inbox store's connection.
 *
 * Why a separate table set instead of the queue's own status. `inbox_events`
 * models a tool's claim: `pending` is claimed to `processing`, and
 * `recoverStale()` returns a claim older than `staleTimeoutMs` to `pending` so
 * an abandoned row is retried (see `inbox-store.ts`). An agent turn plus a
 * Feishu send routinely outlives that window, so a message under an active turn
 * would be handed to the next `pop()` and answered twice. The ledger therefore
 * takes ownership: once a message is attached to a job its queue row becomes
 * `routed`, which no claim path selects, and the job's own state decides what
 * happens next.
 *
 * Why the same connection. Attaching a message to a job and creating that job
 * must be one transaction; with a second connection they could interleave and
 * leave a routed message belonging to no job - a message no consumer will ever
 * see again. The class therefore takes the open handle rather than opening its
 * own database.
 *
 * Concurrency: every transition is a conditional UPDATE whose `changes` count is
 * checked, the same shape `InboxStore.pop()` uses. A partial unique index keeps
 * one collecting job and one in-flight job per conversation, so serialisation is
 * a schema guarantee rather than an assumption about callers.
 */

import type { DatabaseSync } from 'node:sqlite'

/** Where one job is in its life. */
export type ReplyJobState =
  | 'collecting'
  | 'submitting'
  | 'running'
  | 'replying'
  | 'replied'
  | 'failed'
  | 'cancelled'
  | 'reply_uncertain'

/** States in which a job holds the conversation's turn slot. */
export const INFLIGHT_STATES: readonly ReplyJobState[] = ['submitting', 'running', 'replying']

/** How one job ended, kept separately from the state so a retry keeps its history. */
export type ReplyOutcome = 'answer' | 'empty' | 'error' | 'timeout' | 'interrupted' | 'stopped'

/** One conversation's binding to a DSH session. */
export interface ConversationBinding {
  readonly convKey: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly generation: number
  readonly sessionId: string
  readonly preambleSent: boolean
}

/** One job row as callers read it. */
export interface ReplyJob {
  readonly jobId: string
  readonly convKey: string
  readonly sessionId: string
  readonly state: ReplyJobState
  readonly outcome?: ReplyOutcome
  readonly replyToMessageId: string
  readonly collectUntil: number
  readonly submittedAt?: number
  readonly deadlineAt?: number
  readonly turn?: number
  readonly nextAttemptAt: number
  readonly submitAttempts: number
  readonly sendAttempts: number
  readonly stopRequested: boolean
  readonly replyText?: string
  readonly replyMessageId?: string
  readonly lastError?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** What came back from attaching one message to the ledger. */
export interface AttachResult {
  readonly jobId: string
  /** True when this message opened the job; false when it joined an existing batch. */
  readonly opened: boolean
  /** False when the message was already attached (a redelivery). */
  readonly attached: boolean
}

export interface ReplyStoreStats {
  readonly collecting: number
  readonly submitting: number
  readonly running: number
  readonly replying: number
  readonly replied: number
  readonly failed: number
  readonly cancelled: number
  readonly replyUncertain: number
  readonly total: number
}

interface JobRow {
  job_id: string | number | bigint | Uint8Array | null
  conv_key: string | number | bigint | Uint8Array | null
  session_id: string | number | bigint | Uint8Array | null
  state: string | number | bigint | Uint8Array | null
  outcome: string | number | bigint | Uint8Array | null
  reply_to_message_id: string | number | bigint | Uint8Array | null
  collect_until: number | bigint | null
  submitted_at: number | bigint | null
  deadline_at: number | bigint | null
  turn: number | bigint | null
  next_attempt_at: number | bigint | null
  submit_attempts: number | bigint | null
  send_attempts: number | bigint | null
  stop_requested: number | bigint | null
  reply_text: string | number | bigint | Uint8Array | null
  reply_message_id: string | number | bigint | Uint8Array | null
  last_error: string | number | bigint | Uint8Array | null
  created_at: number | bigint | null
  updated_at: number | bigint | null
}

const JOB_COLUMNS = `job_id, conv_key, session_id, state, outcome, reply_to_message_id, collect_until,
  submitted_at, deadline_at, turn, next_attempt_at, submit_attempts, send_attempts, stop_requested,
  reply_text, reply_message_id, last_error, created_at, updated_at`

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function numberOrZero(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value)
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value)
}

function optionalText(value: unknown): string | undefined {
  const body = text(value)
  return body === '' ? undefined : body
}

/** One ledger over the inbox store's open connection. */
export class ReplyStore {
  private readonly db: DatabaseSync

  /**
   * @param db - the inbox store's open connection; never a second one.
   */
  constructor(db: DatabaseSync) {
    this.db = db
    // Foreign keys are off by default in SQLite and are a per-connection setting,
    // so the reference from a job to its conversation binding would not be
    // enforced without this line.
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(`CREATE TABLE IF NOT EXISTS conv_bindings (
      conv_key TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL CHECK (chat_type IN ('p2p','group')),
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
      session_id TEXT NOT NULL UNIQUE,
      preamble_sent INTEGER NOT NULL DEFAULT 0 CHECK (preamble_sent IN (0,1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS reply_jobs (
      job_id TEXT PRIMARY KEY CHECK (length(job_id) BETWEEN 4 AND 50),
      conv_key TEXT NOT NULL REFERENCES conv_bindings(conv_key),
      session_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN
        ('collecting','submitting','running','replying','replied','failed','cancelled','reply_uncertain')),
      outcome TEXT CHECK (outcome IN ('answer','empty','error','timeout','interrupted','stopped')),
      reply_to_message_id TEXT NOT NULL,
      collect_until INTEGER NOT NULL,
      submitted_at INTEGER,
      deadline_at INTEGER,
      turn INTEGER,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      submit_attempts INTEGER NOT NULL DEFAULT 0,
      send_attempts INTEGER NOT NULL DEFAULT 0,
      stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0,1)),
      reply_text TEXT,
      reply_message_id TEXT,
      end_reason TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    // Serialisation as a schema invariant: at most one collecting job and one
    // in-flight job per conversation. A caller that races itself hits a unique
    // violation instead of producing two concurrent turns in one chat.
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_collecting
      ON reply_jobs(conv_key) WHERE state = 'collecting'`)
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_inflight
      ON reply_jobs(conv_key) WHERE state IN ('submitting','running','replying')`)
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_reply_msg
      ON reply_jobs(reply_message_id) WHERE reply_message_id IS NOT NULL`)
    this.db.exec('CREATE INDEX IF NOT EXISTS ix_jobs_due ON reply_jobs(state, collect_until, deadline_at)')
    this.db.exec(`CREATE TABLE IF NOT EXISTS reply_job_messages (
      event_id TEXT PRIMARY KEY REFERENCES inbox_events(event_id),
      message_id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL REFERENCES reply_jobs(job_id),
      seq INTEGER NOT NULL,
      UNIQUE (job_id, seq)
    )`)
  }

  /**
   * Run a function inside one write transaction.
   *
   * `BEGIN IMMEDIATE` rather than plain `BEGIN`: the attach path reads a row and
   * then writes based on it, and a deferred transaction would let a second
   * writer read the same state before either commits.
   * @param work - the statements to run.
   * @returns whatever `work` returned.
   */
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* the original error is the one worth reporting */ }
      throw error
    }
  }

  /**
   * Read or create the conversation binding for a chat.
   *
   * @param input - chat identity and the session id to bind it to.
   * @returns the binding in force, which may predate this call.
   */
  ensureBinding(input: {
    convKey: string
    chatId: string
    chatType: 'p2p' | 'group'
    sessionId: string
    now: number
  }): ConversationBinding {
    const existing = this.binding(input.convKey)
    if (existing !== undefined) return existing
    this.db.prepare(`INSERT OR IGNORE INTO conv_bindings
      (conv_key, chat_id, chat_type, generation, session_id, preamble_sent, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, 0, ?, ?)`)
      .run(input.convKey, input.chatId, input.chatType, input.sessionId, input.now, input.now)
    const created = this.binding(input.convKey)
    if (created === undefined) throw new Error(`lark-inbox: conversation binding for ${input.convKey} could not be created`)
    return created
  }

  /**
   * Read one conversation binding.
   * @param convKey - conversation key.
   * @returns the binding, or undefined when this conversation never had a turn.
   */
  binding(convKey: string): ConversationBinding | undefined {
    const row = this.db.prepare(`SELECT conv_key, chat_id, chat_type, generation, session_id, preamble_sent
      FROM conv_bindings WHERE conv_key = ?`).get(convKey) as unknown as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      convKey: text(row.conv_key),
      chatId: text(row.chat_id),
      chatType: text(row.chat_type) === 'group' ? 'group' : 'p2p',
      generation: numberOrZero(row.generation),
      sessionId: text(row.session_id),
      preambleSent: numberOrZero(row.preamble_sent) === 1,
    }
  }

  /**
   * Mark the standing instructions as delivered for a conversation.
   *
   * Only the first prompt of a conversation carries them, so this is recorded
   * once and the steady state stays one short message per turn.
   * @param convKey - conversation key.
   * @param now - current time.
   */
  markPreambleSent(convKey: string, now: number): void {
    this.db.prepare('UPDATE conv_bindings SET preamble_sent = 1, updated_at = ? WHERE conv_key = ?').run(now, convKey)
  }

  /**
   * Start a new session for a conversation, forgetting the old one's context.
   *
   * The generation, not the session id, is what moves: the id stays derived from
   * the key so a restart resolves the same way it did before.
   * @param convKey - conversation key.
   * @param next - the session id to bind next.
   * @param now - current time.
   */
  rotateBinding(convKey: string, next: string, now: number): void {
    this.db.prepare(`UPDATE conv_bindings
      SET generation = generation + 1, session_id = ?, preamble_sent = 0, updated_at = ?
      WHERE conv_key = ?`).run(next, now, convKey)
  }

  /**
   * Attach one inbox message to the conversation's open batch, opening one if needed.
   *
   * One transaction: the queue row becomes `routed` and the job it now belongs to
   * exists, or neither happened. A redelivery returns `attached: false` and
   * changes nothing, which is what keeps a retried event id from opening a
   * second job.
   * @param input - the message, its conversation, and the batch window.
   * @returns the job it joined and whether that job was created here.
   */
  attach(input: {
    eventId: string
    messageId: string
    jobId: string
    convKey: string
    replyToMessageId: string
    now: number
    debounceMs: number
  }): AttachResult {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT job_id FROM reply_job_messages WHERE event_id = ?')
        .get(input.eventId) as unknown as { job_id?: unknown } | undefined
      if (existing !== undefined) return { jobId: text(existing.job_id), opened: false, attached: false }

      const open = this.db.prepare(`SELECT job_id, next_attempt_at FROM reply_jobs
        WHERE conv_key = ? AND state = 'collecting'`).get(input.convKey) as unknown as JobRow | undefined

      let jobId: string
      let opened = false
      if (open === undefined) {
        this.db.prepare(`INSERT INTO reply_jobs
          (job_id, conv_key, session_id, state, reply_to_message_id, collect_until, created_at, updated_at)
          VALUES (?, ?, '', 'collecting', ?, ?, ?, ?)`)
          .run(input.jobId, input.convKey, input.replyToMessageId, input.now + input.debounceMs, input.now, input.now)
        jobId = input.jobId
        opened = true
      } else {
        jobId = text(open.job_id)
        // The window extends with each new message, capped by the caller's own
        // ceiling so a fast typist cannot postpone the answer indefinitely.
        this.db.prepare(`UPDATE reply_jobs
          SET collect_until = MAX(collect_until, ?), reply_to_message_id = ?, updated_at = ?
          WHERE job_id = ?`).run(input.now + input.debounceMs, input.replyToMessageId, input.now, jobId)
      }

      const seq = numberOrZero((this.db.prepare('SELECT COUNT(*) AS n FROM reply_job_messages WHERE job_id = ?')
        .get(jobId) as unknown as { n?: unknown }).n)
      this.db.prepare('INSERT INTO reply_job_messages (event_id, message_id, job_id, seq) VALUES (?, ?, ?, ?)')
        .run(input.eventId, input.messageId, jobId, seq)
      // Ownership moves to the ledger; no claim path selects `routed`.
      this.db.prepare("UPDATE inbox_events SET status = 'routed', updated_at = ? WHERE event_id = ?")
        .run(input.now, input.eventId)
      return { jobId, opened, attached: true }
    })
  }

  /**
   * Read the message bodies belonging to a batch, in arrival order.
   * @param jobId - the batch.
   * @returns the stored payloads, decoded to their rendered text.
   */
  messagesOf(jobId: string): Array<{ eventId: string; messageId: string; text: string }> {
    const rows = this.db.prepare(`SELECT m.event_id, m.message_id, e.payload
      FROM reply_job_messages m JOIN inbox_events e ON e.event_id = m.event_id
      WHERE m.job_id = ? ORDER BY m.seq ASC`).all(jobId) as unknown as Array<Record<string, unknown>>
    return rows.map(row => {
      let body = ''
      try {
        const parsed: unknown = JSON.parse(text(row.payload))
        body = typeof parsed === 'object' && parsed !== null ? text((parsed as { content?: unknown }).content) : ''
      } catch { body = '' }
      return { eventId: text(row.event_id), messageId: text(row.message_id), text: body }
    })
  }

  /**
   * Read one job.
   * @param jobId - job id.
   * @returns the job, or undefined when no such job exists.
   */
  job(jobId: string): ReplyJob | undefined {
    const row = this.db.prepare(`SELECT ${JOB_COLUMNS} FROM reply_jobs WHERE job_id = ?`)
      .get(jobId) as unknown as JobRow | undefined
    return row === undefined ? undefined : toJob(row)
  }

  /**
   * List jobs a periodic sweep should act on.
   *
   * Two conditions in one query: a batch whose window closed, and a job whose
   * turn deadline passed. Both are "time to do something", which is why one
   * sweep drives both instead of two timers.
   * @param now - current time.
   * @returns the jobs to act on, oldest first.
   */
  dueJobs(now: number): ReplyJob[] {
    const rows = this.db.prepare(`SELECT ${JOB_COLUMNS} FROM reply_jobs
      WHERE (state = 'collecting' AND collect_until <= ? AND next_attempt_at <= ?)
         OR (state = 'submitting' AND next_attempt_at <= ?)
         OR (state = 'running' AND deadline_at IS NOT NULL AND deadline_at <= ?)
         OR (state = 'replying' AND next_attempt_at <= ?)
      ORDER BY updated_at ASC`).all(now, now, now, now, now) as unknown as JobRow[]
    return rows.map(toJob)
  }

  /**
   * Jobs still holding a conversation's turn slot.
   * @param convKey - conversation key.
   * @returns the in-flight job, when one exists.
   */
  inflightJob(convKey: string): ReplyJob | undefined {
    const row = this.db.prepare(`SELECT ${JOB_COLUMNS} FROM reply_jobs
      WHERE conv_key = ? AND state IN ('submitting','running','replying')`).get(convKey) as unknown as JobRow | undefined
    return row === undefined ? undefined : toJob(row)
  }

  /**
   * Move one collecting batch to submission.
   *
   * Refused when another job already holds the conversation's slot: the turn is
   * serial per chat, and the caller retries on the next sweep rather than
   * queueing a second concurrent turn.
   * @param jobId - the batch.
   * @param sessionId - the session the turn will run in.
   * @param now - current time.
   * @returns true when this call moved the job.
   */
  claimSubmit(jobId: string, sessionId: string, now: number): boolean {
    const job = this.job(jobId)
    if (job === undefined) return false
    if (this.inflightJob(job.convKey) !== undefined) return false
    const result = this.db.prepare(`UPDATE reply_jobs
      SET state = 'submitting', session_id = ?, submitted_at = ?, submit_attempts = submit_attempts + 1, updated_at = ?
      WHERE job_id = ? AND state = 'collecting'`).run(sessionId, now, now, jobId)
    return Number(result.changes) === 1
  }

  /**
   * Record that the batch now runs in a turn.
   * @param jobId - the job.
   * @param deadlineAt - when the turn is considered timed out.
   * @param now - current time.
   */
  markRunning(jobId: string, deadlineAt: number, now: number): void {
    this.db.prepare(`UPDATE reply_jobs SET state = 'running', deadline_at = ?, updated_at = ?
      WHERE job_id = ? AND state = 'submitting'`).run(deadlineAt, now, jobId)
  }

  /**
   * Put a failed submission back for a later retry.
   *
   * Attempts are counted by {@link claimSubmit}; this only schedules the retry,
   * because a fixed immediate retry against a broken provider is a busy loop.
   * @param jobId - the job.
   * @param error - why the submission failed.
   * @param nextAttemptAt - earliest time to try again.
   * @param now - current time.
   */
  deferSubmit(jobId: string, error: string, nextAttemptAt: number, now: number): void {
    this.db.prepare(`UPDATE reply_jobs SET state = 'collecting', last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE job_id = ? AND state = 'submitting'`).run(error, nextAttemptAt, now, jobId)
  }

  /**
   * Bind the turn number once the turn is observable.
   *
   * The prompt is accepted before the engine reports a turn, so the number is
   * learned from the event stream rather than returned by the call.
   * @param jobId - the job.
   * @param turn - the turn number.
   * @param now - current time.
   */
  bindTurn(jobId: string, turn: number, now: number): void {
    this.db.prepare('UPDATE reply_jobs SET turn = ?, updated_at = ? WHERE job_id = ? AND turn IS NULL')
      .run(turn, now, jobId)
  }

  /**
   * Find the running job a turn belongs to.
   * @param sessionId - the session the turn runs in.
   * @param turn - the turn number.
   * @returns the matching job, if one is waiting for this turn.
   */
  jobByTurn(sessionId: string, turn: number): ReplyJob | undefined {
    const row = this.db.prepare(`SELECT ${JOB_COLUMNS} FROM reply_jobs
      WHERE session_id = ? AND turn = ? AND state = 'running'`).get(sessionId, turn) as unknown as JobRow | undefined
    return row === undefined ? undefined : toJob(row)
  }

  /**
   * Find the job a session is currently running.
   * @param sessionId - session id.
   * @returns the running job, when one exists.
   */
  runningJobForSession(sessionId: string): ReplyJob | undefined {
    const row = this.db.prepare(`SELECT ${JOB_COLUMNS} FROM reply_jobs
      WHERE session_id = ? AND state = 'running'`).get(sessionId) as unknown as JobRow | undefined
    return row === undefined ? undefined : toJob(row)
  }

  /**
   * Mark a running turn as cancelled-by-timeout and start its grace period.
   *
   * The marker in `last_error` is what lets the sweep tell "we asked it to stop"
   * from "it was stopped for another reason" when the engine's own `turn/end`
   * arrives; the deadline moving forward is the grace expiry.
   * @param jobId - the running job.
   * @param marker - the marker to record.
   * @param graceUntil - when the grace period ends.
   * @param now - current time.
   * @returns true when this call marked it.
   */
  markTimeoutPending(jobId: string, marker: string, graceUntil: number, now: number): boolean {
    const result = this.db.prepare(`UPDATE reply_jobs
      SET last_error = ?, deadline_at = ?, updated_at = ?
      WHERE job_id = ? AND state = 'running'`).run(marker, graceUntil, now, jobId)
    return Number(result.changes) === 1
  }

  /**
   * Move a finished turn to the send step.
   * @param jobId - the job.
   * @param outcome - how the turn ended.
   * @param replyText - what to send.
   * @param endReason - the engine's own reason, kept for diagnosis.
   * @param now - current time.
   * @returns true when this call moved the job.
   */
  finishTurn(jobId: string, outcome: ReplyOutcome, replyText: string, endReason: string, now: number): boolean {
    const result = this.db.prepare(`UPDATE reply_jobs
      SET state = 'replying', outcome = ?, reply_text = ?, last_error = NULL, end_reason = ?,
          next_attempt_at = 0, updated_at = ?
      WHERE job_id = ? AND state = 'running'`).run(outcome, replyText, endReason, now, jobId)
    return Number(result.changes) === 1
  }

  /**
   * Record a delivered answer and settle the messages it answered.
   * @param jobId - the job.
   * @param messageId - the Feishu message id the answer created, when known.
   * @param now - current time.
   */
  markSent(jobId: string, messageId: string | undefined, now: number): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE reply_jobs SET state = 'replied', reply_message_id = ?, updated_at = ?
        WHERE job_id = ?`).run(messageId === undefined || messageId === '' ? null : messageId, now, jobId)
      this.db.prepare(`UPDATE inbox_events SET status = 'done', updated_at = ?
        WHERE event_id IN (SELECT event_id FROM reply_job_messages WHERE job_id = ?)`).run(now, jobId)
    })
  }

  /**
   * Record a send that must not be retried, and retire its messages.
   * @param jobId - the job.
   * @param error - why it failed.
   * @param now - current time.
   */
  markSendFailed(jobId: string, error: string, now: number): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE reply_jobs SET state = 'failed', last_error = ?, updated_at = ?
        WHERE job_id = ?`).run(error, now, jobId)
      this.db.prepare(`UPDATE inbox_events SET status = 'dead', updated_at = ?
        WHERE event_id IN (SELECT event_id FROM reply_job_messages WHERE job_id = ?)`).run(now, jobId)
    })
  }

  /**
   * Schedule another send attempt.
   * @param jobId - the job.
   * @param error - why the last attempt failed.
   * @param nextAttemptAt - earliest time to try again.
   * @param now - current time.
   */
  deferSend(jobId: string, error: string, nextAttemptAt: number, now: number): void {
    this.db.prepare(`UPDATE reply_jobs SET last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE job_id = ? AND state = 'replying'`).run(error, nextAttemptAt, now, jobId)
  }

  /**
   * Count one send attempt and return the new total.
   *
   * Counted here rather than when the turn finished, because a retry after a
   * transport failure is a second attempt against the platform and only this
   * counter can bound that loop.
   * @param jobId - the job being sent.
   * @returns attempts including this one, or 0 when the job is gone.
   */
  bumpSendAttempt(jobId: string): number {
    this.db.prepare('UPDATE reply_jobs SET send_attempts = send_attempts + 1 WHERE job_id = ?').run(jobId)
    const row = this.db.prepare('SELECT send_attempts FROM reply_jobs WHERE job_id = ?')
      .get(jobId) as unknown as { send_attempts?: unknown } | undefined
    return numberOrZero(row?.send_attempts)
  }

  /**
   * Cancel a batch that never ran, and retire its messages.
   * @param jobId - the job.
   * @param reason - operator-facing reason.
   * @param now - current time.
   * @returns true when this call cancelled it.
   */
  cancelCollecting(jobId: string, reason: string, now: number): boolean {
    const result = this.db.prepare(`UPDATE reply_jobs SET state = 'cancelled', last_error = ?, updated_at = ?
      WHERE job_id = ? AND state = 'collecting'`).run(reason, now, jobId)
    if (Number(result.changes) !== 1) return false
    this.db.prepare(`UPDATE inbox_events SET status = 'done', updated_at = ?
      WHERE event_id IN (SELECT event_id FROM reply_job_messages WHERE job_id = ?)`).run(now, jobId)
    return true
  }

  /**
   * Cancel every open batch in a conversation.
   * @param convKey - conversation key.
   * @param reason - operator-facing reason.
   * @param now - current time.
   * @returns how many batches were cancelled.
   */
  cancelCollectingFor(convKey: string, reason: string, now: number): number {
    const rows = this.db.prepare("SELECT job_id FROM reply_jobs WHERE conv_key = ? AND state = 'collecting'")
      .all(convKey) as unknown as Array<{ job_id?: unknown }>
    let cancelled = 0
    for (const row of rows) {
      if (this.cancelCollecting(text(row.job_id), reason, now)) cancelled += 1
    }
    return cancelled
  }

  /**
   * Ask the in-flight turn of a conversation to stop.
   * @param convKey - conversation key.
   * @param now - current time.
   * @returns the job marked for stopping, when one was running.
   */
  requestStop(convKey: string, now: number): ReplyJob | undefined {
    const inflight = this.inflightJob(convKey)
    if (inflight === undefined) return undefined
    this.db.prepare('UPDATE reply_jobs SET stop_requested = 1, updated_at = ? WHERE job_id = ?').run(now, inflight.jobId)
    return inflight
  }

  /**
   * Whether a stop was requested for a job.
   * @param jobId - the job.
   * @returns true when the person asked it to stop.
   */
  stopRequested(jobId: string): boolean {
    const row = this.db.prepare('SELECT stop_requested FROM reply_jobs WHERE job_id = ?')
      .get(jobId) as unknown as { stop_requested?: unknown } | undefined
    return numberOrZero(row?.stop_requested) === 1
  }

  /**
   * Mark a turn whose send result is unknowable.
   *
   * Reached when a send was in flight at the moment the process died long enough
   * ago that the platform's own idempotency window has certainly expired. Sending
   * again would risk a visible duplicate, so the job stops here and says so.
   * @param jobId - the job.
   * @param reason - why it is uncertain.
   * @param now - current time.
   */
  markReplyUncertain(jobId: string, reason: string, now: number): void {
    this.db.prepare(`UPDATE reply_jobs SET state = 'reply_uncertain', last_error = ?, updated_at = ?
      WHERE job_id = ?`).run(reason, now, jobId)
  }

  /**
   * Resolve jobs left mid-flight by a previous process.
   *
   * Two different answers, because two different risks: a turn that already
   * reached the engine has possibly executed side effects, so it is not re-run -
   * the person is told it was interrupted. A send that had not started is safe to
   * retry, because nothing was delivered.
   * @param now - current time.
   * @param uncertainAfterMs - how long a `replying` job may sit before its
   *   delivery must be treated as unknown.
   * @returns counts of what was recovered.
   */
  recoverInflight(now: number, uncertainAfterMs: number): { interrupted: number; resendable: number; uncertain: number } {
    const rows = this.db.prepare(`SELECT ${JOB_COLUMNS} FROM reply_jobs
      WHERE state IN ('submitting','running','replying')`).all() as unknown as JobRow[]
    let interrupted = 0
    let resendable = 0
    let uncertain = 0
    for (const row of rows) {
      const job = toJob(row)
      if (job.state === 'submitting') {
        // Never reached the engine: safe to collect and try again.
        this.db.prepare(`UPDATE reply_jobs SET state = 'collecting', last_error = ?, next_attempt_at = 0, updated_at = ?
          WHERE job_id = ? AND state = 'submitting'`).run('进程重启前未提交成功', now, job.jobId)
        resendable += 1
        continue
      }
      if (job.state === 'running') {
        // The turn may have run tools already; re-running it would repeat side
        // effects, so it becomes an explained interruption instead.
        this.finishTurn(job.jobId, 'interrupted', fallbackText(job), 'recovered-after-restart', now)
        interrupted += 1
        continue
      }
      const age = now - job.updatedAt
      if (age >= uncertainAfterMs) {
        this.markReplyUncertain(job.jobId, '重启前已在发送，无法确定是否送达', now)
        uncertain += 1
        continue
      }
      // Within the platform's idempotency window: the retry carries the same
      // uuid, so the platform collapses it instead of delivering twice.
      this.db.prepare(`UPDATE reply_jobs SET next_attempt_at = ?, updated_at = ? WHERE job_id = ?`)
        .run(0, now, job.jobId)
      resendable += 1
    }
    return { interrupted, resendable, uncertain }
  }

  /**
   * Counts per state, for the acceptance readings.
   * @returns per-state counts.
   */
  stats(): ReplyStoreStats {
    const rows = this.db.prepare('SELECT state, COUNT(*) AS n FROM reply_jobs GROUP BY state')
      .all() as unknown as Array<{ state?: unknown; n?: unknown }>
    const counts: Record<string, number> = {}
    for (const row of rows) counts[text(row.state)] = numberOrZero(row.n)
    const at = (state: ReplyJobState): number => counts[state] ?? 0
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
    return {
      collecting: at('collecting'),
      submitting: at('submitting'),
      running: at('running'),
      replying: at('replying'),
      replied: at('replied'),
      failed: at('failed'),
      cancelled: at('cancelled'),
      replyUncertain: at('reply_uncertain'),
      total,
    }
  }
}

/**
 * The sentence an interrupted turn sends, kept next to the recovery that writes
 * it so the reason and the wording cannot drift apart.
 * @param job - the job being interrupted.
 * @returns the body to send.
 */
function fallbackText(job: ReplyJob): string {
  return job.replyText !== undefined && job.replyText !== ''
    ? job.replyText
    : '上一次处理被中断了，我没有重跑它，因为那可能重复执行副作用。请再发一次。'
}

/**
 * Decode one row into the shape callers read.
 * @param row - raw row.
 * @returns the job.
 */
function toJob(row: JobRow): ReplyJob {
  const state = text(row.state) as ReplyJobState
  const outcome = optionalText(row.outcome) as ReplyOutcome | undefined
  return {
    jobId: text(row.job_id),
    convKey: text(row.conv_key),
    sessionId: text(row.session_id),
    state,
    ...(outcome === undefined ? {} : { outcome }),
    replyToMessageId: text(row.reply_to_message_id),
    collectUntil: numberOrZero(row.collect_until),
    ...(optionalNumber(row.submitted_at) === undefined ? {} : { submittedAt: numberOrZero(row.submitted_at) }),
    ...(optionalNumber(row.deadline_at) === undefined ? {} : { deadlineAt: numberOrZero(row.deadline_at) }),
    ...(optionalNumber(row.turn) === undefined ? {} : { turn: numberOrZero(row.turn) }),
    nextAttemptAt: numberOrZero(row.next_attempt_at),
    submitAttempts: numberOrZero(row.submit_attempts),
    sendAttempts: numberOrZero(row.send_attempts),
    stopRequested: numberOrZero(row.stop_requested) === 1,
    ...(optionalText(row.reply_text) === undefined ? {} : { replyText: text(row.reply_text) }),
    ...(optionalText(row.reply_message_id) === undefined ? {} : { replyMessageId: text(row.reply_message_id) }),
    ...(optionalText(row.last_error) === undefined ? {} : { lastError: text(row.last_error) }),
    createdAt: numberOrZero(row.created_at),
    updatedAt: numberOrZero(row.updated_at),
  }
}