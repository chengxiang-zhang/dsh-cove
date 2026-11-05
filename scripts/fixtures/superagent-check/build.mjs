/**
 * Fixtures for the acceptance check: one clean ledger and one broken ledger per
 * verdict.
 *
 * The columns are read from `superagent/protocol/db.ts` by importing it, because
 * a hand-copied column list drifts the moment the DDL changes. The tables here are
 * deliberately constraint-free copies of that schema: a ledger that violates an
 * invariant is, by definition, one the strict DDL would have refused to hold, so
 * the only way to build the bad cases is to drop CHECK, UNIQUE and the append-only
 * triggers while keeping the column names and types.
 *
 * Run with the TypeScript import enabled:
 *   node --experimental-strip-types scripts/fixtures/superagent-check/build.mjs [--out <dir>]
 *
 * The check script itself never imports this file; the test spawns it into a
 * temporary directory, and the acceptance command may use `--out` to produce
 * `out/clean.sqlite` and `out/bad-I2.sqlite`.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { CHECKS } from '../../superagent-check.mjs'

const DB_SOURCE = new URL(
  '../../../packages/dsh-web-all/src/host/services/superagent/protocol/db.ts',
  import.meta.url,
).href
const { LOGICAL_TABLES, PHYSICAL, migrate } = await import(DB_SOURCE)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const CHAT = 'oc_owner'
const GROUP_CHAT = 'oc_group'

/** Column names and declared types, read from the real, migrated schema. */
function readColumns() {
  const template = new DatabaseSync(':memory:')
  template.exec('CREATE TABLE inbox_events (event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, status TEXT, payload TEXT)')
  migrate(template)
  const columns = new Map()
  for (const logical of LOGICAL_TABLES) {
    const table = PHYSICAL[logical]
    columns.set(table, template.prepare(`PRAGMA table_info("${table}")`).all().map(row => ({
      name: String(row.name),
      type: String(row.type),
    })))
  }
  columns.set(PHYSICAL.inbox_event, template.prepare(`PRAGMA table_info("${PHYSICAL.inbox_event}")`).all().map(row => ({
    name: String(row.name),
    type: String(row.type),
  })))
  template.close()
  return columns
}

const COLUMNS = readColumns()

/** Create the constraint-free copies of every ledger table. */
function createTables(db) {
  for (const [table, columns] of COLUMNS) {
    const body = columns.map(column => `"${column.name}" ${column.type === '' ? 'TEXT' : column.type}`).join(', ')
    db.exec(`CREATE TABLE "${table}" (${body})`)
  }
}

