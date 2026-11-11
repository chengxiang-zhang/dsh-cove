import { spawn, execFileSync } from 'node:child_process'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync, realpathSync, rmSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import type { SandboxKeeperConfig } from '../kernel/sandbox-keeper.ts'
import type { SandboxBrokerAddress } from '../kernel/sandbox-launch-port.ts'

export interface ProjectKeeperRef {
  readonly version: 1; readonly instance: string; readonly root: string; readonly pid: number
  readonly managementToken: string; readonly artifactDigest: string
}
export interface ProjectKeeperStatus {
  readonly instance: string; readonly keeperPid: number; readonly startIdentity: string
  readonly phase: 'active' | 'quarantine'; readonly cessation: 'unknown'; readonly lastHeldAt: number | null
  readonly artifactDigest: string; readonly recordFailed: boolean; readonly broker: SandboxBrokerAddress
  readonly endpoints: readonly { port: number; families: readonly string[] }[]
  readonly [key: string]: unknown
}
const bundleFiles = ['sandbox-keeper.ts', 'sandbox-broker.ts', 'sandbox-launch-port.ts', 'sandbox-policy.ts', 'sandbox-wire.ts', 'sandbox-fixtures.ts', 'sandbox-fixture-pool.ts', 'sandbox-fixture-preload.ts', 'sandbox-fixture-holder.ts', 'sandbox-qa-grants.ts'] as const
/** Starts a fixed collector program from an immutable TCB copy, independently of plugin lifetime. */
export async function startProjectKeeper(input: Omit<SandboxKeeperConfig, 'version' | 'root' | 'instance' | 'managementToken' | 'artifactDigest'> & { collectorRoot: string; budgetVersion?: 'project-gates-v1' }): Promise<ProjectKeeperRef> {
  const collectorRoot = realpathSync(input.collectorRoot), admission = join(collectorRoot, '.admission')
  mkdirSync(admission)
  let child: ReturnType<typeof spawn> | undefined
  try {
    const budgetPath = join(collectorRoot, 'budget.json'), keepers = readdirSync(collectorRoot).filter(x => x.startsWith('keeper-'))
    const budget = { version: input.budgetVersion ?? 'fixed-four-v1', maximum: input.budgetVersion === 'project-gates-v1' ? 8 : 4 }
    try {
      const recorded = JSON.parse(readFileSync(budgetPath, 'utf8'))
      if (JSON.stringify(recorded) !== JSON.stringify(budget)) throw new Error('KEEPER_BUDGET_VERSION_CHANGED')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (keepers.length && budget.maximum !== 4) throw new Error('KEEPER_BUDGET_VERSION_CHANGED')
      writeFileSync(budgetPath, JSON.stringify(budget), { flag: 'wx', mode: 0o400 })
    }
    if (keepers.length >= budget.maximum) throw new Error('KEEPER_QUARANTINE_BUDGET')
    const instance = randomUUID(), root = join(collectorRoot, 'keeper-' + instance), tcb = join(root, 'tcb')
    if (Buffer.byteLength(join(root, 'management.sock')) >= 104) throw new Error('KEEPER_SOCKET_PATH_LIMIT')
    mkdirSync(root, { mode: 0o700 }); mkdirSync(tcb)
    const owner = dirname(createRequire(import.meta.url).resolve('@dsh-cove/dsh-web-all/src/host/services/superagent/kernel/sandbox-keeper.ts')), hashes: Record<string, string> = {}
    for (const name of bundleFiles) { const bytes = readFileSync(join(owner, name)); hashes[name] = createHash('sha256').update(bytes).digest('hex'); writeFileSync(join(tcb, name), bytes, { flag: 'wx', mode: 0o400 }) }
    chmodSync(tcb, 0o500)
    const artifactDigest = createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), managementToken = randomBytes(32).toString('hex')
    writeFileSync(join(root, 'artifact.json'), JSON.stringify({ version: 1, hashes, artifactDigest }), { flag: 'wx', mode: 0o400 })
    const { collectorRoot: _collectorRoot, budgetVersion: _budgetVersion, ...configuration } = input
    const config: SandboxKeeperConfig = { ...configuration, version: 1, instance, root, managementToken, artifactDigest }
    const configPath = join(root, 'config.json'); writeFileSync(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o400 })
    const log = openSync(join(root, 'keeper-start.log'), 'ax', 0o600)
    try {
      child = spawn(realpathSync(process.execPath), ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(tcb, 'sandbox-keeper.ts'), configPath], { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'en_US.UTF-8' }, stdio: ['ignore', log, log], detached: true })
    } finally { closeSync(log) }
    let failure: Error | undefined; child.once('error', error => { failure = error })
    if (!child.pid) throw new Error('KEEPER_START_FAILED')
    const ref = Object.freeze({ version: 1 as const, instance, root, pid: child.pid, managementToken, artifactDigest })
    writeFileSync(join(root, 'owner-ref.json'), JSON.stringify({ ...ref, responsibility: 'retained-until-qualified-cessation', nextReviewAt: Date.now() + 1000 }), { flag: 'wx', mode: 0o400 })
    child.unref()
    for (let i = 0; i < 100; i++) {
      if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`KEEPER_START_FAILED:${root}`)
      const result = await inspectProjectKeeper(ref)
      if (result.current) return ref
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`KEEPER_START_UNOBSERVED_RETAINED:${root}`)
  } finally { rmSync(admission, { recursive: true }) }
}
function request(ref: ProjectKeeperRef, operation: 'status' | 'retire' | 'dispose'): Promise<ProjectKeeperStatus> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(ref.root, 'management.sock')); let bytes = Buffer.alloc(0), settled = false
    const finish = (error?: Error, value?: ProjectKeeperStatus) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(value!) }
    const timer = setTimeout(() => finish(new Error('KEEPER_CONTROL_TIMEOUT')), 1000)
    socket.once('error', error => finish(error)); socket.once('close', () => { if (!settled) finish(new Error('KEEPER_CONTROL_LOST')) })
    socket.once('connect', () => socket.write(JSON.stringify({ version: 1, instance: ref.instance, token: ref.managementToken, operation }) + '\n'))
    socket.on('data', data => {
      try {
        bytes = Buffer.concat([bytes, data]); if (bytes.length > 256 * 1024) throw new Error('KEEPER_CONTROL_LIMIT')
        const end = bytes.indexOf(10); if (end < 0) return
        if (end !== bytes.length - 1) throw new Error('KEEPER_CONTROL_FRAME')
        const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)))
        if (result.error) throw new Error(String(result.error))
        if (result.instance !== ref.instance || result.keeperPid !== ref.pid || result.artifactDigest !== ref.artifactDigest) throw new Error('KEEPER_IDENTITY_CHANGED')
        finish(undefined, result)
      } catch (error) { finish(error as Error) }
    })
  })
}
export async function inspectProjectKeeper(ref: ProjectKeeperRef): Promise<{ current: true; status: ProjectKeeperStatus } | { current: false; reason: string }> {
  try {
    const status = await request(ref, 'status')
    const start = execFileSync('/bin/ps', ['-p', String(ref.pid), '-o', 'lstart='], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 1000 }).trim()
    if (start !== status.startIdentity || !Number.isSafeInteger(status.lastHeldAt) || Number(status.lastHeldAt) > Date.now() || Date.now() - Number(status.lastHeldAt) > 2500 || status.recordFailed) throw new Error('KEEPER_ISOLATION_NOT_CURRENT')
    return { current: true, status }
  } catch (error) { return { current: false, reason: (error as Error).message } }
}
export async function retireProjectKeeper(ref: ProjectKeeperRef): Promise<ProjectKeeperStatus> { return request(ref, 'retire') }
/** No qualified all-owner cessation provider is currently installed. A boolean is not accepted. */
export async function requestProjectKeeperDisposal(ref: ProjectKeeperRef): Promise<never> { await request(ref, 'dispose'); throw new Error('KEEPER_UNEXPECTED_DISPOSAL_ACK') }
