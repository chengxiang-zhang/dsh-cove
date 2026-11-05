#!/usr/bin/env node
/**
 * Acceptance check for the superagent ledger.
 *
 * The question is not "is the code correct" - the specs and tests own that - but
 * "does the running ledger still satisfy the invariants it claims". It reads the
 * ledger read-only and nothing else: no network, no model call, no channel API, so
 * it is safe against a live installation.
 *
 * This file is the plumbing the seven-step chain and the module read-outs need:
 * argument parsing, read-only open, logical-to-physical table mapping, a check
 * registry, both output shapes, and exit-code aggregation. T28 fills the registry
 * with I1-I4, E1-E7, the P-/W-/M-/R-/D-/J-/T-/X-/V- invariants and the shadow-phase
 * checks; each entry is one row of read-out SQL written in logical table names, so
 * the SQL in the design documents can be used verbatim.
 *
 * Usage:
 *   node scripts/superagent-check.mjs [--db <path>] [--since-hours <n>] [--shadow]
 *                                    [--snapshot <file>] [--compare <file>] [--json]
 *
 * `--db` defaults to `$DSH_HOME/lark-inbox/inbox.sqlite` (`$DSH_HOME` defaults to
 * `~/.dsh`), the same ledger the responder owns. `--since-hours` is the window the
 * windowed checks read and defaults to 24. `--shadow` runs the shadow-phase checks.
 * `--snapshot` and `--compare` are E6's two halves and are wired by T28; the
 * skeleton parses them so the CLI contract is already closed.
 *
 * Exit: 0 every applicable criterion holds, 1 a criterion failed, 2 usage or IO
 * error (bad flag, missing or unopenable ledger, a statement that will not run),
 * 3 no failure but no evidence - a ledger without the sa_ tables, an empty window,
 * a shadow run below its threshold. "Nothing failed" and "nothing was proven" are
 * different answers, and the exit code is the only place that difference survives.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

/**
 * Logical table name to physical table name, as `02-协议` defines it: the DDL owns
 * this mapping (`protocol/db.ts`, T04), and the read-out SQL in the design
 * documents only ever names the logical side. The copy lives here because the check
 * runs from `scripts/` and imports no TypeScript; T28 adds the consistency test
 * against `db.ts` instead of trusting the copy.
 *
 * `inbox_event` is the responder's existing table and keeps its own name.
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
 * Each entry is one invariant or one reading:
 * - `id` printed as `<id> ok|FAIL|nodata|read <reading>`; ids are the ones the
 *   design documents and T28 use, so a failing line can be quoted in a report.
 * - `sql` is read-out SQL in logical table names. A verdict expects a small result:
 *   a single numeric cell (a count) or the empty set.
 * - `expect` is `zero` | `empty` | `eq1` | `le:N`.
 * - `kind` is `verdict` (participates in the exit code) or `reading` (printed,
 *   never judged): a host that has not used a feature yet is healthy, not failing.
 * - `requires` names the logical tables whose absence means "this ledger has never
 *   run this module", which is `nodata`, not a pass and not a SQL error.
 * - `evidence` defaults to `required`, meaning a `nodata` here makes the run exit
 *   3. A check whose input is a caller flag (E6 needs `--compare`) declares
 *   `optional`: absent input is "not applicable", which must not turn a green run
 *   into "no evidence".
 *
 * T03 registers one verdict (`P-words`) to prove the path end to end; the rest of
 * the table is T28's.
 * @type {ReadonlyArray<{id: string, sql: string, expect: string, kind: 'verdict'|'reading', requires?: string[], evidence?: 'required'|'optional'}>}
 */
export const CHECKS = Object.freeze([
  Object.freeze({
    id: 'P-words',
    sql: 'SELECT count(*) FROM outbox WHERE words > 100',
    expect: 'zero',
    kind: 'verdict',
    requires: ['outbox'],
  }),
])

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
      if (physical === undefined || !present.has(physical)) continue
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
    if (physical === undefined) continue
    text = text.replaceAll(new RegExp(`\\b${logical}\\b`, 'gu'), physical)
  }
  return text
}

/**
 * The reading a result carries: a single numeric cell is the reading (a count),
 * anything else is reported as its row count.
 * @param {Array<Record<string, unknown>>} rows
 * @returns {number}
 */
