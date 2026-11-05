/**
 * Protocol DDL: the only place that defines superagent tables (02, T04).
 *
 * Every logical object of 02 maps to a physical `sa_` table; the pre-existing
 * `inbox_events` keeps its name and only gains a nullable `owner` column. Enum
 * CHECKs are generated from the closed sets in `objects.ts`, never copied by hand.
 *
 * Migration is in place (F26): tables are `CREATE TABLE IF NOT EXISTS`, columns
 * missing from an existing table are added after `PRAGMA table_info`, nothing is
 * dropped or rebuilt. The whole migration is one transaction. `selfCheck` lists
 * every missing table, column, index or trigger; a non-empty list refuses start.
 *
 * The database path is always supplied by the caller; this module never decides
 * where the ledger lives.
 */

import { DatabaseSync } from 'node:sqlite'
import {
  ASSUMPTION_MODES, ASSUMPTION_STATUSES, ATTEMPT_STATES, AUDIENCE_CLASSES, AUDIENCES, AUTHORITIES,
  CANCEL_ORIGINS, CAPABILITIES, CHECK_KINDS, COMMITMENT_KINDS, COMMITMENT_STATES, DELIBERATION_STATES,
  DISPOSITIONS, DOC_KINDS, DOC_WRITERS, END_REASONS, ENTITY_SOURCES, ENTITY_STATES, INTAKE_STATES,
  JOURNAL_KINDS, LIFETIMES, MEMORY_KINDS, MEMORY_STATES, NEVER_AUTO_CAPABILITIES, OPEN_STATES,
  ORIGIN_KINDS, OUTBOX_MOMENTS, OUTBOX_STATES, OWNERS, PAYLOADS, PROVENANCES, RULE_LAYERS,
  RULE_STATES, RULE_THENS, SPECULATION_STATES, STRENGTHS, TERMINAL_STATES, TIERS, TRIGGER_KINDS,
} from './objects.ts'

export const SCHEMA_VERSION = 1

export type SqlParam = string | number | null

/**
 * Ledger write transaction. Defined here, implemented by the kernel (T08).
 * World, memory and rules depend only on the protocol, so they receive this
 * interface instead of importing the kernel.
 */
export interface LedgerTx {
  /** Runtime-checked: the target table must be owned by the calling module, else TABLE_NOT_OWNED. */
  run(sql: string, ...params: SqlParam[]): { changes: number }
  get<T>(sql: string, ...params: SqlParam[]): T | undefined
  all<T>(sql: string, ...params: SqlParam[]): T[]
  /** Host clock reading taken when the transaction began. */
  readonly now: number
}

export interface LedgerReader {
  get<T>(sql: string, ...params: SqlParam[]): T | undefined
  all<T>(sql: string, ...params: SqlParam[]): T[]
}

/** Owning module per the 02 object catalogue ("归属模块"); `channels` owns the pre-existing inbox_events. */
export type OwnerModule = 'channels' | 'kernel' | 'world' | 'memory' | 'rules' | 'desk' | 'judgment' | 'timing' | 'executors' | 'recovery'