/** One row, explicit columns, so a schema change fails loudly here. */
function insert(db, table, row) {
  const keys = Object.keys(row)
  const placeholders = keys.map(() => '?').join(', ')
  db.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(', ')}) VALUES (${placeholders})`)
    .run(...keys.map(key => row[key]))
}

function tables(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)))
}

/**
 * The clean ledger: one inbound event, one committed delivery that acked within
 * five seconds, one attempt that ended, one brief, one rule, one memory row.
 *
 * Every verdict in the registry has to be green on it, which is the point: a
 * check that cannot pass a plausible day is a broken check.
 */
function seedClean(db) {
  const now = Date.now()
  const received = now - 20 * MINUTE
  const ackAt = received + 5_000
  const attemptStart = received + 15_000

  insert(db, PHYSICAL.inbox_event, {
    event_id: 'e1', received_at: received, status: 'claimed', payload: '{"sender":{"open_id":"ou_1"}}',
    owner: 'superagent',
  })
  insert(db, PHYSICAL.desk, {
    desk_id: 'd1', chat_id: CHAT, chat_type: 'p2p', session_id: 's1', generation: 1,
    audience_class: 'owner_p2p', cwd: '/repo/dsh-web', turn_open: 0, event_count: 1,
    last_event_at: received, created_at: now - DAY, updated_at: now - MINUTE,
  })
  insert(db, PHYSICAL.party, {
    party_id: 'p_owner', kind: 'person', union_id: 'on_owner', open_id: 'ou_1', display: '老板',
    class: 'owner', source: 'config', created_at: now - DAY, updated_at: now - DAY,
  })
  insert(db, PHYSICAL.intake, {
    event_id: 'e1', shadow: 0, owner: 'superagent', sender: 'ou_1', desk_id: 'd1', thread_key: 't1',
    state: 'disposed', disposition: 'commit', about: '改超时', class: 'repo-change', confidence: 0.9,
    pred_eta_min: 30, pred_executor: 'oneshot', created_at: received + 2_000, updated_at: received + 2_000,
  })
  insert(db, PHYSICAL.commitment, {
    commitment_id: 'C-1', n: 1, kind: 'deliver', debtor: 'superagent', creditor: 'owner', ball: 'owner',
    desk_id: 'd1', thread_key: 't1', origin_kind: 'event', origin_ref: 'e1', work_class: 'repo-change',
    what: '把超时改成 30 秒', intent: 'deliver', check_kind: 'command', done_when: 'node --test exit 0',
    boundary: '只改超时', state: 'fulfilled', eta_at: now - 30 * MINUTE, next_look_at: null,
    eta_model_min: 30, eta_factor: 1, budget_wall_ms: 600_000, budget_turns: 3, used_wall_ms: 300_000,
    used_turns: 2, used_tokens: 900, extended: 0, evidence_json: '{"exit":0,"reading":"13 passed"}',
    actual_min: 28, attempts: 1, executor_switched: 0, closed_at: now - 8 * MINUTE,
    created_at: received + 3_000, updated_at: now - 8 * MINUTE,
  })
  insert(db, PHYSICAL.attempt, {
    attempt_id: 'a1', commitment_id: 'C-1', n: 1, executor: 'oneshot', provider: 'deepseek', model: 'flash',
    effort: 'default', reason: 'deliver', lifetime: 'oneshot', session_id: 'sess1', cwd: '/repo/dsh-web',
    state: 'ended', turn_open: 0, turns: 2, tool_calls: 7, last_tool_at: now - 9 * MINUTE,
    end_reason: 'completed', started_at: attemptStart, ended_at: now - 9 * MINUTE,
    created_at: attemptStart, updated_at: now - 9 * MINUTE,
  })
  insert(db, PHYSICAL.outbox, {
    outbox_id: 'o1', idem_key: 'ack:C-1', chat_id: CHAT, reply_to: 'om_1', event_id: 'e1', commitment_id: 'C-1',
    payload: 'text', body: '接了 C-1：把超时改成 30 秒。预计 30 分钟。不对就说。', moment: 'ack', tier: 'reply',
    audience: 'owner', words: 21, expects_reply: 0, deliver: 0, lease_epoch: 1, state: 'sent', attempts: 1,
    message_id: 'om_ack', sent_at: ackAt, created_at: ackAt, updated_at: ackAt,
  })
  insert(db, PHYSICAL.outbox, {
    outbox_id: 'o2', idem_key: 'deliver:C-1', chat_id: CHAT, reply_to: null, event_id: null, commitment_id: 'C-1',
    payload: 'text', body: '改完了。改了 scripts/x.mjs；跑了 node --test；退出码 0；读数 13 passed。', moment: 'deliver',
    tier: 'brief', audience: 'owner', words: 30, expects_reply: 0, deliver: 1, lease_epoch: 1, state: 'sent',
    attempts: 1, message_id: 'om_deliver', sent_at: now - 7 * MINUTE, created_at: now - 7 * MINUTE,
    updated_at: now - 7 * MINUTE,
  })
  insert(db, PHYSICAL.lease, {
    name: 'outlet', holder: 'h1', epoch: 1, heartbeat_at: now, expires_at: now + 30 * MINUTE,
    created_at: now - HOUR, updated_at: now,
  })
  insert(db, PHYSICAL.journal, {
    commitment_id: 'C-1', seq: 1, actor: 'superagent', kind: 'report', request_id: 'req1', consumed_turn: 1,
    verified: 1, body_json: '{"note":"done"}', created_at: now - 6 * MINUTE,
  })
  insert(db, PHYSICAL.memory, {
    memory_id: 'm1', kind: 'preference', topic: 'timeout', about: '超时偏好', body: '老板偏好 30 秒超时',
    authority: 'owner-said', source_event: 'e1', source_quote: '把超时改成 30 秒', commitment_id: 'C-1',
    state: 'active', created_at: now - 10 * MINUTE, updated_at: now - 10 * MINUTE,
  })
  insert(db, PHYSICAL.rule, {
    rule_id: 'r1', scope_path: 'local/dsh-web', layer: 'technique', when_json: '{}', then: 'allow',
    exceptions_json: null, priority: 10, provenance: 'config', version: 1, state: 'active', approved_by: null,
    rollback_if: 'two regressions', weight: 1, hits: 0, created_at: now - DAY, updated_at: now - DAY,
  })
  insert(db, PHYSICAL.deliberation, {
    deliberation_id: 'dl1', request_id: 'req1', desk_id: 'd1', commitment_id: 'C-1', trigger_kind: 'intake',
    state: 'done', shadow: 0, started_at: now - 30 * MINUTE, ended_at: now - 25 * MINUTE, window_id: 7,
    audience_class: 'owner_p2p', pub_hash: 'p1', dossier_hash: 'h1', dossier_tokens: 1_200,
    rule_trace: '[{"rule_id":"r1"}]', ops: 1, tool_errors: 0, tokens: 900, end_reason: 'completed',
    created_at: now - 30 * MINUTE, updated_at: now - 25 * MINUTE,
  })
  insert(db, PHYSICAL.work_class, {
    class_id: 'repo-change', samples: 3, eta_factor: 1.1, ask_mode: 'defaults', pushback_mode: 'cite',
    preferred_executor: 'oneshot', misjudge_rate: 0.1, p90_turns: 4, created_at: now - DAY, updated_at: now - DAY,
  })
  insert(db, PHYSICAL.world_entity, {
    entity_id: 'ent1', canonical: 'dsh-web', kind: 'repo', realm: 'local', path: 'local/dsh-web', state: 'enrolled',
    source: 'config', lease_until: now + DAY, manifest_json: null, created_at: now - DAY, updated_at: now - DAY,
  })
  insert(db, PHYSICAL.workspace, {
    path: 'local/dsh-web', entity_id: 'ent1', commitment_id: 'C-1', mandate_id: 'mnd1', branch: 'dev',
    removed_at: null, created_at: now - DAY, updated_at: now - DAY,
  })
  insert(db, PHYSICAL.mandate, {
    mandate_id: 'mnd1', principal: 'owner', scope_path: 'local/dsh-web', capability: 'read', strength: 'allow',
    policy_version: 1, granted_by: 'owner', granted_at: now - DAY, revoked_at: null, revoked_by: null,
    created_at: now - DAY, updated_at: now - DAY,
  })
  return now
}

/** An open deliver commitment, used by several bad cases. */
function openCommitment(db, now, id, threadKey, overrides = {}) {
  insert(db, PHYSICAL.commitment, {
    commitment_id: id, n: Number(id.replace(/\D/gu, '')) || 0, kind: 'deliver', debtor: 'superagent',
    creditor: 'owner', ball: 'superagent', desk_id: 'd1', thread_key: threadKey, origin_kind: 'host',
    origin_ref: `host:${id}`, work_class: 'repo-change', what: '做事', intent: 'deliver', check_kind: 'command',
    done_when: 'exit 0', boundary: '', state: 'open', eta_at: now + HOUR, next_look_at: now + HOUR,
    eta_model_min: 30, eta_factor: 1, budget_wall_ms: 600_000, budget_turns: 3, used_wall_ms: 0, used_turns: 0,
    used_tokens: 0, extended: 0, evidence_json: null, actual_min: null, attempts: 0, executor_switched: 0,
    closed_at: null, created_at: now - MINUTE, updated_at: now - MINUTE,
    ...overrides,
  })
}

/** An outbox row, for cases that only need a stray message. */
function message(db, now, id, overrides = {}) {
  insert(db, PHYSICAL.outbox, {
    outbox_id: id, idem_key: `k:${id}`, chat_id: CHAT, reply_to: null, event_id: null, commitment_id: null,
    payload: 'text', body: '一条消息。', moment: 'answer', tier: 'reply', audience: 'owner', words: 3,
    expects_reply: 0, deliver: 0, lease_epoch: 1, state: 'sent', attempts: 1, message_id: `om_${id}`,
    sent_at: now - MINUTE, created_at: now - MINUTE, updated_at: now - MINUTE, ...overrides,
  })
}

/**
 * One mutation per verdict: each turns the clean ledger into one that breaks
 * exactly that invariant (other verdicts may break too; the test asserts the
 * target one).
 * @type {Record<string, (db: DatabaseSync, now: number) => void>}
 */
const MUTATIONS = {
  'P-json': (db, now) => insert(db, PHYSICAL.journal, {
    commitment_id: 'C-1', seq: 2, actor: 'superagent', kind: 'note', request_id: null, consumed_turn: null,
    verified: null, body_json: 'x'.repeat(9_000), created_at: now - MINUTE,
  }),
  'P-words': (db, now) => message(db, now, 'o_words', { words: 120, moment: 'answer', tier: 'reply' }),
  'P-budget': (db, now) => insert(db, PHYSICAL.commitment, {
    commitment_id: 'C-2', n: 2, kind: 'deliver', debtor: 'superagent', creditor: 'owner', ball: 'owner',
    desk_id: 'd1', thread_key: 't2', origin_kind: 'host', origin_ref: 'host:C-2', work_class: 'repo-change',
    what: '做事', intent: 'deliver', check_kind: 'command', done_when: 'exit 0', state: 'fulfilled',
    budget_wall_ms: null, budget_turns: null, evidence_json: '{"exit":0}', closed_at: now - MINUTE,
    created_at: now - 2 * HOUR, updated_at: now - MINUTE,
  }),
  'P-ask1': (db, now) => {
    insert(db, PHYSICAL.assumption, {
      commitment_id: 'C-1', ordinal: 1, question: '问一', taken: '默认一', reversible: 1, mode: 'asked',
      status: 'open', resolved_by: null, created_at: now - MINUTE, updated_at: now - MINUTE,
    })
    insert(db, PHYSICAL.assumption, {
      commitment_id: 'C-1', ordinal: 2, question: '问二', taken: '默认二', reversible: 1, mode: 'asked',
      status: 'open', resolved_by: null, created_at: now - MINUTE, updated_at: now - MINUTE,
    })
  },
  'P-docwriter': (db, now) => insert(db, PHYSICAL.doc_index, {
    doc_id: 'doc1', path: 'docs/x.md', title: 'x', kind: 'handoff', commitment_id: 'C-1', added_by: 'model',
    added_at: now - MINUTE, created_at: now - MINUTE,
  }),
  I1: (db, now) => openCommitment(db, now, 'C-3', 't3', { next_look_at: now + 2 * DAY }),
  I2: (db, now) => insert(db, PHYSICAL.inbox_event, {
    event_id: 'e9', received_at: now - 15 * MINUTE, status: 'claimed', payload: '{}', owner: 'superagent',
  }),
  'I2-reply': (db, now) => message(db, now, 'o_reply', {
    event_id: 'e1', commitment_id: 'C-1', tier: 'reply', payload: 'text', created_at: now - 12 * MINUTE,
  }),
  I3: (db, now) => insert(db, PHYSICAL.attempt, {
    attempt_id: 'a3', commitment_id: 'C-1', n: 2, executor: 'oneshot', provider: 'deepseek', model: 'flash',
    reason: 'deliver', lifetime: 'oneshot', state: 'running', last_tool_at: now - MINUTE,
    started_at: now - 2 * MINUTE, created_at: now - 2 * MINUTE, updated_at: now - MINUTE,
  }),
  I4: (db, now) => {
    message(db, now, 'o_q1', { state: 'queued', lease_epoch: 1, moment: 'answer' })
    message(db, now, 'o_q2', { state: 'queued', lease_epoch: 2, moment: 'answer' })
  },
  IDLE: (db, now) => insert(db, PHYSICAL.deliberation, {
    deliberation_id: 'dl2', request_id: 'req2', desk_id: 'd1', trigger_kind: 'intake', state: 'done', shadow: 0,
    started_at: now - HOUR, ended_at: now - HOUR + MINUTE, window_id: 8, audience_class: 'owner_p2p',
    pub_hash: 'p2', dossier_hash: 'h2', dossier_tokens: 300, rule_trace: '[]', ops: 0,
    created_at: now - HOUR, updated_at: now - HOUR + MINUTE,
  }),
  'W-discover': (db, now) => insert(db, PHYSICAL.world_entity, {
    entity_id: 'ent2', canonical: 'found', kind: 'repo', realm: 'local', path: 'local/found', state: 'enrolled',
    source: 'discover', lease_until: now + DAY, created_at: now - MINUTE, updated_at: now - MINUTE,
  }),
  'W-lease': (db, now) => insert(db, PHYSICAL.world_entity, {
    entity_id: 'ent3', canonical: 'stale', kind: 'repo', realm: 'local', path: 'local/stale', state: 'enrolled',
    source: 'config', lease_until: now - MINUTE, created_at: now - DAY, updated_at: now - DAY,
  }),
  'W-workspace': (db, now) => insert(db, PHYSICAL.workspace, {
    path: 'local/orphan', entity_id: null, commitment_id: null, mandate_id: null, branch: 'dev', removed_at: null,
    created_at: now - MINUTE, updated_at: now - MINUTE,
  }),
  'W-selfgrant': (db, now) => insert(db, PHYSICAL.mandate, {
    mandate_id: 'mnd2', principal: 'superagent', scope_path: 'local/dsh-web', capability: 'write_repo',
    strength: 'allow', policy_version: 1, granted_by: 'superagent', granted_at: now - MINUTE,
    created_at: now - MINUTE, updated_at: now - MINUTE,
  }),
  'M-dup': (db, now) => insert(db, PHYSICAL.memory, {
    memory_id: 'm2', kind: 'preference', topic: 'timeout', about: '重复', body: '重复偏好',
    authority: 'observed', state: 'active', created_at: now - MINUTE, updated_at: now - MINUTE,
  }),
  'M-promote': (db, now) => {
    // Same instant on purpose: a per-day check must not straddle local midnight
    // because the fixture was built a few minutes after it.
    message(db, now, 'o_promote_1', { moment: 'ask', body: '要不要在群里说一声？', created_at: now })
    message(db, now, 'o_promote_2', { moment: 'ask', body: '要不要在群里说一声？', created_at: now })
  },
  'M-canary': (db, now) => {
    insert(db, PHYSICAL.desk, {
      desk_id: 'd_group', chat_id: GROUP_CHAT, chat_type: 'group', session_id: 's_group', generation: 1,
      audience_class: 'group_with_owner', turn_open: 0, created_at: now - DAY, updated_at: now - MINUTE,
    })
    message(db, now, 'o_canary', { chat_id: GROUP_CHAT, body: 'CANARY-42 未批准内容' })
  },
  'M-source': (db, now) => insert(db, PHYSICAL.memory, {
    memory_id: 'm3', kind: 'constraint', topic: 'source', about: '缺原话', body: '我说过', authority: 'owner-said',
    source_event: null, source_quote: null, state: 'active', created_at: now - MINUTE, updated_at: now - MINUTE,
  }),
  'R-trace': (db) => db.prepare('UPDATE "sa_deliberation" SET rule_trace = NULL WHERE deliberation_id = ?').run('dl1'),
  'R-extract': (db, now) => insert(db, PHYSICAL.rule, {
    rule_id: 'r_extract', scope_path: 'local/dsh-web', layer: 'technique', when_json: '{}', then: 'allow',
    priority: 5, provenance: 'extracted', version: 1, state: 'active', approved_by: null, weight: 1, hits: 0,
    created_at: now - MINUTE, updated_at: now - MINUTE,
  }),
  'R-inferred': (db, now) => insert(db, PHYSICAL.rule, {
    rule_id: 'r_inferred', scope_path: 'local/dsh-web', layer: 'policy', when_json: '{}', then: 'allow',
    priority: 5, provenance: 'inferred', version: 1, state: 'proposed', approved_by: null, weight: 1, hits: 0,
    created_at: now - MINUTE, updated_at: now - MINUTE,
  }),
  'R-cap': (db, now) => {
    for (let index = 0; index < 120; index += 1) {
      insert(db, PHYSICAL.rule, {
        rule_id: `r_cap_${index}`, scope_path: 'local/dsh-web', layer: 'technique', when_json: '{}', then: 'allow',
        priority: 1, provenance: 'config', version: 1, state: 'active', approved_by: null, weight: 1, hits: 0,
        created_at: now - MINUTE, updated_at: now - MINUTE,
      })
    }
  },
  'R-replay': (db, now) => insert(db, PHYSICAL.rule, {
    rule_id: 'r_replay', scope_path: 'local/dsh-web', layer: 'technique', when_json: '{}', then: 'allow',
    priority: 5, provenance: 'extracted', version: 1, state: 'active', approved_by: 'owner', weight: 1, hits: 0,
    created_at: now - MINUTE, updated_at: now - MINUTE,
  }),
  'R-const': (db, now) => insert(db, PHYSICAL.rule, {
    rule_id: 'r_const', scope_path: 'local/dsh-web', layer: 'constitution', when_json: '{}', then: 'deny',
    priority: 100, provenance: 'config', version: 1, state: 'active', approved_by: 'superagent', weight: 1,
    hits: 0, created_at: now - MINUTE, updated_at: now - MINUTE,
  }),
  'D-fp': (db, now) => insert(db, PHYSICAL.deliberation, {
    deliberation_id: 'dl_fp', request_id: 'req_fp', desk_id: 'd1', trigger_kind: 'intake', state: 'done', shadow: 0,
    started_at: now - 20 * MINUTE, ended_at: now - 15 * MINUTE, window_id: 7, audience_class: 'owner_p2p',
    pub_hash: 'p1', dossier_hash: 'h2', dossier_tokens: 300, rule_trace: '[]', ops: 1,
    created_at: now - 20 * MINUTE, updated_at: now - 15 * MINUTE,
  }),
  'D-pub': (db, now) => insert(db, PHYSICAL.deliberation, {
    deliberation_id: 'dl_pub', request_id: 'req_pub', desk_id: 'd1', trigger_kind: 'intake', state: 'done',
    shadow: 0, started_at: now - 20 * MINUTE, ended_at: now - 15 * MINUTE, window_id: 7,
    audience_class: 'owner_p2p', pub_hash: 'p2', dossier_hash: 'h1', dossier_tokens: 300, rule_trace: '[]',
    ops: 1, created_at: now - 20 * MINUTE, updated_at: now - 15 * MINUTE,
  }),
  'D-open8': (db, now) => {
    insert(db, PHYSICAL.desk, {
      desk_id: 'd8', chat_id: 'oc_d8', chat_type: 'p2p', session_id: 's8', generation: 1,
      audience_class: 'owner_p2p', turn_open: 0, created_at: now - DAY, updated_at: now - MINUTE,
    })
    for (let index = 1; index <= 9; index += 1) {
      openCommitment(db, now, `C-8${index}`, `t8-${index}`, { desk_id: 'd8' })
    }
  },
  'J-thread': (db, now) => {
    openCommitment(db, now, 'C-91', 't9')
    openCommitment(db, now, 'C-92', 't9')
  },
  'T-interrupt': (db, now) => {
    for (let index = 0; index < 4; index += 1) {
      message(db, now, `o_int_${index}`, { tier: 'interrupt', moment: 'alert', created_at: now })
    }
  },
  'T-brief': (db, now) => {
    message(db, now, 'o_brief_1', { moment: 'brief', tier: 'brief', created_at: now })
    message(db, now, 'o_brief_2', { moment: 'brief', tier: 'brief', created_at: now })
  },
  'X-evidence': (db, now) => insert(db, PHYSICAL.commitment, {
    commitment_id: 'C-10', n: 10, kind: 'deliver', debtor: 'superagent', creditor: 'owner', ball: 'owner',
    desk_id: 'd1', thread_key: 't10', origin_kind: 'host', origin_ref: 'host:C-10', work_class: 'repo-change',
    what: '做事', intent: 'deliver', check_kind: 'command', done_when: 'exit 0', state: 'fulfilled',
    budget_wall_ms: 600_000, budget_turns: 3, evidence_json: null, closed_at: now - MINUTE,
    created_at: now - 2 * HOUR, updated_at: now - MINUTE,
  }),
  'X-stale': (db, now) => {
    openCommitment(db, now, 'C-11', 't11')
    insert(db, PHYSICAL.attempt, {
      attempt_id: 'a_stale', commitment_id: 'C-11', n: 1, executor: 'oneshot', reason: 'deliver',
      lifetime: 'durable', state: 'running', turn_open: 0, last_tool_at: now - 20 * MINUTE,
      started_at: now - 30 * MINUTE, created_at: now - 30 * MINUTE, updated_at: now - 20 * MINUTE,
    })
  },
  'V-orphan-dup': (db, now) => {
    message(db, now, 'o_orphan_1', { idem_key: 'orphan:C-1', commitment_id: 'C-1' })
    message(db, now, 'o_orphan_2', { idem_key: 'orphan:C-1', commitment_id: 'C-1' })
  },
  'V-orphan-open': (db, now) => insert(db, PHYSICAL.commitment, {
    commitment_id: 'C-12', n: 12, kind: 'deliver', debtor: 'superagent', creditor: 'owner', ball: 'superagent',
    desk_id: 'd1', thread_key: 't12', origin_kind: 'host', origin_ref: 'host:C-12', work_class: 'repo-change',
    what: '做事', intent: 'deliver', check_kind: 'command', done_when: 'exit 0', state: 'orphaned',
    budget_wall_ms: 600_000, budget_turns: 3, closed_at: null, created_at: now - HOUR, updated_at: now - MINUTE,
  }),
  'V-lease1': (db, now) => insert(db, PHYSICAL.lease, {
    name: 'outlet2', holder: 'h2', epoch: 2, heartbeat_at: now, expires_at: now + HOUR, created_at: now,
    updated_at: now,
  }),
  R23: (db, now) => insert(db, PHYSICAL.journal, {
    commitment_id: 'C-1', seq: 3, actor: 'judgment', kind: 'amend', request_id: 'req3', consumed_turn: null,
    verified: null, body_json: '{"amend":"scope"}', created_at: now - MINUTE,
  }),
  // Seven-step chain failures.
  E1: (db) => db.prepare('UPDATE "inbox_events" SET received_at = received_at - 60000 WHERE event_id = ?').run('e1'),
  E2: (db, now) => message(db, now, 'o_e2', {
    commitment_id: 'C-1', moment: 'answer', created_at: now - 19 * MINUTE,
  }),
  E3: (db) => db.prepare('UPDATE "sa_commitment" SET evidence_json = NULL WHERE commitment_id = ?').run('C-1'),
  E4: (db, now) => insert(db, PHYSICAL.intake, {
    event_id: 'e4', shadow: 0, owner: 'superagent', sender: 'ou_1', desk_id: 'd1', thread_key: 't1',
    state: 'disposed', disposition: 'amend', created_at: now - 10 * MINUTE, updated_at: now - 10 * MINUTE,
  }),
  E5: (db, now) => {
    insert(db, PHYSICAL.inbox_event, {
      event_id: 'e5', received_at: now - 5 * MINUTE, status: 'claimed', payload: '{}', owner: 'superagent',
    })
    insert(db, PHYSICAL.intake, {
      event_id: 'e5', shadow: 0, owner: 'superagent', sender: 'ou_1', desk_id: 'd1', thread_key: 't5',
      state: 'disposed', disposition: 'release', created_at: now - 5 * MINUTE, updated_at: now - 5 * MINUTE,
    })
  },
  'E-window': (db) => db.prepare('UPDATE "sa_intake" SET created_at = created_at - 172800000').run(),
}

/** Shadow-phase ledger: the clean day plus `count` shadow rows from responder events. */
function addShadowRows(db, now, count) {
  for (let index = 0; index < count; index += 1) {
    const eventId = `se_${index}`
    insert(db, PHYSICAL.inbox_event, {
      event_id: eventId, received_at: now - 30 * MINUTE - index * 1_000, status: 'claimed', payload: '{}',
      owner: 'responder',
    })
    insert(db, PHYSICAL.intake, {
      event_id: eventId, shadow: 1, owner: 'superagent', sender: 'ou_2', desk_id: 'd1', thread_key: `st_${index}`,
      state: 'disposed', disposition: 'answer', created_at: now - 29 * MINUTE, updated_at: now - 29 * MINUTE,
    })
  }
}

/** Build one fixture at `path` and return the path. */
function buildFixture(path, mutate) {
  const db = new DatabaseSync(path)
  try {
    createTables(db)
    const now = seedClean(db)
    if (mutate !== undefined) mutate(db, now)
  } finally {
    db.close()
  }
  return path
}

/**
 * Build every fixture into `outDir`.
 * @param outDir - directory to create or replace.
 * @returns the paths written, by fixture name.
 */
export function buildAll(outDir) {
  const expected = CHECKS
    .filter(check => check.kind !== 'reading' && check.shadowOnly !== true && check.id !== 'E6' && check.id !== 'E7')
    .map(check => check.id)
  const missing = expected.filter(id => MUTATIONS[id] === undefined)
  if (missing.length > 0) throw new Error(`no bad fixture for: ${missing.join(', ')}`)
  const extra = Object.keys(MUTATIONS).filter(id => !expected.includes(id))
  if (extra.length > 0) throw new Error(`bad fixture without a verdict: ${extra.join(', ')}`)

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const written = { clean: join(outDir, 'clean.sqlite') }
  buildFixture(written.clean)
  for (const id of expected) written[id] = buildFixture(join(outDir, `bad-${id}.sqlite`), MUTATIONS[id])
  written['shadow-clean'] = join(outDir, 'shadow-clean.sqlite')
  buildFixture(written['shadow-clean'], (db, now) => addShadowRows(db, now, 30))
  written['shadow-29'] = join(outDir, 'shadow-29.sqlite')
  buildFixture(written['shadow-29'], (db, now) => addShadowRows(db, now, 29))
  return written
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outIndex = process.argv.indexOf('--out')
  const outDir = outIndex === -1
    ? join(dirname(fileURLToPath(import.meta.url)), 'out')
    : process.argv[outIndex + 1]
  const written = buildAll(outDir)
  const names = Object.keys(written)
  process.stdout.write(`built ${String(names.length)} fixtures in ${outDir}\n`)
  for (const name of names.slice(0, 3)) process.stdout.write(`  ${name}: ${written[name]}\n`)
  process.stdout.write('  ...\n')
}

export { COLUMNS, MUTATIONS, buildFixture, seedClean, tables }