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
/** What asked for this job: a person's message, or the answer path noticing something. */
export type ReplyJobKind = 'request' | 'proactive'

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
  /**
   * Hash of the standing instructions this conversation has been told.
   *
   * Absent on a binding created before instructions were versioned: those rows keep
   * the old "told once" rule, which is what leaves the feature switched off behaving
   * exactly as it did.
   */
  readonly preambleHash?: string
}

/** One job row as callers read it. */
export interface ReplyJob {
  readonly jobId: string
  readonly convKey: string
  readonly sessionId: string
  readonly kind: ReplyJobKind
  /** Whether this job's answer may be sent; fixed when the job was opened. */
  readonly deliver: boolean
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
  /** How the answer reached the person: as text, or as a reaction on their message. */
  readonly replyVia?: 'text' | 'reaction'
  readonly lastError?: string
  /**
   * When a turn that still owed a steer ended, and the job is waiting for the turn
   * the engine opens to consume it. Non-null means "hold the slot, do not answer".
   */
  readonly carryUntil?: number
  /** Text the earlier turn had produced, joined into the reply that finally closes. */
  readonly carryText?: string
  /** The turn this job first bound to, kept for diagnosis across a carry. */
  readonly firstTurn?: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** What a member row says about a steer, when it is one. */
export type SteerState = 'none' | 'pending' | 'consumed' | 'returned' | 'stranded'

/** One message belonging to a job, with its steer bookkeeping. */
export interface JobMessage {
  readonly eventId: string
  readonly messageId: string
  readonly text: string
  readonly steerState: SteerState
  readonly steerRequestId?: string
  readonly steerTurn?: number
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
  kind?: string | number | bigint | Uint8Array | null
  deliver?: number | bigint | null
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
  carry_until: number | bigint | null
  carry_text: string | number | bigint | Uint8Array | null
  first_turn: number | bigint | null
  reply_via: string | number | bigint | Uint8Array | null
  created_at: number | bigint | null
  updated_at: number | bigint | null
}

const JOB_COLUMNS = `job_id, conv_key, session_id, kind, deliver, state, outcome, reply_to_message_id, collect_until,
  submitted_at, deadline_at, turn, next_attempt_at, submit_attempts, send_attempts, stop_requested,
  reply_text, reply_message_id, last_error, carry_until, carry_text, first_turn, reply_via, created_at, updated_at`

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

/** Read a member's steer state, defaulting to the ordinary case. */
function toSteerState(value: unknown): SteerState {
  switch (text(value)) {
    case 'pending': return 'pending'
    case 'consumed': return 'consumed'
    case 'returned': return 'returned'
    case 'stranded': return 'stranded'
    default: return 'none'
  }
}

/**
 * Whether a failed statement was refused by a uniqueness rule.
 *
 * `node:sqlite` reports these as a plain error whose message names the constraint;
 * the code is shared with syntax and IO failures, so the message is what separates
 * "this row already exists" from "this statement is wrong".
 * @param error - whatever a statement threw.
 * @returns true when a unique or primary-key constraint refused the write.
 */
function isConstraintViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('UNIQUE constraint failed') || message.includes('PRIMARY KEY constraint failed')
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
    // Added after the first installations existed, so it is migrated in place
    // rather than assumed: a host that already has jobs must keep working.
    const jobColumns = this.db.prepare('PRAGMA table_info(reply_jobs)').all() as unknown as Array<{ name?: unknown }>
    if (!jobColumns.some(column => text(column.name) === 'kind')) {
      this.db.exec("ALTER TABLE reply_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'request'")
    }
    // Whether this job's answer may leave the host, decided when the message was
    // accepted rather than when it is sent: switching the mode to probe must not
    // silently retract replies already promised to someone.
    if (!jobColumns.some(column => text(column.name) === 'deliver')) {
      this.db.exec('ALTER TABLE reply_jobs ADD COLUMN deliver INTEGER NOT NULL DEFAULT 1')
    }
    // A proactive job has no message to answer, so its reply target is nullable at
    // the schema level too; the old NOT NULL is left in place for request jobs and
    // enforced by the insert paths rather than by the column, because SQLite cannot
    // relax a constraint in place.
    this.db.exec(`CREATE TABLE IF NOT EXISTS reply_job_messages (
      event_id TEXT PRIMARY KEY REFERENCES inbox_events(event_id),
      message_id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL REFERENCES reply_jobs(job_id),
      seq INTEGER NOT NULL,
      UNIQUE (job_id, seq)
    )`)
    // Steer bookkeeping, added in place for the same reason as the two columns
    // above: an installation that already holds jobs must keep working, and the
    // `state` CHECK cannot be widened, so a steered message is still an ordinary
    // member of its job and only these columns say otherwise.
    const messageColumns = this.db.prepare('PRAGMA table_info(reply_job_messages)').all() as unknown as Array<{ name?: unknown }>
    if (!messageColumns.some(column => text(column.name) === 'steer_state')) {
      this.db.exec(`ALTER TABLE reply_job_messages ADD COLUMN steer_state TEXT NOT NULL DEFAULT 'none'
        CHECK (steer_state IN ('none','pending','consumed','returned','stranded'))`)
    }
    if (!messageColumns.some(column => text(column.name) === 'steer_request_id')) {
      this.db.exec('ALTER TABLE reply_job_messages ADD COLUMN steer_request_id TEXT')
    }
    if (!messageColumns.some(column => text(column.name) === 'steer_turn')) {
      this.db.exec('ALTER TABLE reply_job_messages ADD COLUMN steer_turn INTEGER')
    }
    if (!messageColumns.some(column => text(column.name) === 'steered_at')) {
      this.db.exec('ALTER TABLE reply_job_messages ADD COLUMN steered_at INTEGER')
    }
    // One request id, one member: a retried steer collapses on the engine's own
    // deduplication, and this index is what makes that identity local as well.
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_msgs_steer_req
      ON reply_job_messages(steer_request_id) WHERE steer_request_id IS NOT NULL`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS ix_msgs_steer_pending
      ON reply_job_messages(job_id) WHERE steer_state = 'pending'`)
    // A job that must survive the turn that ended under it. `carry_until` is the
    // wake-up time for the turn the engine opens to consume the steer it never got
    // to; `carry_text` is the part of the answer already produced, so the reply that
    // finally closes covers both turns instead of dropping the first half.
    if (!jobColumns.some(column => text(column.name) === 'carry_until')) {
      this.db.exec('ALTER TABLE reply_jobs ADD COLUMN carry_until INTEGER')
    }
    if (!jobColumns.some(column => text(column.name) === 'carry_text')) {
      this.db.exec('ALTER TABLE reply_jobs ADD COLUMN carry_text TEXT')
    }
    if (!jobColumns.some(column => text(column.name) === 'first_turn')) {
      this.db.exec('ALTER TABLE reply_jobs ADD COLUMN first_turn INTEGER')
    }
    // How an answer reached the person. A reaction carries no text, so the row has
    // to say which one it was; `outcome` keeps meaning "what the turn produced" and
    // its CHECK stays untouched.
    if (!jobColumns.some(column => text(column.name) === 'reply_via')) {
      this.db.exec(`ALTER TABLE reply_jobs ADD COLUMN reply_via TEXT NOT NULL DEFAULT 'text'
        CHECK (reply_via IN ('text','reaction'))`)
    }
    // Which standing instructions a conversation has been told, rather than only
    // whether it has been told any. A boolean meant a conversation that started
    // before a contract existed could never receive it.
    const bindingColumns = this.db.prepare('PRAGMA table_info(conv_bindings)').all() as unknown as Array<{ name?: unknown }>
    if (!bindingColumns.some(column => text(column.name) === 'preamble_hash')) {
      this.db.exec('ALTER TABLE conv_bindings ADD COLUMN preamble_hash TEXT')
    }
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
    const row = this.db.prepare(`SELECT conv_key, chat_id, chat_type, generation, session_id, preamble_sent, preamble_hash
      FROM conv_bindings WHERE conv_key = ?`).get(convKey) as unknown as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      convKey: text(row.conv_key),
      chatId: text(row.chat_id),
      chatType: text(row.chat_type) === 'group' ? 'group' : 'p2p',
      generation: numberOrZero(row.generation),
      sessionId: text(row.session_id),
      preambleSent: numberOrZero(row.preamble_sent) === 1,
      ...(optionalText(row.preamble_hash) === undefined ? {} : { preambleHash: text(row.preamble_hash) }),
    }
  }

  /**
   * The conversation an unprompted message would go to.
   *
   * The most recently active direct conversation: that is the chat the person
   * actually talks to this bot in, and the only defensible guess when a notice has
   * no message behind it to name a target.
   * @returns the binding, or undefined when nobody has ever written in.
   */
  latestDirectBinding(): ConversationBinding | undefined {
    const row = this.db.prepare(`SELECT conv_key, chat_id, chat_type, generation, session_id, preamble_sent, preamble_hash
      FROM conv_bindings WHERE chat_type = 'p2p' ORDER BY updated_at DESC LIMIT 1`)
      .get() as unknown as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      convKey: text(row.conv_key),
      chatId: text(row.chat_id),
      chatType: 'p2p',
      generation: numberOrZero(row.generation),
      sessionId: text(row.session_id),
      preambleSent: numberOrZero(row.preamble_sent) === 1,
      ...(optionalText(row.preamble_hash) === undefined ? {} : { preambleHash: text(row.preamble_hash) }),
    }
  }

  /**
   * Record which standing instructions a conversation has been told.
   *
   * `preamble_sent` stays set as well, because a build from before instructions were
   * versioned reads only that flag; the hash is what the current build compares, so a
   * conversation that was told an older contract can still be told the new one.
   * @param convKey - conversation key.
   * @param hash - hash of the instructions that were sent.
   * @param now - current time.
   */
  markPreambleSent(convKey: string, hash: string, now: number): void {
    this.db.prepare('UPDATE conv_bindings SET preamble_sent = 1, preamble_hash = ?, updated_at = ? WHERE conv_key = ?')
      .run(hash, now, convKey)
  }

  /**
   * When this conversation last had an answer sent in it.
   *
   * Used for the one line of conversational metadata a turn is given, so the model
   * can tell "you replied a moment ago" from "this person is coming back after a
   * day", which are different conversations. Read from the replies themselves rather
   * than from the binding's `updated_at`, which moves for unrelated writes.
   * @param convKey - conversation key.
   * @returns epoch milliseconds of the last reply, or undefined when there is none.
   */
  lastSpokeAt(convKey: string): number | undefined {
    const row = this.db.prepare(`SELECT MAX(updated_at) AS last FROM reply_jobs
      WHERE conv_key = ? AND state = 'replied'`).get(convKey) as unknown as { last?: unknown } | undefined
    return optionalNumber(row?.last)
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
    /** Whether this conversation's answers may be sent, fixed now. */
    deliver?: boolean
  }): AttachResult {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT job_id FROM reply_job_messages WHERE event_id = ?')
        .get(input.eventId) as unknown as { job_id?: unknown } | undefined
      if (existing !== undefined) return { jobId: text(existing.job_id), opened: false, attached: false }

      // Only a request batch may collect messages. A proactive job has no message
      // behind it and its prompt never quotes one, so joining a real question to it
      // would answer the wrong thing - or, with SILENT, mark the question done and
      // send nothing.
      const open = this.db.prepare(`SELECT job_id, next_attempt_at FROM reply_jobs
        WHERE conv_key = ? AND state = 'collecting' AND kind = 'request'`)
        .get(input.convKey) as unknown as JobRow | undefined

      let jobId: string
      let opened = false
      if (open === undefined) {
        this.db.prepare(`INSERT INTO reply_jobs
          (job_id, conv_key, session_id, deliver, state, reply_to_message_id, collect_until, created_at, updated_at)
          VALUES (?, ?, '', ?, 'collecting', ?, ?, ?, ?)`)
          .run(
            input.jobId,
            input.convKey,
            input.deliver === false ? 0 : 1,
            input.replyToMessageId,
            input.now + input.debounceMs,
            input.now,
            input.now,
          )
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
      // Touch the conversation: `latestDirectBinding()` answers "which chat is this
      // person actually using", and a binding created once and never updated would
      // point at whichever chat happened to be new first.
      this.db.prepare('UPDATE conv_bindings SET updated_at = ? WHERE conv_key = ?').run(input.now, input.convKey)
      return { jobId, opened, attached: true }
    })
  }

  /**
   * Open a proactive job for a conversation, if the budget allows it.
   *
   * Not a message that arrived: nothing asked for this, so there is no reply target
   * and no batch to collect. The job exists so the turn that decides whether to
   * speak is recorded exactly like any other, and so silence has somewhere to be
   * counted rather than being invisible.
   * @param input - conversation, session, and the budget window.
   * @returns the job id, or undefined when the budget is spent.
   */
  openProactive(input: {
    jobId: string
    convKey: string
    sessionId: string
    now: number
    windowMs: number
    max: number
    /** Whether this notice may be sent, fixed now. */
    deliver?: boolean
  }): string | undefined {
    const recent = this.db.prepare(`SELECT COUNT(*) AS n FROM reply_jobs
      WHERE kind = 'proactive' AND created_at >= ?`).get(input.now - input.windowMs) as unknown as { n?: unknown }
    if (numberOrZero(recent.n) >= input.max) return undefined
    this.db.prepare(`INSERT INTO reply_jobs
      (job_id, conv_key, session_id, kind, deliver, state, reply_to_message_id, collect_until, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, '', 'proactive', ?, 'collecting', '', ?, 0, ?, ?)`)
      .run(input.jobId, input.convKey, input.deliver === false ? 0 : 1, input.now, input.now, input.now)
    return input.jobId
  }

  /**
   * Whether a session has already spoken unprompted recently.
   *
   * The budget is per conversation, not per session: what a person experiences is
   * how often their chat gets an unasked-for message.
   * @param convKey - conversation key.
   * @param since - epoch milliseconds.
   * @returns how many proactive jobs were opened since then.
   */
  proactiveCountSince(convKey: string, since: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM reply_jobs
      WHERE kind = 'proactive' AND conv_key = ? AND created_at >= ?`).get(convKey, since) as unknown as { n?: unknown }
    return numberOrZero(row.n)
  }

  /**
   * Counts for proactive jobs: how many were opened, and how many chose silence.
   * @returns the counts the acceptance readings report.
   */
  proactiveStats(): { opened: number; spoke: number; silent: number } {
    const rows = this.db.prepare(`SELECT state, outcome, COUNT(*) AS n FROM reply_jobs
      WHERE kind = 'proactive' GROUP BY state, outcome`).all() as unknown as Array<{
        state?: unknown
        outcome?: unknown
        n?: unknown
      }>
    let opened = 0
    let spoke = 0
    let silent = 0
    for (const row of rows) {
      const count = numberOrZero(row.n)
      opened += count
      if (text(row.state) === 'replied' && text(row.outcome) === 'answer') spoke += count
      if (text(row.state) === 'replied' && text(row.outcome) === 'empty') silent += count
    }
    return { opened, spoke, silent }
  }

  /**
   * Read the message bodies belonging to a batch, in arrival order.
   * @param jobId - the batch.
   * @returns the stored payloads, decoded to their rendered text.
   */
  messagesOf(jobId: string): JobMessage[] {
    const rows = this.db.prepare(`SELECT m.event_id, m.message_id, m.steer_state, m.steer_request_id, m.steer_turn, e.payload
      FROM reply_job_messages m JOIN inbox_events e ON e.event_id = m.event_id
      WHERE m.job_id = ? ORDER BY m.seq ASC`).all(jobId) as unknown as Array<Record<string, unknown>>
    return rows.map(row => {
      let body = ''
      try {
        const parsed: unknown = JSON.parse(text(row.payload))
        body = typeof parsed === 'object' && parsed !== null ? text((parsed as { content?: unknown }).content) : ''
      } catch { body = '' }
      return {
        eventId: text(row.event_id),
        messageId: text(row.message_id),
        text: body,
        steerState: toSteerState(row.steer_state),
        ...(optionalText(row.steer_request_id) === undefined ? {} : { steerRequestId: text(row.steer_request_id) }),
        ...(optionalNumber(row.steer_turn) === undefined ? {} : { steerTurn: numberOrZero(row.steer_turn) }),
      }
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
         OR (state = 'submitting' AND deadline_at IS NOT NULL AND deadline_at <= ?)
         OR (state = 'running' AND deadline_at IS NOT NULL AND deadline_at <= ?)
         OR (state = 'running' AND carry_until IS NOT NULL AND carry_until <= ?)
         OR (state = 'replying' AND next_attempt_at <= ?)
      ORDER BY updated_at ASC`).all(now, now, now, now, now, now) as unknown as JobRow[]
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
  claimSubmit(jobId: string, sessionId: string, now: number, deadlineAt: number): boolean {
    const job = this.job(jobId)
    if (job === undefined) return false
    if (this.inflightJob(job.convKey) !== undefined) return false
    // A deadline covers the submission itself, not just the turn: the engine call
    // can pend forever, and a submission nobody closes would leave the person with
    // silence while the job holds the conversation's only turn slot.
    const result = this.db.prepare(`UPDATE reply_jobs
      SET state = 'submitting', session_id = ?, submitted_at = ?, deadline_at = ?,
          submit_attempts = submit_attempts + 1, updated_at = ?
      WHERE job_id = ? AND state = 'collecting'`).run(sessionId, now, deadlineAt, now, jobId)
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
   * Close a job whose turn never started, with something to send.
   *
   * The pre-turn states are deliberately the ones with no bound turn: once a turn
   * exists, only that turn's own end may close it, because the run may already
   * have executed tools.
   * @param jobId - the job.
   * @param outcome - how it ended.
   * @param text - the body to send.
   * @param now - current time.
   * @returns true when this call closed it.
   */
  failPreTurn(jobId: string, outcome: ReplyOutcome, text: string, now: number): boolean {
    const result = this.db.prepare(`UPDATE reply_jobs
      SET state = 'replying', outcome = ?, reply_text = ?, next_attempt_at = 0, updated_at = ?
      WHERE job_id = ? AND state IN ('collecting','submitting','running') AND turn IS NULL`).run(outcome, text, now, jobId)
    return Number(result.changes) === 1
  }

  /**
   * Put a turn that never bound itself back into the batch.
   *
   * The job is marked running *before* the prompt is handed over, because the
   * engine can open the turn and finish it before the call returns; a later mark
   * would orphan those events. That ordering needs an undo for the synchronous
   * failure: a job that never bound a turn is still a submission that failed, and
   * retrying it is correct. Once a turn is bound, the run happened and only the
   * turn's own end may close it.
   * @param jobId - the job.
   * @param error - why the submission failed.
   * @param nextAttemptAt - earliest time to try again.
   * @param now - current time.
   * @returns true when this call moved it.
   */
  revertRun(jobId: string, error: string, nextAttemptAt: number, now: number): boolean {
    const job = this.job(jobId)
    if (job === undefined) return false
    // A newer batch may already hold the conversation's collecting slot, and the
    // update below would then violate `ux_jobs_collecting` and throw out of the whole
    // sweep - parking every job behind it. Fold this one into that batch instead: the
    // person gets one answer covering both questions.
    const collecting = this.db.prepare(`SELECT job_id FROM reply_jobs
      WHERE conv_key = ? AND state = 'collecting' AND kind = 'request' AND job_id <> ?`)
      .get(job.convKey, jobId) as unknown as { job_id?: unknown } | undefined
    if (collecting !== undefined) {
      const target = text(collecting.job_id)
      return this.transaction(() => {
        const base = numberOrZero((this.db.prepare('SELECT COUNT(*) AS n FROM reply_job_messages WHERE job_id = ?')
          .get(target) as unknown as { n?: unknown }).n)
        const members = this.db.prepare('SELECT event_id FROM reply_job_messages WHERE job_id = ? ORDER BY seq ASC')
          .all(jobId) as unknown as Array<{ event_id?: unknown }>
        for (const [index, member] of members.entries()) {
          this.db.prepare('UPDATE reply_job_messages SET job_id = ?, seq = ? WHERE event_id = ?')
            .run(target, base + index, text(member.event_id))
        }
        this.db.prepare('DELETE FROM reply_jobs WHERE job_id = ?').run(jobId)
        this.db.prepare('UPDATE reply_jobs SET last_error = ?, updated_at = ? WHERE job_id = ?').run(error, now, target)
        return true
      })
    }
    const result = this.db.prepare(`UPDATE reply_jobs
      SET state = 'collecting', last_error = ?, next_attempt_at = ?, deadline_at = NULL, updated_at = ?
      WHERE job_id = ? AND state IN ('submitting','running') AND turn IS NULL`).run(error, nextAttemptAt, now, jobId)
    return Number(result.changes) === 1
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
    this.db.prepare(`UPDATE reply_jobs SET turn = ?, first_turn = COALESCE(first_turn, ?), updated_at = ?
      WHERE job_id = ? AND turn IS NULL`).run(turn, turn, now, jobId)
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
   * @param nextAttemptAt - when a sweep may retry the send. Pass a future time
   *   when the caller sends immediately: otherwise the next sweep picks the job up
   *   while that send is still in flight and the platform sees two requests. The
   *   duplicate collapses on its `uuid`, but a slow send would still be issued
   *   twice, and a stalled one would be issued again before anyone knows it failed.
   * @param via - how the answer reaches the person; a reaction carries no text.
   * @returns true when this call moved the job.
   */
  finishTurn(
    jobId: string,
    outcome: ReplyOutcome,
    replyText: string,
    endReason: string,
    now: number,
    nextAttemptAt = 0,
    via: 'text' | 'reaction' = 'text',
  ): boolean {
    const result = this.db.prepare(`UPDATE reply_jobs
      SET state = 'replying', outcome = ?, reply_text = ?, last_error = NULL, end_reason = ?,
          next_attempt_at = ?, carry_until = NULL, reply_via = ?, updated_at = ?
      WHERE job_id = ? AND state = 'running'`).run(outcome, replyText, endReason, nextAttemptAt, via, now, jobId)
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
      // Guarded: a slow request can settle after the job was already closed, and a
      // late success must not resurrect it.
      this.db.prepare(`UPDATE reply_jobs SET state = 'replied', reply_message_id = ?, updated_at = ?
        WHERE job_id = ? AND state IN ('replying','running')`)
        .run(messageId === undefined || messageId === '' ? null : messageId, now, jobId)
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
        WHERE job_id = ? AND state IN ('replying','running')`).run(error, now, jobId)
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
   * How many batches are already collecting in a conversation.
   *
   * A steer must not overtake them: the message that arrives while a batch is open
   * belongs behind the batch the person's earlier line opened, or two messages sent
   * a second apart would be answered in the wrong order.
   * @param convKey - conversation key.
   * @returns the number of open batches, which the schema caps at one.
   */
  collectingIn(convKey: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM reply_jobs WHERE conv_key = ? AND state = 'collecting'")
      .get(convKey) as unknown as { n?: unknown } | undefined
    return numberOrZero(row?.n)
  }

  /**
   * Attach one arriving message to the turn that is already running.
   *
   * The message becomes an ordinary member of that job - same table, same
   * uniqueness rules - and only `steer_state` separates it from the messages whose
   * text the prompt was built from. That is what keeps "one reply per job" true
   * without a second job existing while the first holds `ux_jobs_inflight`.
   * @param input - the message, its target job, and the request id it will steer with.
   * @returns true when the member was added; false for a redelivery or a job that
   *   is no longer running.
   */
  attachSteer(input: {
    eventId: string
    messageId: string
    jobId: string
    steerRequestId: string
    now: number
  }): boolean {
    return this.transaction(() => {
      const known = this.db.prepare('SELECT job_id FROM reply_job_messages WHERE event_id = ?')
        .get(input.eventId) as unknown as { job_id?: unknown } | undefined
      if (known !== undefined) return false
      const target = this.db.prepare('SELECT state, conv_key FROM reply_jobs WHERE job_id = ?')
        .get(input.jobId) as unknown as { state?: unknown; conv_key?: unknown } | undefined
      if (target === undefined || text(target.state) !== 'running') return false
      const seq = numberOrZero((this.db.prepare('SELECT COUNT(*) AS n FROM reply_job_messages WHERE job_id = ?')
        .get(input.jobId) as unknown as { n?: unknown }).n)
      try {
        this.db.prepare(`INSERT INTO reply_job_messages
          (event_id, message_id, job_id, seq, steer_state, steer_request_id, steered_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
          .run(input.eventId, input.messageId, input.jobId, seq, input.steerRequestId, input.now)
      } catch (error) {
        // A second member for the same request id, or for the same message. Either
        // way there is nothing to add and the caller's ordinary path is the answer -
        // an exception here would escape through the answer path's own sweep and park
        // a conversation for a duplicate it could have ignored.
        if (!isConstraintViolation(error)) throw error
        return false
      }
      this.db.prepare("UPDATE inbox_events SET status = 'routed', updated_at = ? WHERE event_id = ?")
        .run(input.now, input.eventId)
      this.db.prepare('UPDATE conv_bindings SET updated_at = ? WHERE conv_key = ?').run(input.now, text(target.conv_key))
      return true
    })
  }

  /**
   * Count the steers one job has taken on.
   *
   * Returned members are excluded: they left the job, so they no longer extend the
   * turn they were meant to join. The cap exists because a turn accepting steer
   * after steer never has to end.
   * @param jobId - the job.
   * @returns how many steers it still owns.
   */
  steerCount(jobId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM reply_job_messages
      WHERE job_id = ? AND steer_state IN ('pending','consumed','stranded')`)
      .get(jobId) as unknown as { n?: unknown } | undefined
    return numberOrZero(row?.n)
  }

  /**
   * Count the steers of one job that no turn has consumed yet.
   * @param jobId - the job.
   * @returns how many are still waiting to be picked up.
   */
  pendingSteerCount(jobId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM reply_job_messages
      WHERE job_id = ? AND steer_state = 'pending'`).get(jobId) as unknown as { n?: unknown } | undefined
    return numberOrZero(row?.n)
  }

  /**
   * Record that a turn consumed one steered message.
   *
   * A `pending` member becomes `consumed` and the job's reply target moves to it, so
   * the answer threads onto the line the person added last - the same rule a message
   * joining a collecting batch already follows. A `stranded` member only records the
   * turn it finally appeared in: it belongs to a job that already answered, and
   * rewriting that job would make it look like it was still owed something.
   * @param input - the steer request id and the turn that consumed it.
   * @returns the member and its owning job, or undefined when no such steer exists.
   */
  consumedSteer(input: { requestId: string; turn: number; now: number }): {
    jobId: string
    messageId: string
    priorState: SteerState
    jobState: ReplyJobState
    jobTurn?: number
  } | undefined {
    return this.transaction(() => {
      const member = this.db.prepare(`SELECT event_id, message_id, job_id, steer_state FROM reply_job_messages
        WHERE steer_request_id = ?`).get(input.requestId) as unknown as Record<string, unknown> | undefined
      if (member === undefined) return undefined
      const priorState = toSteerState(member.steer_state)
      const jobId = text(member.job_id)
      const messageId = text(member.message_id)
      this.db.prepare('UPDATE reply_job_messages SET steer_turn = ?, steered_at = ? WHERE event_id = ?')
        .run(input.turn, input.now, text(member.event_id))
      if (priorState === 'pending') {
        this.db.prepare("UPDATE reply_job_messages SET steer_state = 'consumed' WHERE event_id = ?")
          .run(text(member.event_id))
        this.db.prepare('UPDATE reply_jobs SET reply_to_message_id = ?, updated_at = ? WHERE job_id = ?')
          .run(messageId, input.now, jobId)
      }
      const job = this.db.prepare('SELECT state, turn FROM reply_jobs WHERE job_id = ?')
        .get(jobId) as unknown as { state?: unknown; turn?: unknown } | undefined
      return {
        jobId,
        messageId,
        priorState,
        jobState: text(job?.state) as ReplyJobState,
        ...(optionalNumber(job?.turn) === undefined ? {} : { jobTurn: numberOrZero(job?.turn) }),
      }
    })
  }

  /**
   * Move a job onto the turn that actually consumed its steer.
   *
   * Unlike {@link bindTurn} this overwrites: the point is that the job was owed a
   * turn it had not seen yet, and its own `user/message` only ever arrives once per
   * turn. Clearing `carry_until` in the same statement is what ends the hold - the
   * held turn is here, so the normal settle path applies again.
   * @param jobId - the job.
   * @param turn - the turn that consumed the steer.
   * @param now - current time.
   */
  rebindTurn(jobId: string, turn: number, now: number): void {
    this.db.prepare(`UPDATE reply_jobs SET turn = ?, carry_until = NULL, updated_at = ?
      WHERE job_id = ? AND state = 'running'`).run(turn, now, jobId)
  }

  /**
   * Keep a job alive across the turn that ended while it still owed a steer.
   *
   * The job stays `running`, so it keeps the conversation's slot and no second job
   * can submit behind it; the text produced so far is parked in `carry_text` so the
   * reply that finally closes covers both turns instead of throwing the first away.
   * @param input - the job, the parked text, and when the wait gives up.
   * @returns true when this call held it.
   */
  holdForCarry(input: { jobId: string; carryText: string; carryUntil: number; now: number }): boolean {
    const result = this.db.prepare(`UPDATE reply_jobs SET carry_until = ?, carry_text = ?, updated_at = ?
      WHERE job_id = ? AND state = 'running'`).run(input.carryUntil, input.carryText, input.now, input.jobId)
    return Number(result.changes) === 1
  }

  /**
   * Give up on steers no turn will consume.
   *
   * Called when the job is being closed for a reason that ends the whole exchange -
   * a stop, a timeout, a carry that expired - and by recovery, where the process
   * that was going to consume them is gone.
   * @param jobId - the job being closed.
   * @param now - current time.
   * @returns how many members were stranded.
   */
  strandPending(jobId: string, now: number): number {
    const result = this.db.prepare(`UPDATE reply_job_messages SET steer_state = 'stranded', steered_at = ?
      WHERE job_id = ? AND steer_state = 'pending'`).run(now, jobId)
    return Number(result.changes)
  }

  /**
   * Put a steer that never reached the engine back in the queue.
   *
   * One transaction, because the two half-states are both wrong: a member pointing
   * at a batch that does not exist would never be answered, and a batch whose
   * message is still owned by the running job would answer it twice.
   * @param input - the member, the id a new batch would use, and its window.
   * @returns the batch that now owns the message, or undefined when the member was
   *   not pending and nothing changed.
   */
  returnSteer(input: {
    eventId: string
    jobId: string
    now: number
    debounceMs: number
    deliver?: boolean
  }): { jobId: string; opened: boolean } | undefined {
    return this.transaction(() => {
      const member = this.db.prepare(`SELECT message_id, job_id, steer_state FROM reply_job_messages
        WHERE event_id = ?`).get(input.eventId) as unknown as Record<string, unknown> | undefined
      if (member === undefined || toSteerState(member.steer_state) !== 'pending') return undefined
      const messageId = text(member.message_id)
      const owner = this.db.prepare('SELECT conv_key FROM reply_jobs WHERE job_id = ?')
        .get(text(member.job_id)) as unknown as { conv_key?: unknown } | undefined
      if (owner === undefined) return undefined
      const convKey = text(owner.conv_key)

      const open = this.db.prepare(`SELECT job_id FROM reply_jobs
        WHERE conv_key = ? AND state = 'collecting' AND kind = 'request'`)
        .get(convKey) as unknown as { job_id?: unknown } | undefined
      let batchId: string
      let opened = false
      if (open === undefined) {
        // The id was never used: the steer path attaches to a running job instead of
        // opening a batch, so this id is free unless a redelivery opened one.
        const taken = this.db.prepare('SELECT state FROM reply_jobs WHERE job_id = ?')
          .get(input.jobId) as unknown as { state?: unknown } | undefined
        if (taken !== undefined && text(taken.state) !== 'collecting') return undefined
        if (taken === undefined) {
          this.db.prepare(`INSERT INTO reply_jobs
            (job_id, conv_key, session_id, deliver, state, reply_to_message_id, collect_until, created_at, updated_at)
            VALUES (?, ?, '', ?, 'collecting', ?, ?, ?, ?)`)
            .run(input.jobId, convKey, input.deliver === false ? 0 : 1, messageId,
              input.now + input.debounceMs, input.now, input.now)
        }
        batchId = input.jobId
        opened = taken === undefined
      } else {
        batchId = text(open.job_id)
      }

      const seq = numberOrZero((this.db.prepare('SELECT COUNT(*) AS n FROM reply_job_messages WHERE job_id = ?')
        .get(batchId) as unknown as { n?: unknown }).n)
      this.db.prepare(`UPDATE reply_job_messages SET job_id = ?, seq = ?, steer_state = 'returned'
        WHERE event_id = ?`).run(batchId, seq, input.eventId)
      this.db.prepare(`UPDATE reply_jobs SET collect_until = MAX(collect_until, ?), reply_to_message_id = ?, updated_at = ?
        WHERE job_id = ?`).run(input.now + input.debounceMs, messageId, input.now, batchId)
      return { jobId: batchId, opened }
    })
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
        // effects, so it becomes an explained interruption instead. Its steers are
        // stranded in the same breath: nothing in this process will consume them, and
        // leaving them pending would keep them looking like work still to come.
        this.strandPending(job.jobId, now)
        this.finishTurn(job.jobId, 'interrupted', fallbackText(job), 'recovered-after-restart', now)
        interrupted += 1
        continue
      }
      // Nothing was ever sent, so there is nothing to duplicate: this is a reply the
      // person is still owed, not an uncertain one.
      if (job.sendAttempts === 0) {
        this.db.prepare('UPDATE reply_jobs SET next_attempt_at = ?, updated_at = ? WHERE job_id = ?')
          .run(0, now, job.jobId)
        resendable += 1
        continue
      }
      // Measured from the attempt, not from the last write: `updated_at` moves on
      // every recovery, so using it would let each restart push the window forward
      // and re-send indefinitely.
      const age = now - (job.submittedAt ?? job.createdAt)
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
   * Every session this ledger has bound a conversation to.
   *
   * Read at mount so a restarted process can tell the notification path which
   * sessions belong to it, without keeping a second copy of the same fact.
   * @returns distinct session ids, oldest binding first.
   */
  sessionIds(): string[] {
    const rows = this.db.prepare('SELECT session_id FROM conv_bindings ORDER BY created_at ASC')
      .all() as unknown as Array<{ session_id?: unknown }>
    return rows.map(row => text(row.session_id)).filter(id => id !== '')
  }

  /**
   * Newest jobs first, for the status tool and the acceptance readings.
   *
   * Ordered by `updated_at` rather than `created_at`: the question this answers is
   * "what just happened", and a batch that sat collecting for a while moved last
   * when it finally ran.
   * @param limit - how many rows to return.
   * @returns the newest jobs.
   */
  recent(limit: number): ReplyJob[] {
    const rows = this.db.prepare(`SELECT ${JOB_COLUMNS} FROM reply_jobs
      ORDER BY updated_at DESC LIMIT ?`).all(Math.max(1, Math.min(50, limit))) as unknown as JobRow[]
    return rows.map(toJob)
  }

  /**
   * Delete finished jobs, and their batch memberships, older than a cutoff.
   *
   * Messages first: `reply_job_messages` references both the job and the queue
   * row, so deleting the job alone would leave a row pointing at nothing once the
   * queue is pruned in turn.
   * @param olderThan - epoch milliseconds; jobs last updated before this go.
   * @returns how many jobs and memberships were removed.
   */
  pruneTerminal(olderThan: number): { jobs: number; messages: number } {
    return this.transaction(() => {
      const messages = this.db.prepare(`DELETE FROM reply_job_messages WHERE job_id IN (
        SELECT job_id FROM reply_jobs
        WHERE state IN ('replied','failed','cancelled','reply_uncertain') AND updated_at < ?
      )`).run(olderThan)
      const jobs = this.db.prepare(`DELETE FROM reply_jobs
        WHERE state IN ('replied','failed','cancelled','reply_uncertain') AND updated_at < ?`).run(olderThan)
      return { jobs: Number(jobs.changes), messages: Number(messages.changes) }
    })
  }

  /**
   * How many answers actually reached a person.
   *
   * Not `stats().replied`: a proactive batch that chose `SILENT` also settles as
   * replied, and counting it here would let the acceptance readings claim delivery
   * that never happened.
   * @returns the number of delivered answers.
   */
  answeredCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM reply_jobs
      WHERE state = 'replied' AND outcome = 'answer'`).get() as unknown as { n?: unknown }
    return numberOrZero(row.n)
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
    kind: text(row.kind) === 'proactive' ? 'proactive' : 'request',
    deliver: numberOrZero(row.deliver) !== 0,
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
    ...(optionalNumber(row.carry_until) === undefined ? {} : { carryUntil: numberOrZero(row.carry_until) }),
    ...(optionalText(row.carry_text) === undefined ? {} : { carryText: text(row.carry_text) }),
    ...(optionalNumber(row.first_turn) === undefined ? {} : { firstTurn: numberOrZero(row.first_turn) }),
    replyVia: text(row.reply_via) === 'reaction' ? 'reaction' : 'text',
    createdAt: numberOrZero(row.created_at),
    updatedAt: numberOrZero(row.updated_at),
  }
}