/** Named schema error; `code` is stable for callers that log a diagnostic and skip mounting. */
export class LedgerSchemaError extends Error {
  readonly code: 'INBOX_STORE_FIRST'
  constructor(code: 'INBOX_STORE_FIRST', message: string) {
    super(message)
    this.name = 'LedgerSchemaError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// DDL helpers
// ---------------------------------------------------------------------------

const q = (name: string): string => `"${name}"`
const lit = (value: string): string => `'${value.replace(/'/g, "''")}'`
const list = (values: readonly string[]): string => values.map(lit).join(', ')
const oneOf = (col: string, values: readonly string[]): string => `CHECK (${q(col)} IN (${list(values)}))`

const TEXT = 'TEXT'
const TEXT_NN = 'TEXT NOT NULL'
const INT = 'INTEGER'
const INT_NN = 'INTEGER NOT NULL'
const REAL = 'REAL'
const COUNT = 'INTEGER NOT NULL DEFAULT 0'
const enumNN = (col: string, values: readonly string[]): string => `TEXT NOT NULL ${oneOf(col, values)}`
const enumNull = (col: string, values: readonly string[]): string => `TEXT ${oneOf(col, values)}`
const flagNN = (col: string, fallback?: 0 | 1): string =>
  `INTEGER NOT NULL${fallback === undefined ? '' : ` DEFAULT ${fallback}`} CHECK (${q(col)} IN (0, 1))`
const flagNull = (col: string): string => `INTEGER CHECK (${q(col)} IN (0, 1))`

type Column = readonly [name: string, def: string]

interface TableSpec {
  readonly logical: LogicalTable
  readonly owner: OwnerModule
  /** Mutable tables carry `updated_at` (N10); append-only tables do not. */
  readonly mutable: boolean
  readonly columns: readonly Column[]
  readonly primaryKey: readonly string[]
  /** Table-level CHECKs; cross-column invariants live here. */
  readonly checks?: readonly string[]
  /** Index name to body after `ON <table>`; unique unless prefixed with `plain:`. */
  readonly unique?: Readonly<Record<string, string>>
  readonly triggers?: Readonly<Record<string, string>>
}

/** Trigger body that rejects any change except to `free` columns and NULL-to-value writes of `once` columns. */
function onlyChange(table: string, columns: readonly Column[], free: readonly string[], once: readonly string[], code: string): string {
  const violations = columns.map(([name]) => name).filter(name => !free.includes(name)).map(name =>
    once.includes(name)
      ? `(OLD.${q(name)} IS NOT NULL AND NEW.${q(name)} IS NOT OLD.${q(name)})`
      : `NEW.${q(name)} IS NOT OLD.${q(name)}`)
  return `BEFORE UPDATE ON ${table} WHEN ${violations.join(' OR ')} BEGIN SELECT RAISE(ABORT, ${lit(code)}); END`
}

const rejectDelete = (table: string): string => `BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END`

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const LOGICAL_TABLES = ['inbox_event', 'party', 'desk', 'intake', 'commitment', 'assumption', 'attempt',
  'journal', 'outbox', 'lease', 'memory', 'rule', 'rule_replay', 'rule_conflict', 'world_entity', 'world_alias',
  'world_addr', 'mandate', 'workspace', 'work_class', 'autonomy', 'speculation', 'deliberation', 'subscription',
  'doc_index', 'degrade_event'] as const
export type LogicalTable = (typeof LOGICAL_TABLES)[number]

/** Logical name to physical table: `sa_<logical>`, except the pre-existing `inbox_events`. */
export const PHYSICAL: Readonly<Record<LogicalTable, string>> = Object.freeze(Object.fromEntries(
  LOGICAL_TABLES.map(name => [name, name === 'inbox_event' ? 'inbox_events' : `sa_${name}`])) as Record<LogicalTable, string>)

const T = PHYSICAL
const OPEN = list(OPEN_STATES)
const TERMINAL = list(TERMINAL_STATES)

const JOURNAL_COLUMNS: readonly Column[] = [
  ['commitment_id', TEXT_NN], ['seq', INT_NN], ['actor', TEXT_NN], ['kind', enumNN('kind', JOURNAL_KINDS)],
  ['request_id', TEXT], ['consumed_turn', INT], ['verified', flagNull('verified')],
  ['body_json', 'TEXT CHECK (length("body_json") <= 8000)'],
]

const MEMORY_COLUMNS: readonly Column[] = [
  ['memory_id', TEXT_NN], ['kind', enumNN('kind', MEMORY_KINDS)], ['topic', TEXT_NN], ['about', TEXT],
  ['body', TEXT_NN], ['authority', enumNN('authority', AUTHORITIES)], ['source_event', TEXT],
  ['source_quote', TEXT], ['commitment_id', TEXT], ['supersedes', TEXT],
  ['state', enumNN('state', MEMORY_STATES)], ['use_set', TEXT], ['say_set', TEXT], ['last_used_at', INT],
]

const MANDATE_COLUMNS: readonly Column[] = [
  ['mandate_id', TEXT_NN], ['principal', TEXT_NN], ['scope_path', TEXT_NN],
  ['capability', enumNN('capability', CAPABILITIES)], ['strength', enumNN('strength', STRENGTHS)],
  ['policy_version', INT_NN], ['granted_by', `TEXT NOT NULL CHECK ("granted_by" <> 'superagent')`],
  ['granted_at', INT_NN], ['revoked_at', INT], ['revoked_by', TEXT],
]

const TABLE_SPECS: readonly TableSpec[] = [
  {
    logical: 'party', owner: 'world', mutable: true, primaryKey: ['party_id'],
    columns: [
      ['party_id', TEXT_NN], ['kind', enumNN('kind', ['person', 'executor', 'session'])], ['union_id', TEXT],
      ['open_id', TEXT], ['display', TEXT],
      ['class', enumNN('class', ['owner', 'colleague', 'member', 'external', 'executor', 'watched'])],
      ['source', enumNN('source', ['config', 'observed'])], ['manifest_json', TEXT],
    ],
    checks: [`"class" NOT IN ('owner', 'colleague') OR "source" = 'config'`],
    unique: { ux_sa_party_union: '(union_id)' },
  },
  {
    logical: 'desk', owner: 'desk', mutable: true, primaryKey: ['desk_id'],
    columns: [
      ['desk_id', TEXT_NN], ['chat_id', TEXT_NN], ['chat_type', enumNN('chat_type', ['p2p', 'group'])],
      ['session_id', TEXT], ['generation', COUNT], ['audience_json', TEXT],
      ['audience_class', enumNull('audience_class', AUDIENCE_CLASSES)], ['cwd', TEXT],
      ['turn_open', flagNN('turn_open', 0)], ['event_count', COUNT], ['last_event_at', INT],
    ],
    unique: { ux_sa_desk_chat: '(chat_id)', ux_sa_desk_session: '(session_id) WHERE session_id IS NOT NULL' },
  },
  {
    logical: 'intake', owner: 'kernel', mutable: true, primaryKey: ['event_id', 'shadow'],
    columns: [
      ['event_id', TEXT_NN], ['shadow', flagNN('shadow')], ['owner', enumNN('owner', OWNERS)], ['sender', TEXT_NN],
      ['desk_id', TEXT], ['thread_key', TEXT_NN], ['state', enumNN('state', INTAKE_STATES)],
      ['disposition', enumNull('disposition', DISPOSITIONS)], ['about', TEXT], ['class', TEXT],
      ['confidence', REAL], ['pred_eta_min', REAL], ['pred_executor', TEXT], ['pred_executor_reason', TEXT],
      ['reason', TEXT], ['alternative', TEXT], ['corrects', TEXT], ['new_thread', flagNull('new_thread')],
      ['deliberation_id', TEXT],
    ],
    checks: [
      `("state" = 'disposed') = ("disposition" IS NOT NULL)`,
      `"disposition" IS NOT 'decline' OR ("reason" IS NOT NULL AND "alternative" IS NOT NULL)`,
    ],
  },
  {
    logical: 'commitment', owner: 'kernel', mutable: true, primaryKey: ['commitment_id'],
    columns: [
      ['commitment_id', TEXT_NN], ['n', INT_NN], ['parent_id', TEXT], ['kind', enumNN('kind', COMMITMENT_KINDS)],
      ['debtor', TEXT_NN], ['creditor', TEXT_NN], ['on_behalf_of', TEXT], ['ball', TEXT_NN], ['desk_id', TEXT],
      ['thread_key', TEXT], ['origin_kind', enumNN('origin_kind', ORIGIN_KINDS)], ['origin_ref', TEXT_NN],
      ['work_class', TEXT], ['what', TEXT_NN], ['intent', TEXT_NN], ['check_kind', enumNN('check_kind', CHECK_KINDS)],
      ['done_when', TEXT_NN], ['boundary', TEXT], ['target', TEXT], ['state', enumNN('state', COMMITMENT_STATES)],
      ['slot', TEXT], ['due_at', INT], ['eta_at', INT], ['next_look_at', INT], ['eta_model_min', REAL],
      ['eta_factor', REAL], ['budget_wall_ms', INT], ['budget_turns', INT], ['used_wall_ms', COUNT],
      ['used_turns', COUNT], ['used_tokens', COUNT], ['extended', flagNN('extended', 0)], ['evidence_json', TEXT],
      ['actual_min', REAL], ['attempts', COUNT], ['executor_switched', flagNN('executor_switched', 0)],
      ['closed_at', INT],
    ],
    checks: [
      `"commitment_id" = 'C-' || "n"`,
      `"state" NOT IN (${OPEN}) OR "next_look_at" IS NOT NULL`,
      `"state" <> 'fulfilled' OR "evidence_json" IS NOT NULL`,
      `"kind" <> 'watch' OR "target" IS NOT NULL`,
      `"kind" <> 'deliver' OR ("budget_wall_ms" IS NOT NULL AND "budget_turns" IS NOT NULL)`,
      `"state" NOT IN (${TERMINAL}) OR "closed_at" IS NOT NULL`,
      `"origin_kind" <> 'host' OR "kind" IN ('goal', 'remind', 'watch')`,
    ],
    unique: {
      ux_sa_commit_n: '(n)',
      ux_sa_commit_origin: '(origin_ref)',
      ux_sa_commit_thread: `(thread_key, debtor) WHERE kind = 'deliver' AND parent_id IS NULL AND state IN (${OPEN})`,
      ux_sa_commit_slot: `(slot) WHERE slot IS NOT NULL AND state IN ('open', 'at_risk')`,
    },
    triggers: {
      sa_commit_terminal: `BEFORE UPDATE ON ${T.commitment} WHEN OLD.state IN (${TERMINAL}) BEGIN SELECT RAISE(ABORT, 'TERMINAL'); END`,
      // R1 A6: REPLACE deletes the conflicting row without its triggers; refuse the insert instead.
      sa_commit_no_rebuild_terminal: `BEFORE INSERT ON ${T.commitment} WHEN EXISTS (SELECT 1 FROM ${T.commitment} WHERE commitment_id = NEW.commitment_id AND state IN (${TERMINAL})) BEGIN SELECT RAISE(ABORT, 'TERMINAL'); END`,
      sa_commit_no_replace: `BEFORE INSERT ON ${T.commitment} WHEN EXISTS (SELECT 1 FROM ${T.commitment} WHERE (commitment_id = NEW.commitment_id OR n = NEW.n OR origin_ref = NEW.origin_ref) AND NOT (commitment_id = NEW.commitment_id AND state IN (${TERMINAL}))) BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: sa_commitment (no replace)'); END`,
      sa_commit_thread_no_replace: `BEFORE INSERT ON ${T.commitment} WHEN NEW.kind = 'deliver' AND NEW.parent_id IS NULL AND NEW.state IN (${OPEN}) AND EXISTS (SELECT 1 FROM ${T.commitment} WHERE thread_key = NEW.thread_key AND debtor = NEW.debtor AND kind = 'deliver' AND parent_id IS NULL AND state IN (${OPEN})) BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: ux_sa_commit_thread (no replace)'); END`,
      sa_commit_slot_no_replace: `BEFORE INSERT ON ${T.commitment} WHEN NEW.slot IS NOT NULL AND NEW.state IN ('open', 'at_risk') AND EXISTS (SELECT 1 FROM ${T.commitment} WHERE slot = NEW.slot AND state IN ('open', 'at_risk')) BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: ux_sa_commit_slot (no replace)'); END`,
    },
  },
  {
    logical: 'assumption', owner: 'judgment', mutable: true, primaryKey: ['commitment_id', 'ordinal'],
    columns: [
      ['commitment_id', TEXT_NN], ['ordinal', INT_NN], ['question', TEXT_NN], ['taken', TEXT_NN],
      ['reversible', flagNN('reversible')], ['mode', enumNN('mode', ASSUMPTION_MODES)],
      ['status', enumNN('status', ASSUMPTION_STATUSES)], ['resolved_by', TEXT],
    ],
    unique: { ux_sa_assumption_asked: `(commitment_id) WHERE mode = 'asked' AND status = 'open'` },
  },
  {
    logical: 'attempt', owner: 'executors', mutable: true, primaryKey: ['attempt_id'],
    columns: [
      ['attempt_id', TEXT_NN], ['commitment_id', TEXT_NN], ['n', 'INTEGER NOT NULL CHECK ("n" BETWEEN 1 AND 3)'],
      ['executor', TEXT_NN], ['provider', TEXT], ['model', TEXT], ['effort', TEXT],
      ['reason', `TEXT NOT NULL CHECK (length(trim("reason")) > 0)`], ['lifetime', enumNN('lifetime', LIFETIMES)],
      ['session_id', TEXT], ['cwd', TEXT], ['branch', TEXT], ['state', enumNN('state', ATTEMPT_STATES)],
      ['turn_open', flagNN('turn_open', 0)], ['turns', COUNT], ['tool_calls', COUNT], ['last_tool_at', INT],
      ['repeat_sig', TEXT], ['repeat_count', COUNT], ['end_reason', enumNull('end_reason', END_REASONS)],
      ['cancel_origin', enumNull('cancel_origin', CANCEL_ORIGINS)], ['started_at', INT], ['ended_at', INT],
    ],
    unique: {
      ux_sa_attempt_session: '(session_id) WHERE session_id IS NOT NULL',
      ux_sa_attempt_live: `(commitment_id) WHERE state IN ('pending', 'running')`,
    },
    triggers: {
      // I3: a deliver commitment may only run with both stop-loss lines set.
      sa_attempt_running_budget: `BEFORE UPDATE OF state ON ${T.attempt} WHEN NEW.state = 'running' AND OLD.state IS NOT 'running' AND EXISTS (SELECT 1 FROM ${T.commitment} c WHERE c.commitment_id = NEW.commitment_id AND c.kind = 'deliver' AND (c.budget_wall_ms IS NULL OR c.budget_turns IS NULL)) BEGIN SELECT RAISE(ABORT, 'NO_BUDGET'); END`,
      // R1 A4: a running attempt belongs to an open commitment; an ended attempt stays ended.
      sa_attempt_running_open: `BEFORE UPDATE OF state ON ${T.attempt} WHEN NEW.state = 'running' AND NOT EXISTS (SELECT 1 FROM ${T.commitment} c WHERE c.commitment_id = NEW.commitment_id AND c.state IN ('open', 'at_risk')) BEGIN SELECT RAISE(ABORT, 'ATTEMPT_ON_CLOSED'); END`,
      sa_attempt_running_open_ins: `BEFORE INSERT ON ${T.attempt} WHEN NEW.state = 'running' AND NOT EXISTS (SELECT 1 FROM ${T.commitment} c WHERE c.commitment_id = NEW.commitment_id AND c.state IN ('open', 'at_risk')) BEGIN SELECT RAISE(ABORT, 'ATTEMPT_ON_CLOSED'); END`,
      sa_attempt_ended_final: `BEFORE UPDATE OF state ON ${T.attempt} WHEN OLD.state = 'ended' AND NEW.state IS NOT 'ended' BEGIN SELECT RAISE(ABORT, 'ATTEMPT_ENDED'); END`,
      sa_attempt_owner_exists: `BEFORE INSERT ON ${T.attempt} WHEN NOT EXISTS (SELECT 1 FROM ${T.commitment} c WHERE c.commitment_id = NEW.commitment_id) BEGIN SELECT RAISE(ABORT, 'ATTEMPT_ORPHAN'); END`,
      sa_attempt_running_budget_ins: `BEFORE INSERT ON ${T.attempt} WHEN NEW.state = 'running' AND EXISTS (SELECT 1 FROM ${T.commitment} c WHERE c.commitment_id = NEW.commitment_id AND c.kind = 'deliver' AND (c.budget_wall_ms IS NULL OR c.budget_turns IS NULL)) BEGIN SELECT RAISE(ABORT, 'NO_BUDGET'); END`,
    },
  },
  {
    logical: 'journal', owner: 'kernel', mutable: false, primaryKey: ['commitment_id', 'seq'],
    columns: JOURNAL_COLUMNS,
    unique: { ux_sa_journal_request: '(request_id) WHERE request_id IS NOT NULL' },
    triggers: {
      sa_journal_no_delete: rejectDelete(T.journal),
      // P2: the only permitted update is consumed_turn going from NULL to a value.
      // R1 A2: REPLACE on the key or on request_id would rewrite a row; an insert never displaces one.
      sa_journal_no_replace: `BEFORE INSERT ON ${T.journal} WHEN EXISTS (SELECT 1 FROM ${T.journal} WHERE commitment_id = NEW.commitment_id AND seq = NEW.seq) OR (NEW.request_id IS NOT NULL AND EXISTS (SELECT 1 FROM ${T.journal} WHERE request_id = NEW.request_id)) BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: sa_journal (append-only, no replace)'); END`,
      sa_journal_no_update: onlyChange(T.journal, [...JOURNAL_COLUMNS, ['created_at', INT_NN]], [], ['consumed_turn'], 'APPEND_ONLY'),
    },
  },
  {
    logical: 'outbox', owner: 'kernel', mutable: true, primaryKey: ['outbox_id'],
    columns: [
      ['outbox_id', TEXT_NN], ['idem_key', `TEXT NOT NULL CHECK (length("idem_key") <= 50)`], ['chat_id', TEXT_NN],
      ['reply_to', TEXT], ['event_id', TEXT], ['commitment_id', TEXT], ['payload', enumNN('payload', PAYLOADS)],
      ['body', TEXT_NN], ['moment', enumNN('moment', OUTBOX_MOMENTS)], ['tier', enumNN('tier', TIERS)],
      ['audience', enumNN('audience', AUDIENCES)],
      // Column-level so that the column can be dropped and re-added in place.
      ['words', `INTEGER NOT NULL CHECK ("words" <= 100) CHECK ("payload" <> 'react' OR "words" = 0)`],
      ['expects_reply', flagNN('expects_reply', 0)], ['deliver', flagNN('deliver', 0)], ['lease_epoch', INT_NN],
      ['state', enumNN('state', OUTBOX_STATES)], ['attempts', COUNT], ['next_attempt_at', INT],
      ['message_id', TEXT], ['error', TEXT], ['sent_at', INT],
    ],
    unique: {
      ux_sa_outbox_idem: '(idem_key)',
      ux_sa_outbox_reply: `(event_id) WHERE tier = 'reply' AND payload = 'text' AND event_id IS NOT NULL`,
    },
  },
  {
    logical: 'lease', owner: 'kernel', mutable: true, primaryKey: ['name'],
    columns: [
      ['name', `TEXT NOT NULL CHECK ("name" = 'outlet')`], ['holder', TEXT_NN], ['epoch', INT_NN],
      ['heartbeat_at', INT_NN], ['expires_at', INT_NN],
    ],
  },
  {
    logical: 'memory', owner: 'memory', mutable: true, primaryKey: ['memory_id'],
    columns: MEMORY_COLUMNS,
    checks: [`"authority" NOT IN ('owner-said', 'party-said') OR ("source_event" IS NOT NULL AND "source_quote" IS NOT NULL)`],
    unique: { ux_sa_memory_active: `(topic, kind) WHERE state = 'active'` },
    triggers: {
      sa_memory_no_delete: rejectDelete(T.memory),
      sa_memory_no_replace: `BEFORE INSERT ON ${T.memory} WHEN EXISTS (SELECT 1 FROM ${T.memory} WHERE memory_id = NEW.memory_id) OR (NEW.state = 'active' AND EXISTS (SELECT 1 FROM ${T.memory} WHERE topic = NEW.topic AND kind = NEW.kind AND state = 'active')) BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: sa_memory (append-only, no replace)'); END`,
      // R1 A5: corrections are new rows; a row's state only moves forward (active -> superseded | retired).
      sa_memory_state_one_way: `BEFORE UPDATE OF state ON ${T.memory} WHEN NEW.state IS NOT OLD.state AND NOT (OLD.state = 'active' AND NEW.state IN ('superseded', 'retired')) BEGIN SELECT RAISE(ABORT, 'MEMORY_STATE_ONE_WAY'); END`,
      sa_memory_no_update: onlyChange(T.memory, [...MEMORY_COLUMNS, ['created_at', INT_NN]], ['state', 'last_used_at', 'updated_at'], [], 'APPEND_ONLY'),
    },
  },
  {
    logical: 'rule', owner: 'rules', mutable: true, primaryKey: ['rule_id'],
    columns: [
      ['rule_id', TEXT_NN], ['scope_path', TEXT_NN], ['layer', enumNN('layer', RULE_LAYERS)], ['when_json', TEXT_NN],
      ['then', enumNN('then', RULE_THENS)], ['exceptions_json', TEXT], ['priority', COUNT],
      ['provenance', enumNN('provenance', PROVENANCES)], ['version', 'INTEGER NOT NULL DEFAULT 1'],
      ['state', enumNN('state', RULE_STATES)], ['approved_by', TEXT], ['rollback_if', TEXT], ['weight', REAL],
      ['hits', COUNT], ['last_hit_at', INT],
    ],
    checks: [
      `"provenance" <> 'inferred' OR "layer" = 'technique'`,
      `"provenance" <> 'inferred' OR "state" <> 'active'`,
      `"layer" <> 'constitution' OR "approved_by" = 'owner'`,
      `"provenance" <> 'extracted' OR "state" <> 'active' OR "approved_by" IS NOT NULL`,
    ],
  },
  {
    logical: 'rule_replay', owner: 'rules', mutable: false, primaryKey: ['replay_id'],
    columns: [
      ['replay_id', TEXT_NN], ['rule_id', TEXT_NN], ['sample_size', INT_NN], ['changed', INT_NN],
      ['changed_ratio', 'REAL NOT NULL'], ['direction_json', TEXT], ['passed', flagNN('passed')],
    ],
  },
  {
    logical: 'rule_conflict', owner: 'rules', mutable: true, primaryKey: ['conflict_id'],
    columns: [['conflict_id', TEXT_NN], ['rule_a', TEXT_NN], ['rule_b', TEXT_NN], ['detail', TEXT], ['resolved_at', INT]],
  },
  {
    logical: 'world_entity', owner: 'world', mutable: true, primaryKey: ['entity_id'],
    columns: [
      ['entity_id', TEXT_NN], ['canonical', TEXT_NN], ['kind', enumNN('kind', ['host', 'repo', 'org', 'session'])],
      ['realm', enumNN('realm', ['local', 'netbird', 'external'])], ['path', TEXT_NN],
      ['state', enumNN('state', ENTITY_STATES)], ['source', enumNN('source', ENTITY_SOURCES)],
      ['lease_until', INT], ['manifest_json', TEXT], ['revoked_by', TEXT],
    ],
    checks: [`NOT ("source" = 'discover' AND "state" = 'enrolled')`],
    unique: { ux_sa_entity_canonical: '(canonical)', ux_sa_entity_path: '(path)' },
  },
  {
    logical: 'world_alias', owner: 'world', mutable: true, primaryKey: ['alias'],
    columns: [['alias', TEXT_NN], ['entity_id', TEXT_NN], ['kind', enumNN('kind', ['ip', 'ssh', 'dns', 'spoken'])]],
  },
  {
    logical: 'world_addr', owner: 'world', mutable: true, primaryKey: ['addr_id'],
    columns: [
      ['addr_id', TEXT_NN], ['entity_id', TEXT_NN], ['kind', enumNN('kind', ['lan', 'wifi', 'netbird', 'dns'])],
      ['address', TEXT_NN], ['priority', COUNT],
    ],
  },
  {
    logical: 'mandate', owner: 'world', mutable: true, primaryKey: ['mandate_id'],
    columns: MANDATE_COLUMNS,
    triggers: {
      sa_mandate_no_delete: rejectDelete(T.mandate),
      sa_mandate_no_replace: `BEFORE INSERT ON ${T.mandate} WHEN EXISTS (SELECT 1 FROM ${T.mandate} WHERE mandate_id = NEW.mandate_id) BEGIN SELECT RAISE(ABORT, 'IMMUTABLE'); END`,
      sa_mandate_no_update: onlyChange(T.mandate, [...MANDATE_COLUMNS, ['created_at', INT_NN]], ['updated_at'], ['revoked_at', 'revoked_by'], 'IMMUTABLE'),
    },
  },
  {
    logical: 'workspace', owner: 'world', mutable: true, primaryKey: ['path'],
    columns: [['path', TEXT_NN], ['entity_id', TEXT], ['commitment_id', TEXT], ['mandate_id', TEXT], ['branch', TEXT], ['removed_at', INT]],
  },
  {
    logical: 'work_class', owner: 'rules', mutable: true, primaryKey: ['class_id'],
    columns: [
      ['class_id', TEXT_NN], ['samples', COUNT],
      ['eta_factor', 'REAL NOT NULL DEFAULT 1 CHECK ("eta_factor" BETWEEN 0.5 AND 4)'],
      ['ask_mode', enumNN('ask_mode', ['declare', 'ask'])], ['pushback_mode', enumNN('pushback_mode', ['on', 'muted'])],
      ['preferred_executor', TEXT], ['misjudge_rate', REAL], ['p90_turns', REAL],
    ],
  },
  {
    logical: 'autonomy', owner: 'rules', mutable: true, primaryKey: ['class_id', 'capability'],
    columns: [
      ['class_id', TEXT_NN], ['capability', enumNN('capability', CAPABILITIES)], ['strength', enumNN('strength', STRENGTHS)],
      ['streak', COUNT], ['streak_days_json', TEXT], ['demoted_at', INT],
    ],
    checks: [`"capability" NOT IN (${list(NEVER_AUTO_CAPABILITIES)}) OR "strength" <> 'allow'`],
  },
  {
    logical: 'speculation', owner: 'timing', mutable: true, primaryKey: ['spec_id'],
    columns: [
      ['spec_id', TEXT_NN], ['kind', enumNN('kind', ['probe', 'prep', 'patrol'])], ['commitment_id', TEXT],
      ['desk_id', TEXT], ['path', TEXT], ['state', enumNN('state', SPECULATION_STATES)],
    ],
  },
  {
    logical: 'deliberation', owner: 'desk', mutable: true, primaryKey: ['deliberation_id'],
    columns: [
      ['deliberation_id', TEXT_NN], ['request_id', TEXT_NN], ['desk_id', TEXT], ['commitment_id', TEXT],
      ['trigger_kind', enumNN('trigger_kind', TRIGGER_KINDS)], ['state', enumNN('state', DELIBERATION_STATES)],
      ['shadow', flagNN('shadow', 0)], ['started_at', INT], ['ended_at', INT], ['window_id', INT],
      ['audience_class', enumNull('audience_class', AUDIENCE_CLASSES)], ['pub_hash', TEXT], ['dossier_hash', TEXT],
      ['dossier_tokens', INT], ['rule_trace', TEXT], ['ops', COUNT], ['tool_errors', COUNT], ['tokens', INT],
      ['end_reason', enumNull('end_reason', END_REASONS)],
    ],
    unique: {
      ux_sa_delib_request: '(request_id)',
      ux_sa_delib_commitment: `(commitment_id) WHERE commitment_id IS NOT NULL AND state IN ('requested', 'running')`,
      ux_sa_delib_desk: `(desk_id) WHERE desk_id IS NOT NULL AND state = 'running'`,
    },
  },
  {
    logical: 'subscription', owner: 'judgment', mutable: true, primaryKey: ['thread_key'],
    columns: [['thread_key', TEXT_NN], ['commitment_id', TEXT_NN], ['attempt_id', TEXT_NN], ['input_seq', COUNT]],
  },
  {
    logical: 'doc_index', owner: 'memory', mutable: false, primaryKey: ['doc_id'],
    columns: [
      ['doc_id', TEXT_NN], ['path', TEXT_NN], ['title', TEXT_NN], ['kind', enumNN('kind', DOC_KINDS)],
      ['commitment_id', TEXT], ['added_by', enumNN('added_by', DOC_WRITERS)], ['added_at', INT_NN],
    ],
    unique: { ux_sa_doc_path: '(path)' },
  },
  {
    logical: 'degrade_event', owner: 'recovery', mutable: true, primaryKey: ['degrade_id'],
    columns: [['degrade_id', TEXT_NN], ['reason', TEXT_NN], ['scope', TEXT_NN], ['started_at', INT_NN], ['ended_at', INT]],
  },
]

/** Full column list of a spec, including the time columns every table carries (N10). */
function allColumns(spec: TableSpec): readonly Column[] {
  const time: Column[] = [['created_at', INT_NN]]
  if (spec.mutable) time.push(['updated_at', INT])
  return [...spec.columns, ...time]
}

const INBOX_OWNER_DEF = `TEXT CHECK (owner IS NULL OR owner IN (${list(OWNERS)}))`
/** R1 O3: REPLACE on inbox_events would swap the owner without the CAS trigger; the insert is dropped instead. */
const INBOX_NO_REPLACE_TRIGGER = `BEFORE INSERT ON ${T.inbox_event} WHEN EXISTS (SELECT 1 FROM ${T.inbox_event} WHERE event_id = NEW.event_id) OR (NEW.message_id <> '' AND EXISTS (SELECT 1 FROM ${T.inbox_event} WHERE message_id = NEW.message_id)) BEGIN SELECT RAISE(IGNORE); END`
const INBOX_OWNER_TRIGGER = `BEFORE UPDATE OF owner ON ${T.inbox_event} WHEN OLD.owner IS NOT NULL AND NEW.owner IS NOT OLD.owner BEGIN SELECT RAISE(ABORT, 'OWNER_ALREADY_SET'); END`

/**
 * Physical table to its owning module, as listed in the 02 object catalogue.
 * The kernel writes `inbox_events.owner` only (claim CAS); the ledger grants that
 * single column, not the table.
 */
export const TABLE_OWNERS: Readonly<Record<string, OwnerModule>> = Object.freeze({
  [T.inbox_event]: 'channels',
  ...Object.fromEntries(TABLE_SPECS.map(spec => [T[spec.logical], spec.owner])),
})

/** The physical `sa_` tables, in definition order. */
export const SA_TABLES: readonly string[] = Object.freeze(TABLE_SPECS.map(spec => T[spec.logical]))

// ---------------------------------------------------------------------------
// Migration and self-check
// ---------------------------------------------------------------------------

type Db = DatabaseSync

function columnNames(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${q(table)})`).all() as unknown as Array<{ name?: unknown }>
  return new Set(rows.map(row => String(row.name ?? '')))
}

function schemaNames(db: Db, type: 'table' | 'index' | 'trigger'): Set<string> {
  const rows = db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as unknown as Array<{ name?: unknown }>
  return new Set(rows.map(row => String(row.name ?? '')))
}

function createTableSql(spec: TableSpec): string {
  const lines = allColumns(spec).map(([name, def]) => `${q(name)} ${def}`)
  lines.push(`PRIMARY KEY (${spec.primaryKey.map(q).join(', ')})`)
  for (const check of spec.checks ?? []) lines.push(`CHECK (${check})`)
  return `CREATE TABLE IF NOT EXISTS ${T[spec.logical]} (\n  ${lines.join(',\n  ')}\n)`
}

/** `ALTER TABLE ADD COLUMN` cannot add a NOT NULL column without a default; such a gap refuses start. */
function addColumn(db: Db, table: string, [name, def]: Column): void {
  if (/NOT NULL/.test(def) && !/DEFAULT/.test(def)) {
    throw new Error(`superagent ledger: cannot add ${table}.${name} in place (NOT NULL without default)`)
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${q(name)} ${def}`)
}

