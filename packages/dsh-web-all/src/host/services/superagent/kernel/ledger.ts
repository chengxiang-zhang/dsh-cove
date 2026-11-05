/**
 * Kernel ledger (T08): the only place that opens a write transaction on the ledger (P1).
 *
 * `Ledger.open(fn)` runs `fn` inside one synchronous `BEGIN IMMEDIATE` transaction.
 * `fn` must not return a thenable: node:sqlite is synchronous, and a transaction
 * held across an await would interleave with other writers on the same file.
 *
 * Before every write the kernel checks the 02 state machine and the four table
 * constraints itself; the protocol DDL repeats them as a backstop. Raw `tx.run`
 * is restricted to the tables the calling module owns (TABLE_OWNERS).
 *
 * The kernel knows nothing above the protocol: it imports only `protocol/`.
 */

import type { DatabaseSync } from 'node:sqlite'
import { PHYSICAL, TABLE_OWNERS, type LedgerReader, type LedgerTx, type OwnerModule, type SqlParam } from '../protocol/db.ts'
import {
  OPEN_STATES, TERMINAL_STATES, canTransition, parseEndReason,
  type AttemptRow, type AudienceClass, type CommitmentRow, type CommitmentState, type Disposition,
  type JournalKind, type OutboxRow, type TriggerKind,
} from '../protocol/objects.ts'

export type LedgerErrorCode = 'ILLEGAL_TRANSITION' | 'LEDGER_ASYNC_TX' | 'LEDGER_NESTED_TX' | 'SHADOW_NO_WRITE'
  | 'TABLE_NOT_OWNED' | 'HOST_PROPOSE_KIND' | 'THREAD_BUSY' | 'ALREADY_DISPOSED' | 'MISSING' | 'BAD_COLUMN'
  | 'MULTI_STATEMENT' | 'MODULE_REQUIRED' | 'REPLY_EXISTS' | 'IDEM_EXISTS'

export class LedgerError extends Error {
  readonly code: LedgerErrorCode
  /** For ILLEGAL_TRANSITION: which rule refused the write. */
  readonly constraint?: string
  constructor(code: LedgerErrorCode, message: string, constraint?: string) {
    super(`${code}: ${message}`)
    this.name = 'LedgerError'
    this.code = code
    this.constraint = constraint
  }
}

/** Structural clock: the kernel may not import host-ports (DEPS), it only needs `now`. */
export interface LedgerClock { now(): number }

type Writable<T> = Partial<Omit<T, 'created_at' | 'updated_at'>>

export type NewCommitment = Writable<Omit<CommitmentRow, 'commitment_id' | 'n' | 'closed_at'>>
  & Pick<CommitmentRow, 'kind' | 'debtor' | 'creditor' | 'ball' | 'origin_ref' | 'what' | 'intent' | 'check_kind' | 'done_when'>
  & { state?: 'proposed' | 'open' }

export type NewAttempt = Writable<Omit<AttemptRow, 'n'>>
  & Pick<AttemptRow, 'commitment_id' | 'executor' | 'reason' | 'lifetime'> & { n?: number }

export interface NewIntake {
  event_id: string
  shadow: 0 | 1
  owner: 'responder' | 'superagent'
  sender: string
  thread_key: string
  desk_id?: string
  deliberation_id?: string
}

/** A queued outbox row; tier and words come from the outlet policy, never from the proposal. */
export type NewOutbox = Pick<OutboxRow, 'idem_key' | 'chat_id' | 'payload' | 'body' | 'moment' | 'tier' | 'audience' | 'words' | 'lease_epoch'>
  & Partial<Pick<OutboxRow, 'outbox_id' | 'reply_to' | 'event_id' | 'commitment_id' | 'expects_reply' | 'deliver'>>

export interface IntakeDisposition {
  disposition: Disposition
  reason?: string
  alternative?: string
  about?: string
  corrects?: string
  class?: string
  confidence?: number
  new_thread?: boolean
  deliberation_id?: string
}

export interface TurnFinish {
  ops: number; tool_errors: number; tokens: number; end_reason: string; rule_trace: unknown
  pub_hash?: string; dossier_hash?: string; audience_class?: AudienceClass; dossier_tokens?: number; window_id?: number
}

