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
 *   alive       the answer path says so itself, recently
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
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

/**
 * @typedef {object} ResponderHeartbeat
 * @property {number} startedAt
 * @property {number} sweptAt
 * @property {string} mode
 * @property {number} answered
 * @property {number} open
 * @property {number} failed
 */

/**
 * Read the `lark-inbox` block of a DSH profile patch.
 *
 * A whole YAML parser would be a dependency for four keys, so this reads exactly
 * the shape the profile has: a `lark-inbox:` mapping nested under the entity's
 * config, whose scalars sit on the same line and whose list items are `- id`
 * lines. It returns undefined rather than a guess when the block is absent, and
 * the caller reports "cannot tell" instead of a pass - a config check that
 * silently misreads is worse than no check.
 * @param {string} text - profile patch contents.
 * @returns {{mode?: string, openIds: string[], cwd?: string, receipt?: boolean} | undefined}
 */
export function readInboxProfile(text) {
  const lines = text.split('\n')
  const stripped = lines.map(line => stripComment(line))
  const start = stripped.findIndex(line => /^\s*["']?lark-inbox["']?:\s*$/u.test(line))
  if (start === -1) return undefined
  const baseIndent = lines[start].search(/\S/u)
  /** @type {{mode?: string, openIds: string[], cwd?: string, receipt?: boolean}} */
  const result = { openIds: [] }
  let listOwner = ''
  for (let index = start + 1; index < stripped.length; index += 1) {
    const raw = stripped[index]
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    const indent = raw.search(/\S/u)
    if (indent <= baseIndent) break
    const item = /^\s*-\s*(.+?)\s*$/u.exec(raw)
    if (item !== null) {
      if (listOwner === 'autoReplyOpenIds') result.openIds.push(trimQuotes(item[1]))
      continue
    }
    const pair = /^\s*["']?([A-Za-z][A-Za-z0-9_]*)["']?:\s*(.*?)\s*$/u.exec(raw)
    if (pair === null) continue
    const [, key, value] = pair
    listOwner = value === '' ? key : ''
    const scalar = trimQuotes(value)
    // Inline arrays are legal YAML and were read as an empty list, which reported
    // "no allowlist" for a profile that had one.
    if (key === 'autoReplyOpenIds' && value.startsWith('[')) {
      result.openIds = value.replace(/^\[|\]$/gu, '').split(',').map(item => trimQuotes(item)).filter(item => item !== '')
      listOwner = ''
      continue
    }
    if (key === 'autoReplyMode' && scalar !== '') result.mode = scalar
    if (key === 'autoReplyCwd' && scalar !== '') result.cwd = scalar
    if (key === 'autoReplyReceipt') result.receipt = scalar === 'true'
    if (key === 'retentionDays' && scalar !== '') result.retentionDays = Number(scalar)
  }
  return result
}

/**
 * How long the "one reply per message" promise actually holds.
 *
 * The idempotency keys live in the same tables retention prunes: `event_id` and
 * `message_id` in the queue, the message membership in the ledger. Once those rows
 * are gone a redelivery looks like a new message, so the honest promise is the
 * retention window - not "forever", which is what a green check would otherwise
 * imply.
 * @param {number|undefined} retentionDays - configured retention, when readable.
 * @returns the promise in days; 0 means records are never pruned.
 */
export function dedupePromiseDays(retentionDays) {
  if (retentionDays === undefined) return 30
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0
  return retentionDays
}

/**
 * Drop a trailing `#` comment that is not inside quotes.
 *
 * Without this, `retentionDays: 30 # days` parsed as NaN and was then printed as a
 * promise of "forever" - a wrong reading produced by a legal comment.
 * @param {string} line - one profile line.
 * @returns the line without its comment.
 */
export function stripComment(line) {
  let quote = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '#') return line.slice(0, index)
  }
  return line
}

/**
 * Remove surrounding quotes and trim, as the settings schema does.
 * @param {string} value - raw scalar.
 * @returns the value a running process would see.
 */
export function trimQuotes(value) {
  return String(value ?? '').trim().replace(/^['"]|['"]$/gu, '').trim()
}

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
 * @param {Array<{eventId: string, receivedAt: number, senderOpenId?: string}>} [input.waiting] - inbound messages still pending.
 * @param {ResponderHeartbeat} [input.heartbeat] - what the live process last wrote about itself.
 * @param {string} [input.heartbeatPath] - where that file lives, for the report.
 * @param {{mode?: string, openIds: string[]}} [input.liveConfig] - the profile's inbox settings, when readable.
 * @param {number} input.now - current epoch milliseconds.
 * @param {number} input.stuckMs - how long an open job, or an unanswered message, may sit.
 * @returns {Array<{id: string, label: string, ok: boolean|null, detail: string, sql: string}>} criteria in report order.
 */
export function evaluateJobs({ jobs, messages, waiting = [], heartbeat, heartbeatPath, liveConfig, now, stuckMs }) {
  // A delivery is only a delivery if the platform gave back a message id. Without
  // that check, a probe run - which records the answer and sends nothing - satisfies
  // "at least one reply really went out". This was the review's sharpest finding.
  const answered = jobs.filter(job =>
    job.kind !== 'proactive'
    && job.state === 'replied'
    && job.outcome === 'answer'
    && (job.replyMessageId ?? '') !== '')

  const stuck = jobs.filter(job => OPEN_STATES.has(job.state) && now - job.updatedAt > stuckMs)

  const perMessage = new Map()
  for (const row of messages) perMessage.set(row.messageId, (perMessage.get(row.messageId) ?? 0) + 1)
  const repeated = [...perMessage.entries()].filter(([, count]) => count > 1)

  // `cancelled` is the one closed state with nothing to send: the person asked to
  // stop, or an operator turned the path off before the batch ran. Counting it as
  // an unexplained silence would be wrong.
  // An unprompted notice that chose silence is a delivered outcome, not a gap; the
  // ledger marks it with `silent` so it can be told apart from a turn that broke.
  const choseSilence = job => job.kind === 'proactive' && job.outcome === 'empty' && (job.endReason ?? '') === 'silent'
  const unexplained = jobs.filter(job =>
    job.state !== 'cancelled'
    && (CLOSED_STATES.has(job.state) || job.state === 'replied')
    && (job.replyText ?? '').trim() === ''
    && !choseSilence(job))

  const waitingTooLong = waiting.filter(item => now - item.receivedAt > stuckMs)

  // The allowlist is the one setting whose mistake is invisible until a message
  // goes unanswered: an open id copied from the wrong place refuses the very
  // person the bot exists to answer. Comparing it against who actually wrote in is
  // the only way to catch that without waiting.
  const profile = liveConfig
  const straySenders = profile === undefined || profile.openIds.length === 0
    ? []
    : [...new Set(waiting.map(item => item.senderOpenId ?? '').filter(id => id !== ''))]
      .filter(id => !profile.openIds.includes(id))

  // The heartbeat is the only reading that comes from the live process rather than
  // from what it left behind. Everything else here can look healthy in a process
  // whose answer path is not mounted at all - that is exactly how a dead bot looked
  // like an idle one.
  const beat = heartbeat ?? undefined
  // A future timestamp means a clock jump or a forged file; either way it is not
  // evidence that a sweep happened, and a negative age would sail through `< stuckMs`.
  const beatAge = beat === undefined ? undefined : now - beat.sweptAt
  const beatPlausible = beatAge !== undefined && beatAge > -60_000

  return [
    {
      id: 'alive',
      label: '回话链路在跑（有心跳）',
      ok: beatAge === undefined ? false : beatPlausible && beatAge < stuckMs,
      detail: beat === undefined
        ? '没有心跳文件：自动回话从未在本进程挂起来（或插件加载的是旧代码）'
        : !beatPlausible
          ? `心跳时间在未来（${Math.round((beatAge ?? 0) / 60000)} 分钟），不可作为证据`
          : beatAge < stuckMs
          ? `最后心跳 ${Math.round((beatAge ?? 0) / 1000)} 秒前，mode=${beat.mode}，已回复 ${beat.answered}，进行中 ${beat.open}`
          : `心跳停在 ${Math.round((beatAge ?? 0) / 60000)} 分钟前，mode=${beat.mode}：链路还在，但已经不动了`,
      sql: `select * from json_each(readfile('${heartbeatPath ?? 'responder.json'}'))`,
    },
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
      id: 'allowlist',
      label: '在等的人都在白名单里',
      ok: profile === undefined ? null : straySenders.length === 0,
      detail: profile === undefined
        ? '读不到 profile 里的 lark-inbox 段，无法核对（不当作通过）'
        : profile.openIds.length === 0
          ? '白名单为空：任何能给机器人发消息的人都会被回答'
          : straySenders.length === 0
            ? `白名单 ${profile.openIds.length} 项覆盖了当前所有待答消息的发送者`
            : `${straySenders.join(', ')} 不在白名单里——这些消息会被拒绝`,
      sql: "select json_extract(payload,'$.senderOpenId') from inbox_events where status='pending'",
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
      label: '账本里一条消息只有一个归属',
      ok: repeated.length === 0,
      // Named for what it measures. It cannot prove the platform saw exactly one
      // send: the schema already makes a duplicate membership impossible.
      detail: repeated.length === 0
        ? `${messages.length} 条消息，无重复归属（这是账本约束，不等于平台只收到一次）`
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
  let heartbeat
  let heartbeatPath
  let liveConfig
  try {
    const tables = handle.prepare("select name from sqlite_master where type='table'").all()
    const names = new Set(tables.map(row => String(row.name)))
    const missing = ['reply_jobs', 'reply_job_messages', 'conv_bindings', 'inbox_events'].filter(name => !names.has(name))
    if (missing.length > 0) {
      // The answer path has never run in this process. Say so plainly rather than
      // reporting four empty criteria as if they were passes.
      process.stdout.write(`账本里没有回话表（缺 ${missing.join(', ')}）：自动回话从未在本进程跑过。\n`)
      process.stdout.write('这通常意味着插件加载的是旧代码，或 responder 没有挂起来。\n')
      process.exit(1)
    }
    const shapeJob = row => ({
      jobId: String(row.job_id),
      kind: String(row.kind ?? 'request'),
      state: String(row.state),
      ...(row.outcome === null ? {} : { outcome: String(row.outcome) }),
      replyToMessageId: String(row.reply_to_message_id ?? ''),
      ...(row.reply_text === null || row.reply_text === '' ? {} : { replyText: String(row.reply_text) }),
      ...(row.reply_message_id === null || row.reply_message_id === '' ? {} : { replyMessageId: String(row.reply_message_id) }),
      ...(row.end_reason === null ? {} : { endReason: String(row.end_reason) }),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    })
    const columns = `job_id, kind, state, outcome, reply_to_message_id, reply_text, reply_message_id, end_reason, created_at, updated_at`
    // Open jobs are read without the window: a job stuck for two days is exactly the
    // failure worth catching, and filtering it out hid it behind any recent success.
    const openStates = "'collecting','submitting','running','replying'"
    const open = handle.prepare(`SELECT ${columns} FROM reply_jobs WHERE state IN (${openStates})`).all()
    const finished = handle.prepare(`SELECT ${columns} FROM reply_jobs
      WHERE created_at >= ? AND state NOT IN (${openStates}) ORDER BY created_at ASC`).all(since)
    jobs = [...finished, ...open].map(shapeJob)
    messages = handle.prepare(`SELECT m.message_id, m.job_id FROM reply_job_messages m
      JOIN reply_jobs j ON j.job_id = m.job_id WHERE j.created_at >= ?`).all(since).map(row => ({
      messageId: String(row.message_id),
      jobId: String(row.job_id),
    }))
    heartbeatPath = join(dirname(db), 'responder.json')
    if (existsSync(heartbeatPath)) {
      try {
        const parsed = JSON.parse(readFileSync(heartbeatPath, 'utf8'))
        if (typeof parsed?.sweptAt === 'number') heartbeat = parsed
      } catch {
        // A corrupt heartbeat is reported as "no heartbeat", never as a pass.
        heartbeat = undefined
      }
    }
    // Inbound messages nothing is attached to. Not filtered by `since`: a message
    // that has been waiting for days is the finding, not an old record.
    waiting = handle.prepare("SELECT event_id, received_at, payload FROM inbox_events WHERE status = 'pending'")
      .all().map(row => {
        let senderOpenId = ''
        try {
          const parsed = JSON.parse(String(row.payload))
          senderOpenId = typeof parsed?.senderOpenId === 'string' ? parsed.senderOpenId : ''
        } catch { senderOpenId = '' }
        return { eventId: String(row.event_id), receivedAt: Number(row.received_at), senderOpenId }
      })
  } finally {
    handle.close()
  }

  // Same home as the ledger, so a `--db` on another installation is not matched
  // against this one's profile.
  const profilePath = join(dirname(dirname(db)), 'profiles', 'web', 'cordis.patch.yml')
  if (existsSync(profilePath)) {
    try {
      liveConfig = readInboxProfile(readFileSync(profilePath, 'utf8'))
    } catch {
      liveConfig = undefined
    }
  }
  const promise = dedupePromiseDays(liveConfig?.retentionDays)
  const criteria = evaluateJobs({
    jobs,
    messages,
    waiting,
    ...(liveConfig === undefined ? {} : { liveConfig }),
    ...(heartbeat === undefined ? {} : { heartbeat }),
    ...(heartbeatPath === undefined ? {} : { heartbeatPath }),
    now: Date.now(),
    stuckMs: stuckMinutes * 60_000,
  })
  process.stdout.write(`账本 ${db}（最近 ${sinceHours} 小时：${jobs.length} 个作业 / ${messages.length} 条消息）\n`)
  process.stdout.write(promise === 0
    ? '去重承诺：永久（终态记录不清理，任何重投都只会回一条）\n\n'
    : `去重承诺：${promise} 天 —— 超过这个期限的重投不再保证只回一条\n\n`)
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
  const skipped = criteria.filter(criterion => criterion.ok === null).map(criterion => criterion.id)
  if (skipped.length > 0) {
    // No evidence is not the same as evidence of health. Exit 3 lets a caller tell
    // "nothing failed" from "nothing was proven" instead of treating both as green.
    process.stdout.write(`未发现故障，但有 ${skipped.length} 条判据无证据：${skipped.join('、')}。\n`)
    process.exit(3)
  }
  process.stdout.write('七条判据全部通过。\n')
  process.exit(0)
}

// Only run when invoked as a CLI, so importing the evaluator stays side-effect free.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv)
}