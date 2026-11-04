/**
 * The acceptance check's own contracts.
 *
 * Its job is to fail loudly when the answer path goes quiet, so the cases that
 * matter here are the ones where it must NOT print PASS: a stuck job, one message
 * claimed by two batches, and a closed batch with nothing to say.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  dedupePromiseDays,
  evaluateJobs,
  profileCandidates,
  readAckReadings,
  readInboxProfile,
  readLiveProfile,
  readSteerReadings,
} from './lark-autoreply-check.mjs'

const SCRIPT = fileURLToPath(new URL('./lark-autoreply-check.mjs', import.meta.url))

const NOW = 1_700_000_000_000
const STUCK = 10 * 60_000

/** One ledger row as the criteria see it. */
function job(overrides) {
  return {
    jobId: 'fj_1',
    kind: 'request',
    state: 'replied',
    outcome: 'answer',
    replyToMessageId: 'om_1',
    replyText: '在的',
    // A delivery needs the platform's own message id. Without it the same row is
    // what a probe run leaves behind - recorded, never sent.
    replyMessageId: 'om_sent_1',
    createdAt: NOW - 60_000,
    updatedAt: NOW - 30_000,
    ...overrides,
  }
}

/** Criteria keyed by id, so a case can assert one without depending on order. */
function byId(criteria) {
  return Object.fromEntries(criteria.map(criterion => [criterion.id, criterion]))
}

test('an empty ledger skips the answered criterion instead of claiming a pass', () => {
  const criteria = byId(evaluateJobs({ jobs: [], messages: [], now: NOW, stuckMs: STUCK }))
  assert.equal(criteria.answered.ok, null)
  assert.equal(criteria['no-silence'].ok, true)
  assert.equal(criteria['no-duplicate'].ok, true)
  assert.equal(criteria.explained.ok, true)
})

