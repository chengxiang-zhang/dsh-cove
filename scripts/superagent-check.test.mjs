/**
 * The acceptance check's own contracts (W6-T28).
 *
 * The checker exists to keep "nothing failed" and "nothing was proven" apart, so
 * these cases pin both directions: a clean ledger has to pass every verdict, a
 * ledger that breaks exactly one invariant has to fail that verdict and exit 1,
 * and a ledger with no evidence at all has to exit 3 instead of reporting success.
 *
 * Fixtures are built once per run by `fixtures/superagent-check/build.mjs`, which
 * reads the columns from `protocol/db.ts` so the fixture schema cannot drift from
 * the DDL. The bad cases therefore live in constraints-free copies of that schema:
 * a ledger that violates an invariant is one the strict DDL would have refused.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { CHECKS, PHYSICAL } from './superagent-check.mjs'

const SCRIPT = fileURLToPath(new URL('./superagent-check.mjs', import.meta.url))
const BUILD = fileURLToPath(new URL('./fixtures/superagent-check/build.mjs', import.meta.url))
const DB_SOURCE = fileURLToPath(new URL(
  '../packages/dsh-web-all/src/host/services/superagent/protocol/db.ts',
  import.meta.url,
))

/** Both logical-name mapping paths; the same data cases cover each. */
const MODES = ['view', 'text']

/** Verdicts that exist without `--shadow`. */
const VERDICTS = CHECKS.filter(check => check.kind === 'verdict')
const ACTIVE_VERDICTS = VERDICTS.filter(check => check.shadowOnly !== true)
const SHADOW_VERDICTS = VERDICTS.filter(check => check.shadowOnly === true)

/** One bad fixture per verdict, except the two that are not a single statement. */
const FIXTURE_VERDICTS = ACTIVE_VERDICTS.filter(check => check.id !== 'E6' && check.id !== 'E7')

let FIXTURES

before(() => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-check-fixtures-'))
  // The builder imports the TypeScript DDL; the flag is why it is a separate process.
  const run = spawnSync(process.execPath, ['--experimental-strip-types', BUILD, '--out', root], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  FIXTURES = root
})

after(() => {
  if (FIXTURES !== undefined) rmSync(FIXTURES, { recursive: true, force: true })
})

function fixture(name) {
  return join(FIXTURES, name)
}

/** Run the CLI with one mapping path pinned. */
function runCheck(args, mode = 'view') {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SUPERAGENT_CHECK_MAPPING: mode },
  })
}

/** The parsed `--json` payload of a run. */
function payloadOf(run) {
  return JSON.parse(run.stdout)
}

/** One verdict's status in a JSON payload, or `missing`. */
function statusOf(payload, id) {
  const entry = payload.checks.find(check => check.id === id)
  return entry === undefined ? 'missing' : entry.status
}

test('the clean ledger passes every verdict, with E6 waiting for a comparison', () => {
  for (const mode of MODES) {
    const run = runCheck(['--db', fixture('clean.sqlite'), '--json'], mode)
    assert.equal(run.status, 0, `${mode}: ${run.stdout}${run.stderr}`)
    const payload = payloadOf(run)
    assert.equal(payload.exit, 0, `${mode}: ${run.stdout}`)
    for (const check of ACTIVE_VERDICTS) {
      const expected = check.id === 'E6' ? 'nodata' : 'ok'
      assert.equal(statusOf(payload, check.id), expected, `${mode}: ${check.id} was not ${expected}: ${run.stdout}`)
    }
    // Readings are printed and never judged; they must not vanish from the output.
    for (const check of CHECKS.filter(entry => entry.kind === 'reading')) {
      assert.equal(statusOf(payload, check.id), 'read', `${mode}: ${check.id} reading missing: ${run.stdout}`)
    }
    // Without `--shadow` the shadow verdicts are not applicable, not passing.
    for (const check of SHADOW_VERDICTS) {
      assert.equal(statusOf(payload, check.id), 'missing', `${mode}: ${check.id} should not run without --shadow`)
    }
  }
})

test('each broken invariant fails its own verdict and nothing else has to', async (t) => {
  for (const check of FIXTURE_VERDICTS) {
    await t.test(check.id, () => {
      const run = runCheck(['--db', fixture(`bad-${check.id}.sqlite`), '--json'])
      if (check.id === 'E-window') {
        // A window with no intake is no evidence, not a violated invariant.
        assert.equal(run.status, 3, run.stdout + run.stderr)
        assert.equal(statusOf(payloadOf(run), check.id), 'nodata', run.stdout)
        return
      }
      assert.equal(run.status, 1, run.stdout + run.stderr)
      assert.equal(statusOf(payloadOf(run), check.id), 'FAIL', run.stdout)
      assert.equal(payloadOf(run).exit, 1, run.stdout)
    })
  }
})

