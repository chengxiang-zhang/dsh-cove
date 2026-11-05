#!/usr/bin/env node
/**
 * Acceptance check for the superagent ledger: the seven-step chain, the merge
 * invariants and every module's own read-outs.
 *
 * The question is not "is the code correct" - the specs and tests own that - but
 * "does the running ledger still satisfy the invariants it claims". It reads the
 * ledger read-only and nothing else: no network, no model call, no channel API, so
 * it is safe against a live installation. The only file it writes is the snapshot
 * the caller names with `--snapshot`.
 *
 * The registry below is the whole product of this file. Each verdict is one row of
 * read-out SQL from `02`-`11`, written in logical table names so the documents can
 * be used verbatim; `runChecks` maps those names onto the physical tables, binds
 * the window, and decides the exit code. A verdict with no data to judge says
 * `nodata`, and a run with an unproven required verdict exits 3: "nothing failed"
 * and "nothing was proven" are different answers, and this file exists to keep them
 * apart.
 *
 * Usage:
 *   node scripts/superagent-check.mjs [--db <path>] [--since-hours <n>] [--shadow]
 *                                    [--snapshot <file>] [--compare <file>] [--json]
 *
 * `--db` defaults to `$DSH_HOME/lark-inbox/inbox.sqlite` (`$DSH_HOME` defaults to
 * `~/.dsh`). `--since-hours` is the window the windowed checks read and defaults
 * to 24. `--shadow` runs the shadow-phase checks. `--snapshot` writes the current
 * open-commitment set as JSON; `--compare` diffs the ledger against such a file and
 * answers E6.
 *
 * Exit: 0 every applicable criterion holds, 1 a criterion failed, 2 usage or IO
 * error (bad flag, missing or unopenable ledger, a statement that will not run, an
 * unreadable snapshot), 3 no failure but no evidence - a ledger without the sa_
 * tables, a window with no intake, a shadow run below its volume, an absent
 * `--compare`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

/**
 * Logical table name to physical table name, as `02-协议` defines it: the DDL owns
 * this mapping (`protocol/db.ts`), and the read-out SQL only ever names the logical
 * side. The copy lives here because the check runs from `scripts/` and imports no
 * TypeScript; `superagent-check.test.mjs` compares this table against `db.ts`, so
 * the copy cannot drift silently.
 * @type {Readonly<Record<string, string>>}
 */
export const PHYSICAL = Object.freeze({
  assumption: 'sa_assumption',
  attempt: 'sa_attempt',
  autonomy: 'sa_autonomy',
  commitment: 'sa_commitment',
  degrade_event: 'sa_degrade_event',
  deliberation: 'sa_deliberation',
  desk: 'sa_desk',
  doc_index: 'sa_doc_index',
  inbox_event: 'inbox_events',
  intake: 'sa_intake',
  journal: 'sa_journal',
  lease: 'sa_lease',
  mandate: 'sa_mandate',
  memory: 'sa_memory',
  outbox: 'sa_outbox',
  party: 'sa_party',
  rule: 'sa_rule',
  rule_conflict: 'sa_rule_conflict',
  rule_replay: 'sa_rule_replay',
  speculation: 'sa_speculation',
  subscription: 'sa_subscription',
  work_class: 'sa_work_class',
  workspace: 'sa_workspace',
  world_addr: 'sa_world_addr',
  world_alias: 'sa_world_alias',
  world_entity: 'sa_world_entity',
})

/**
 * The check registry.
 *
 * Entry fields:
 * - `id` is printed as `<id> ok|FAIL|nodata|read <reading>`; ids are the ones the
 *   design documents use, so a failing line can be quoted in a report.
 * - `sql` is read-out SQL in logical table names. A verdict expects a small result:
 *   a single numeric cell (a count) or the empty set.
 * - `expect` is `zero` | `empty` | `eq1` | `le:N` | `ge:N` | `lt:N`.
 *   `ge:N` means "at least N to be evidence at all": below N the check is `nodata`,
 *   never `FAIL` (a shadow run with 29 rows has not failed, it has not run enough).
 * - `window` binds the `--since-hours` window into the statement: `'since'` for one
 *   `?` (the window start), `'range'` for two (`?` start, `?` end).
 * - `kind` is `verdict` (participates in the exit code) or `reading` (printed,
 *   never judged).
 * - `requires` names the logical tables whose absence means "this ledger has never
 *   run this module", which is `nodata`, not a pass and not a SQL error.
 * - `evidence` defaults to `required`, meaning a `nodata` here makes the run exit
 *   3. A check whose input is a caller flag declares `optional`: absent input is
 *   "not applicable", which must not turn a green run into "no evidence".
 * - `shadowOnly` checks run only with `--shadow`.
 * - `nodataWhenZero` turns a zero reading into `nodata` (a table with no rows has
 *   not proven that the row is unique).
 * - `aggregate` judges from other verdicts (E7 is exactly I2 plus I2-reply).
 * - `compare` diffs the current open set against the `--compare` file (E6).
 * @type {ReadonlyArray<object>}
 */
