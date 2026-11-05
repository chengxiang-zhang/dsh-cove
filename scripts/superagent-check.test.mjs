/**
 * The acceptance check's own contracts.
 *
 * Its job is to keep "nothing failed" and "nothing was proven" apart, so the cases
 * that matter here are the ones where it must NOT print ok: a missing ledger, a
 * broken window argument, a ledger no superagent has ever written, and a row that
 * breaks the words invariant. Every case that reads data runs under both
 * logical-name mappings, because the check must answer the same on a connection
 * that refuses the TEMP write the view path depends on.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { CHECKS } from './superagent-check.mjs'

const SCRIPT = fileURLToPath(new URL('./superagent-check.mjs', import.meta.url))

/** Both mapping paths the script can take; the same assertions cover each. */
const MODES = ['view', 'text']

/** A fresh throwaway directory; nothing is written inside the repository. */
function workspace() {
  return mkdtempSync(join(tmpdir(), 'superagent-check-'))
}

/**
 * A ledger shaped like the one the responder owns.
 *
 * `bare` is the installation that has never run the superagent: a real ledger with
 * no `sa_` tables at all. `words` inserts one outbox row, and it is inserted
 * directly because the fixture deliberately has no CHECK constraint - the point is
 * to see what the check says about a ledger that already violates the invariant.
 * @param {{words?: number, bare?: boolean}} [options]
 * @returns {{root: string, db: string}}
 */
function ledger({ words, bare = false } = {}) {
  const root = workspace()
  const db = join(root, 'inbox.sqlite')
  const handle = new DatabaseSync(db)
  if (bare) {
    handle.exec('CREATE TABLE inbox_events (event_id TEXT PRIMARY KEY, received_at INTEGER)')
  } else {
    handle.exec('CREATE TABLE sa_outbox (outbox_id TEXT PRIMARY KEY, words INTEGER)')
    if (words !== undefined) {
      handle.prepare('INSERT INTO sa_outbox (outbox_id, words) VALUES (?, ?)').run('o_1', words)
    }
  }
  handle.close()
  return { root, db }
}

/** Run the CLI with one mapping path pinned. */
function runCheck(args, mode) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SUPERAGENT_CHECK_MAPPING: mode },
  })
}

/** Remove the fixtures a test created. */
function dispose(...roots) {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}

test('an unreadable ledger is an IO answer (exit 2) that names the path, never no-data', () => {
  const root = workspace()
  try {
    const missing = join(root, 'absent.sqlite')
    const missingRun = spawnSync(process.execPath, [SCRIPT, '--db', missing], { encoding: 'utf8' })
    assert.equal(missingRun.status, 2, missingRun.stdout + missingRun.stderr)
    assert.ok(missingRun.stderr.includes(missing), missingRun.stderr)
    assert.doesNotMatch(missingRun.stdout, /nodata/u, missingRun.stdout)

    // The same class of answer for a file that is not a SQLite database: it exists,
    // so claiming it holds no evidence would misreport what the ledger is.
    const junk = join(root, 'junk.sqlite')
    writeFileSync(junk, 'not a database at all')
    const junkRun = spawnSync(process.execPath, [SCRIPT, '--db', junk], { encoding: 'utf8' })
    assert.equal(junkRun.status, 2, junkRun.stdout + junkRun.stderr)
    assert.doesNotMatch(junkRun.stdout, /nodata/u, junkRun.stdout)
  } finally {
    dispose(root)
  }
})

test('a non-numeric --since-hours is a usage error (exit 2), not an empty window', () => {
  const fixture = ledger({ words: 50 })
  try {
    const run = spawnSync(process.execPath, [SCRIPT, '--db', fixture.db, '--since-hours', 'abc'], { encoding: 'utf8' })
    assert.equal(run.status, 2, run.stdout + run.stderr)
    assert.match(run.stderr, /--since-hours/u)
  } finally {
    dispose(fixture.root)
  }
})

test('a ledger with no sa_ tables answers nodata (exit 3), neither pass nor failure', () => {
  const fixture = ledger({ bare: true })
  try {
    for (const mode of MODES) {
      const run = runCheck(['--db', fixture.db], mode)
      assert.equal(run.status, 3, `${mode}: ${run.stdout}${run.stderr}`)
      assert.match(run.stdout, /P-words nodata/u, `${mode}: ${run.stdout}`)
      assert.doesNotMatch(run.stdout, /P-words (ok|FAIL)/u, `${mode}: ${run.stdout}`)
    }
  } finally {
    dispose(fixture.root)
  }
})

test('an outbox row inside the budget passes P-words (exit 0)', () => {
  const fixture = ledger({ words: 50 })
  try {
    for (const mode of MODES) {
      const run = runCheck(['--db', fixture.db], mode)
      assert.equal(run.status, 0, `${mode}: ${run.stdout}${run.stderr}`)
      assert.match(run.stdout, /P-words ok 0/u, `${mode}: ${run.stdout}`)
    }
  } finally {
    dispose(fixture.root)
  }
})

test('a row past the words budget fails P-words (exit 1) with the reading attached', () => {
  const fixture = ledger({ words: 120 })
  try {
    for (const mode of MODES) {
      const run = runCheck(['--db', fixture.db], mode)
      assert.equal(run.status, 1, `${mode}: ${run.stdout}${run.stderr}`)
      assert.match(run.stdout, /P-words FAIL 1/u, `${mode}: ${run.stdout}`)
    }
  } finally {
    dispose(fixture.root)
  }
})

test('a read-only run leaves the ledger file byte-identical', () => {
  const fixture = ledger({ words: 50 })
  try {
    for (const mode of MODES) {
      const before = statSync(fixture.db)
      const run = runCheck(['--db', fixture.db], mode)
      const after = statSync(fixture.db)
      assert.equal(run.status, 0, `${mode}: ${run.stdout}${run.stderr}`)
      assert.equal(after.size, before.size, `${mode}: size changed`)
      assert.equal(after.mtimeMs, before.mtimeMs, `${mode}: mtime changed`)
      assert.equal(existsSync(`${fixture.db}-wal`), false, `${mode}: WAL side file appeared`)
      assert.equal(existsSync(`${fixture.db}-journal`), false, `${mode}: journal side file appeared`)
    }
  } finally {
    dispose(fixture.root)
  }
})

test('--json is machine-readable and its exit field is the process status', () => {
  const good = ledger({ words: 50 })
  const bad = ledger({ words: 120 })
  try {
    for (const mode of MODES) {
      for (const [fixture, expected] of [[good, 0], [bad, 1]]) {
        const run = runCheck(['--db', fixture.db, '--json'], mode)
        assert.equal(run.status, expected, `${mode}: ${run.stdout}${run.stderr}`)
        const payload = JSON.parse(run.stdout)
        assert.equal(payload.exit, run.status, `${mode}: exit field disagrees with the process`)
        assert.equal(payload.checks.length, CHECKS.length, `${mode}: ${run.stdout}`)
        assert.deepEqual(payload.checks[0], {
          id: 'P-words',
          status: expected === 0 ? 'ok' : 'FAIL',
          value: expected === 0 ? 0 : 1,
          expect: 'zero',
        })
      }
    }
  } finally {
    dispose(good.root, bad.root)
  }
})