test('the shadow phase runs only with --shadow and needs volume to be evidence', () => {
  const withoutFlag = runCheck(['--db', fixture('shadow-clean.sqlite'), '--json'])
  assert.equal(withoutFlag.status, 0, withoutFlag.stdout + withoutFlag.stderr)
  for (const check of SHADOW_VERDICTS) {
    assert.equal(statusOf(payloadOf(withoutFlag), check.id), 'missing', withoutFlag.stdout)
  }

  const enough = runCheck(['--db', fixture('shadow-clean.sqlite'), '--shadow', '--json'])
  assert.equal(enough.status, 0, enough.stdout + enough.stderr)
  for (const check of SHADOW_VERDICTS) {
    assert.equal(statusOf(payloadOf(enough), check.id), 'ok', enough.stdout)
  }

  const tooFew = runCheck(['--db', fixture('shadow-29.sqlite'), '--shadow', '--json'])
  assert.equal(tooFew.status, 3, tooFew.stdout + tooFew.stderr)
  assert.equal(statusOf(payloadOf(tooFew), 'S-volume'), 'nodata', tooFew.stdout)
})

test('E6 compares the open set against a snapshot and never turns a drift into a pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-check-compare-'))
  try {
    const snapshot = join(root, 'open.json')
    const saved = runCheck(['--db', fixture('clean.sqlite'), '--snapshot', snapshot, '--json'])
    assert.equal(saved.status, 0, saved.stdout + saved.stderr)
    assert.deepEqual(JSON.parse(readFileSync(snapshot, 'utf8')), [], 'the clean ledger has nothing open')

    const same = runCheck(['--db', fixture('clean.sqlite'), '--compare', snapshot, '--json'])
    assert.equal(same.status, 0, same.stdout + same.stderr)
    assert.equal(statusOf(payloadOf(same), 'E6'), 'ok', same.stdout)

    // One new open commitment between snapshot and compare is exactly what E6 is for.
    const drifted = join(root, 'drifted.sqlite')
    copyFileSync(fixture('clean.sqlite'), drifted)
    const handle = new DatabaseSync(drifted)
    try {
      handle.prepare(`INSERT INTO sa_commitment (commitment_id, n, kind, debtor, creditor, ball, desk_id,
        thread_key, origin_kind, origin_ref, work_class, what, intent, check_kind, done_when, state,
        budget_wall_ms, budget_turns, next_look_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('C-77', 77, 'deliver', 'superagent', 'owner', 'superagent', 'd1', 't77', 'host', 'host:C-77',
          'repo-change', '做事', 'deliver', 'command', 'exit 0', 'open', 600_000, 3, Date.now() + 3_600_000,
          Date.now(), Date.now())
    } finally {
      handle.close()
    }
    const moved = runCheck(['--db', drifted, '--compare', snapshot, '--json'])
    assert.equal(moved.status, 1, moved.stdout + moved.stderr)
    assert.equal(statusOf(payloadOf(moved), 'E6'), 'FAIL', moved.stdout)
    assert.match(moved.stdout, /C-77|新增/u, moved.stdout)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the logical-name table is the one the DDL declares', () => {
  const source = readFileSync(DB_SOURCE, 'utf8')
  const declaration = /const LOGICAL_TABLES = \[([\s\S]*?)\] as const/u.exec(source)
  assert.ok(declaration !== null, 'LOGICAL_TABLES not found in db.ts')
  const names = [...declaration[1].matchAll(/'([a-z_]+)'/gu)].map(match => match[1])
  assert.ok(names.length > 20, `only ${names.length} logical tables parsed from db.ts`)
  // The DDL maps every name with one rule, so the check can rebuild the table and
  // compare it: a hand-copied entry that drifts shows up here, not in production.
  const expected = Object.fromEntries(names.map(name => [name, name === 'inbox_event' ? 'inbox_events' : `sa_${name}`]))
  assert.deepEqual({ ...PHYSICAL }, expected)
})

test('E1: an acknowledgement later than the dispatch is a chain violation', () => {
  const run = runCheck(['--db', fixture('bad-E1.sqlite'), '--json'])
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.equal(statusOf(payloadOf(run), 'E1'), 'FAIL', run.stdout)
})

test('an unreadable ledger is an IO answer, an empty ledger is no data', () => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-check-io-'))
  try {
    const missing = join(root, 'absent.sqlite')
    const missingRun = spawnSync(process.execPath, [SCRIPT, '--db', missing], { encoding: 'utf8' })
    assert.equal(missingRun.status, 2, missingRun.stdout + missingRun.stderr)
    assert.ok(missingRun.stderr.includes(missing), missingRun.stderr)
    assert.doesNotMatch(missingRun.stdout, /nodata/u, missingRun.stdout)

    const junk = join(root, 'junk.sqlite')
    writeFileSync(junk, 'not a database at all')
    const junkRun = spawnSync(process.execPath, [SCRIPT, '--db', junk], { encoding: 'utf8' })
    assert.equal(junkRun.status, 2, junkRun.stdout + junkRun.stderr)

    const empty = join(root, 'empty.sqlite')
    writeFileSync(empty, '')
    const emptyRun = spawnSync(process.execPath, [SCRIPT, '--db', empty], { encoding: 'utf8' })
    assert.equal(emptyRun.status, 3, emptyRun.stdout + emptyRun.stderr)
    assert.match(emptyRun.stdout, /nodata/u, emptyRun.stdout)

    const badHours = spawnSync(process.execPath, [SCRIPT, '--db', empty, '--since-hours', 'abc'], { encoding: 'utf8' })
    assert.equal(badHours.status, 2, badHours.stdout + badHours.stderr)
    assert.match(badHours.stderr, /--since-hours/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a ledger with the tables but no evidence exits 3, and a violation still exits 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-check-partial-'))
  try {
    const partial = join(root, 'partial.sqlite')
    const handle = new DatabaseSync(partial)
    // The real outbox shape: a table that exists with a different shape is a
    // schema drift (exit 2), which would hide the no-evidence answer under test.
    handle.exec(`CREATE TABLE sa_outbox (outbox_id TEXT PRIMARY KEY, idem_key TEXT, chat_id TEXT, event_id TEXT,
      commitment_id TEXT, payload TEXT, body TEXT, moment TEXT, tier TEXT, audience TEXT, words INTEGER,
      expects_reply INTEGER, deliver INTEGER, lease_epoch INTEGER, state TEXT, attempts INTEGER,
      message_id TEXT, sent_at INTEGER, created_at INTEGER, updated_at INTEGER)`)
    handle.prepare('INSERT INTO sa_outbox (outbox_id, words) VALUES (?, ?)').run('o_1', 50)
    handle.close()

    for (const mode of MODES) {
      const run = runCheck(['--db', partial], mode)
      // P-words is proven; everything that needs another table has no evidence.
      assert.equal(run.status, 3, `${mode}: ${run.stdout}${run.stderr}`)
      assert.match(run.stdout, /P-words ok 0/u, run.stdout)
      assert.match(run.stdout, /I2 nodata/u, run.stdout)
    }

    // A violation outranks missing evidence: exit 1 is never softened to 3.
    const bad = join(root, 'bad.sqlite')
    const badHandle = new DatabaseSync(bad)
    badHandle.exec(`CREATE TABLE sa_outbox (outbox_id TEXT PRIMARY KEY, idem_key TEXT, chat_id TEXT, event_id TEXT,
      commitment_id TEXT, payload TEXT, body TEXT, moment TEXT, tier TEXT, audience TEXT, words INTEGER,
      expects_reply INTEGER, deliver INTEGER, lease_epoch INTEGER, state TEXT, attempts INTEGER,
      message_id TEXT, sent_at INTEGER, created_at INTEGER, updated_at INTEGER)`)
    badHandle.prepare('INSERT INTO sa_outbox (outbox_id, words) VALUES (?, ?)').run('o_1', 120)
    badHandle.close()
    for (const mode of MODES) {
      const run = runCheck(['--db', bad], mode)
      assert.equal(run.status, 1, `${mode}: ${run.stdout}${run.stderr}`)
      assert.match(run.stdout, /P-words FAIL 1/u, run.stdout)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a read-only run leaves the ledger file byte-identical', () => {
  for (const mode of MODES) {
    const before = statSync(fixture('clean.sqlite'))
    const run = runCheck(['--db', fixture('clean.sqlite')], mode)
    const after = statSync(fixture('clean.sqlite'))
    assert.equal(run.status, 0, `${mode}: ${run.stdout}${run.stderr}`)
    assert.equal(after.size, before.size, `${mode}: size changed`)
    assert.equal(after.mtimeMs, before.mtimeMs, `${mode}: mtime changed`)
    assert.equal(existsSync(`${fixture('clean.sqlite')}-wal`), false, `${mode}: WAL side file appeared`)
    assert.equal(existsSync(`${fixture('clean.sqlite')}-journal`), false, `${mode}: journal side file appeared`)
  }
})

test('--json stays machine-readable and its exit field is the process status', () => {
  for (const [name, expected] of [['clean.sqlite', 0], ['bad-I2.sqlite', 1]]) {
    const run = runCheck(['--db', fixture(name), '--json'])
    assert.equal(run.status, expected, run.stdout + run.stderr)
    const payload = payloadOf(run)
    assert.equal(payload.exit, run.status, 'exit field disagrees with the process')
    assert.equal(payload.checks.length, ACTIVE_VERDICTS.length + CHECKS.filter(check => check.kind === 'reading').length)
    if (expected === 1) assert.equal(statusOf(payload, 'I2'), 'FAIL', run.stdout)
  }
})