export const CHECKS = Object.freeze([
  // 02 协议不变量
  Object.freeze({ id: 'P-json', sql: 'SELECT count(*) FROM journal WHERE length(body_json) > 8000', expect: 'zero', kind: 'verdict', requires: ['journal'] }),
  Object.freeze({ id: 'P-words', sql: 'SELECT count(*) FROM outbox WHERE words > 100', expect: 'zero', kind: 'verdict', requires: ['outbox'] }),
  Object.freeze({ id: 'P-budget', sql: "SELECT count(*) FROM commitment WHERE kind = 'deliver' AND (budget_wall_ms IS NULL OR budget_turns IS NULL)", expect: 'zero', kind: 'verdict', requires: ['commitment'] }),
  Object.freeze({ id: 'P-ask1', sql: "SELECT commitment_id, count(*) FROM assumption WHERE mode = 'asked' AND status = 'open' GROUP BY commitment_id HAVING count(*) > 1", expect: 'empty', kind: 'verdict', requires: ['assumption'] }),
  Object.freeze({ id: 'P-docwriter', sql: "SELECT count(*) FROM doc_index WHERE added_by NOT IN ('host', 'human')", expect: 'zero', kind: 'verdict', requires: ['doc_index'] }),

  // 03 内核不变量
  Object.freeze({ id: 'I1', sql: "SELECT count(*) FROM commitment WHERE state IN ('proposed', 'open', 'at_risk') AND kind <> 'goal' AND next_look_at > strftime('%s', 'now') * 1000 + 86400000", expect: 'zero', kind: 'verdict', requires: ['commitment'] }),
  Object.freeze({ id: 'I2', sql: "SELECT count(*) FROM inbox_event e LEFT JOIN intake i ON i.event_id = e.event_id AND i.shadow = 0 WHERE e.owner = 'superagent' AND (i.state IS NULL OR i.state <> 'disposed') AND e.received_at < strftime('%s', 'now') * 1000 - 600000", expect: 'zero', kind: 'verdict', requires: ['inbox_event', 'intake'] }),
  Object.freeze({ id: 'I2-reply', sql: "SELECT event_id, count(*) FROM outbox WHERE tier = 'reply' AND payload = 'text' AND event_id IS NOT NULL GROUP BY event_id HAVING count(*) > 1", expect: 'empty', kind: 'verdict', requires: ['outbox'] }),
  Object.freeze({ id: 'I3', sql: "SELECT count(*) FROM attempt a JOIN commitment c USING (commitment_id) WHERE a.state = 'running' AND c.state NOT IN ('open', 'at_risk')", expect: 'zero', kind: 'verdict', requires: ['attempt', 'commitment'] }),
  Object.freeze({ id: 'I4', sql: "SELECT count(DISTINCT lease_epoch) FROM outbox WHERE state = 'queued'", expect: 'le:1', kind: 'verdict', requires: ['outbox'] }),
  Object.freeze({ id: 'IDLE', sql: "SELECT round(avg(ops = 0), 2) FROM deliberation WHERE started_at > strftime('%s', 'now') * 1000 - 86400000", expect: 'lt:0.3', kind: 'verdict', requires: ['deliberation'] }),

  // 04 世界模型
  Object.freeze({ id: 'W-discover', sql: "SELECT count(*) FROM world_entity WHERE state = 'enrolled' AND source = 'discover'", expect: 'zero', kind: 'verdict', requires: ['world_entity'] }),
  Object.freeze({ id: 'W-lease', sql: "SELECT count(*) FROM world_entity WHERE state = 'enrolled' AND lease_until < strftime('%s', 'now') * 1000", expect: 'zero', kind: 'verdict', requires: ['world_entity'] }),
  Object.freeze({ id: 'W-workspace', sql: 'SELECT count(*) FROM workspace w WHERE w.removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM mandate m WHERE m.scope_path = w.path AND m.revoked_at IS NULL)', expect: 'zero', kind: 'verdict', requires: ['workspace', 'mandate'] }),
  Object.freeze({ id: 'W-selfgrant', sql: "SELECT count(*) FROM mandate WHERE granted_by = 'superagent'", expect: 'zero', kind: 'verdict', requires: ['mandate'] }),

  // 05 记忆
  Object.freeze({ id: 'M-dup', sql: "SELECT topic, kind, count(*) FROM memory WHERE state = 'active' GROUP BY 1, 2 HAVING count(*) > 1", expect: 'empty', kind: 'verdict', requires: ['memory'] }),
  Object.freeze({ id: 'M-promote', sql: "SELECT date(created_at / 1000, 'unixepoch', 'localtime') d, count(*) FROM outbox WHERE moment = 'ask' AND body LIKE '%要不要在群里%' GROUP BY d HAVING count(*) > 1", expect: 'empty', kind: 'verdict', requires: ['outbox'] }),
  Object.freeze({ id: 'M-canary', sql: "SELECT count(*) FROM outbox o JOIN desk d USING (chat_id) WHERE d.chat_type = 'group' AND o.body LIKE '%CANARY-%'", expect: 'zero', kind: 'verdict', requires: ['outbox', 'desk'] }),
  Object.freeze({ id: 'M-source', sql: "SELECT count(*) FROM memory WHERE authority IN ('owner-said', 'party-said') AND (source_event IS NULL OR source_quote IS NULL)", expect: 'zero', kind: 'verdict', requires: ['memory'] }),

  // 06 规则
  Object.freeze({ id: 'R-trace', sql: 'SELECT count(*) FROM deliberation WHERE rule_trace IS NULL', expect: 'zero', kind: 'verdict', requires: ['deliberation'] }),
  Object.freeze({ id: 'R-extract', sql: "SELECT count(*) FROM rule WHERE provenance = 'extracted' AND state = 'active' AND approved_by IS NULL", expect: 'zero', kind: 'verdict', requires: ['rule'] }),
  Object.freeze({ id: 'R-inferred', sql: "SELECT count(*) FROM rule WHERE provenance = 'inferred' AND layer <> 'technique'", expect: 'zero', kind: 'verdict', requires: ['rule'] }),
  Object.freeze({ id: 'R-cap', sql: "SELECT count(*) FROM rule WHERE state = 'active'", expect: 'le:120', kind: 'verdict', requires: ['rule'] }),
  Object.freeze({ id: 'R-replay', sql: "SELECT count(*) FROM rule r WHERE r.state = 'active' AND r.provenance IN ('extracted', 'inferred') AND NOT EXISTS (SELECT 1 FROM rule_replay p WHERE p.rule_id = r.rule_id)", expect: 'zero', kind: 'verdict', requires: ['rule', 'rule_replay'] }),
  Object.freeze({ id: 'R-const', sql: "SELECT count(*) FROM rule WHERE layer = 'constitution' AND approved_by <> 'owner'", expect: 'zero', kind: 'verdict', requires: ['rule'] }),

  // 07 桌子
  Object.freeze({ id: 'D-fp', sql: 'SELECT window_id, audience_class, count(DISTINCT dossier_hash) FROM deliberation WHERE started_at BETWEEN ? AND ? GROUP BY 1, 2 HAVING count(DISTINCT dossier_hash) > 1', expect: 'empty', kind: 'verdict', requires: ['deliberation'], window: 'range' }),
  Object.freeze({ id: 'D-pub', sql: 'SELECT window_id, count(DISTINCT pub_hash) FROM deliberation WHERE started_at BETWEEN ? AND ? GROUP BY 1 HAVING count(DISTINCT pub_hash) > 1', expect: 'empty', kind: 'verdict', requires: ['deliberation'], window: 'range' }),
  Object.freeze({ id: 'D-open8', sql: 'SELECT count(*) FROM desk d WHERE d.session_id IS NOT NULL AND (SELECT count(*) FROM commitment c WHERE c.desk_id = d.desk_id AND c.state IN (\'proposed\', \'open\', \'at_risk\')) > 8', expect: 'zero', kind: 'verdict', requires: ['desk', 'commitment'] }),

  // 08 判断（N23：未结案 = proposed/open/at_risk）
  Object.freeze({ id: 'J-thread', sql: "SELECT thread_key, count(*) FROM commitment WHERE kind = 'deliver' AND parent_id IS NULL AND state IN ('proposed', 'open', 'at_risk') GROUP BY 1 HAVING count(*) > 1", expect: 'empty', kind: 'verdict', requires: ['commitment'] }),

  // 09 时机
  Object.freeze({ id: 'T-interrupt', sql: "SELECT date(created_at / 1000, 'unixepoch', 'localtime') d, count(*) FROM outbox WHERE tier = 'interrupt' GROUP BY d HAVING count(*) > 3", expect: 'empty', kind: 'verdict', requires: ['outbox'] }),
  Object.freeze({ id: 'T-brief', sql: "SELECT date(created_at / 1000, 'unixepoch', 'localtime') d, count(*) FROM outbox WHERE moment = 'brief' GROUP BY d HAVING count(*) > 1", expect: 'empty', kind: 'verdict', requires: ['outbox'] }),

  // 10 执行体
  Object.freeze({ id: 'X-evidence', sql: "SELECT count(*) FROM commitment WHERE state = 'fulfilled' AND evidence_json IS NULL", expect: 'zero', kind: 'verdict', requires: ['commitment'] }),
  Object.freeze({ id: 'X-stale', sql: "SELECT count(*) FROM attempt WHERE state = 'running' AND last_tool_at < strftime('%s', 'now') * 1000 - 600000", expect: 'zero', kind: 'verdict', requires: ['attempt'] }),

  // 11 恢复
  Object.freeze({ id: 'V-orphan-dup', sql: "SELECT commitment_id, count(*) FROM outbox WHERE idem_key LIKE 'orphan:%' GROUP BY 1 HAVING count(*) > 1", expect: 'empty', kind: 'verdict', requires: ['outbox'] }),
  Object.freeze({ id: 'V-orphan-open', sql: "SELECT count(*) FROM commitment WHERE state = 'orphaned' AND closed_at IS NULL", expect: 'zero', kind: 'verdict', requires: ['commitment'] }),
  Object.freeze({ id: 'V-lease1', sql: 'SELECT count(*) FROM lease', expect: 'eq1', kind: 'verdict', requires: ['lease'], nodataWhenZero: true }),

  // 01 R23：已结案承诺上还有未消费的追加/直通
  Object.freeze({ id: 'R23', sql: "SELECT count(*) FROM journal j JOIN commitment c USING (commitment_id) WHERE c.state IN ('fulfilled', 'unverified') AND j.kind IN ('amend', 'passthrough') AND j.consumed_turn IS NULL", expect: 'zero', kind: 'verdict', requires: ['journal', 'commitment'] }),

  // 七步链（01 §E）：窗口 = --since-hours
  Object.freeze({
    id: 'E1',
    sql: "SELECT count(*) FROM commitment c JOIN inbox_event e ON e.event_id = c.origin_ref WHERE c.origin_kind = 'event' AND c.kind = 'deliver' AND c.created_at > ? AND ((SELECT MIN(o.created_at) FROM outbox o WHERE o.commitment_id = c.commitment_id AND o.moment = 'ack') IS NULL OR (SELECT MIN(o.created_at) FROM outbox o WHERE o.commitment_id = c.commitment_id AND o.moment = 'ack') > e.received_at + 30000 OR (SELECT MIN(o.created_at) FROM outbox o WHERE o.commitment_id = c.commitment_id AND o.moment = 'ack') > (SELECT MIN(t.started_at) FROM attempt t WHERE t.commitment_id = c.commitment_id))",
    expect: 'zero', kind: 'verdict', requires: ['commitment', 'inbox_event', 'outbox', 'attempt'], window: 'since',
  }),
  Object.freeze({
    id: 'E2',
    sql: "SELECT count(*) FROM outbox o WHERE o.commitment_id IS NOT NULL AND o.created_at > ? AND o.moment NOT IN ('ask', 'cannot', 'pushback') AND o.created_at > (SELECT MIN(a.created_at) FROM outbox a WHERE a.commitment_id = o.commitment_id AND a.moment = 'ack') AND o.created_at < (SELECT MIN(d.created_at) FROM outbox d WHERE d.commitment_id = o.commitment_id AND d.moment = 'deliver')",
    expect: 'zero', kind: 'verdict', requires: ['outbox'], window: 'since',
  }),
  Object.freeze({
    id: 'E3',
    sql: "SELECT count(*) FROM outbox o JOIN commitment c USING (commitment_id) WHERE o.moment = 'deliver' AND o.created_at > ? AND (o.words > 100 OR (c.state = 'fulfilled' AND c.evidence_json IS NULL) OR (c.state = 'unverified' AND o.body NOT LIKE '做完了，但没验证%'))",
    expect: 'zero', kind: 'verdict', requires: ['outbox', 'commitment'], window: 'since',
  }),
  Object.freeze({
    id: 'E4',
    sql: "SELECT count(*) FROM (SELECT i.thread_key FROM intake i WHERE i.disposition = 'amend' AND i.shadow = 0 GROUP BY i.thread_key HAVING (SELECT count(*) FROM commitment c WHERE c.thread_key = i.thread_key AND c.kind = 'deliver' AND c.parent_id IS NULL AND c.state IN ('proposed', 'open', 'at_risk')) <> 1 OR (SELECT count(*) FROM journal j JOIN commitment c2 ON c2.commitment_id = j.commitment_id WHERE c2.thread_key = i.thread_key AND j.kind = 'amend') < 1)",
    expect: 'zero', kind: 'verdict', requires: ['intake', 'commitment', 'journal'],
  }),
  Object.freeze({
    id: 'E5',
    sql: "SELECT count(*) FROM intake i JOIN inbox_event e ON e.event_id = i.event_id LEFT JOIN commitment c ON c.thread_key = i.thread_key AND c.state = 'released' WHERE i.disposition = 'release' AND i.shadow = 0 AND i.created_at > ? AND (c.commitment_id IS NULL OR c.closed_at IS NULL OR c.closed_at - e.received_at > 60000 OR (SELECT count(*) FROM attempt a WHERE a.commitment_id = c.commitment_id AND (a.state <> 'ended' OR a.ended_at IS NULL OR a.ended_at - e.received_at > 60000)) > 0 OR (SELECT count(*) FROM outbox o WHERE o.commitment_id = c.commitment_id AND o.created_at > c.closed_at + 5000) > 1)",
    expect: 'zero', kind: 'verdict', requires: ['intake', 'inbox_event', 'commitment', 'attempt', 'outbox'], window: 'since',
  }),
  Object.freeze({ id: 'E6', expect: null, kind: 'verdict', requires: ['commitment'], compare: true, evidence: 'optional' }),
  Object.freeze({ id: 'E7', expect: null, kind: 'verdict', aggregate: ['I2', 'I2-reply'] }),

  // 窗口内有没有任何证据：24 小时一条 intake 都没有时，E 链是空转而不是通过。
  Object.freeze({ id: 'E-window', sql: 'SELECT count(*) FROM intake WHERE shadow = 0 AND created_at > ?', expect: 'ge:1', kind: 'verdict', requires: ['intake'], window: 'since' }),

  // 影子期（N12、N18）
  Object.freeze({ id: 'S-owner', sql: "SELECT count(*) FROM intake i JOIN inbox_event e ON e.event_id = i.event_id WHERE i.shadow = 1 AND e.owner <> 'responder'", expect: 'zero', kind: 'verdict', requires: ['intake', 'inbox_event'], shadowOnly: true }),
  Object.freeze({ id: 'S-outbox', sql: "SELECT count(*) FROM outbox o JOIN inbox_event e ON e.event_id = o.event_id WHERE e.owner = 'responder'", expect: 'zero', kind: 'verdict', requires: ['outbox', 'inbox_event'], shadowOnly: true }),
  Object.freeze({ id: 'S-commit', sql: "SELECT count(*) FROM commitment c JOIN inbox_event e ON c.origin_ref = e.event_id WHERE c.origin_kind = 'event' AND e.owner = 'responder'", expect: 'zero', kind: 'verdict', requires: ['commitment', 'inbox_event'], shadowOnly: true }),
  Object.freeze({ id: 'S-volume', sql: 'SELECT count(*) FROM intake WHERE shadow = 1 AND created_at > ?', expect: 'ge:30', kind: 'verdict', requires: ['intake'], window: 'since', shadowOnly: true }),

  // 读数类：只输出，不判定，不影响退出码。
  Object.freeze({ id: 'J-dispositions', sql: "SELECT disposition, count(*) FROM intake WHERE state = 'disposed' GROUP BY 1 ORDER BY 2 DESC", kind: 'reading', requires: ['intake'] }),
  Object.freeze({ id: 'J-misjudge', sql: "SELECT round(avg(corrects), 2) FROM intake WHERE state = 'disposed'", kind: 'reading', requires: ['intake'] }),
  Object.freeze({ id: 'T-tiers', sql: "SELECT tier, count(*) FROM outbox WHERE state = 'sent' AND created_at > ? GROUP BY 1", kind: 'reading', requires: ['outbox'], window: 'since' }),
  Object.freeze({ id: 'T-spec-adopt', sql: "SELECT kind, round(avg(state = 'used'), 2) FROM speculation GROUP BY 1", kind: 'reading', requires: ['speculation'] }),
  Object.freeze({ id: 'X-attempt-states', sql: 'SELECT state, count(*) FROM attempt GROUP BY 1', kind: 'reading', requires: ['attempt'] }),
  Object.freeze({ id: 'X-switched', sql: 'SELECT round(avg(executor_switched), 2), count(*) FROM commitment WHERE closed_at IS NOT NULL', kind: 'reading', requires: ['commitment'] }),
  Object.freeze({ id: 'X-reconcile', sql: "SELECT count(*) FROM attempt WHERE cancel_origin = 'reconcile'", kind: 'reading', requires: ['attempt'] }),
  Object.freeze({ id: 'V-degrade-open', sql: 'SELECT degrade_id, reason, scope, started_at, ended_at FROM degrade_event WHERE ended_at IS NULL', kind: 'reading', requires: ['degrade_event'] }),
  Object.freeze({ id: 'V-open', sql: "SELECT commitment_id, state FROM commitment WHERE state IN ('proposed', 'open', 'at_risk') ORDER BY 1", kind: 'reading', requires: ['commitment'] }),
  Object.freeze({ id: 'D-size', sql: 'SELECT round(avg(dossier_tokens)), round(avg(ops = 0), 2) FROM deliberation WHERE started_at > ?', kind: 'reading', requires: ['deliberation'], window: 'since' }),
  Object.freeze({ id: 'R-calibration', sql: 'SELECT class_id, samples, round(eta_factor, 2), ask_mode, pushback_mode, preferred_executor FROM work_class WHERE samples > 0 ORDER BY samples DESC', kind: 'reading', requires: ['work_class'] }),
])

