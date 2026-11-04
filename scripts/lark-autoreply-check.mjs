#!/usr/bin/env node
/**
 * Acceptance check for the Feishu answer path.
 *
 * The question this answers is not "is the code correct" - the test suite owns
 * that - but "is this host actually answering people, and is it ever silent".
 * It reads the reply ledger and nothing else: no network, no model call, no
 * Feishu API, so it is safe to run against a live installation at any time.
 *
 * Four criteria, each with the reading behind it:
 *
 *   answered    at least one turn produced text and was delivered
 *   consuming   no inbound message is waiting past the deadline for anything
 *   no-silence  nothing is sitting in a non-terminal state past its deadline
 *   no-duplicate one message belongs to exactly one batch
 *   explained   every closed batch has something to send, so a failure is a
 *               sentence rather than a gap
 *
 * `consuming` is the one criterion that reads the queue rather than the ledger,
 * and it exists because the silent failure this feature was built to remove looks
 * exactly like an idle one from the ledger's side: zero jobs, zero errors. A
 * message that has waited past the deadline with nobody attached is the symptom,
 * so it is measured directly.
 *
 * `answered` reports "no data" instead of failing when the ledger is empty: an
 * installation nobody has messaged yet has not failed, it has not started.
 *
 * Usage:
 *   node scripts/lark-autoreply-check.mjs [--db <path>] [--since-hours <n>] [--stuck-minutes <n>]
 *
 * Exit: 0 all applicable criteria hold, 1 something failed, 2 usage or IO error.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

/** Non-terminal states; a job here should be moving. */
const OPEN_STATES = new Set(['collecting', 'submitting', 'running', 'replying'])

/** Terminal states; a job here is done and must carry something to send. */
const CLOSED_STATES = new Set(['replied', 'failed', 'cancelled', 'reply_uncertain'])

/**
 * One row of the reply ledger, reduced to what the criteria need.
 * @typedef {object} JobFacts
 * @property {string} jobId
 * @property {string} state
 * @property {string} [outcome]
 * @property {string} replyToMessageId
 * @property {string} [replyText]
 * @property {number} updatedAt
 * @property {number} createdAt
 */

/**
 * Decide the four criteria from ledger facts.
 *
 * Pure on purpose: the numbers an operator reads should be reproducible from the
 * same rows by hand, and the failure modes should be testable without a database.
 * @param {object} input
 * @param {JobFacts[]} input.jobs - every job in the window.
 * @param {Array<{messageId: string, jobId: string}>} input.messages - batch members.
 * @param {Array<{eventId: string, receivedAt: number}>} [input.waiting] - inbound messages still pending.
 * @param {number} input.now - current epoch milliseconds.
 * @param {number} input.stuckMs - how long an open job, or an unanswered message, may sit.
 * @returns {Array<{id: string, label: string, ok: boolean|null, detail: string, sql: string}>} criteria in report order.
 */
export function evaluateJobs({ jobs, messages, waiting = [], now, stuckMs }) {
  const answered = jobs.filter(job => job.state === 'replied' && job.outcome === 'answer')

  const stuck = jobs.filter(job => OPEN_STATES.has(job.state) && now - job.updatedAt > stuckMs)

  const perMessage = new Map()
  for (const row of messages) perMessage.set(row.messageId, (perMessage.get(row.messageId) ?? 0) + 1)
  const repeated = [...perMessage.entries()].filter(([, count]) => count > 1)

  // `cancelled` is the one closed state with nothing to send: the person asked to
  // stop, or an operator turned the path off before the batch ran. Counting it as
  // an unexplained silence would be wrong.
  const unexplained = jobs.filter(job =>
    job.state !== 'cancelled'
    && (CLOSED_STATES.has(job.state) || job.state === 'replied')
    && (job.replyText ?? '').trim() === '')

  const waitingTooLong = waiting.filter(item => now - item.receivedAt > stuckMs)

  return [
    {
      id: 'answered',
      label: '至少一条回复真的发出去了',
      ok: jobs.length === 0 ? null : answered.length > 0,
      detail: jobs.length === 0
        ? '账本为空：还没有人发消息，或 responder 没有运行'
        : `${answered.length} 条已回复（共 ${jobs.length} 个作业）`,
      sql: "select count(*) from reply_jobs where state='replied' and outcome='answer'",
    },
    {
      id: 'consuming',
      label: '没有入站消息在无人接管地等',
      ok: waitingTooLong.length === 0,
      detail: waitingTooLong.length === 0
        ? `${waiting.length} 条待处理消息都还在时限内`
        : `${waitingTooLong.length} 条消息等超过 ${Math.round(stuckMs / 60000)} 分钟仍没人接：${waitingTooLong
          .map(item => `${item.eventId}(${Math.round((now - item.receivedAt) / 60000)}min)`)
          .join(', ')}`,
      sql: "select event_id, received_at from inbox_events where status='pending'",
    },
    {
      id: 'no-silence',
      label: '没有作业卡在非终态',
      ok: stuck.length === 0,
      detail: stuck.length === 0
        ? '所有作业都停在终态或有进展'
        : `${stuck.length} 个作业超过 ${Math.round(stuckMs / 60000)} 分钟没动：${stuck.map(job => `${job.jobId}(${job.state})`).join(', ')}`,
      sql: `select job_id, state from reply_jobs where state in ('collecting','submitting','running','replying')`,
    },
    {
      id: 'no-duplicate',
      label: '一条消息只属于一个批次',
      ok: repeated.length === 0,
      detail: repeated.length === 0
        ? `${messages.length} 条消息，无重复归属`
        : `${repeated.length} 条消息被多个批次引用：${repeated.map(([id, count]) => `${id}(${count})`).join(', ')}`,
      sql: 'select message_id, count(*) from reply_job_messages group by 1 having count(*) > 1',
    },
    {
      id: 'explained',
      label: '每个结案作业都有话可说',
      ok: unexplained.length === 0,
      detail: unexplained.length === 0
        ? '所有结案作业都带正文或说明'
        : `${unexplained.length} 个作业结案却没有正文：${unexplained.map(job => `${job.jobId}(${job.state})`).join(', ')}`,
      sql: "select job_id from reply_jobs where state in ('replied','failed','reply_uncertain') and coalesce(reply_text,'')=''",
    },
  ]
}