export interface KernelTx extends LedgerTx {
  createCommitment(spec: NewCommitment): CommitmentRow
  transition(id: string, to: CommitmentState, patch?: Partial<CommitmentRow>): CommitmentRow
  append(id: string, entry: { actor: string; kind: JournalKind; request_id?: string; body: unknown }): number
  markConsumed(requestId: string, turn: number): boolean
  recordAttempt(a: NewAttempt): AttemptRow
  updateAttempt(id: string, patch: Partial<AttemptRow>): AttemptRow
  propose(origin: 'host', spec: NewCommitment & { origin_ref: string }): CommitmentRow
  insertIntake(row: NewIntake): void
  /** The judgment also lands `class`, `confidence`, `new_thread` and `deliberation_id` (T27 gap 2); nothing else. */
  disposeIntake(eventId: string, shadow: 0 | 1, d: IntakeDisposition): void
  requestTurn(r: { trigger_kind: TriggerKind; desk_id?: string; commitment_id?: string; request_id: string }): string | undefined
  finishTurn(deliberationId: string, r: TurnFinish): void
  /** T13: the only way to push next_look_at without a state change; applies the I1 cap itself. */
  touch(commitmentId: string, nextLookAt: number): void
  /** T14: writes one queued outbox row. */
  recordOutbox(row: NewOutbox): OutboxRow
  /** T12 passthrough: input_seq + 1 on the thread's live subscription; returns the new value. */
  advanceSubscription(threadKey: string): number
  /** Non-state commitment fields only (Lead ruling): slot, used_wall_ms, used_turns, extended, budget_wall_ms, budget_turns. */
  patchCommitment(id: string, patch: CommitmentPatch): CommitmentRow
}

export const PATCHABLE_COMMITMENT_COLUMNS = ['slot', 'used_wall_ms', 'used_turns', 'extended', 'budget_wall_ms', 'budget_turns'] as const
export type CommitmentPatch = Partial<Pick<CommitmentRow, (typeof PATCHABLE_COMMITMENT_COLUMNS)[number]>>

export interface Ledger {
  /** `module` is required (R1 A3): an omitted module would otherwise inherit the kernel's write rights. */
  open<T>(fn: (tx: KernelTx) => T, opts: { module: OwnerModule; shadow?: boolean }): T
  read: LedgerReader
  nowMs(): number
}

// ---------------------------------------------------------------------------

const HOUR = 3_600_000
const LOOK_CAP_MS = 24 * HOUR
const GOAL_LOOK_CAP_MS = 7 * 24 * HOUR
const JOURNAL_ROW_MAX = 8000
const HOST_KINDS: ReadonlySet<string> = new Set(['goal', 'remind', 'watch'])
const OPEN: ReadonlySet<string> = new Set(OPEN_STATES)
const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_STATES)

const C = PHYSICAL.commitment
const J = PHYSICAL.journal
const A = PHYSICAL.attempt
const I = PHYSICAL.intake
const D = PHYSICAL.deliberation

const WRITE_TARGET = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?(\w+)/i
/** The one approved shape (Lead ruling): the claim CAS on inbox_events.owner. */
/**
 * R1 A2/A6: REPLACE deletes the conflicting row without firing its delete triggers
 * (recursive_triggers is off), so it rewrites append-only and terminal rows. No
 * statement may carry REPLACE semantics through tx.run; the DDL repeats the refusal.
 */
const REPLACE_SHAPE = /^\s*(?:REPLACE\s+INTO|INSERT\s+OR\s+REPLACE|UPDATE\s+OR\s+REPLACE)\b/i
/** Audit and state tables: rows are appended or moved through named methods, never replaced. */
const NO_REPLACE_TABLES: ReadonlySet<string> = new Set([PHYSICAL.journal, PHYSICAL.memory, PHYSICAL.mandate, PHYSICAL.commitment,
  PHYSICAL.attempt, PHYSICAL.outbox, PHYSICAL.intake, PHYSICAL.deliberation, PHYSICAL.assumption, PHYSICAL.doc_index, PHYSICAL.inbox_event])
/** The one approved shape (Lead ruling): the claim CAS on inbox_events.owner. */
const KERNEL_OWNER_CAS = 'update inbox_events set owner = ? where event_id = ? and owner is null'
const normalized = (sql: string): string => sql.trim().replace(/\s+/g, ' ').replace(/\s*;$/, '').toLowerCase()
const READ_ONLY = /^\s*(?:SELECT|WITH)\b/i
const WRITE_WORD = /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)\b/i