/** The open-commitment set, the one query E6 and `--snapshot` share (`11` 读数第一条). */
const OPEN_SET_SQL = "SELECT commitment_id, state FROM commitment WHERE state IN ('proposed', 'open', 'at_risk') ORDER BY 1"

/** `--name value` and `--switch` pairs the CLI accepts. */
const FLAGS = Object.freeze({
  db: 'value',
  'since-hours': 'value',
  'snapshot': 'value',
  'compare': 'value',
  'shadow': 'switch',
  'json': 'switch',
})

/**
 * Test-only hook: pin one logical-name mapping so both paths run the same checks.
 * Production leaves it unset and takes the TEMP VIEW path with a text fallback.
 */
const MAPPING_ENV = 'SUPERAGENT_CHECK_MAPPING'

/** Default ledger path, the same resolution the responder uses. */
export function defaultLedgerPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'lark-inbox', 'inbox.sqlite')
}

/**
 * Parse the CLI contract.
 * @param {string[]} argv - arguments after the script name.
 * @returns {{error: string} | {db: string, sinceHours: number, shadow: boolean, json: boolean, snapshot?: string, compare?: string}}
 */
export function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) return { error: `无法识别的参数 ${token}` }
    const name = token.slice(2)
    const kind = Object.prototype.hasOwnProperty.call(FLAGS, name) ? FLAGS[name] : undefined
    if (kind === undefined) return { error: `未知参数 --${name}` }
    if (kind === 'switch') {
      values.set(name, 'true')
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next === '' || next.startsWith('--')) return { error: `--${name} 缺少值` }
    values.set(name, next)
    index += 1
  }
  const rawHours = values.get('since-hours') ?? '24'
  const sinceHours = Number(rawHours)
  if (!Number.isFinite(sinceHours) || sinceHours <= 0) {
    return { error: `--since-hours 必须是正数（收到 ${rawHours}）` }
  }
  const db = values.get('db') ?? defaultLedgerPath()
  if (db.trim() === '') return { error: '--db 不能是空路径' }
  return {
    db,
    sinceHours,
    shadow: values.has('shadow'),
    json: values.has('json'),
    ...(values.has('snapshot') ? { snapshot: values.get('snapshot') } : {}),
    ...(values.has('compare') ? { compare: values.get('compare') } : {}),
  }
}

