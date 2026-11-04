/**
 * The acceptance check's own contracts.
 *
 * Its job is to fail loudly when the answer path goes quiet, so the cases that
 * matter here are the ones where it must NOT print PASS: a stuck job, one message
 * claimed by two batches, and a closed batch with nothing to say.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateJobs } from './lark-autoreply-check.mjs'

const NOW = 1_700_000_000_000
const STUCK = 10 * 60_000

/** One ledger row as the criteria see it. */
function job(overrides) {
  return {
    jobId: 'fj_1',
    state: 'replied',
    outcome: 'answer',
    replyToMessageId: 'om_1',
    replyText: '在的',
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

test('one answered turn satisfies every criterion', () => {
  const criteria = byId(evaluateJobs({
    jobs: [job()],
    messages: [{ messageId: 'om_1', jobId: 'fj_1' }],
    now: NOW,
    stuckMs: STUCK,
  }))
  for (const criterion of Object.values(criteria)) assert.equal(criterion.ok, true)
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