/**
 * node:sqlite compiles only the first statement of a string and silently drops the
 * rest, so any `;` before the end is refused. A `;` inside a string literal is refused
 * too: rejecting is safer than parsing SQL here.
 */
function assertSingle(sql: string): void {
  if (sql.trim().replace(/;\s*$/, '').includes(';')) throw new LedgerError('MULTI_STATEMENT', `one statement per call: ${sql.slice(0, 60)}`)
}

/** Which table a write statement targets; throws TABLE_NOT_OWNED unless the module owns it. */
function assertOwned(sql: string, module: OwnerModule): void {
  assertSingle(sql)
  const target = WRITE_TARGET.exec(sql)?.[1]
  if (REPLACE_SHAPE.test(sql) && target !== undefined && NO_REPLACE_TABLES.has(target)) {
    throw new LedgerError('TABLE_NOT_OWNED', `REPLACE semantics are refused on ${target}: ${sql.slice(0, 60)}`)
  }
  if (!target) throw new LedgerError('TABLE_NOT_OWNED', `tx.run accepts INSERT/UPDATE/DELETE only: ${sql.slice(0, 60)}`)
  if (TABLE_OWNERS[target] === module) return
  // The kernel owns exactly one column of the channel's table: the claim CAS on owner.
  if (module === 'kernel' && target === PHYSICAL.inbox_event && normalized(sql) === KERNEL_OWNER_CAS) return
  throw new LedgerError('TABLE_NOT_OWNED', `${module} may not write ${target} (owner: ${TABLE_OWNERS[target] ?? 'none'})`)
}

function assertRead(sql: string): void {
  assertSingle(sql)
  if (!READ_ONLY.test(sql) || WRITE_WORD.test(sql)) throw new LedgerError('TABLE_NOT_OWNED', `read accepts SELECT only: ${sql.slice(0, 60)}`)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
    && typeof (value as { then?: unknown }).then === 'function'
}

/** The earliest a look may be: one clock round ahead. */
export const MIN_LOOK_AHEAD_MS = 60_000

/** I1: non-goal commitments are looked at within 24 hours, goals within 7 days. */
function clampLook(kind: string, nextLookAt: number | null | undefined, now: number): number | null {
  if (nextLookAt === null || nextLookAt === undefined) return null
  // R1 A9: never before the next round either; a past look is due every round.
  return Math.max(now + MIN_LOOK_AHEAD_MS, Math.min(nextLookAt, now + (kind === 'goal' ? GOAL_LOOK_CAP_MS : LOOK_CAP_MS)))
}

/** Kernel-side copy of the 02 table constraints; the DDL repeats them. */
function checkCommitment(row: Partial<CommitmentRow>): void {
  const fail = (constraint: string, message: string): never => { throw new LedgerError('ILLEGAL_TRANSITION', message, constraint) }
  if (OPEN.has(String(row.state)) && (row.next_look_at === null || row.next_look_at === undefined)) fail('next_look_at', `${row.state} commitment needs next_look_at`)
  if (row.state === 'fulfilled' && !row.evidence_json) fail('evidence', 'fulfilled needs evidence_json')
  if (row.kind === 'watch' && !row.target) fail('watch_target', 'watch needs target')
  if (row.kind === 'deliver' && (row.budget_wall_ms == null || row.budget_turns == null)) fail('deliver_budget', 'deliver needs budget_wall_ms and budget_turns')
}

/** Splits an oversized journal body into rows of at most 8000 characters; never truncates. */
function journalChunks(body: unknown): string[] {
  const text = JSON.stringify(body ?? null)
  if (text.length <= JOURNAL_ROW_MAX) return [text]
  const parts: string[] = []
  let offset = 0
  while (offset < text.length) {
    let size = Math.min(JOURNAL_ROW_MAX - 100, text.length - offset)
    let wrapped = ''
    for (;;) {
      wrapped = JSON.stringify({ chunk: text.slice(offset, offset + size), part: parts.length + 1, of: 0 })
      if (wrapped.length <= JOURNAL_ROW_MAX - 20) break
      size -= wrapped.length - (JOURNAL_ROW_MAX - 20)
    }
    parts.push(text.slice(offset, offset + size))
    offset += size
  }
  return parts.map((chunk, i) => JSON.stringify({ chunk, part: i + 1, of: parts.length }))
}