/**
 * Map logical table names onto the physical ones.
 *
 * The documented read-out SQL names logical tables, so either the connection
 * carries a TEMP VIEW per logical name (the TEMP database stays writable on a
 * read-only connection) or the SQL text is rewritten word by word. Both paths run
 * the same registry and both are covered by the same test cases; the fallback is
 * there because a TEMP write is not guaranteed to be accepted everywhere the check
 * runs. A preference of `text` skips the views entirely (test hook).
 * @param {DatabaseSync} handle - the read-only ledger.
 * @param {Set<string>} present - physical table names in the ledger.
 * @param {'view'|'text'|undefined} preference - forced path, when a test asks.
 * @returns {{mode: 'view'|'text'}}
 */
export function mapLogicalNames(handle, present, preference) {
  if (preference !== 'text') {
    let allViews = true
    for (const [logical, physical] of Object.entries(PHYSICAL)) {
      if (!present.has(physical)) continue
      try {
        handle.exec(`CREATE TEMP VIEW "${logical}" AS SELECT * FROM "${physical}"`)
      } catch {
        allViews = false
        break
      }
    }
    if (allViews) return { mode: 'view' }
  }
  return { mode: 'text' }
}

/**
 * Rewrite logical table names in one statement to physical names.
 *
 * Word boundaries matter: `sa_outbox` must not be read as `outbox`, and
 * `rule_replay` must not be read as `rule`.
 * @param {string} sql - statement in logical names.
 * @returns {string} the same statement in physical names.
 */