function migrateBody(db: Db): string[] {
  const added: string[] = []
  const tables = schemaNames(db, 'table')
  // Start-order contract: the channel store creates inbox_events first, then the
  // protocol migrates the same file. Never create the channel's table here.
  if (!tables.has(T.inbox_event)) {
    throw new LedgerSchemaError('INBOX_STORE_FIRST',
      'superagent ledger: inbox_events not found; open the channel inbox store (InboxStore.open) on this database before protocol migrate')
  }
  for (const spec of TABLE_SPECS) {
    const table = T[spec.logical]
    if (!tables.has(table)) {
      db.exec(createTableSql(spec))
      added.push(table)
    } else {
      const present = columnNames(db, table)
      for (const column of allColumns(spec)) {
        if (present.has(column[0])) continue
        addColumn(db, table, column)
        added.push(`${table}.${column[0]}`)
      }
    }
    for (const [name, body] of Object.entries(spec.unique ?? {})) {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table}${body}`)
    }
    for (const [name, body] of Object.entries(spec.triggers ?? {})) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${name} ${body}`)
    }
  }
  // inbox_events belongs to the channel; only the owner column and its CAS trigger are ours.
  if (!columnNames(db, T.inbox_event).has('owner')) {
    db.exec(`ALTER TABLE ${T.inbox_event} ADD COLUMN owner ${INBOX_OWNER_DEF}`)
    added.push(`${T.inbox_event}.owner`)
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS sa_inbox_owner_cas ${INBOX_OWNER_TRIGGER}`)
  if (columnNames(db, T.inbox_event).has('message_id')) db.exec(`CREATE TRIGGER IF NOT EXISTS sa_inbox_no_replace ${INBOX_NO_REPLACE_TRIGGER}`)
  return added
}

/** One transaction, idempotent: a second run on a migrated database returns `added: []`. */
export function migrate(db: Db): { added: string[] } {
  db.exec('BEGIN IMMEDIATE')
  try {
    const added = migrateBody(db)
    db.exec('COMMIT')
    return { added }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Lists every missing table, column, index and trigger; any entry means the service must not start. */
export function selfCheck(db: Db): { ok: true } | { ok: false; missing: string[] } {
  const missing: string[] = []
  const tables = schemaNames(db, 'table')
  const indexes = schemaNames(db, 'index')
  const triggers = schemaNames(db, 'trigger')
  for (const spec of TABLE_SPECS) {
    const table = T[spec.logical]
    if (!tables.has(table)) {
      missing.push(table)
      continue
    }
    const present = columnNames(db, table)
    for (const [name] of allColumns(spec)) if (!present.has(name)) missing.push(`${table}.${name}`)
    for (const name of Object.keys(spec.unique ?? {})) if (!indexes.has(name)) missing.push(`index:${name}`)
    for (const name of Object.keys(spec.triggers ?? {})) if (!triggers.has(name)) missing.push(`trigger:${name}`)
  }
  if (!tables.has(T.inbox_event)) missing.push(T.inbox_event)
  else {
    if (!columnNames(db, T.inbox_event).has('owner')) missing.push(`${T.inbox_event}.owner`)
    if (!triggers.has('sa_inbox_owner_cas')) missing.push('trigger:sa_inbox_owner_cas')
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

/**
 * Opens the kernel's own connection to the ledger at `path` (supplied by the caller),
 * migrates and self-checks it. Any failure closes the handle and throws: the
 * superagent domain does not mount, the responder keeps running.
 */
export function openLedgerDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db)
    const check = selfCheck(db)
    if (!check.ok) throw new Error(`superagent ledger self-check failed: missing ${check.missing.join(', ')}`)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
