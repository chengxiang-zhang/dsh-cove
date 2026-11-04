/**
 * The acceptance check's own contracts.
 *
 * Its job is to fail loudly when the answer path goes quiet, so the cases that
 * matter here are the ones where it must NOT print PASS: a stuck job, one message
 * claimed by two batches, and a closed batch with nothing to say.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dedupePromiseDays, evaluateJobs, readInboxProfile } from './lark-autoreply-check.mjs'

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
  assert.deepEqual(readInboxProfile('    lark-inbox:'), { openIds: [] })
})

test('an empty allowlist reads as no restriction', () => {
  const parsed = readInboxProfile('  lark-inbox:\n    autoReplyMode: self\n')
  assert.deepEqual(parsed, { mode: 'self', openIds: [] })
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

test('an unreadable profile is unknown, not a pass', () => {
  const criteria = byId(evaluateJobs({ jobs: [], messages: [], now: NOW, stuckMs: STUCK }))
  assert.equal(criteria.allowlist.ok, null)
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