export function readingOf(rows) {
  if (rows.length === 1) {
    const cells = Object.values(rows[0])
    if (cells.length === 1 && typeof cells[0] === 'number') return cells[0]
  }
  return rows.length
}

/**
 * Judge one result against its expectation.
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} expect - `zero` | `empty` | `eq1` | `le:N`.
 * @returns {{ok: boolean, value: number}}
 */
export function judge(rows, expect) {
  if (expect === 'empty') return { ok: rows.length === 0, value: rows.length }
  const value = readingOf(rows)
  if (expect === 'zero') return { ok: value === 0, value }
  if (expect === 'eq1') return { ok: value === 1, value }
  const ceiling = /^le:(\d+)$/u.exec(expect)
  if (ceiling !== null) return { ok: value <= Number(ceiling[1]), value }
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
 * Run the registry against one open ledger.
 *
 * A statement that will not run is an IO-class error (exit 2), never a verdict: the
 * ledger exists, so silence about it would be the wrong answer. A missing table is
 * the opposite: the module has never run here, which is `nodata`.
 * @param {DatabaseSync} handle - read-only ledger.
 * @param {{sinceHours: number, shadow: boolean}} options
 * @returns {{checks: Array<object>, exit: number, mode: 'view'|'text'}}
 */
export function runChecks(handle, options) {
  const present = tableNames(handle)
  const forced = process.env[MAPPING_ENV]
  const mapping = mapLogicalNames(handle, present, forced === 'view' || forced === 'text' ? forced : undefined)
  const checks = []
  for (const check of CHECKS) {
    const missing = (check.requires ?? []).filter(logical => !present.has(PHYSICAL[logical] ?? logical))
    if (missing.length > 0) {
      checks.push({
        id: check.id,
        status: 'nodata',
        value: null,
        expect: check.expect ?? null,
        kind: check.kind,
        evidence: check.evidence ?? 'required',
        reason: `账本里没有 ${missing.join('、')} 表`,
      })
      continue
    }
    const sql = mapping.mode === 'text' ? rewriteLogicalNames(check.sql) : check.sql
    let rows
    try {
      rows = handle.prepare(sql).all()
    } catch (error) {
      throw new Error(`运行 ${check.id} 的 SQL 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (check.kind === 'reading') {
      checks.push({ id: check.id, status: 'read', value: summarize(rows), expect: null, kind: 'reading', evidence: 'optional' })
      continue
    }
    const verdict = judge(rows, check.expect)
    checks.push({
      id: check.id,
      status: verdict.ok ? 'ok' : 'FAIL',
      value: verdict.value,
      expect: check.expect,
      kind: 'verdict',
      evidence: check.evidence ?? 'required',
    })
  }
  return { checks, exit: exitCodeFor(checks), mode: mapping.mode, windowHours: options.sinceHours, shadow: options.shadow }
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
 * Print the run: JSON when asked, otherwise one line per check plus the ledger and
 * window it read, so a pasted line carries its own context.
 * @param {{checks: Array<object>, exit: number, mode: string, windowHours: number, shadow: boolean}} result
 * @param {{db: string, json: boolean}} args
 */
export function render(result, args) {
  if (args.json) {
    const checks = result.checks.map(check => ({ id: check.id, status: check.status, value: check.value, expect: check.expect }))
    return `${JSON.stringify({ checks, exit: result.exit })}\n`
  }
  const lines = [
    `账本 ${args.db}（最近 ${result.windowHours} 小时${result.shadow ? '，影子模式' : ''}；逻辑名映射 ${result.mode === 'view' ? 'TEMP VIEW' : 'SQL 文本改写'}）`,
  ]
  for (const check of result.checks) {
    if (check.status === 'read') lines.push(`${check.id} read ${display(check.value)}`)
    else if (check.status === 'nodata') lines.push(`${check.id} nodata ${check.reason}`)
    else lines.push(`${check.id} ${check.status} ${display(check.value)}`)
  }
  if (result.exit === 1) lines.push('有判据未通过。')
  else if (result.exit === 3) lines.push('未发现故障，但有判据没有证据。')
  else lines.push('全部判据通过。')
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
  process.stdout.write(render(result, args))
  process.exit(result.exit)
}

// Only run when invoked as a CLI, so importing the registry stays side-effect free.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv)
}