export function rewriteLogicalNames(sql) {
  let text = sql
  for (const [logical, physical] of Object.entries(PHYSICAL)) {
    text = text.replaceAll(new RegExp(`\\b${logical}\\b`, 'gu'), physical)
  }
  return text
}

/**
 * The reading a result carries: a single numeric cell is the reading (a count), a
 * single NULL cell means "this query has nothing to say", anything else is
 * reported as its row count.
 * @param {Array<Record<string, unknown>>} rows
 * @returns {number | null}
 */
export function readingOf(rows) {
  if (rows.length === 1) {
    const cells = Object.values(rows[0])
    if (cells.length === 1) {
      const value = cells[0]
      if (typeof value === 'number') return value
      if (value === null) return null
    }
  }
  return rows.length
}

/**
 * Judge one result against its expectation.
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} expect - `zero` | `empty` | `eq1` | `le:N` | `ge:N` | `lt:N`.
 * @returns {{ok: boolean, value: number | null, nodata?: boolean, reason?: string}}
 */
export function judge(rows, expect) {
  if (expect === 'empty') return { ok: rows.length === 0, value: rows.length }
  const value = readingOf(rows)
  if (value === null) return { ok: false, value: null, nodata: true, reason: '这条判据没有读数' }
  if (expect === 'zero') return { ok: value === 0, value }
  if (expect === 'eq1') return { ok: value === 1, value }
  const ceiling = /^le:(\d+)$/u.exec(expect)
  if (ceiling !== null) return { ok: value <= Number(ceiling[1]), value }
  const floor = /^ge:(\d+)$/u.exec(expect)
  if (floor !== null) {
    const minimum = Number(floor[1])
    if (value < minimum) {
      return { ok: false, value, nodata: true, reason: `只有 ${String(value)}，不足证据门槛 ${String(minimum)}` }
    }
    return { ok: true, value }
  }
  const below = /^lt:(\d+(?:\.\d+)?)$/u.exec(expect)
  if (below !== null) return { ok: value < Number(below[1]), value }
  throw new Error(`未知期望 ${expect}`)
}

