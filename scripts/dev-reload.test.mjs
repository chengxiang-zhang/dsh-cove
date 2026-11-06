/**
 * `dev-reload`'s own contracts.
 *
 * The script exists to keep "build landed" and "the running host reloaded" apart:
 * a build alone changes files nobody reads, and the only honest evidence is a
 * re-mount line in the host's log after one profile recompose. These cases pin the
 * edit (one marker, atomic, reversible), the argument surface, and the log reader
 * that decides whether to believe the reload happened.
 */
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_EVIDENCE, MARKER_PREFIX, addMarker, logSize, matchAfter, parseArgs, pathsFor, stamp, stripMarkers,
} from './dev-reload.mjs'

const temp = () => mkdtempSync(join(tmpdir(), 'dev-reload-'))

test('the marker is one comment line, idempotent, and stripMarkers restores the file', () => {
  const original = 'a: 1\nb: 2\n'
  const marked = addMarker(original, '2026-11-06T09-00-00-000Z')

  assert.equal(marked, `${original}${MARKER_PREFIX} 2026-11-06T09-00-00-000Z\n`)
  assert.equal(addMarker(marked, '2026-11-06T09-00-00-000Z'), marked, 'the same stamp is not appended twice')
  assert.equal(stripMarkers(marked), original)
})

test('the marker survives a file with no trailing newline', () => {
  assert.equal(addMarker('a: 1', 'x'), `a: 1\n${MARKER_PREFIX} x\n`)
})

test('stripMarkers removes every run of markers and nothing else', () => {
  const marked = `a: 1\n${MARKER_PREFIX} one\nb: 2\n${MARKER_PREFIX} two\n`
  assert.equal(stripMarkers(marked), 'a: 1\nb: 2\n')
})

test('stamp is sortable and safe in a comment', () => {
  const value = stamp(new Date('2026-11-06T09:00:00.000Z'))
  assert.equal(value, '2026-11-06T09-00-00-000Z')
  assert.doesNotMatch(value, /[:.]/u)
})

test('the command line defaults to the web profile under DSH_HOME, and every flag parses', () => {
  const bare = parseArgs([], { DSH_HOME: '/tmp/home', DSH_PROFILE: undefined })
  assert.deepEqual(bare.options, { profile: 'web', home: '/tmp/home', log: undefined, evidence: undefined, probe: undefined, expect: undefined, build: true, timeoutMs: 30_000, dryRun: false })

  const full = parseArgs(['--profile', 'rescue', '--home', '/h', '--log', '/l', '--no-build', '--timeout', '5', '--dry-run'], {})
  assert.deepEqual(full.options, { profile: 'rescue', home: '/h', log: '/l', evidence: undefined, probe: undefined, expect: undefined, build: false, timeoutMs: 5_000, dryRun: true })
})

test('a bad argument is refused, never silently ignored', () => {
  assert.match(parseArgs(['--nope'], {}).error, /未知参数/u)
  assert.match(parseArgs(['--timeout', 'zero'], {}).error, /timeout/u)
  assert.match(parseArgs(['--profile', '../etc'], {}).error, /不合法/u)
  assert.equal(parseArgs(['--help'], {}).help, true)
  assert.match(parseArgs(['--probe', 'http://x'], {}).error, /成对/u)
  assert.match(parseArgs(['--probe', 'http://x', '--expect', '['], {}).error, /正则/u)
})

test('the edited patch and the watched log are derived from the profile name', () => {
  const paths = pathsFor({ profile: 'web', home: '/Users/x/.dsh', log: undefined })
  assert.equal(paths.patch, '/Users/x/.dsh/profiles/web/cordis.patch.yml')
  assert.equal(paths.log, '/Users/x/.dsh/logs/web.launchd.log')
  const explicit = pathsFor({ profile: 'rescue', home: '/h', log: '/tmp/out.log' })
  assert.equal(explicit.log, '/tmp/out.log')
})

test('the log reader only returns a match written after the recorded offset', () => {
  const dir = temp()
  try {
    const log = join(dir, 'web.log')
    writeFileSync(log, 'old line mentioning reload plugin at nothing\n')
    const offset = logSize(log)
    assert.equal(matchAfter(log, offset, DEFAULT_EVIDENCE), undefined, 'pre-existing lines do not count')

    appendFileSync(log, 'dsh-lark-inbox: 使用飞书应用 cli_x\n')
    const matched = matchAfter(log, offset, DEFAULT_EVIDENCE)
    assert.match(String(matched), /使用飞书应用/u)

    assert.equal(logSize(join(dir, 'missing.log')), 0, 'a missing log is size 0, not a crash')
    assert.equal(matchAfter(join(dir, 'missing.log'), 0, DEFAULT_EVIDENCE), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})