export function createLedger(db: DatabaseSync, clock: LedgerClock): Ledger {
  const columns = new Map<string, Set<string>>()
  const columnsOf = (table: string): Set<string> => {
    let set = columns.get(table)
    if (!set) {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
      set = new Set(rows.map(r => r.name))
      columns.set(table, set)
    }
    return set
  }

  const get = <T>(sql: string, ...params: SqlParam[]): T | undefined => db.prepare(sql).get(...params) as T | undefined
  const all = <T>(sql: string, ...params: SqlParam[]): T[] => db.prepare(sql).all(...params) as T[]
  const exec = (sql: string, ...params: SqlParam[]): number => Number(db.prepare(sql).run(...params).changes)

  /** INSERT from a record whose keys are checked against the live table columns. */
  const insertRow = (table: string, row: Record<string, unknown>): void => {
    const known = columnsOf(table)
    const keys = Object.keys(row).filter(k => row[k] !== undefined)
    for (const k of keys) if (!known.has(k)) throw new LedgerError('BAD_COLUMN', `${table}.${k}`)
    exec(`INSERT INTO ${table} (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      ...keys.map(k => row[k] as SqlParam))
  }

  const updateRow = (table: string, keyCol: string, key: string, patch: Record<string, unknown>): void => {
    const known = columnsOf(table)
    const keys = Object.keys(patch).filter(k => patch[k] !== undefined)
    for (const k of keys) if (!known.has(k) || k === keyCol) throw new LedgerError('BAD_COLUMN', `${table}.${k}`)
    if (keys.length === 0) return
    exec(`UPDATE ${table} SET ${keys.map(k => `"${k}" = ?`).join(', ')} WHERE "${keyCol}" = ?`,
      ...keys.map(k => patch[k] as SqlParam), key)
  }

  const commitmentById = (id: string): CommitmentRow => {
    const row = get<CommitmentRow>(`SELECT * FROM ${C} WHERE commitment_id = ?`, id)
    if (!row) throw new LedgerError('MISSING', `commitment ${id}`)
    return row
  }

  let active = false

  function makeTx(module: OwnerModule, shadow: boolean, now: number, isOpen: () => boolean): KernelTx {
    const live = (): void => { if (!isOpen()) throw new LedgerError('LEDGER_ASYNC_TX', 'transaction already closed') }
    const noShadow = (what: string): void => { if (shadow) throw new LedgerError('SHADOW_NO_WRITE', `${what} in a shadow transaction`) }

    const insertCommitment = (spec: NewCommitment, originKind: 'event' | 'host'): CommitmentRow => {
      const n = (get<{ n: number | null }>(`SELECT max(n) AS n FROM ${C}`)?.n ?? 0) + 1
      const row: Partial<CommitmentRow> = {
        ...spec, commitment_id: `C-${n}`, n, origin_kind: originKind, state: spec.state ?? 'open',
        next_look_at: clampLook(spec.kind, spec.next_look_at, now), created_at: now, updated_at: now,
      }
      checkCommitment(row)
      if (row.kind === 'deliver' && !row.parent_id && row.thread_key) {
        const busy = get(`SELECT 1 FROM ${C} WHERE thread_key = ? AND debtor = ? AND kind = 'deliver' AND parent_id IS NULL AND state IN ('proposed', 'open', 'at_risk')`,
          row.thread_key, row.debtor as string)
        if (busy) throw new LedgerError('THREAD_BUSY', `thread ${row.thread_key} already has an open deliver for ${row.debtor}`)
      }
      insertRow(C, row)
      return commitmentById(row.commitment_id as string)
    }

    const tx: KernelTx = {
      now,
      run(sql, ...params) {
        live()
        // R1 A8: a shadow turn writes nothing but intake(shadow=1), which named methods do.
        noShadow('tx.run')
        assertOwned(sql, module)
        return { changes: exec(sql, ...params) }
      },
      get(sql, ...params) { live(); assertRead(sql); return get(sql, ...params) },
      all(sql, ...params) { live(); assertRead(sql); return all(sql, ...params) },

      createCommitment(spec) {
        live(); noShadow('createCommitment')
        if ((spec.origin_kind as string | undefined) === 'host') throw new LedgerError('HOST_PROPOSE_KIND', 'host-originated commitments go through propose')
        return insertCommitment(spec, 'event')
      },

      propose(origin, spec) {
        live(); noShadow('propose')
        if (origin !== 'host' || !HOST_KINDS.has(spec.kind)) throw new LedgerError('HOST_PROPOSE_KIND', `host may propose goal/remind/watch only, got ${spec.kind}`)
        return insertCommitment(spec, 'host')
      },

      transition(id, to, patch = {}) {
        live()
        const current = commitmentById(id)
        if (!canTransition(current.state, to)) throw new LedgerError('ILLEGAL_TRANSITION', `${id}: ${current.state} -> ${to}`, 'state_machine')
        const { commitment_id: _id, n: _n, state: _s, created_at: _c, closed_at: _x, origin_kind: _o, ...rest } = patch
        const next: Partial<CommitmentRow> = { ...rest, state: to, updated_at: now }
        const kind = rest.kind ?? current.kind
        if ('next_look_at' in rest) next.next_look_at = clampLook(kind, rest.next_look_at, now)
        else if (OPEN.has(to)) next.next_look_at = clampLook(kind, current.next_look_at, now)
        if (TERMINAL.has(to)) {
          // Calibration raw material (03): filled by the host at close, never by the caller.
          const stats = get<{ attempts: number; executors: number }>(
            `SELECT count(*) AS attempts, count(DISTINCT executor) AS executors FROM ${A} WHERE commitment_id = ?`, id)
          next.closed_at = now
          next.actual_min = Math.round((now - current.created_at) / 6000) / 10
          next.attempts = stats?.attempts ?? 0
          next.executor_switched = (stats?.executors ?? 0) > 1 ? 1 : 0
        }
        checkCommitment({ ...current, ...next })
        updateRow(C, 'commitment_id', id, next)
        return commitmentById(id)
      },

      append(id, entry) {
        live()
        const chunks = journalChunks(entry.body)
        const first = (get<{ seq: number | null }>(`SELECT max(seq) AS seq FROM ${J} WHERE commitment_id = ?`, id)?.seq ?? 0) + 1
        chunks.forEach((body_json, i) => insertRow(J, {
          commitment_id: id, seq: first + i, actor: entry.actor, kind: entry.kind,
          request_id: i === 0 ? entry.request_id ?? null : null, body_json, created_at: now,
        }))
        return first
      },

      markConsumed(requestId, turn) {
        live()
        return exec(`UPDATE ${J} SET consumed_turn = ? WHERE request_id = ? AND consumed_turn IS NULL`, turn, requestId) > 0
      },

      recordAttempt(a) {
        live(); noShadow('recordAttempt')
        const owner = commitmentById(a.commitment_id)
        if (TERMINAL.has(owner.state)) throw new LedgerError('ILLEGAL_TRANSITION', `attempt on closed ${owner.commitment_id}`, 'attempt_on_closed')
        const n = a.n ?? (get<{ c: number }>(`SELECT count(*) AS c FROM ${A} WHERE commitment_id = ?`, a.commitment_id)?.c ?? 0) + 1
        const attemptId = a.attempt_id ?? `${a.commitment_id}:A${n}`
        const state = a.state ?? 'pending'
        insertRow(A, { ...a, attempt_id: attemptId, n, state, started_at: a.started_at ?? (state === 'running' ? now : undefined), created_at: now, updated_at: now })
        return get<AttemptRow>(`SELECT * FROM ${A} WHERE attempt_id = ?`, attemptId) as AttemptRow
      },

      updateAttempt(id, patch) {
        live()
        const current = get<AttemptRow>(`SELECT * FROM ${A} WHERE attempt_id = ?`, id)
        if (!current) throw new LedgerError('MISSING', `attempt ${id}`)
        const { attempt_id: _id, commitment_id: _c, created_at: _x, ...rest } = patch
        if (current.state === 'ended' && rest.state !== undefined && rest.state !== 'ended') {
          throw new LedgerError('ILLEGAL_TRANSITION', `attempt ${id} has ended`, 'attempt_ended')
        }
        if (rest.state === 'running') {
          // I3 (R1 A4): a running attempt belongs to an open commitment with its stop-loss line.
          const owner = commitmentById(current.commitment_id)
          if (owner.state !== 'open' && owner.state !== 'at_risk') throw new LedgerError('ILLEGAL_TRANSITION', `running attempt on ${owner.state} ${owner.commitment_id}`, 'attempt_on_closed')
          if (owner.kind === 'deliver' && (owner.budget_wall_ms == null || owner.budget_turns == null)) throw new LedgerError('ILLEGAL_TRANSITION', `no stop-loss on ${owner.commitment_id}`, 'no_budget')
        }
        const next: Partial<AttemptRow> = { ...rest, updated_at: now }
        if (rest.state === 'running' && current.started_at === null && rest.started_at === undefined) next.started_at = now
        if (rest.state === 'ended' && rest.ended_at === undefined) next.ended_at = now
        if (rest.end_reason !== undefined && rest.end_reason !== null) next.end_reason = parseEndReason(rest.end_reason)
        updateRow(A, 'attempt_id', id, next)
        return get<AttemptRow>(`SELECT * FROM ${A} WHERE attempt_id = ?`, id) as AttemptRow
      },

      insertIntake(row) {
        live()
        insertRow(I, { ...row, state: 'pending', created_at: now, updated_at: now })
      },

      disposeIntake(eventId, shadowFlag, d) {
        live()
        const changed = exec(`UPDATE ${I} SET disposition = ?, state = 'disposed', reason = coalesce(?, reason), alternative = coalesce(?, alternative),
          about = coalesce(?, about), corrects = coalesce(?, corrects), class = coalesce(?, class), confidence = coalesce(?, confidence),
          new_thread = coalesce(?, new_thread), deliberation_id = coalesce(?, deliberation_id), updated_at = ?
          WHERE event_id = ? AND shadow = ? AND state <> 'disposed'`,
          d.disposition, d.reason ?? null, d.alternative ?? null, d.about ?? null, d.corrects ?? null, d.class ?? null,
          d.confidence ?? null, d.new_thread === undefined ? null : (d.new_thread ? 1 : 0), d.deliberation_id ?? null, now, eventId, shadowFlag)
        if (changed === 0) throw new LedgerError('ALREADY_DISPOSED', `intake ${eventId}/${shadowFlag} missing or already disposed`)
      },

      requestTurn(r) {
        live()
        if (get(`SELECT 1 FROM ${D} WHERE request_id = ?`, r.request_id)) return undefined
        if (r.commitment_id && get(`SELECT 1 FROM ${D} WHERE commitment_id = ? AND state IN ('requested', 'running')`, r.commitment_id)) return undefined
        if (r.desk_id && get(`SELECT 1 FROM ${D} WHERE desk_id = ? AND state IN ('requested', 'running')`, r.desk_id)) return undefined
        const deliberationId = `D:${r.request_id}`
        insertRow(D, { deliberation_id: deliberationId, request_id: r.request_id, desk_id: r.desk_id, commitment_id: r.commitment_id,
          trigger_kind: r.trigger_kind, state: 'requested', shadow: shadow ? 1 : 0, created_at: now, updated_at: now })
        return deliberationId
      },

      finishTurn(deliberationId, r) {
        live()
        const changed = exec(`UPDATE ${D} SET state = 'done', ended_at = ?, ops = ?, tool_errors = ?, tokens = ?, end_reason = ?, rule_trace = ?,
          pub_hash = ?, dossier_hash = ?, audience_class = ?, dossier_tokens = ?, window_id = ?, updated_at = ? WHERE deliberation_id = ? AND state <> 'done'`,
          now, r.ops, r.tool_errors, r.tokens, parseEndReason(r.end_reason), JSON.stringify(r.rule_trace ?? null),
          r.pub_hash ?? null, r.dossier_hash ?? null, r.audience_class ?? null, r.dossier_tokens ?? null, r.window_id ?? null, now, deliberationId)
        if (changed === 0) throw new LedgerError('MISSING', `open deliberation ${deliberationId}`)
      },

      patchCommitment(id, patch) {
        live()
        const current = commitmentById(id)
        if (TERMINAL.has(current.state)) throw new LedgerError('ILLEGAL_TRANSITION', `patch on ${current.state} ${id}`, 'patch_closed')
        const allowed: readonly string[] = PATCHABLE_COMMITMENT_COLUMNS
        for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw new LedgerError('BAD_COLUMN', `${C}.${key} is not patchable`)
        const refuse = (constraint: string, message: string): never => { throw new LedgerError('ILLEGAL_TRANSITION', `${id}: ${message}`, constraint) }
        // R1 A7: every patchable column moves one way only.
        if (patch.extended !== undefined && patch.extended !== current.extended && !(current.extended === 0 && patch.extended === 1)) refuse('extended_once', 'extended only goes 0 -> 1')
        for (const k of ['budget_wall_ms', 'budget_turns'] as const) {
          const v = patch[k]
          if (v !== undefined && current[k] !== null && (v === null || v < (current[k] as number))) refuse('budget_grows', `${k} may only grow`)
        }
        for (const k of ['used_wall_ms', 'used_turns'] as const) {
          const v = patch[k]
          if (v !== undefined && (v === null || v < current[k])) refuse('used_grows', `${k} may only grow`)
        }
        if (patch.slot !== undefined && patch.slot !== current.slot) {
          if (current.slot !== null && patch.slot !== null) refuse('slot_fixed', 'a held slot is not swapped')
          if (current.slot !== null && patch.slot === null
            && get(`SELECT 1 FROM ${A} WHERE commitment_id = ? AND lifetime = 'durable' AND state IN ('pending', 'running')`, id)) {
            refuse('slot_live', 'the slot is not released while durable work is live')
          }
        }
        const next = { ...current, ...patch }
        checkCommitment(next)
        updateRow(C, 'commitment_id', id, { ...patch, updated_at: now })
        return commitmentById(id)
      },

      touch(commitmentId, nextLookAt) {
        live()
        const current = commitmentById(commitmentId)
        if (!OPEN.has(current.state)) throw new LedgerError('ILLEGAL_TRANSITION', `touch on ${current.state} ${commitmentId}`, 'touch_closed')
        updateRow(C, 'commitment_id', commitmentId, { next_look_at: clampLook(current.kind, nextLookAt, now), updated_at: now })
      },

      recordOutbox(row) {
        live(); noShadow('recordOutbox')
        const outboxId = row.outbox_id ?? `O:${row.idem_key}`
        try {
          insertRow(PHYSICAL.outbox, { ...row, outbox_id: outboxId, state: 'queued', attempts: 0, created_at: now, updated_at: now })
        } catch (error) {
          // R1 A10: a concurrent second reply surfaces as the 02 code, not a raw constraint.
          const message = error instanceof Error ? error.message : String(error)
          if (/UNIQUE/.test(message) && /event_id/.test(message)) throw new LedgerError('REPLY_EXISTS', `event ${row.event_id ?? '?'} already has a reply`)
          if (/UNIQUE/.test(message)) throw new LedgerError('IDEM_EXISTS', `idem_key ${row.idem_key} already queued`)
          throw error
        }
        return get<OutboxRow>(`SELECT * FROM ${PHYSICAL.outbox} WHERE outbox_id = ?`, outboxId) as OutboxRow
      },

      advanceSubscription(threadKey) {
        live()
        const changed = exec(`UPDATE ${PHYSICAL.subscription} SET input_seq = input_seq + 1, updated_at = ? WHERE thread_key = ?`, now, threadKey)
        if (changed === 0) throw new LedgerError('MISSING', `subscription ${threadKey}`)
        return (get<{ input_seq: number }>(`SELECT input_seq FROM ${PHYSICAL.subscription} WHERE thread_key = ?`, threadKey) as { input_seq: number }).input_seq
      },
    }
    return tx
  }

  return {
    open<T>(fn: (tx: KernelTx) => T, opts: { module: OwnerModule; shadow?: boolean }): T {
      // R1 A3: no default module; the caller names whose tables it writes.
      const module = (opts as { module?: OwnerModule } | undefined)?.module
      if (module === undefined) throw new LedgerError('MODULE_REQUIRED', 'Ledger.open needs { module }')
      if (active) throw new LedgerError('LEDGER_NESTED_TX', 'Ledger.open is not re-entrant')
      let open = true
      const tx = makeTx(module, opts.shadow === true, clock.now(), () => open)
      // R1 A1: BEGIN can fail (SQLITE_BUSY after busy_timeout); the re-entrancy flag is
      // only raised once a transaction actually exists, and always lowered in finally.
      db.exec('BEGIN IMMEDIATE')
      active = true
      try {
        const result = fn(tx)
        if (isThenable(result)) {
          // Swallow the abandoned promise's own outcome; the caller gets the named error.
          Promise.resolve(result).then(undefined, () => undefined)
          throw new LedgerError('LEDGER_ASYNC_TX', 'Ledger.open callback must be synchronous')
        }
        db.exec('COMMIT')
        return result
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* the transaction may already be gone; the original error wins */ }
        throw error
      } finally {
        open = false
        active = false
      }
    },
    read: {
      get(sql, ...params) { assertRead(sql); return get(sql, ...params) },
      all(sql, ...params) { assertRead(sql); return all(sql, ...params) },
    },
    nowMs: () => clock.now(),
  }
}