/** Physical table names the ledger holds. */
function tableNames(handle) {
  return new Set(handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)))
}

/** The value of a reading, kept whole so `--json` stays machine-readable. */
function summarize(rows) {
  if (rows.length === 1) {
    const cells = Object.values(rows[0])
    if (cells.length === 1) return cells[0]
  }
  return rows
}

/**
 * The open-commitment set, or null when the ledger has no commitment table.
 * @param {DatabaseSync} handle - read-only ledger.
 * @param {Set<string>} present - physical table names.
 * @param {{mode: 'view'|'text'}} mapping - mapping in force.
 * @returns {Array<{commitment_id: string, state: string}> | null}
 */
function readOpenSet(handle, present, mapping) {
  if (!present.has(PHYSICAL.commitment)) return null
  const sql = mapping.mode === 'text' ? rewriteLogicalNames(OPEN_SET_SQL) : OPEN_SET_SQL
  return handle.prepare(sql).all().map(row => ({ commitment_id: String(row.commitment_id), state: String(row.state) }))
}

/**
 * Diff the current open set against a snapshot (`[{commitment_id, state}]`).
 * @param {Array<{commitment_id: string, state: string}>} current
 * @param {Array<{commitment_id: string, state: string}>} snapshot
 * @returns {{added: string[], removed: string[], changed: string[]}}
 */
