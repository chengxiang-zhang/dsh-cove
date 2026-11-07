import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scriptsDir = resolve(packageRoot, 'presets/code-vibe/skills/wish-programming/scripts')
const journey = resolve(scriptsDir, 'journey.sh')
const checkSpec = resolve(scriptsDir, 'check_spec.py')
const releaseCheck = resolve(scriptsDir, 'release_check.py')

function has(command: string): boolean {
  const probe = spawnSync(command, ['-V'], { encoding: 'utf8' })
  return probe.error === undefined
}

const bashReady = process.platform !== 'win32' && has('bash')
const pythonReady = has('python3')

function run(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

const workspaces: string[] = []

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wish-release-flow-'))
  workspaces.push(root)
  await writeFile(join(root, 'AGENTS.md'), '# fixture workspace\n')
  await mkdir(join(root, 'docs/wish/W1'), { recursive: true })
  await writeFile(
    join(root, 'docs/wish/W1/design-spec.md'),
    '# 设计规范单\n\n## 页面树\n\n- /orders\n',
  )
  return root
}

async function writeReleasePlan(root: string): Promise<void> {
  await mkdir(join(root, '.sdd/release'), { recursive: true })
  await writeFile(join(root, '.sdd/release/W1.env'), [
    'TARGET=production',
    'ENV=prod-fixture',
    "ARTIFACT=registry.example.com/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "VERSION_CMD=printf 'v1\\n'",
    'VERSION_EXPECT=v1',
    "SMOKE_CMD=printf 'ORDERS_OK\\n'",
    'SMOKE_PROOF=ORDERS_OK',
    'ROLLBACK=sha-abc123',
    "ROLLBACK_CHECK_CMD=printf 'ok\\n'",
    "ALERT_CMD=printf 'rules=3\\n'",
    '',
  ].join('\n'))
}

async function writeE2eEvidence(root: string): Promise<void> {
  const e2e = join(root, '.sdd/acceptance/W1/e2e')
  await mkdir(e2e, { recursive: true })
  await writeFile(join(e2e, 'steps.md'), '# E2E\n\n1. 打开 /orders\n2. 点击 Refund\n')
  await writeFile(join(e2e, 'run.log'), '[browser] /orders -> refund clicked -> toast visible\n')
  await writeFile(join(e2e, 'shot.png'), 'not-a-real-png-but-the-evidence-gate-only-counts-files')
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function row(verdicts: string, name: string): string {
  const match = new RegExp(`^(\\w+)\\s+${name}\\s{2,}(.*)$`, 'mu').exec(verdicts)
  return match ? `${match[1]} ${match[2]}` : 'no-row'
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!bashReady || !pythonReady)('wish release flow', () => {
  it('refuses a production authorization before the release plan exists', async () => {
    const root = await makeWorkspace()
    const result = run('bash', [journey, '--cwd', root, '--spec', 'W1', '--authorize-deploy', '--by', 'tester', '--quote', '可以上'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no release plan')
  })

  it('records the authorization once the plan exists and unblocks the deploy assert', async () => {
    const root = await makeWorkspace()
    await writeReleasePlan(root)

    const before = run('bash', [journey, '--cwd', root, '--spec', 'W1', '--assert', 'deploy'])
    expect(before.status).toBe(1)
    expect(before.stderr).toContain('no authorization')

    const authorized = run('bash', [journey, '--cwd', root, '--spec', 'W1', '--authorize-deploy', '--by', '张呈祥', '--quote', '可以上'])
    expect(authorized.status).toBe(0)
    const marker = await readFile(join(root, '.sdd/acceptance/W1.deploy-authorized'), 'utf8')
    expect(marker).toContain('by=张呈祥')
    expect(marker).toContain('quote=可以上')

    const after = run('bash', [journey, '--cwd', root, '--spec', 'W1', '--assert', 'deploy'])
    expect(after.status).toBe(0)
    expect(after.stdout).toContain('assert deploy ok')
  })

  it('refuses an empty authorization quote', async () => {
    const root = await makeWorkspace()
    await writeReleasePlan(root)
    const result = run('bash', [journey, '--cwd', root, '--spec', 'W1', '--authorize-deploy', '--by', 'tester'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--quote')
  })

  it('keeps a UI wish open until the end-to-end evidence exists', async () => {
    const root = await makeWorkspace()
    const missing = run('python3', [checkSpec, root, 'W1', '--phase', 'close'])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('e2e/steps.md')

    await writeE2eEvidence(root)
    const present = run('python3', [checkSpec, root, 'W1', '--phase', 'close'])
    expect(present.status, present.stderr).toBe(0)
  })

  it('fails the change set while the release commit is still local-only', async () => {
    const root = await makeWorkspace()
    await writeReleasePlan(root)
    git(root, 'init')
    git(root, 'config', 'user.email', 'fixture@example.com')
    git(root, 'config', 'user.name', 'fixture')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'fixture: release candidate')
    const remote = await mkdtemp(join(tmpdir(), 'wish-release-remote-'))
    workspaces.push(remote)
    git(remote, 'init', '--bare')
    git(root, 'remote', 'add', 'origin', remote)
    git(root, 'push', '-u', 'origin', 'HEAD')

    const pushed = run('python3', [releaseCheck, root, 'W1'])
    expect(row(pushed.stdout, 'change-set')).toMatch(/^PASS\b/u)

    await writeFile(join(root, 'local-only.txt'), 'not pushed\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'fixture: local-only follow-up')

    const unpushed = run('python3', [releaseCheck, root, 'W1'])
    expect(row(unpushed.stdout, 'change-set')).toMatch(/^FAIL\b/u)
    expect(unpushed.stdout).toContain('unpushed commit')
  }, 30_000)
})
