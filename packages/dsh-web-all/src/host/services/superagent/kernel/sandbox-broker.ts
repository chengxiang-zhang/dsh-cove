import { createServer, type Socket } from 'node:net'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, realpathSync, unlinkSync } from 'node:fs'
import { relative, isAbsolute } from 'node:path'
import { materializeFixtureResources, type OwnedFixtureResources } from './sandbox-fixture-pool.ts'
import { SandboxFrameDecoder, decodeSandboxBytes } from './sandbox-wire.ts'
import { constrainSandboxPolicy, type SandboxDomain } from './sandbox-policy.ts'
import { SANDBOX_WIRE_LIMIT, SANDBOX_WRITE_LIMIT, NATIVE_CONNECT_LOG, type SandboxLaunchRequest } from './sandbox-launch-port.ts'

export interface SandboxBrokerGrant {
  readonly runId: string
  readonly epoch: number
  readonly socketPath: string
  readonly domain: SandboxDomain
  readonly expiresAt: number
  readonly maxConcurrent: number
  readonly maxLaunches: number
  readonly maxOutputBytes: number
  /** An opaque capability minted only by the trusted, live dual-stack holder. Never wire data. */
  readonly fixtureResources?: OwnedFixtureResources
  /** Fixed preparation-owned tool environment; never accepted from wire requests. */
  readonly launchEnvironment?: Readonly<Record<string, string>>
  /** Additional directory-valued keys registered by the trusted host, not by a wire caller. */
  readonly directoryEnvironmentNames?: readonly string[]
  /** Trusted registry only. No candidate module is evaluated to decide admission. */
  readonly admitLaunch: (request: Readonly<SandboxLaunchRequest>) => string | null
  /** Collector-owned sink. It must not be writable by any candidate. */
  readonly record: (event: Readonly<Record<string, unknown>>) => void
}
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const within = (path: string, roots: readonly string[]): boolean => roots.some(root => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) })
const canonical = (path: unknown): string => { if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || realpathSync(path) !== path) throw new Error('SANDBOX_PATH_IDENTITY'); return path }
function admitRequest(value: unknown, domain: SandboxDomain, directoryNames: readonly string[]): SandboxLaunchRequest {
  if (!exact(value, ['profile', 'executable', 'args', 'cwd', 'env', 'processPolicy', 'timeoutMs'])) throw new Error('SANDBOX_REQUEST_SCHEMA')
  const r = value as unknown as SandboxLaunchRequest
  const cwd = canonical(r.cwd), executable = canonical(r.executable)
  if (!within(cwd, domain.writeRoots) || !within(executable, domain.executableRoots)) throw new Error('SANDBOX_REQUEST_OUTSIDE_GRANT')
  if (!Array.isArray(r.args) || r.args.length > 256 || r.args.some(x => typeof x !== 'string' || x.length > 8192 || x.includes('\0')) || Buffer.byteLength(JSON.stringify(r.args)) > 65536) throw new Error('SANDBOX_ARGUMENT_LIMIT')
  if (!['single', 'children'].includes(r.processPolicy) || !Number.isSafeInteger(r.timeoutMs) || r.timeoutMs < 1 || r.timeoutMs > 300000) throw new Error('SANDBOX_REQUEST_LIMIT')
  if (!r.env || typeof r.env !== 'object' || Array.isArray(r.env) || Object.keys(r.env).some(k => !['PATH', 'HOME', 'TMPDIR', 'LANG', 'RUST_LOG', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME', 'DSH_DATA_DIR', ...directoryNames].includes(k))) throw new Error('SANDBOX_ENV_SCHEMA')
  if (r.env.RUST_LOG !== undefined && (r.env.RUST_LOG !== NATIVE_CONNECT_LOG || !r.env.CODEX_HOME)) throw new Error('SANDBOX_ENV_VALUE')
  if (r.env.PATH !== '/usr/bin:/bin' || r.env.LANG !== 'en_US.UTF-8') throw new Error('SANDBOX_ENV_VALUE')
  for (const [key, value] of Object.entries(r.env)) {
    if (key === 'PATH' || key === 'LANG' || key === 'RUST_LOG') continue
    if (!within(canonical(value), domain.writeRoots)) throw new Error('SANDBOX_ENV_OUTSIDE_GRANT')
  }
  if (!r.env.HOME || !r.env.TMPDIR) throw new Error('SANDBOX_ENV_VALUE')
  return r
}
/** Host-only. The immutable grant is installed before an untrusted outer starts. */
export async function createSandboxBroker(input: SandboxBrokerGrant) {
  if (process.platform !== 'darwin') throw new Error('SANDBOX_UNSUPPORTED')
  if (typeof input.admitLaunch !== 'function' || typeof input.record !== 'function' || ![input.epoch, input.expiresAt, input.maxConcurrent, input.maxLaunches, input.maxOutputBytes].every(Number.isSafeInteger) || !input.runId || !Number.isSafeInteger(input.epoch) || input.epoch < 1 || input.expiresAt <= Date.now() || input.maxConcurrent < 1 || input.maxConcurrent > 64 || input.maxLaunches < 1 || input.maxLaunches > 4096 || input.maxOutputBytes < 1 || input.maxOutputBytes > 256 * 1024 * 1024) throw new Error('SANDBOX_GRANT_INVALID')
  const domain: SandboxDomain = Object.freeze({
    readRoots: Object.freeze(input.domain.readRoots.map(canonical)), readPaths: Object.freeze((input.domain.readPaths ?? []).map(canonical)), writeRoots: Object.freeze(input.domain.writeRoots.map(canonical)), executableRoots: Object.freeze(input.domain.executableRoots.map(canonical)),
    metadataPaths: Object.freeze([...input.domain.metadataPaths]), fixturePorts: Object.freeze([...input.domain.fixturePorts]), unixSockets: Object.freeze([...input.domain.unixSockets]),
  })
  const directoryEnvironmentNames = Object.freeze([...(input.directoryEnvironmentNames ?? [])])
  if (directoryEnvironmentNames.length > 8 || directoryEnvironmentNames.some(k => !/^[A-Z][A-Z0-9_]{0,63}$/.test(k) || /^(?:NODE|LD|DYLD|PATH|HOME|TMPDIR|LANG)/.test(k))) throw new Error('SANDBOX_DIRECTORY_ENV_REGISTRATION')
  const launchEnvironment = Object.freeze({ ...(input.launchEnvironment ?? {}) })
  for (const [key, value] of Object.entries(launchEnvironment)) {
    if (!['PATH', 'COREPACK_ENABLE_NETWORK', 'pnpm_config_verify_deps_before_run', 'DSH_QA_SANDBOX_BROKER', 'DSH_QA_SANDBOX_PROFILE', 'DSH_QA_SANDBOX_ROUTES', 'DSH_VERIFICATION_BROKER', 'GIT_CONFIG_NOSYSTEM', 'GIT_EXEC_PATH', 'OPENSSL_CONF', 'CURL_SSL_BACKEND', 'DSH_P7_KEEPER_FIXTURE'].includes(key) || typeof value !== 'string' || value.length > 65536 || value.includes('\0')) throw new Error('SANDBOX_TRUSTED_ENV_SCHEMA')
    if (key === 'PATH' && value.split(':').some(path => !within(canonical(path), domain.executableRoots))) throw new Error('SANDBOX_TRUSTED_PATH_DOMAIN')
    if (key === 'GIT_EXEC_PATH' && !domain.executableRoots.includes(value)) throw new Error('SANDBOX_TRUSTED_ENV_PATH');
    if (key === 'CURL_SSL_BACKEND' && value !== 'Secure-Transport') throw new Error('SANDBOX_TRUSTED_ENV_VALUE');
    if (key === 'OPENSSL_CONF' && !domain.executableRoots.some(root => value === root + '/openssl_config')) throw new Error('SANDBOX_TRUSTED_ENV_VALUE');
    if (key === 'GIT_CONFIG_NOSYSTEM' && value !== '1') throw new Error('SANDBOX_TRUSTED_ENV_VALUE')
    if (key === 'COREPACK_ENABLE_NETWORK' && value !== '0' || key === 'pnpm_config_verify_deps_before_run' && value !== 'false') throw new Error('SANDBOX_TRUSTED_ENV_VALUE')
  }
  const grant = Object.freeze({ ...input, domain, launchEnvironment, directoryEnvironmentNames })
  const sockets = new Set<Socket>(), children = new Set<ChildProcessWithoutNullStreams>(), used = new Set<string>()
  let revoked = false, closing = false, collectorFailed = false, total = 0
  const record = (event: Record<string, unknown>): boolean => {
    if (collectorFailed) return false
    try { grant.record(Object.freeze({ runId: grant.runId, epoch: grant.epoch, observedAt: Date.now(), ...event })); return true }
    catch {
      collectorFailed = true; revoked = true
      for (const child of children) kill(child)
      for (const socket of sockets) socket.destroy()
      return false
    }
  }
  const kill = (child: ChildProcessWithoutNullStreams | undefined) => {
    // Only the live ChildProcess owned by this connection is a cancellation target.
    if (child?.pid && child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL') } catch { /* No group is not proof that all writers stopped. */ }
  }
  const server = createServer(socket => {
    if (revoked || sockets.size >= 2 * grant.maxConcurrent) {
      socket.on('error', () => {})
      if (sockets.size >= 2 * grant.maxConcurrent) { socket.destroy(); return }
      sockets.add(socket); socket.once('close', () => sockets.delete(socket))
      const reason = revoked ? 'SANDBOX_GRANT_REVOKED' : 'SANDBOX_CONNECTION_LIMIT'
      record({ type: 'connection-refused', reason })
      // Let the peer read the refusal before closing the read side. Immediate destroy
      // races its already queued open/write bytes and can replace the reason with EPIPE.
      let discarded = 0
      const refusalDrain = setTimeout(() => socket.destroy(), 1000)
      socket.once('close', () => clearTimeout(refusalDrain))
      socket.on('data', bytes => { discarded += bytes.length; if (discarded > SANDBOX_WIRE_LIMIT) socket.destroy() })
      socket.end(JSON.stringify({ version: 1, seq: 1, type: 'refused', reason }) + '\n')
      return
    }
    sockets.add(socket)
    let child: ChildProcessWithoutNullStreams | undefined, handleId = '', expected = 1, sequence = 0, ended = false, opened = false, inputEnded = false, pendingBytes = 0, outputBytes = 0
    const decoder = new SandboxFrameDecoder(SANDBOX_WIRE_LIMIT)
    let timer: ReturnType<typeof setTimeout> | undefined, drain: ReturnType<typeof setTimeout> | undefined
    const send = (event: Record<string, unknown>) => {
      if (!record({ handleId, ...event })) return
      if (ended || socket.destroyed) return
      const frame = JSON.stringify({ version: 1, seq: ++sequence, ...event }) + '\n'
      if (socket.writableLength + Buffer.byteLength(frame) > 2 * SANDBOX_WIRE_LIMIT) { kill(child); socket.destroy(); return }
      socket.write(frame)
    }
    const end = (complete: boolean) => {
      if (ended) return
      send({ type: 'observation-end', complete }); ended = true
      if (timer) clearTimeout(timer); if (drain) clearTimeout(drain)
      socket.end(); child?.stdout.destroy(); child?.stderr.destroy()
    }
    const reject = (reason: string) => {
      if (child) { send({ type: 'error', reason }); kill(child) }
      else { send({ type: 'refused', reason }); end(true) }
    }
    timer = setTimeout(() => { reject('SANDBOX_OPEN_TIMEOUT'); socket.destroy() }, 1000)
    socket.on('data', bytes => {
      try {
      for (const m of decoder.push(bytes)) {
        try {
          if (revoked || Date.now() >= grant.expiresAt) throw new Error('SANDBOX_GRANT_EXPIRED')
          if (m.version !== 1 || m.seq !== expected++) throw new Error('SANDBOX_REQUEST_SEQUENCE')
          if (m.type === 'open') {
            if (opened || !exact(m, ['version', 'seq', 'type', 'runId', 'epoch', 'handleId', 'request']) || m.runId !== grant.runId || m.epoch !== grant.epoch || typeof m.handleId !== 'string' || !/^[a-f0-9-]{36}$/.test(m.handleId)) throw new Error('SANDBOX_OPEN_FENCED')
            if (used.has(m.handleId) || used.size >= grant.maxLaunches || children.size >= grant.maxConcurrent) throw new Error('SANDBOX_OPEN_LIMIT_OR_REPLAY')
            const r = admitRequest(m.request, domain, grant.directoryEnvironmentNames), policy = constrainSandboxPolicy(r.profile, domain)
            Object.freeze(r.args); Object.freeze(r.env); Object.freeze(r)
            const registeredLaunchId = grant.admitLaunch(r)
            if (typeof registeredLaunchId !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(registeredLaunchId)) throw new Error('SANDBOX_REGISTERED_LAUNCH_REQUIRED')
            if (r.processPolicy === 'single' && /\(allow [^()]*\bprocess-fork\b/.test(policy.profile)) throw new Error('SANDBOX_PROCESS_POLICY_MISMATCH')
            if (timer) clearTimeout(timer)
            opened = true; handleId = m.handleId; used.add(handleId); total++
            if (!record({ type: 'admitted', handleId, registeredLaunchId, ...policy, executable: r.executable, args: r.args, cwd: r.cwd, processPolicy: r.processPolicy })) throw new Error('SANDBOX_COLLECTOR_UNAVAILABLE')
            // Only the reconstructed, finite policy plus trusted suffix reaches the compiler.
            const fixtures = grant.fixtureResources ? materializeFixtureResources(grant.fixtureResources) : undefined
            const stdio: Array<'pipe' | 'ignore' | number> = ['pipe', 'pipe', 'pipe']
            if (fixtures) {
              for (const { source, target } of fixtures.descriptors) {
                if (target < 64 || stdio[target] !== undefined) throw new Error('FIXTURE_FD_COLLISION')
                while (stdio.length <= target) stdio.push('ignore')
                stdio[target] = source
              }
              if (!record({ type: 'fixture-injected', handleId, version: grant.fixtureResources!.version, targets: fixtures.descriptors.map(d => d.target), environment: fixtures.env })) throw new Error('SANDBOX_COLLECTOR_UNAVAILABLE')
            }
            child = spawn('/usr/bin/sandbox-exec', ['-p', policy.profile, r.executable, ...r.args], { cwd: r.cwd, env: { ...r.env, ...grant.launchEnvironment, ...fixtures?.env }, detached: true, stdio }) as ChildProcessWithoutNullStreams
            children.add(child)
            child.once('spawn', () => send({ type: 'spawned', handleId, pid: child!.pid, originalDigest: policy.originalDigest, effectiveDigest: policy.effectiveDigest }))
            const output = (type: string, bytes: Buffer) => {
              outputBytes += bytes.length
              if (outputBytes > grant.maxOutputBytes) { reject('SANDBOX_OUTPUT_LIMIT'); return }
              for (let offset = 0; offset < bytes.length; offset += 32768) send({ type, data: bytes.subarray(offset, offset + 32768).toString('base64') })
            }
            child.stdout.on('data', bytes => output('stdout', bytes)); child.stderr.on('data', bytes => output('stderr', bytes))
            child.stdin.on('error', error => send({ type: 'error', reason: `SANDBOX_STDIN:${error.message}` }))
            child.once('error', error => { send({ type: 'error', reason: error.message }); end(false) })
            child.once('exit', (code, signal) => {
              children.delete(child!); send({ type: 'exit', code, signal })
              drain = setTimeout(() => end(false), 250)
            })
            child.once('close', () => end(true))
            timer = setTimeout(() => { send({ type: 'error', reason: 'SANDBOX_TIMEOUT' }); kill(child) }, Math.min(r.timeoutMs, grant.expiresAt - Date.now()))
          } else {
            if (!child || !opened || ended) throw new Error('SANDBOX_NOT_OPEN')
            if (m.type === 'cancel' && exact(m, ['version', 'seq', 'type'])) { record({ type: 'cancel-requested', handleId }); kill(child) }
            else if (m.type === 'write' && exact(m, ['version', 'seq', 'type', 'data'])) {
              if (inputEnded) throw new Error('SANDBOX_INPUT_FRAME')
              const bytes = decodeSandboxBytes(m.data, SANDBOX_WRITE_LIMIT)
              if (bytes.length > SANDBOX_WRITE_LIMIT || pendingBytes + bytes.length > 2 * SANDBOX_WRITE_LIMIT) throw new Error('SANDBOX_INPUT_BACKPRESSURE')
              pendingBytes += bytes.length
              child.stdin.write(bytes, error => { pendingBytes -= bytes.length; send({ type: 'ack', inputSeq: m.seq, ...(error ? { error: error.message } : {}) }) })
            } else if (m.type === 'end' && exact(m, ['version', 'seq', 'type'])) {
              if (inputEnded) throw new Error('SANDBOX_INPUT_REPLAY')
              inputEnded = true; child.stdin.end(() => send({ type: 'ack', inputSeq: m.seq }))
            } else throw new Error('SANDBOX_REQUEST_UNKNOWN')
          }
        } catch (error) { reject((error as Error).message); return }
      }
      } catch (error) { reject((error as Error).message); socket.destroy() }
    })
    socket.on('error', () => kill(child))
    socket.once('close', () => {
      sockets.delete(socket)
      if (!ended) {
        record({ type: 'connection-lost', handleId, parentExitObserved: !!child && (child.exitCode !== null || child.signalCode !== null) })
        if (opened && !revoked) {
          // Lost observation/control invalidates this entire immutable grant, not just its handle.
          revoked = true
          record({ type: 'grant-revoked', reason: 'OPEN_CONNECTION_LOST', handleId, descendants: 'unknown' })
          for (const owned of children) kill(owned)
          for (const peer of sockets) peer.destroy()
        } else kill(child)
      }
      if (timer) clearTimeout(timer); if (drain) clearTimeout(drain)
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(grant.socketPath, () => { server.off('error', reject); resolve() }) })
  chmodSync(grant.socketPath, 0o600)
  const revoke = async () => {
    if (closing) return
    closing = true; revoked = true; clearTimeout(expiry)
    const owned = [...children]
    for (const child of owned) kill(child)
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (owned.length) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 500)
      void Promise.all(owned.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(done => child.once('exit', () => done())))).then(() => { clearTimeout(timer); resolve() })
    })
    try { unlinkSync(grant.socketPath) } catch { /* Closing a Unix listener may already remove its path. */ }
    record({ type: 'broker-closed', totalLaunches: total, remainingObservedParents: children.size, descendants: 'unknown' })
  }
  const expiry = setTimeout(() => { void revoke() }, Math.max(1, grant.expiresAt - Date.now()))
  return Object.freeze({ address: Object.freeze({ socketPath: grant.socketPath, runId: grant.runId, epoch: grant.epoch }), close: revoke })
}