export function diffOpenSets(current, snapshot) {
  const before = new Map(snapshot.map(row => [row.commitment_id, row.state]))
  const after = new Map(current.map(row => [row.commitment_id, row.state]))
  const added = [...after.keys()].filter(id => !before.has(id)).sort()
  const removed = [...before.keys()].filter(id => !after.has(id)).sort()
  const changed = [...after.keys()].filter(id => before.has(id) && before.get(id) !== after.get(id)).sort()
  return { added, removed, changed }
}

/** Read and validate a snapshot file. */
function readSnapshot(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`快照不是数组：${path}`)
  return parsed.map((row, index) => {
    const record = row
    if (typeof record !== 'object' || record === null || typeof record.commitment_id !== 'string' || typeof record.state !== 'string') {
      throw new Error(`快照第 ${String(index + 1)} 行不是 {commitment_id, state}：${path}`)
    }
    return { commitment_id: record.commitment_id, state: record.state }
  })
}

/**
 * Run the registry against one open ledger.
 *
 * A statement that will not run is an IO-class error (exit 2), never a verdict: the
 * ledger exists, so silence about it would be the wrong answer. A missing table is
 * the opposite: the module has never run here, which is `nodata`.
 * @param {DatabaseSync} handle - read-only ledger.
 * @param {{sinceHours: number, shadow?: boolean, compare?: string, snapshot?: string, now?: number}} options
 * @returns {object} the results, the exit code, the mapping and the open set.
 */
