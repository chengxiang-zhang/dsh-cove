import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseCheck = resolve(
  packageRoot,
  'presets/code-vibe/skills/wish-programming/scripts/release_check.py',
)

const SPEC_ID = 'w7-release'
const DIGEST = '0123456789abcdef'.repeat(4)

interface Fixture {
  root: string
  id: string
}

interface FixtureOptions {
  /** Write `.sdd/acceptance/<id>.deploy-authorized` (default true). */
  marker?: boolean
  /** Create `.sdd/acceptance/<id>/e2e/` with steps.md, run.log and a screenshot (default true). */
  e2e?: boolean
  /** Override SMOKE_CMD in the release plan. */
  smokeCmd?: string
  /** Override SMOKE_PROOF in the release plan. */
  smokeProof?: string
}

interface ProbeResult {
  status: number | null
  stdout: string
  stderr: string
}

function probe(command: string, args: string[]): ProbeResult {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** `python3`, else `python`, else null: the gate is a Python script, CI may carry neither. */
function findPython(): string | null {
  for (const candidate of ['python3', 'python']) {
    if (probe(candidate, ['-c', 'import sys; assert sys.version_info[0] == 3']).status === 0) return candidate
  }
  return null
}

const python = findPython()
const git = probe('git', ['--version']).status === 0 ? 'git' : null
const mayRun = python !== null && git !== null

function runGit(root: string, args: string[]): void {
  const result = spawnSync(git as string, ['-C', root, ...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? result.error?.message ?? ''}`)
  }
}

/**
 * Positive release-readiness fixture: a committed git work tree carrying the release
 * plan, the deploy authorization (provably newer than the plan) and browser e2e proof.
 * `.sdd/release/<id>/` is gitignored so repeat runs keep seeing a clean change-set.
 */
function makeFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(resolve(tmpdir(), 'dsh-release-gate-'))
  const id = SPEC_ID
  const planPath = resolve(root, '.sdd/release', `${id}.env`)
  mkdirSync(dirname(planPath), { recursive: true })
  writeFileSync(planPath, [
    '# release plan for the release-readiness gate',
    'TARGET=production',
    'ENV=production-cn',
    `ARTIFACT=harbor.example.com/dsh/cove@sha256:${DIGEST}`,
    '',
    "VERSION_CMD=printf 'v1.2.3\\n'",
    'VERSION_EXPECT=v1.2.3',
    `SMOKE_CMD=${options.smokeCmd ?? "printf 'ORDERS_OK\\n'"}`,
    `SMOKE_PROOF=${options.smokeProof ?? 'ORDERS_OK'}`,
    'ROLLBACK=rel-2026.11.07-1',
    "ROLLBACK_CHECK_CMD=printf 'rollback-ok\\n'",
    "ALERT_CMD=printf 'alert-rules-3\\n'",
    '',
  ].join('\n'))

  // The authorization must provably postdate the plan, whatever the filesystem clock does.
  const earlier = new Date(Date.now() - 3_600_000)
  utimesSync(planPath, earlier, earlier)

  if (options.marker !== false) {
    mkdirSync(resolve(root, '.sdd/acceptance'), { recursive: true })
    writeFileSync(resolve(root, '.sdd/acceptance', `${id}.deploy-authorized`), [
      'by=张呈祥',
      `ts=${new Date().toISOString()}`,
      'quote=可以上',
      '',
    ].join('\n'))
  }

  if (options.e2e !== false) {
    const e2e = resolve(root, '.sdd/acceptance', id, 'e2e')
    mkdirSync(e2e, { recursive: true })
    writeFileSync(resolve(e2e, 'steps.md'), [
      '1. 打开生产发布看板，确认目标环境',
      '2. 点击发布，等待版本号刷新',
      '',
    ].join('\n'))
    writeFileSync(resolve(e2e, 'run.log'), 'step 1 ok\nstep 2 ok\n')
    writeFileSync(resolve(e2e, 'shot.png'), 'png-bytes')
  }

  writeFileSync(resolve(root, '.gitignore'), '.sdd/release/*/\n')
  runGit(root, ['init', '--quiet'])
  runGit(root, ['config', 'user.email', 'release-gate@example.com'])
  runGit(root, ['config', 'user.name', 'release gate'])
  runGit(root, ['config', 'commit.gpgsign', 'false'])
  runGit(root, ['add', '--all'])
  runGit(root, ['commit', '--quiet', '--message', 'release gate fixture'])
  return { root, id }
}

function runGate(fixture: Fixture, ...flags: string[]): ProbeResult {
  return probe(python as string, [releaseCheck, fixture.root, fixture.id, ...flags])
}

function withFixture(options: FixtureOptions, body: (fixture: Fixture) => void): void {
  const fixture = makeFixture(options)
  try {
    body(fixture)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
}

/** The table row for one check, e.g. `FAIL   authorized  missing ...`. */
function rowFor(stdout: string, name: string): string {
  const row = stdout
    .split('\n')
    .find(line => new RegExp(`^(?:PASS|FAIL|UNRUN)\\s+${name}\\s`, 'u').test(line))
  expect(row, `no table row for ${name} in:\n${stdout}`).toBeDefined()
  return row as string
}

function statusRows(fixture: Fixture): string[] {
  const statusPath = resolve(fixture.root, '.sdd/release', fixture.id, 'status.tsv')
  expect(existsSync(statusPath), `missing ${statusPath}`).toBe(true)
  return readFileSync(statusPath, 'utf8').trim().split('\n')
}

describe('preset release-readiness gate', () => {
  it.skipIf(!mayRun)('passes all nine checks on a complete release plan when asked to run', () => {
    withFixture({}, (fixture) => {
      const result = runGate(fixture, '--run')
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('9/9 PASS')
      expect(result.stdout).toContain(`spec=${fixture.id}`)
      for (const name of ['plan', 'change-set', 'e2e', 'authorized', 'artifact', 'version', 'smoke', 'rollback', 'alert']) {
        expect(rowFor(result.stdout, name)).toMatch(/^PASS\s/u)
      }

      const rows = statusRows(fixture)
      expect(rows).toHaveLength(9)
      expect(rows[0]).toMatch(/^plan\tPASS\t/u)
      expect(rows.map(row => row.split('\t')[1])).toEqual(Array.from({ length: 9 }, () => 'PASS'))
      // The command checks leave their full stdio evidence behind.
      for (const log of ['version.log', 'smoke.log', 'rollback.log', 'alert.log', 'change-set.log']) {
        expect(existsSync(resolve(fixture.root, '.sdd/release', fixture.id, log)), log).toBe(true)
      }
    })
  }, 30_000)

  it.skipIf(!mayRun)('fails authorized when the deploy authorization marker is missing', () => {
    withFixture({ marker: false }, (fixture) => {
      const result = runGate(fixture, '--run')
      expect(result.status, result.stderr).toBe(1)
      expect(rowFor(result.stdout, 'authorized')).toMatch(/^FAIL\s/u)
      expect(result.stdout).not.toContain('9/9 PASS')
      expect(statusRows(fixture).find(row => row.startsWith('authorized\t'))).toMatch(/^authorized\tFAIL\t/u)
    })
  }, 30_000)

  it.skipIf(!mayRun)('fails smoke when the command does not prove the declared product marker', () => {
    withFixture({ smokeCmd: "printf 'ok\\n'", smokeProof: 'ORDERS_OK' }, (fixture) => {
      const result = runGate(fixture, '--run')
      expect(result.status, result.stderr).toBe(1)
      expect(rowFor(result.stdout, 'smoke')).toMatch(/^FAIL\s/u)
      expect(rowFor(result.stdout, 'smoke')).toContain('ORDERS_OK')
    })
  }, 30_000)

  it.skipIf(!mayRun)('fails e2e when the browser end-to-end evidence directory is gone', () => {
    withFixture({ e2e: false }, (fixture) => {
      const result = runGate(fixture, '--run')
      expect(result.status, result.stderr).toBe(1)
      expect(rowFor(result.stdout, 'e2e')).toMatch(/^FAIL\s/u)
      expect(rowFor(result.stdout, 'e2e')).toContain('.sdd/acceptance')
    })
  }, 30_000)

  it.skipIf(!mayRun)('reports the four command checks as UNRUN without --run', () => {
    withFixture({}, (fixture) => {
      const result = runGate(fixture)
      expect(result.status, result.stderr).toBe(1)
      expect(result.stdout).toContain('UNRUN')
      expect(result.stdout).toContain('needs --run')
      expect(result.stdout).toContain('5/9 PASS')
      for (const name of ['version', 'smoke', 'rollback', 'alert']) {
        expect(rowFor(result.stdout, name)).toMatch(/^UNRUN\s+.*needs --run$/u)
      }
      expect(rowFor(result.stdout, 'plan')).toMatch(/^PASS\s/u)
    })
  }, 30_000)

  it.skipIf(!mayRun)('prints the same verdicts as JSON when --json is set', () => {
    withFixture({}, (fixture) => {
      const result = runGate(fixture, '--run', '--json')
      expect(result.status, result.stderr).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        spec: string
        target: string
        checks: Array<{ name: string, verdict: string, detail: string }>
        passed: number
        total: number
      }
      expect(payload.spec).toBe(fixture.id)
      expect(payload.target).toBe('production-cn')
      expect(payload.total).toBe(9)
      expect(payload.passed).toBe(payload.total)
      expect(payload.checks.map(check => check.name)).toEqual([
        'plan', 'change-set', 'e2e', 'authorized', 'artifact', 'version', 'smoke', 'rollback', 'alert',
      ])
      expect(payload.checks.every(check => check.verdict === 'PASS')).toBe(true)
      expect(payload.checks.every(check => check.detail.length > 0)).toBe(true)
      expect(result.stdout.trim().startsWith('{')).toBe(true)
    })
  }, 30_000)
})