test('a message waiting past the deadline fails the consuming criterion', () => {
  const criteria = byId(evaluateJobs({
    jobs: [],
    messages: [],
    // Zero jobs and zero errors is what an idle installation also looks like; the
    // waiting message is the difference.
    waiting: [{ eventId: 'om_x', receivedAt: NOW - STUCK - 60_000 }],
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.consuming.ok, false)
  assert.match(criteria.consuming.detail, /om_x/)
})

test('a message that just arrived is not yet a finding', () => {
  const criteria = byId(evaluateJobs({
    jobs: [],
    messages: [],
    waiting: [{ eventId: 'om_y', receivedAt: NOW - 1000 }],
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.consuming.ok, true)
})

test('one answered turn with a live heartbeat satisfies every criterion', () => {
  const criteria = byId(evaluateJobs({
    jobs: [job()],
    messages: [{ messageId: 'om_1', jobId: 'fj_1' }],
    heartbeat: { startedAt: NOW - 60_000, sweptAt: NOW - 2000, mode: 'self', answered: 1, open: 0, failed: 0 },
    liveConfig: { mode: 'self', openIds: ['ou_owner'] },
    now: NOW,
    stuckMs: STUCK,
  }))
  for (const criterion of Object.values(criteria)) assert.equal(criterion.ok, true)
})

test('an empty ledger still reports a missing heartbeat as a failure', () => {
  // This is the shape that let a dead answer path look like an idle bot.
  const criteria = byId(evaluateJobs({ jobs: [], messages: [], now: NOW, stuckMs: STUCK }))
  assert.equal(criteria.alive.ok, false)
  assert.match(criteria.alive.detail, /没有心跳/)
})

test('a heartbeat that stopped moving fails even though jobs look fine', () => {
  const criteria = byId(evaluateJobs({
    jobs: [job()],
    messages: [{ messageId: 'om_1', jobId: 'fj_1' }],
    heartbeat: { startedAt: NOW - 3_600_000, sweptAt: NOW - STUCK - 60_000, mode: 'self', answered: 1, open: 0, failed: 0 },
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.alive.ok, false)
  assert.match(criteria.alive.detail, /已经不动了/)
})

test('a job left open past the deadline fails the silence criterion', () => {
  const criteria = byId(evaluateJobs({
    jobs: [job({ state: 'running', outcome: undefined, replyText: undefined, updatedAt: NOW - STUCK - 1000 })],
    messages: [],
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria['no-silence'].ok, false)
  assert.match(criteria['no-silence'].detail, /fj_1/)
})

test('a job that is open but moving does not fail the silence criterion', () => {
  const criteria = byId(evaluateJobs({
    jobs: [job({ state: 'running', outcome: undefined, replyText: undefined, updatedAt: NOW - 1000 })],
    messages: [],
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria['no-silence'].ok, true)
})

test('one message claimed by two batches fails the duplicate criterion', () => {
  const criteria = byId(evaluateJobs({
    jobs: [job(), job({ jobId: 'fj_2' })],
    messages: [{ messageId: 'om_1', jobId: 'fj_1' }, { messageId: 'om_1', jobId: 'fj_2' }],
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria['no-duplicate'].ok, false)
  assert.match(criteria['no-duplicate'].detail, /om_1/)
})

test('a closed batch with no body fails the explanation criterion', () => {
  const criteria = byId(evaluateJobs({
    jobs: [job({ state: 'failed', outcome: undefined, replyText: undefined })],
    messages: [],
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.explained.ok, false)
})

test('an answer delivered as a reaction has something to say', () => {
  // The shape a real acknowledgement leaves behind: no body, no message id, no send
  // attempt - because the reaction on the person's own message was the whole answer.
  const criteria = byId(evaluateJobs({
    jobs: [job({
      replyText: undefined,
      replyMessageId: undefined,
      replyVia: 'reaction',
      sendAttempts: 0,
      endReason: 'ack-reaction',
    })],
    messages: [{ messageId: 'om_1', jobId: 'fj_1' }],
    heartbeat: { startedAt: NOW - 60_000, sweptAt: NOW - 1000, mode: 'self', answered: 1, open: 0, failed: 0 },
    liveConfig: { mode: 'self', openIds: ['ou_owner'], hasOpenIdsKey: true },
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.explained.ok, true)
  // And the delivery count says so out loud, without letting it count as a delivery.
  assert.match(criteria.answered.detail, /1 条以表情回答/)
  assert.equal(criteria.answered.ok, false)
})

test('a reaction row that also claims a text send cannot pass', () => {
  // A message id or a send attempt contradicts "no text went out". Passing this would
  // hide the one confusion the criterion exists to catch.
  for (const overrides of [
    { replyMessageId: 'om_sent_1', sendAttempts: 0 },
    { replyMessageId: undefined, sendAttempts: 1 },
    { replyMessageId: 'om_sent_1', sendAttempts: 2 },
  ]) {
    const criteria = byId(evaluateJobs({
      jobs: [job({ replyText: undefined, replyVia: 'reaction', ...overrides })],
      messages: [],
      now: NOW,
      stuckMs: STUCK,
    }))
    assert.equal(criteria.explained.ok, false, JSON.stringify(overrides))
    assert.match(criteria.explained.detail, /自相矛盾/)
    assert.match(criteria.explained.detail, /fj_1/)
  }
})

test('a ledger with no reply_via column behaves exactly as before', () => {
  // Every row from before the acknowledgement path reads as text, so an empty body is
  // still a defect rather than an answer.
  const criteria = byId(evaluateJobs({
    jobs: [job({ state: 'failed', outcome: undefined, replyText: undefined })],
    messages: [],
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.explained.ok, false)

  const fine = byId(evaluateJobs({
    jobs: [job()],
    messages: [{ messageId: 'om_1', jobId: 'fj_1' }],
    heartbeat: { startedAt: NOW - 60_000, sweptAt: NOW - 1000, mode: 'self', answered: 1, open: 0, failed: 0 },
    liveConfig: { mode: 'self', openIds: ['ou_owner'], hasOpenIdsKey: true },
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(fine.explained.ok, true)
  assert.doesNotMatch(fine.answered.detail, /表情/)
})

test('a cancelled batch is allowed to have nothing to say', () => {
  const criteria = byId(evaluateJobs({
    jobs: [job({ state: 'cancelled', outcome: undefined, replyText: undefined })],
    messages: [],
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.explained.ok, true)
})

test('an uncertain send must still carry the text it could not confirm', () => {
  const criteria = byId(evaluateJobs({
    jobs: [job({ state: 'reply_uncertain', outcome: 'answer', replyText: undefined })],
    messages: [],
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.explained.ok, false)
})


const PROFILE = [
  '- id: web-all',
  '  config:',
  '    feishu:',
  '      appId: cli_x',
  '    lark-inbox:',
  '      announceToAgent: false',
  '      # 自动回话：probe 先只记录',
  '      autoReplyMode: probe',
  '      autoReplyOpenIds:',
  '        - ou_395f',
  '        - "ou_abc"',
  '      autoReplyCwd: /Users/leo/code/dsh-web',
  '- insert:',
  '    - id: mcp-datasage',
].join('\n')

test('reads the inbox block without a YAML parser', () => {
  assert.deepEqual(readInboxProfile(PROFILE), {
    mode: 'probe',
    openIds: ['ou_395f', 'ou_abc'],
    hasOpenIdsKey: true,
    cwd: '/Users/leo/code/dsh-web',
  })
})

test('stops at the end of the block instead of swallowing the next section', () => {
  const parsed = readInboxProfile(PROFILE)
  assert.equal(parsed.openIds.includes('insert'), false)
  assert.equal(parsed.openIds.length, 2)
})

test('reports an absent block as unknown rather than as a default', () => {
  assert.equal(readInboxProfile('- id: other\n  config:\n    notify: {}'), undefined)
  assert.equal(readInboxProfile(''), undefined)
  // A block that exists but declares nothing is still readable: it means "no
  // settings here", which the caller reports as an empty allowlist, not as unknown.
  // `hasOpenIdsKey` is what lets it say that without also claiming the setting was
  // configured and left empty.
  assert.deepEqual(readInboxProfile('    lark-inbox:'), { openIds: [], hasOpenIdsKey: false })
})

test('an empty allowlist reads as no restriction', () => {
  const parsed = readInboxProfile('  lark-inbox:\n    autoReplyMode: self\n')
  assert.deepEqual(parsed, { mode: 'self', openIds: [], hasOpenIdsKey: false })
})

test('a sender outside the allowlist fails the criterion', () => {
  const criteria = byId(evaluateJobs({
    jobs: [],
    messages: [],
    waiting: [{ eventId: 'om_z', receivedAt: NOW - 1000, senderOpenId: 'ou_stranger' }],
    liveConfig: { mode: 'self', openIds: ['ou_owner'] },
    heartbeat: { startedAt: NOW - 60_000, sweptAt: NOW - 1000, mode: 'self', answered: 0, open: 0, failed: 0 },
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.allowlist.ok, false)
  assert.match(criteria.allowlist.detail, /ou_stranger/)
})

test('an unreadable profile fails the allowlist criterion instead of shrugging', () => {
  // SKIP here was the defect: a run that could not look at the allowlist read the
  // same as a run that found nothing wrong with it.
  const criteria = byId(evaluateJobs({ jobs: [], messages: [], now: NOW, stuckMs: STUCK }))
  assert.equal(criteria.allowlist.ok, false)
  assert.match(criteria.allowlist.detail, /读不到/)
})

test('a missing profile names the reason it could not be read', () => {
  const criteria = byId(evaluateJobs({
    jobs: [],
    messages: [],
    profileProblem: '找不到 profile（试过 /nowhere/cordis.patch.yml）',
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.allowlist.ok, false)
  assert.match(criteria.allowlist.detail, /\/nowhere\/cordis\.patch\.yml/)
})

test('a block with no allowlist key says so rather than claiming coverage', () => {
  const criteria = byId(evaluateJobs({
    jobs: [],
    messages: [],
    liveConfig: { mode: 'self', openIds: [], hasOpenIdsKey: false },
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.allowlist.ok, true)
  assert.match(criteria.allowlist.detail, /没有配置 autoReplyOpenIds/)
})

test('an allowlist that was configured and left empty reads differently', () => {
  const criteria = byId(evaluateJobs({
    jobs: [],
    messages: [],
    liveConfig: { mode: 'self', openIds: [], hasOpenIdsKey: true },
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.allowlist.ok, true)
  assert.match(criteria.allowlist.detail, /白名单为空/)
})


test('the dedupe promise is the retention window, not "forever"', () => {
  // The idempotency keys live in the tables retention prunes, so a green check must
  // not imply a stronger promise than the records can keep.
  assert.equal(dedupePromiseDays(30), 30)
  assert.equal(dedupePromiseDays(0), 0)
  assert.equal(dedupePromiseDays(undefined), 30)
  assert.equal(dedupePromiseDays(Number.NaN), 0)
})

test('retentionDays is read from the profile like every other setting', () => {
  const parsed = readInboxProfile('  lark-inbox:\n    retentionDays: 7\n')
  assert.equal(parsed.retentionDays, 7)
})


test('a probe run does not count as a delivered answer', () => {
  const criteria = byId(evaluateJobs({
    jobs: [job({ replyMessageId: undefined })],
    messages: [{ messageId: 'om_1', jobId: 'fj_1' }],
    heartbeat: { startedAt: NOW - 60_000, sweptAt: NOW - 1000, mode: 'probe', answered: 1, open: 0, failed: 0 },
    liveConfig: { mode: 'probe', openIds: ['ou_1'] },
    now: NOW,
    stuckMs: STUCK,
  }))
  // Recorded without a message id means nothing left the host.
  assert.equal(criteria.answered.ok, false)
})

test('an unprompted notice that chose silence is not an unexplained gap', () => {
  const criteria = byId(evaluateJobs({
    jobs: [job({ kind: 'proactive', outcome: 'empty', replyText: undefined, replyMessageId: undefined, endReason: 'silent' })],
    messages: [],
    heartbeat: { startedAt: NOW - 60_000, sweptAt: NOW - 1000, mode: 'self', answered: 0, open: 0, failed: 0 },
    liveConfig: { mode: 'self', openIds: ['ou_1'] },
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.explained.ok, true)
})

test('a heartbeat from the future is not evidence', () => {
  const criteria = byId(evaluateJobs({
    jobs: [],
    messages: [],
    heartbeat: { startedAt: NOW, sweptAt: NOW + 3_600_000, mode: 'self', answered: 0, open: 0, failed: 0 },
    now: NOW,
    stuckMs: STUCK,
  }))
  assert.equal(criteria.alive.ok, false)
})

test('a trailing comment does not turn a retention number into a promise of forever', () => {
  const parsed = readInboxProfile('  lark-inbox:\n    retentionDays: 30 # days\n')
  assert.equal(parsed.retentionDays, 30)
})

test('an inline array and quoted keys are read, not ignored', () => {
  const parsed = readInboxProfile('  "lark-inbox":\n    autoReplyOpenIds: [ou_a, "ou_b"]\n')
  assert.deepEqual(parsed.openIds, ['ou_a', 'ou_b'])
})


const PROFILE_WITH_ALLOWLIST = '- id: web-all\n  config:\n    lark-inbox:\n      autoReplyMode: self\n      autoReplyOpenIds:\n        - ou_owner\n'
const PROFILE_WITHOUT_BLOCK = '- id: web-all\n  config:\n    feishu:\n      appId: cli_x\n'

test('an explicit profile path is the only path tried', () => {
  // Naming a file and getting a clean reading from a different one is worse than an
  // error: the caller believes the named file was checked.
  const candidates = profileCandidates({ explicit: '/tmp/only-this.yml', home: '/home/x', db: '/home/x/.dsh/lark-inbox/inbox.sqlite' })
  assert.deepEqual(candidates, ['/tmp/only-this.yml'])
})

test('the profile is looked for independently of where the ledger sits', () => {
  // This is the defect: the path used to be derived from the ledger alone, so an
  // audit of a copied ledger lost the allowlist evidence entirely.
  const candidates = profileCandidates({ home: '/home/x', db: '/elsewhere/lark-inbox/inbox.sqlite' })
  assert.ok(candidates.includes('/home/x/.dsh/profiles/web/cordis.patch.yml'))
  assert.ok(candidates.includes('/elsewhere/profiles/web/cordis.patch.yml'))
  const withHome = profileCandidates({ dshHome: '/custom', home: '/home/x', db: '/elsewhere/lark-inbox/inbox.sqlite' })
  assert.equal(withHome[0], '/custom/profiles/web/cordis.patch.yml')
})

test('reads the live profile, and says why when it cannot', () => {
  const root = mkdtempSync(join(tmpdir(), 'lark-profile-'))
  try {
    const good = join(root, 'good.yml')
    writeFileSync(good, PROFILE_WITH_ALLOWLIST)
    const read = readLiveProfile({ explicit: good, home: root, db: join(root, 'lark-inbox', 'inbox.sqlite') })
    assert.deepEqual(read.config.openIds, ['ou_owner'])
    assert.equal(read.config.hasOpenIdsKey, true)

    // Negative control: the file exists, the block inside it does not.
    const missingBlock = join(root, 'noblk.yml')
    writeFileSync(missingBlock, PROFILE_WITHOUT_BLOCK)
    const noBlock = readLiveProfile({ explicit: missingBlock, home: root, db: join(root, 'lark-inbox', 'inbox.sqlite') })
    assert.equal(noBlock.config, undefined)
    assert.match(noBlock.problem, /没有 lark-inbox 段/)

    const gone = readLiveProfile({ explicit: join(root, 'nope.yml'), home: root, db: join(root, 'lark-inbox', 'inbox.sqlite') })
    assert.equal(gone.config, undefined)
    assert.match(gone.problem, /找不到 profile/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


/**
 * A ledger the CLI can open, built with the columns this build writes.
 *
 * The readings and the exit codes are only meaningful against a real file, so the
 * cases below run the CLI rather than calling its internals: an exit code is the
 * contract a caller actually depends on.
 */
function makeLedger({ withColumns = true, jobs = [], messages = [], steerStates = [], carried = 0, via = [], vetoed = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lark-ledger-'))
  const dir = join(root, 'lark-inbox')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'inbox.sqlite'))
  const extraJob = withColumns ? ", carry_until INTEGER, reply_via TEXT NOT NULL DEFAULT 'text'" : ''
  const extraMember = withColumns ? ", steer_state TEXT NOT NULL DEFAULT 'none'" : ''
  db.exec('CREATE TABLE inbox_events (event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL)')
  db.exec('CREATE TABLE conv_bindings (conv_key TEXT PRIMARY KEY)')
  // `send_attempts` is part of the ledger from its first release, so it is here even in
  // the "old ledger" variant; only the columns added later are conditional.
  db.exec(`CREATE TABLE reply_jobs (job_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'request', state TEXT NOT NULL,
    outcome TEXT, reply_to_message_id TEXT NOT NULL DEFAULT '', reply_text TEXT, reply_message_id TEXT,
    send_attempts INTEGER NOT NULL DEFAULT 0,
    end_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL${extraJob})`)
  db.exec(`CREATE TABLE reply_job_messages (message_id TEXT NOT NULL, job_id TEXT NOT NULL${extraMember})`)

  for (const row of jobs) {
    db.prepare(`INSERT INTO reply_jobs (job_id, kind, state, outcome, reply_text, reply_message_id, end_reason, created_at, updated_at${withColumns ? ', carry_until' : ''})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${withColumns ? ', ?' : ''})`).run(
      row.jobId, row.kind ?? 'request', row.state, row.outcome ?? 'answer', row.replyText ?? '在的',
      row.replyMessageId ?? 'om_sent', row.endReason ?? null, row.createdAt ?? Date.now() - 60_000,
      row.updatedAt ?? Date.now() - 30_000, ...(withColumns ? [row.carryUntil ?? null] : []),
    )
  }
  for (const row of messages) {
    db.prepare(`INSERT INTO reply_job_messages (message_id, job_id${withColumns ? ', steer_state' : ''}) VALUES (?, ?${withColumns ? ', ?' : ''})`)
      .run(row.messageId, row.jobId, ...(withColumns ? [row.steerState ?? 'none'] : []))
  }
  for (const state of steerStates) {
    if (withColumns) db.prepare("INSERT INTO reply_job_messages (message_id, job_id, steer_state) VALUES (?, 'fj_1', ?)").run(`om_${state}_${Math.random()}`, state)
  }
  for (const row of via) {
    if (!withColumns) continue
    // "Answered by reaction" is a whole shape, not one column: nothing was sent and
    // nothing was tried. Writing only `reply_via` would produce the self-contradictory
    // row the explanation criterion now reports on purpose.
    if (row.replyVia === 'reaction') {
      db.prepare('UPDATE reply_jobs SET reply_via = ?, reply_message_id = NULL, send_attempts = 0 WHERE job_id = ?')
        .run('reaction', row.jobId)
    } else {
      db.prepare('UPDATE reply_jobs SET reply_via = ? WHERE job_id = ?').run(row.replyVia, row.jobId)
    }
  }
  for (let index = 0; index < carried; index += 1) {
    if (withColumns) db.prepare('UPDATE reply_jobs SET carry_until = ? WHERE job_id = ?').run(Date.now() + 15_000, jobs[index]?.jobId ?? 'fj_1')
  }
  db.close()
  writeFileSync(join(dir, 'responder.json'), JSON.stringify({
    startedAt: Date.now() - 60_000, sweptAt: Date.now() - 1000, mode: 'self',
    answered: 0, open: 0, failed: 0, steer: 'on', router: 'on',
  }))
  const profile = join(root, 'profile.yml')
  writeFileSync(profile, PROFILE_WITH_ALLOWLIST)
  return { root, db: join(dir, 'inbox.sqlite'), profile, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** A passing ledger: one answered turn, one member, nothing open. */
function passingLedger(options = {}) {
  return makeLedger({
    jobs: [{ jobId: 'fj_1', state: 'replied', outcome: 'answer' }],
    messages: [{ messageId: 'om_1', jobId: 'fj_1' }],
    ...options,
  })
}

/**
 * A ledger with one reaction answer and one text answer.
 *
 * Both, because `answered` still demands the platform's own message id and a reaction
 * has none: a ledger whose *only* answer was a reaction reports zero deliveries and
 * fails that criterion. That verdict is deliberately unchanged here, so a plausible
 * installation - some answers in prose, some acknowledged - is what these cases model.
 */
function reactionLedger(options = {}) {
  return makeLedger({
    jobs: [
      { jobId: 'fj_reaction', state: 'replied', outcome: 'answer', endReason: 'ack-reaction' },
      { jobId: 'fj_text', state: 'replied', outcome: 'answer' },
    ],
    messages: [{ messageId: 'om_r', jobId: 'fj_reaction' }, { messageId: 'om_t', jobId: 'fj_text' }],
    via: [{ jobId: 'fj_reaction', replyVia: 'reaction' }],
    ...options,
  })
}

/** Run the CLI the way a caller does, with a profile pinned so nothing leaks in. */
function runCheck(ledger, extra = []) {
  return spawnSync(process.execPath, [SCRIPT, '--db', ledger.db, '--profile', ledger.profile, ...extra], { encoding: 'utf8' })
}

test('the readings are printed even though they are not part of the verdict', () => {
  const ledger = reactionLedger({ steerStates: ['consumed'], carried: 1, vetoed: 0 })
  try {
    const run = runCheck(ledger)
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /读数 steer/)
    assert.match(run.stdout, /consume 1/)
    assert.match(run.stdout, /carried 1/)
    assert.match(run.stdout, /读数 ack/)
    assert.match(run.stdout, /表情 1/)
  } finally {
    ledger.cleanup()
  }
})

test('a host that never used either feature still passes', () => {
  // Both readings at zero is a healthy installation, which is why they are readings
  // and not criteria.
  const ledger = passingLedger()
  try {
    const run = runCheck(ledger)
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /consume 0/)
  } finally {
    ledger.cleanup()
  }
})

test('--require-steer turns "no evidence" into a distinct exit code', () => {
  const quiet = passingLedger()
  try {
    const run = runCheck(quiet, ['--require-steer'])
    // Exit 3, not 1: nothing failed, nothing was proven.
    assert.equal(run.status, 3, run.stdout + run.stderr)
    assert.match(run.stdout, /没有可判定的插话证据/)
  } finally {
    quiet.cleanup()
  }

  const used = passingLedger({ steerStates: ['consumed'] })
  try {
    const run = runCheck(used, ['--require-steer'])
    assert.equal(run.status, 0, run.stdout + run.stderr)
  } finally {
    used.cleanup()
  }
})

test('a ledger from before the feature reports the missing columns, not zeros', () => {
  const ledger = makeLedger({
    withColumns: false,
    jobs: [{ jobId: 'fj_1', state: 'replied', outcome: 'answer' }],
    messages: [{ messageId: 'om_1', jobId: 'fj_1' }],
  })
  try {
    const run = runCheck(ledger)
    // Default verdict is unaffected: the readings are not criteria.
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /账本里没有插话列/)
    // And with the requirement on, no columns is the same answer as no evidence.
    const required = runCheck(ledger, ['--require-steer'])
    assert.equal(required.status, 3, required.stdout + required.stderr)
  } finally {
    ledger.cleanup()
  }
})

test('a profile without the block fails the run, and says where it looked', () => {
  // The negative control for the whole slice: delete the segment and the check must
  // stop being green.
  const ledger = passingLedger()
  try {
    writeFileSync(ledger.profile, PROFILE_WITHOUT_BLOCK)
    const run = runCheck(ledger)
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stdout, /FAIL {2}allowlist/)
    assert.match(run.stdout, /没有 lark-inbox 段/)
  } finally {
    ledger.cleanup()
  }
})

test('a profile path that does not exist fails instead of falling back', () => {
  const ledger = passingLedger()
  try {
    const run = spawnSync(process.execPath, [SCRIPT, '--db', ledger.db, '--profile', join(ledger.root, 'absent.yml')], { encoding: 'utf8' })
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stdout, /找不到 profile/)
  } finally {
    ledger.cleanup()
  }
})

test('--require-ack accepts a ledger that shows a reaction', () => {
  const ledger = reactionLedger()
  try {
    const run = runCheck(ledger, ['--require-ack'])
    assert.equal(run.status, 0, run.stdout + run.stderr)
  } finally {
    ledger.cleanup()
  }
})

test('--require-ack refuses a ledger with no reaction at all', () => {
  // Every answer went out as text, so "does an acknowledgement work" is unproven -
  // which is not the same as "it works".
  const ledger = passingLedger()
  try {
    const run = runCheck(ledger, ['--require-ack'])
    assert.equal(run.status, 3, run.stdout + run.stderr)
    assert.match(run.stdout, /没有可判定的表情证据/)
  } finally {
    ledger.cleanup()
  }
})

test('--require-ack calls a ledger without the column unreadable, not empty', () => {
  const ledger = makeLedger({
    withColumns: false,
    jobs: [{ jobId: 'fj_1', state: 'replied', outcome: 'answer' }],
    messages: [{ messageId: 'om_1', jobId: 'fj_1' }],
  })
  try {
    const run = runCheck(ledger, ['--require-ack'])
    assert.equal(run.status, 3, run.stdout + run.stderr)
    assert.match(run.stdout, /账本缺 reply_via 列/)
    // The distinction that matters: not "zero reactions", but "cannot tell".
    assert.doesNotMatch(run.stdout, /没有可判定的表情证据/)
  } finally {
    ledger.cleanup()
  }
})

test('both requirements given means both must hold', () => {
  const both = reactionLedger({ steerStates: ['consumed'] })
  try {
    const run = runCheck(both, ['--require-steer', '--require-ack'])
    assert.equal(run.status, 0, run.stdout + run.stderr)
  } finally {
    both.cleanup()
  }

  // Steer satisfied, acknowledgement absent: still not a green run.
  const half = passingLedger({ steerStates: ['consumed'] })
  try {
    const run = runCheck(half, ['--require-steer', '--require-ack'])
    assert.equal(run.status, 3, run.stdout + run.stderr)
    assert.match(run.stdout, /--require-ack/)
    assert.doesNotMatch(run.stdout, /--require-steer/)
  } finally {
    half.cleanup()
  }

  // Neither: both reasons are reported, so one run explains everything missing.
  const neither = passingLedger()
  try {
    const run = runCheck(neither, ['--require-steer', '--require-ack'])
    assert.equal(run.status, 3, run.stdout + run.stderr)
    assert.match(run.stdout, /--require-steer/)
    assert.match(run.stdout, /--require-ack/)
  } finally {
    neither.cleanup()
  }
})

test('a failed criterion outranks a missing reading', () => {
  // Exit 1 says "something is wrong"; exit 3 says "nothing is wrong, nothing was
  // proven". When both are true, the first is the one an operator must act on.
  const ledger = passingLedger({ via: [{ jobId: 'fj_1', replyVia: 'reaction' }] })
  try {
    writeFileSync(ledger.profile, PROFILE_WITHOUT_BLOCK)
    const run = runCheck(ledger, ['--require-ack'])
    assert.equal(run.status, 1, run.stdout + run.stderr)
  } finally {
    ledger.cleanup()
  }
})