export function runChecks(handle, options) {
  const now = options.now ?? Date.now()
  const since = now - options.sinceHours * 3_600_000
  const present = tableNames(handle)
  const forced = process.env[MAPPING_ENV]
  const mapping = mapLogicalNames(handle, present, forced === 'view' || forced === 'text' ? forced : undefined)
  const checks = []
  const byId = new Map()
  let openSet

  const push = (check, result) => {
    const entry = { expect: check.expect ?? null, evidence: check.evidence ?? 'required', ...result, id: check.id, kind: check.kind }
    checks.push(entry)
    byId.set(check.id, entry)
  }

  for (const check of CHECKS) {
    if (check.shadowOnly === true && options.shadow !== true) continue
    const missing = (check.requires ?? []).filter(logical => !present.has(PHYSICAL[logical] ?? logical))
    if (missing.length > 0) {
      push(check, { status: 'nodata', value: null, reason: `账本里没有 ${missing.join('、')} 表` })
      continue
    }
    if (check.aggregate !== undefined) {
      const members = check.aggregate.map(id => byId.get(id)).filter(entry => entry !== undefined)
      const failed = members.filter(entry => entry.status === 'FAIL')
      const unproven = members.filter(entry => entry.status === 'nodata')
      if (failed.length > 0) push(check, { status: 'FAIL', value: failed.length, reason: `${failed.map(entry => entry.id).join('、')} 未通过` })
      else if (unproven.length > 0) push(check, { status: 'nodata', value: null, reason: `${unproven.map(entry => entry.id).join('、')} 没有证据` })
      else push(check, { status: 'ok', value: members.length })
      continue
    }
    if (check.compare === true) {
      if (options.compare === undefined) {
        push(check, { status: 'nodata', value: null, reason: '缺少 --compare' })
        continue
      }
      if (openSet === undefined) openSet = readOpenSet(handle, present, mapping)
      const snapshot = readSnapshot(options.compare)
      const diff = diffOpenSets(openSet ?? [], snapshot)
      const total = diff.added.length + diff.removed.length + diff.changed.length
      const detail = total === 0
        ? '与快照一致'
        : `新增 ${diff.added.join(', ') || '-'}；消失 ${diff.removed.join(', ') || '-'}；变更 ${diff.changed.join(', ') || '-'}`
      push(check, { status: total === 0 ? 'ok' : 'FAIL', value: total, reason: detail })
      continue
    }
    const sql = mapping.mode === 'text' ? rewriteLogicalNames(check.sql) : check.sql
    const params = check.window === 'since' ? [since] : check.window === 'range' ? [since, now] : []
    let rows
    try {
      const statement = handle.prepare(sql)
      rows = params.length > 0 ? statement.all(...params) : statement.all()
    } catch (error) {
      throw new Error(`运行 ${check.id} 的 SQL 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (check.kind === 'reading') {
      push(check, { status: 'read', value: summarize(rows), evidence: 'optional' })
      continue
    }
    const verdict = judge(rows, check.expect)
    if (verdict.nodata === true) {
      push(check, { status: 'nodata', value: verdict.value, reason: verdict.reason ?? '没有读数' })
      continue
    }
    if (check.nodataWhenZero === true && verdict.value === 0) {
      push(check, { status: 'nodata', value: 0, reason: '表里没有行，无法确认' })
      continue
    }
    push(check, { status: verdict.ok ? 'ok' : 'FAIL', value: verdict.value })
  }

  if (openSet === undefined && options.snapshot !== undefined) openSet = readOpenSet(handle, present, mapping)
  return {
    checks,
    exit: exitCodeFor(checks),
    mode: mapping.mode,
    windowHours: options.sinceHours,
    shadow: options.shadow === true,
    openSet: openSet ?? null,
  }
}

/**
 * Aggregate the exit code: a failure outranks missing evidence, and missing
 * evidence outranks a pass.
 * @param {Array<object>} checks
 * @returns {number} 0, 1 or 3.
 */
export function exitCodeFor(checks) {
  if (checks.some(check => check.status === 'FAIL')) return 1
  const unproven = checks.some(check => check.kind === 'verdict' && check.status === 'nodata' && (check.evidence ?? 'required') === 'required')
  return unproven ? 3 : 0
}

/** One check as a line a person can quote in a report. */
function display(value) {
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

/**
 * Print the run: JSON when asked, otherwise one line per verdict, then the
 * readings, so a pasted line carries its own context.
 * @param {object} result - from `runChecks`.
 * @param {{db: string, json: boolean}} args
 * @returns {string} the report.
 */
export function render(result, args) {
  if (args.json) {
    const checks = result.checks.map(check => ({ id: check.id, status: check.status, value: check.value, expect: check.expect }))
    return `${JSON.stringify({ checks, exit: result.exit })}\n`
  }
  const lines = [
    `账本 ${args.db}（最近 ${String(result.windowHours)} 小时${result.shadow ? '，影子模式' : ''}；逻辑名映射 ${result.mode === 'view' ? 'TEMP VIEW' : 'SQL 文本改写'}）`,
  ]
  const verdicts = result.checks.filter(check => check.kind === 'verdict')
  const readings = result.checks.filter(check => check.kind === 'reading')
  for (const check of verdicts) {
    if (check.status === 'nodata') lines.push(`${check.id} nodata ${check.reason ?? '没有证据'}`)
    else lines.push(`${check.id} ${check.status} ${display(check.value)}`)
  }
  for (const check of readings) {
    // A reading whose table is missing is still no data; printing `read null`
    // would claim it read something.
    if (check.status === 'nodata') lines.push(`${check.id} nodata ${check.reason ?? '没有证据'}`)
    else lines.push(`${check.id} read ${display(check.value)}`)
  }
  if (result.exit === 1) {
    const failed = verdicts.filter(check => check.status === 'FAIL').map(check => check.id)
    lines.push(`未通过的判据：${failed.join('、')}。`)
  } else if (result.exit === 3) {
    const unproven = verdicts.filter(check => check.status === 'nodata' && (check.evidence ?? 'required') === 'required').map(check => check.id)
    lines.push(`未发现故障，但这些判据没有证据：${unproven.join('、')}。`)
  } else {
    lines.push('全部判据通过。')
  }
  return `${lines.join('\n')}\n`
}

/** CLI entry. */
function main(argv) {
  const args = parseArgs(argv.slice(2))
  if (args.error !== undefined) {
    process.stderr.write(`superagent-check: ${args.error}\n`)
    process.exit(2)
  }
  if (!existsSync(args.db)) {
    process.stderr.write(`superagent-check: 账本不存在 ${args.db}\n`)
    process.exit(2)
  }
  let handle
  try {
    handle = new DatabaseSync(args.db, { readOnly: true })
  } catch (error) {
    process.stderr.write(`superagent-check: 无法只读打开 ${args.db}：${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
  let result
  try {
    result = runChecks(handle, args)
  } catch (error) {
    // Close before exiting: `process.exit` does not run `finally` blocks.
    try {
      handle.close()
    } catch {
      // The handle is already unusable; the original error is the one to report.
    }
    process.stderr.write(`superagent-check: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
  handle.close()
  if (args.snapshot !== undefined) {
    // The only file this tool writes, and it is the caller's file, not the ledger.
    writeFileSync(args.snapshot, `${JSON.stringify(result.openSet ?? [], null, 2)}\n`)
  }
  process.stdout.write(render(result, args))
  process.exit(result.exit)
}

// Only run when invoked as a CLI, so importing the registry stays side-effect free.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv)
}