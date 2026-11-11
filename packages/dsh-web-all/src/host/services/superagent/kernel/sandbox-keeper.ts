import { appendFileSync, readFileSync, writeFileSync, renameSync, chmodSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createSandboxFixturePool } from './sandbox-fixture-pool.ts'
import { createProjectQAGrants } from './sandbox-qa-grants.ts'
import { createSandboxBroker } from './sandbox-broker.ts'
import type { SandboxDomain } from './sandbox-policy.ts'
import type { SandboxLaunchRequest } from './sandbox-launch-port.ts'

export interface SandboxKeeperConfig {
  readonly version: 1
  readonly instance: string
  readonly root: string
  readonly runId: string
  readonly epoch: number
  readonly capacity: number
  readonly managementToken: string
  readonly domain: SandboxDomain
  readonly qualificationFixtures?: boolean
  readonly launchEnvironment?: Readonly<Record<string, string>>
  readonly commands: readonly { id: string; executable: string; args: readonly string[]; cwd: string }[]
  readonly expiresAt: number
  readonly artifactDigest: string
}
/** Fixed external collector process. No candidate code is imported or evaluated here. */
export async function runSandboxKeeper(config: SandboxKeeperConfig) {
  if (config.version !== 1 || config.root !== realpathSync(config.root) || !/^[a-f0-9-]{36}$/.test(config.instance) || !/^[a-f0-9]{64}$/.test(config.managementToken) || !config.commands.length || config.commands.length > 64) throw new Error('KEEPER_CONFIG_INVALID')
  const statusPath = join(config.root, 'status.json'), eventsPath = join(config.root, 'events.jsonl'), managementPath = join(config.root, 'management.sock')
  const startIdentity = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 1000 }).trim()
  if (!startIdentity) throw new Error('KEEPER_START_IDENTITY_UNAVAILABLE')
  let phase: 'active' | 'quarantine' = 'active', reason = '', eventBytes = 0, recordFailed = false, lastHeldAt: number | null = null
  const owners = new Map<string, { pid?: number; parentExitObserved: boolean }>()
  let qa: Awaited<ReturnType<typeof createProjectQAGrants>> | undefined
  let broker: Awaited<ReturnType<typeof createSandboxBroker>> | undefined
  const persist = (value: unknown) => { writeFileSync(statusPath + '.next', JSON.stringify(value), { mode: 0o600 }); renameSync(statusPath + '.next', statusPath) }
  const quarantine = (why: string) => { phase = 'quarantine'; reason = why; pool.retire(); void broker?.close(); void qa?.close() }
  const record = (event: Readonly<Record<string, unknown>>) => {
    const frame = JSON.stringify({ at: Date.now(), ...event }) + '\n'
    if (recordFailed || eventBytes + Buffer.byteLength(frame) > 256 * 1024 * 1024) { recordFailed = true; throw new Error('KEEPER_COLLECTOR_BUDGET') }
    appendFileSync(eventsPath, frame, { mode: 0o600 }); eventBytes += Buffer.byteLength(frame)
    if (event.type === 'spawned') owners.set(String(event.handleId), { pid: Number(event.pid), parentExitObserved: false })
    if (event.type === 'exit') { const owner = owners.get(String(event.handleId)); if (owner) owner.parentExitObserved = true }
    if (event.type === 'grant-revoked' || event.type === 'broker-closed') { phase = 'quarantine'; reason = String(event.reason ?? event.type) }
  }
  const pool = await createSandboxFixturePool({ capacity: config.capacity, socketPath: join(config.root, 'allocator.sock'), preloadPath: join(config.root, 'fixture.cjs'), record })
  const state = () => ({ version: 1, instance: config.instance, runId: config.runId, epoch: config.epoch, keeperPid: process.pid, startIdentity, artifactDigest: config.artifactDigest, configDigest: createHash('sha256').update(JSON.stringify(config)).digest('hex'), phase, reason, observedAt: Date.now(), lastHeldAt, nextReviewAt: Date.now() + 1000, endpointBudget: config.capacity, endpoints: pool.ports.map(port => ({ port, families: ['127.0.0.1', '::1'] })), leaseClaims: pool.leases(), owners: [...owners.entries()], cessation: 'unknown', disposal: 'qualified-proof-unavailable', recordFailed, eventsPath, qaSocketPaths: qa?.socketPaths ?? [], broker: broker?.address })
  const admission = (r: Readonly<SandboxLaunchRequest>) => config.commands.find(c => r.executable === c.executable && r.cwd === c.cwd && JSON.stringify(r.args) === JSON.stringify(c.args))?.id ?? null
  try {
    const domain = { ...config.domain, readPaths: [...(config.domain.readPaths ?? []), join(config.root, 'fixture.cjs')], metadataPaths: [...config.domain.metadataPaths, config.root, pool.socketPath], fixturePorts: pool.ports, unixSockets: [...config.domain.unixSockets, pool.socketPath] }
    const base = { runId: config.runId, epoch: config.epoch, domain, expiresAt: config.expiresAt, maxConcurrent: 8, maxLaunches: 256, maxOutputBytes: 64 * 1024 * 1024, fixtureResources: pool.resources, launchEnvironment: config.launchEnvironment, record }
    if (config.qualificationFixtures) qa = await createProjectQAGrants(base, config.commands[0]!.cwd, config.root, config.commands[0]!.executable)
    broker = await createSandboxBroker({ ...base, socketPath: join(config.root, 'broker.sock'), domain: { ...domain, unixSockets: [...domain.unixSockets, ...(qa?.socketPaths ?? [])] }, launchEnvironment: { ...config.launchEnvironment, ...qa?.environment }, admitLaunch: admission })
  } catch (error) { await qa?.close(); await pool.disposeUnused(); throw error }
  const management = createServer(socket => {
    let bytes = Buffer.alloc(0)
    const timeout = setTimeout(() => socket.destroy(), 1000)
    socket.on('error', () => {})
    socket.once('close', () => clearTimeout(timeout))
    socket.on('data', data => {
      try {
        bytes = Buffer.concat([bytes, data]); if (bytes.length > 1024) throw new Error('KEEPER_MANAGEMENT_LIMIT')
        const n = bytes.indexOf(10); if (n < 0) return
        const m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n)))
        if (bytes.length !== n + 1 || Object.keys(m).sort().join(',') !== 'instance,operation,token,version' || m.version !== 1 || m.instance !== config.instance || typeof m.token !== 'string' || m.token.length !== 64 || !timingSafeEqual(Buffer.from(m.token), Buffer.from(config.managementToken))) throw new Error('KEEPER_MANAGEMENT_AUTH')
        if (m.operation === 'retire') quarantine('TRUSTED_RETIRE')
        else if (m.operation === 'dispose') throw new Error('FIXTURE_CESSATION_PROOF_UNAVAILABLE')
        else if (m.operation !== 'status') throw new Error('KEEPER_MANAGEMENT_OPERATION')
        socket.end(JSON.stringify(state()) + '\n')
      } catch (error) { socket.end(JSON.stringify({ error: (error as Error).message }) + '\n') }
    })
  })
  await new Promise<void>((resolve, reject) => { management.once('error', reject); management.listen(managementPath, () => { management.off('error', reject); resolve() }) })
  chmodSync(managementPath, 0o600)
  const observe = async () => {
    try {
      if (recordFailed) quarantine('COLLECTOR_UNAVAILABLE')
      const held = await pool.verifyReservations()
      if (!held.every(x => x.held)) { lastHeldAt = null; quarantine('ENDPOINT_HOLDER_LOST') } else lastHeldAt = Date.now()
      persist(state())
    } catch { lastHeldAt = null; quarantine('KEEPER_OBSERVATION_FAILED'); try { persist(state()) } catch { /* No current persisted observation means no isolation qualification. */ } }
  }
  await observe()
  setInterval(() => { void observe() }, 1000)
  // Parent stdio or IPC is not part of this process's lifetime. P6 supervision owns this ref.
  return Object.freeze({ statusPath, managementPath })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8')) as SandboxKeeperConfig
  await runSandboxKeeper(config)
}