/**
 * Open the ledger read-only.
 *
 * Read-only matters: this tool must never be able to create a table, migrate a
 * schema or write a row into the queue an operator is inspecting.
 * @param {string} path - ledger file.
 * @returns {DatabaseSync} the handle.
 */
function openReadOnly(path) {
  return new DatabaseSync(path, { readOnly: true })
}

/** Read CLI flags as `--name value` pairs. */
function readArgs(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const next = argv[index + 1]
    args.set(token.slice(2), next === undefined || next.startsWith('--') ? 'true' : next)
  }
  return {
    db: args.get('db') ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'lark-inbox', 'inbox.sqlite'),
    sinceHours: Number(args.get('since-hours') ?? 24),
    stuckMinutes: Number(args.get('stuck-minutes') ?? 10),
  }
}

/** CLI entry. */
function main(argv) {
  const { db, sinceHours, stuckMinutes } = readArgs(argv.slice(2))
  if (!Number.isFinite(sinceHours) || sinceHours <= 0) {
    process.stderr.write('lark-autoreply-check: --since-hours must be a positive number\n')
    process.exit(2)
  }
  if (!Number.isFinite(stuckMinutes) || stuckMinutes <= 0) {
    process.stderr.write('lark-autoreply-check: --stuck-minutes must be a positive number\n')
    process.exit(2)
  }
  if (!existsSync(db)) {
    process.stderr.write(`lark-autoreply-check: ledger not found at ${db}\n`)
    process.exit(2)
  }

  let handle
  try {
    handle = openReadOnly(db)
  } catch (error) {
    process.stderr.write(`lark-autoreply-check: cannot open ${db}: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }

  const since = Date.now() - sinceHours * 3_600_000
  let jobs = []
  let messages = []
  let waiting = []
  try {
    const tables = handle.prepare("select name from sqlite_master where type='table'").all()
    const names = new Set(tables.map(row => String(row.name)))
    const missing = ['reply_jobs', 'reply_job_messages', 'conv_bindings'].filter(name => !names.has(name))
    if (missing.length > 0) {
      // The answer path has never run in this process. Say so plainly rather than
      // reporting four empty criteria as if they were passes.
      process.stdout.write(`账本里没有回话表（缺 ${missing.join(', ')}）：自动回话从未在本进程跑过。\n`)
      process.stdout.write('这通常意味着插件加载的是旧代码，或 responder 没有挂起来。\n')
      process.exit(1)
    }
    jobs = handle.prepare(`SELECT job_id, state, outcome, reply_to_message_id, reply_text, created_at, updated_at
      FROM reply_jobs WHERE created_at >= ? ORDER BY created_at ASC`).all(since).map(row => ({
      jobId: String(row.job_id),
      state: String(row.state),
      ...(row.outcome === null ? {} : { outcome: String(row.outcome) }),
      replyToMessageId: String(row.reply_to_message_id),
      ...(row.reply_text === null ? {} : { replyText: String(row.reply_text) }),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }))
    messages = handle.prepare(`SELECT m.message_id, m.job_id FROM reply_job_messages m
      JOIN reply_jobs j ON j.job_id = m.job_id WHERE j.created_at >= ?`).all(since).map(row => ({
      messageId: String(row.message_id),
      jobId: String(row.job_id),
    }))
    // Inbound messages nothing is attached to. Not filtered by `since`: a message
    // that has been waiting for days is the finding, not an old record.
    waiting = handle.prepare("SELECT event_id, received_at FROM inbox_events WHERE status = 'pending'")
      .all().map(row => ({ eventId: String(row.event_id), receivedAt: Number(row.received_at) }))
  } finally {
    handle.close()
  }

  const criteria = evaluateJobs({ jobs, messages, waiting, now: Date.now(), stuckMs: stuckMinutes * 60_000 })
  process.stdout.write(`账本 ${db}（最近 ${sinceHours} 小时：${jobs.length} 个作业 / ${messages.length} 条消息）\n\n`)
  let failed = 0
  for (const criterion of criteria) {
    const mark = criterion.ok === null ? 'SKIP' : criterion.ok ? 'PASS' : 'FAIL'
    if (criterion.ok === false) failed += 1
    process.stdout.write(`${mark}  ${criterion.id.padEnd(13)} ${criterion.label}\n`)
    process.stdout.write(`      ${criterion.detail}\n`)
    process.stdout.write(`      ${criterion.sql}\n\n`)
  }
  if (failed > 0) {
    process.stdout.write(`${failed} 条判据未通过。\n`)
    process.exit(1)
  }
  const skipped = criteria.some(criterion => criterion.ok === null)
  process.stdout.write(skipped ? '可适用的判据全部通过；answered 无数据（还没有人发消息）。\n' : '四条判据全部通过。\n')
  process.exit(0)
}

// Only run when invoked as a CLI, so importing the evaluator stays side-effect free.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv)
}