import { createProjectKeeperFixture } from './project-keeper-fixture.ts'
import { mkdtempSync, readdirSync, lstatSync, chmodSync, symlinkSync, mkdirSync, openSync, closeSync, writeSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createExternalSandboxLaunchPort } from '../kernel/sandbox-launch-port.ts'
import { startProjectKeeper, inspectProjectKeeper, retireProjectKeeper } from './project-keeper.ts'
import { verifyProjectSeal, copyVerifiedProjectSource, type ProjectSeal } from './project-snapshot.ts'
export type ProjectGate = 'typecheck' | 'test' | 'docs:check' | 'build' | 'test:scripts' | 'runtime-deps:check' | 'sync-shared:check'
const gates = new Set<ProjectGate>(['typecheck', 'test', 'docs:check', 'build', 'test:scripts', 'runtime-deps:check', 'sync-shared:check'])
/** Host-only fixed project commands. This returns observations, never an acceptance verdict. */
export async function runProjectVerification(input: {
  sealedCandidate: ProjectSeal; workRoot: string; collectorRoot: string; gate: ProjectGate
  authorizationVersion: string; signal: AbortSignal; liveFence: () => boolean
}) {
  if (!gates.has(input.gate) || !input.authorizationVersion || input.signal.aborted || !input.liveFence()) throw new Error('PROJECT_GATE_FENCED')
  if (!verifyProjectSeal(input.sealedCandidate)) throw new Error('PROJECT_SEAL_CHANGED')
  const seal = input.sealedCandidate, collector = realpathSync(input.collectorRoot)
  const work = mkdtempSync(join(dirname(realpathSync(input.workRoot)), 'gate-' + input.gate.replace(':', '-') + '-'))
  copyVerifiedProjectSource(seal, work)
  const writable = (path: string) => { if (!lstatSync(path).isDirectory()) { chmodSync(path, lstatSync(path).mode & 0o111 ? 0o700 : 0o600); return }; chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name)) }; writable(work)
  for (const [path, name] of [['node_modules', 'modules'], ['packages/dsh-web-all/node_modules', 'package-modules'], ['shared/node_modules', 'shared-modules']]) {
    const target = join(work, path!); mkdirSync(target, { recursive: true }); for (const entry of readdirSync(seal.dependencyRoots[name!]!)) symlinkSync(join(seal.dependencyRoots[name!]!, entry), join(target, entry))
  }
  const home = input.gate === 'test:scripts' ? mkdtempSync(join(dirname(work), 'home-test-scripts-')) : join(work, '.qa-home'), tmp = input.gate === 'test:scripts' ? mkdtempSync(join(dirname(work), 'scratch-test-scripts-')) : join(work, '.qa-tmp'); mkdirSync(home, { recursive: true }); mkdirSync(tmp, { recursive: true })
  const executable = seal.tools.node!, pnpm = join(seal.dependencyRoots.pnpm!, 'bin/pnpm.cjs'), args = [pnpm, input.gate], plan: readonly ProjectGate[] = input.gate === 'runtime-deps:check' ? ['build', 'runtime-deps:check'] : [input.gate]
  const readRoots = ['/usr/lib', '/usr/share', '/bin', '/usr/bin', '/System/Library', seal.root, work, tmp, home]
  const readPaths = ['/', '/dev/null', '/dev/random', '/dev/urandom', '/private/var/select/sh'].map(p => realpathSync(p))
  const metadata = new Set<string>([collector, '/', '/tmp', '/private/tmp', '/private/var', '/private/var/select', '/private/var/select/sh']); for (const path of [...readRoots, ...readPaths, collector]) for (let p = dirname(path); p !== '/'; p = dirname(p)) metadata.add(p)
  const executableRoots = [dirname(executable), '/bin', '/usr/bin', ...Object.values(seal.dependencyRoots), ...(input.gate === 'test:scripts' ? [tmp] : [])]
  const runId = randomUUID(), p7Fixture = input.gate === 'test' ? await createProjectKeeperFixture({runId,epoch:1,expiresAt:Date.now()+300000}) : undefined
  if(p7Fixture){readPaths.push(p7Fixture.capabilityPath);for(let p=p7Fixture.root;p!=='/';p=dirname(p))metadata.add(p);metadata.add(p7Fixture.socketPath)}
  const keeper = await startProjectKeeper({ collectorRoot: collector, budgetVersion: 'project-gates-v1', qualificationFixtures: input.gate === 'test', runId, epoch: 1, capacity: input.gate === 'test' || input.gate === 'test:scripts' ? 256 : 4, expiresAt: Date.now() + 300000, domain: { readRoots, readPaths, writeRoots: [work, tmp, home, '/dev/null'], executableRoots, metadataPaths: [...metadata], fixturePorts: [], unixSockets: p7Fixture ? [p7Fixture.socketPath] : [] }, launchEnvironment: { PATH: dirname(executable) + ':/usr/bin:/bin', COREPACK_ENABLE_NETWORK: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_EXEC_PATH: dirname(executable), ...(input.gate === 'test:scripts' ? { OPENSSL_CONF: seal.tools.openssl_config!, CURL_SSL_BACKEND: 'Secure-Transport' } : {}), pnpm_config_verify_deps_before_run: 'false', ...(p7Fixture ? {DSH_P7_KEEPER_FIXTURE:p7Fixture.capabilityPath} : {}) }, commands: plan.map(gate => ({ id: 'project:' + gate, executable, args: [pnpm, gate], cwd: work })) })
  const initial = await inspectProjectKeeper(keeper); if (!initial.current) throw new Error('PROJECT_KEEPER_UNAVAILABLE')
  const q = JSON.stringify, unix = join(keeper.root, 'allocator.sock'), preload = join(keeper.root, 'fixture.cjs')
  const qaSockets = Array.isArray(initial.status.qaSocketPaths) ? initial.status.qaSocketPaths.filter((p): p is string => typeof p === 'string') : []
  if(p7Fixture)qaSockets.push(p7Fixture.socketPath)
  const profile = ['(version 1)(deny default)(allow process-exec process-fork sysctl-read)(allow process-info* signal (target self) (target children))(allow mach-lookup (global-name "com.apple.system.logger"))', '(allow file-read* ' + readRoots.map(p => `(subpath ${q(p)})`).join(' ') + ' ' + [...readPaths, preload].map(p => `(literal ${q(p)})`).join(' ') + ')', '(allow file-read-metadata ' + [...metadata, collector, keeper.root, unix].map(p => `(literal ${q(p)})`).join(' ') + ')', `(allow file-write* (subpath ${q(work)}) (subpath ${q(tmp)}) (subpath ${q(home)}) (literal "/dev/null"))`, '(allow network-outbound ' + initial.status.endpoints.map(e => `(remote ip "localhost:${e.port}")`).join(' ') + ` (literal ${q(unix)}) ${qaSockets.map(p => `(literal ${q(p)})`).join(' ')})`, '(allow network-inbound ' + initial.status.endpoints.map(e => `(local ip "localhost:${e.port}")`).join(' ') + ')'].join('\n')
  const observeStep = async (step: ProjectGate) => {
  const outPath = join(keeper.root, plan.length === 1 ? 'stdout.raw' : step.replace(':', '-') + '.stdout.raw'), errPath = join(keeper.root, plan.length === 1 ? 'stderr.raw' : step.replace(':', '-') + '.stderr.raw'), out = openSync(outPath, 'wx', 0o600), err = openSync(errPath, 'wx', 0o600)
  const child = createExternalSandboxLaunchPort(initial.status.broker).open({ profile, executable, args: [pnpm, step], cwd: work, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, LANG: 'en_US.UTF-8' }, processPolicy: 'children', timeoutMs: 300000 })
  let code: number | null = null, exitSignal: string | null = null, exited = false, outputBytes = 0; const errors: string[] = []
  const cancel = () => child.cancel()
  const capture = (fd: number, bytes: Buffer) => { outputBytes += bytes.length; if (outputBytes > 64 * 1024 * 1024) { errors.push('PROJECT_OUTPUT_LIMIT'); cancel(); return }; try { writeSync(fd, bytes) } catch { errors.push('PROJECT_COLLECTOR_FAILED'); cancel() } }
  child.stdout.on('data', b => capture(out, b)); child.stderr.on('data', b => capture(err, b)); child.on('error', error => errors.push(error.message)); child.on('exit', (c, s) => { code = c; exitSignal = s; exited = true })
  input.signal.addEventListener('abort', cancel, { once: true })
  let checking = false
  const monitor = setInterval(() => { if (checking) return; checking = true; void (async () => { try { const status = await inspectProjectKeeper(keeper); if (!input.liveFence() || !status.current) { errors.push('PROJECT_LIVE_FENCE_REVOKED'); cancel() } } catch { errors.push('PROJECT_LIVE_FENCE_REVOKED'); cancel() } finally { checking = false } })() }, 1000)
  child.stdin.end()
  await new Promise<void>(resolve => child.once('close', resolve))
  await p7Fixture?.close()
  clearInterval(monitor); input.signal.removeEventListener('abort', cancel); closeSync(out); closeSync(err)
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
  return { gate: step, command: ['pnpm', step], executable, args: [pnpm, step], stdout: { path: outPath, sha256: digest(outPath) }, stderr: { path: errPath, sha256: digest(errPath) }, exit: { observed: exited, code, signal: exitSignal }, complete: exited && errors.length === 0, errors }
  }
  const steps: Awaited<ReturnType<typeof observeStep>>[] = []
  for (const step of plan) {
    if (input.signal.aborted || !input.liveFence() || !(await inspectProjectKeeper(keeper)).current) break
    const observation = await observeStep(step); steps.push(observation)
    if (!observation.complete || observation.exit.code !== 0) break
  }
  const held = await inspectProjectKeeper(keeper)
  await retireProjectKeeper(keeper)
  const last = steps.at(-1), errors = steps.flatMap(step => step.errors)
  if (steps.length !== plan.length) errors.push('PROJECT_FIXED_PLAN_INCOMPLETE')
  const observation = { version: 1, runId, gate: input.gate, command: ['pnpm', input.gate], executable, args, cwd: work, authorizationVersion: input.authorizationVersion, sourceDigest: seal.digest, provenance: seal.provenance, keeperRef: { instance: keeper.instance, root: keeper.root, pid: keeper.pid, artifactDigest: keeper.artifactDigest }, planVersion: 'project-gates-v2', plan, steps, stdout: last?.stdout ?? null, stderr: last?.stderr ?? null, exit: last?.exit ?? { observed: false, code: null, signal: null }, complete: steps.length === plan.length && steps.every(step => step.complete), errors, isolationCurrent: held.current, cessation: 'unknown', resources: 'quarantined', observedAt: Date.now() }
  writeFileSync(join(keeper.root, 'project-observation.json'), JSON.stringify(observation, null, 2), { flag: 'wx', mode: 0o400 })
  return observation
}
