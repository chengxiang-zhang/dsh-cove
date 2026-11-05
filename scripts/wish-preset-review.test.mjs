import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  aggregateSessions,
  classifySession,
  mergeState,
  parseAnalyzerOutput,
  parseArgs,
  readState,
  renderReport,
  riskScore,
  selectChanged,
} from './wish-preset-review.mjs'

const SESSION = {
  host: 'pc-tower',
  sessionId: 'session-1',
  startedAt: 1793500000000,
  updatedAt: 1793500900000,
  turns: 12,
  toolCalls: 140,
  asks: 4,
  errors: 3,
  denials: { 'production': 2 },
  rage: 2,
  rageSamples: ['你他妈为什么总拿这种垃圾的问题阻塞任务'],
  users: 6,
  firstUser: '把交接文档读完再动手',
  file: '/home/pc/.dsh/sessions/--ws--/session-1/session.v4.jsonl.zstd',
  lastFinal: '本轮关闭 G-01，并复跑了门禁',
  maxTurnSec: 2400,
  longTurns: 2,
  emptyTurns: 1,
  risk: 0,
}

test('parseAnalyzerOutput keeps valid JSONL records and drops noise', () => {
  const stdout = [
    JSON.stringify(SESSION),
    '',
    'not json at all',
    JSON.stringify({ noSessionId: true }),
    JSON.stringify({ ...SESSION, sessionId: 'session-2', host: undefined }),
  ].join('\n')
  const rows = parseAnalyzerOutput(stdout, 'zcx-t470p')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].host, 'zcx-t470p')
  assert.equal(rows[1].sessionId, 'session-2')
})

test('parseAnalyzerOutput tolerates empty or missing output', () => {
  assert.deepEqual(parseAnalyzerOutput(''), [])
  assert.deepEqual(parseAnalyzerOutput(undefined), [])
})

test('parseArgs reads the window, host filter and excerpt target', () => {
  const options = parseArgs(['--days', '3', '--hosts', 'pc-tower,zcx-t470p', '--limit', '50', '--json'])
  assert.equal(options.days, 3)
  assert.deepEqual(options.hosts, ['pc-tower', 'zcx-t470p'])
  assert.equal(options.limit, 50)
  assert.equal(options.json, true)
  assert.equal(parseArgs(['--excerpt', 'pc-tower:/tmp/a']).excerpt, 'pc-tower:/tmp/a')
})

test('parseArgs rejects unknown arguments and bad numbers', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument/u)
  assert.throws(() => parseArgs(['--days', '0']), /positive number/u)
  assert.throws(() => parseArgs(['--limit', '1.5']), /positive integer/u)
  assert.throws(() => parseArgs(['--days']), /missing value/u)
})

test('selectChanged reports unknown sessions and transcripts that grew', () => {
  const state = { version: 1, hosts: { 'pc-tower': { 'session-1': { updatedAt: 1 } } }, runs: [] }
  const sessions = [
    { host: 'pc-tower', sessionId: 'session-1', updatedAt: 1 },
    { host: 'pc-tower', sessionId: 'session-1', updatedAt: 2 },
    { host: 'pc-tower', sessionId: 'session-2', updatedAt: 1 },
  ]
  const fresh = selectChanged(sessions, state)
  assert.equal(fresh.length, 2)
  assert.equal(fresh[1].sessionId, 'session-2')
})

test('mergeState marks sessions seen, keeps history bounded and records the run', () => {
  const state = { version: 1, hosts: {}, runs: [] }
  const sessions = [
    { host: 'pc-tower', sessionId: 'session-1', updatedAt: 10, startedAt: 5, risk: 7 },
    { host: 'zcx-t470p', sessionId: 'session-2', updatedAt: 11, startedAt: 6, risk: 3 },
  ]
  const next = mergeState(state, sessions, { runAt: 99, hostReports: [{ host: 'pc-tower', ok: true }] })
  assert.equal(next.hosts['pc-tower']['session-1'].updatedAt, 10)
  assert.equal(next.hosts['pc-tower']['session-1'].firstSeen, 5)
  assert.equal(next.hosts['zcx-t470p']['session-2'].risk, 3)
  assert.equal(next.runs[0].sessions, 2)
  for (let index = 0; index < 60; index += 1) next.runs.unshift({ at: index })
  const again = mergeState(next, [], { runAt: 100 })
  assert.ok(again.runs.length <= 50)
})

test('readState falls back to a fresh state for missing or malformed files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wish-review-'))
  try {
    const missing = join(dir, 'missing.json')
    assert.equal(readState(missing).version, 1)
    assert.deepEqual(readState(missing).hosts, {})
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{not json')
    assert.equal(readState(broken).version, 1)
    const wrongVersion = join(dir, 'v0.json')
    writeFileSync(wrongVersion, JSON.stringify({ version: 0, hosts: { a: 1 } }))
    assert.deepEqual(readState(wrongVersion).hosts, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('classifySession names the failure surface the numbers show', () => {
  assert.deepEqual(classifySession(SESSION).sort(), [
    'ask-heavy',
    'gate-friction',
    'idle-turn',
    'long-turn',
    'user-rage',
  ].sort())
  const calm = { ...SESSION, rage: 0, asks: 0, denials: {}, maxTurnSec: 120, longTurns: 0, emptyTurns: 0, turns: 4, toolCalls: 20 }
  assert.deepEqual(classifySession(calm), [])
})

test('riskScore ranks anger above questions above waste', () => {
  const angry = { ...SESSION, rage: 3, asks: 0, longTurns: 0, emptyTurns: 0, denials: {}, toolCalls: 10, turns: 2 }
  const asking = { ...SESSION, rage: 0, asks: 3, longTurns: 0, emptyTurns: 0, denials: {}, toolCalls: 10, turns: 2 }
  const wasting = { ...SESSION, rage: 0, asks: 0, longTurns: 2, emptyTurns: 1, denials: {}, toolCalls: 10, turns: 2 }
  assert.ok(riskScore(angry) > riskScore(asking))
  assert.ok(riskScore(asking) > riskScore(wasting))
})

test('aggregateSessions sums the window and groups by host', () => {
  const totals = aggregateSessions([
    { ...SESSION, host: 'a', risk: 5 },
    { ...SESSION, host: 'b', sessionId: 'session-2', asks: 0, rage: 0, denials: {}, risk: 0 },
  ])
  assert.equal(totals.sessions, 2)
  assert.equal(totals.asks, 4)
  assert.equal(totals.rage, 2)
  assert.equal(totals.denials.production, 2)
  assert.equal(totals.hosts.a.sessions, 1)
  assert.equal(totals.hosts.b.sessions, 1)
})

test('renderReport is honest when the window is empty', () => {
  const report = renderReport({ runAt: 1793500000000, days: 7, hosts: ['pc-tower'], sessions: [], state: {} })
  assert.match(report, /No new or changed session/u)
  assert.match(report, /No change this round/u)
  assert.doesNotMatch(report, /user-rage/u)
})

test('renderReport carries the evidence a reviewer needs', () => {
  const report = renderReport({
    runAt: 1793500000000,
    days: 7,
    hosts: ['pc-tower'],
    sessions: [{ ...SESSION, risk: riskScore(SESSION) }],
    state: {},
  })
  assert.match(report, /session-1/u)
  assert.match(report, /你他妈为什么总拿这种垃圾的问题阻塞任务/u)
  assert.match(report, /--excerpt pc-tower:/u)
  assert.match(report, /\| production \| 2 \|/u)
  assert.doesNotMatch(report, /No denial text appeared/u)
})