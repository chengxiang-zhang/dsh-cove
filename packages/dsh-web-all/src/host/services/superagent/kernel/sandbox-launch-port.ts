import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { PassThrough, Writable, type Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { SandboxFrameDecoder, SandboxEventValidator, decodeSandboxBytes } from './sandbox-wire.ts'
import { parseSandboxPolicy, serializeSandboxPolicy } from './sandbox-policy.ts'

export interface SandboxLaunchRequest {
  profile: string
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
  processPolicy: 'single' | 'children'
  timeoutMs: number
}
export interface SandboxChild extends EventEmitter {
  readonly stdin: Writable
  readonly stdout: PassThrough | Readable
  readonly stderr: PassThrough | Readable
  readonly pid?: number
  readonly mayHaveStarted: boolean
  cancel(): void
  unref(): void
}
export interface SandboxLaunchPort { open(request: SandboxLaunchRequest): SandboxChild }
export interface SandboxBrokerAddress { socketPath: string; runId: string; epoch: number }
// Temporary connection-only diagnostics for the live native transport investigation.
export const NATIVE_CONNECT_LOG = 'error,reqwest::connect=debug,hyper_util::client::legacy::connect=debug,hyper_util::client::legacy::client=trace'
export const SANDBOX_WIRE_LIMIT = 2 * 1024 * 1024
export const SANDBOX_WRITE_LIMIT = 1024 * 1024

/** The default adapter still initializes a real OS sandbox. No nesting detection or fallback. */
export const directSandboxLaunchPort: SandboxLaunchPort = {
  open(request) {
    const profile = serializeSandboxPolicy(parseSandboxPolicy(request.profile))
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, request.executable, ...request.args], { cwd: request.cwd, env: request.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    return Object.assign(child, {
      get mayHaveStarted() { return child.pid !== undefined },
      cancel() { if (child.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* A missing group is not cessation evidence. */ } } },
    }) as unknown as SandboxChild
  },
}

/** This adapter only reaches an explicitly configured, OS-authorized per-run broker. */
export function createExternalSandboxLaunchPort(address: SandboxBrokerAddress): SandboxLaunchPort {
  const config = Object.freeze({ ...address })
  return {
    open(request) {
      const events = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough()
      const socket = connect(config.socketPath)
      const handleId = randomUUID()
      const decoder = new SandboxFrameDecoder(SANDBOX_WIRE_LIMIT), validator = new SandboxEventValidator(handleId)
      let sequence = 0, closed = false, exited = false, pid: number | undefined, mayHaveStarted = false
      const pending = new Map<number, (error?: Error | null) => void>()
      const connecting = new Set<(error: Error) => void>()
      const finish = () => {
        if (closed) return
        closed = true
        const error = new Error('SANDBOX_CONNECTION_CLOSED')
        const inputError = pending.size || connecting.size || !stdin.writableEnded ? error : undefined
        for (const reject of [...connecting]) reject(error)
        connecting.clear()
        for (const done of [...pending.values()]) done(error)
        pending.clear(); stdin.destroy(inputError); stdout.end(); stderr.end(); socket.destroy(); events.emit('close')
      }
      const fail = (message: string) => { if (!closed) events.emit('error', new Error(message)); finish() }
      const send = (message: Record<string, unknown>): number => {
        if (closed || socket.destroyed) throw new Error('SANDBOX_CONNECTION_CLOSED')
        const seq = ++sequence, frame = JSON.stringify({ version: 1, seq, ...message }) + '\n'
        if (Buffer.byteLength(frame) > SANDBOX_WIRE_LIMIT || socket.writableLength + Buffer.byteLength(frame) > 2 * SANDBOX_WIRE_LIMIT) throw new Error('SANDBOX_PROTOCOL_BACKPRESSURE')
        socket.write(frame); return seq
      }
      const stdin = new Writable({ highWaterMark: 65536,
        write(chunk: Buffer, _encoding, done) {
          try {
            if (chunk.length > SANDBOX_WRITE_LIMIT) throw new Error('SANDBOX_INPUT_TOO_LARGE')
            const seq = send({ type: 'write', data: chunk.toString('base64') }); pending.set(seq, done)
          } catch (error) { done(error as Error) }
        },
        final(done) { try { const seq = send({ type: 'end' }); pending.set(seq, done) } catch (error) { done(error as Error) } },
      })
      // Errors are also reported on the process handle. A rejected input is never an ack.
      stdin.on('error', error => { if (!closed) events.emit('error', error) })
      socket.once('connect', () => {
        try { mayHaveStarted = true; send({ type: 'open', runId: config.runId, epoch: config.epoch, handleId, request }) } catch (error) { fail((error as Error).message) }
      })
      // Writes may be issued synchronously by the caller. Queue them until open is sent.
      const originalWrite = stdin._write.bind(stdin), originalFinal = stdin._final!.bind(stdin)
      const afterConnect = (run: () => void, done: (error: Error) => void) => {
        if (closed || socket.destroyed) { done(new Error('SANDBOX_CONNECTION_CLOSED')); return }
        if (!socket.connecting) { run(); return }
        let settled = false
        const reject = (error: Error) => {
          if (settled) return
          settled = true; connecting.delete(reject); socket.off('connect', resume); done(error)
        }
        const resume = () => {
          if (settled) return
          settled = true; connecting.delete(reject)
          if (closed || socket.destroyed) done(new Error('SANDBOX_CONNECTION_CLOSED')); else run()
        }
        connecting.add(reject); socket.once('connect', resume)
      }
      stdin._write = (chunk, encoding, done) => afterConnect(() => originalWrite(chunk, encoding, done), done)
      stdin._final = done => afterConnect(() => originalFinal(done), done)
      socket.on('data', data => {
        try {
        for (const message of decoder.push(data)) {
          if (closed) return
          try {
            validator.accept(message)
            if (message.type === 'spawned') {
              if (!Number.isSafeInteger(message.pid) || Number(message.pid) < 1 || pid !== undefined || message.handleId !== handleId) throw new Error('SANDBOX_PROCESS_IDENTITY')
              pid = Number(message.pid); events.emit('spawn')
            } else if (message.type === 'stdout' || message.type === 'stderr') {
              if (typeof message.data !== 'string' || message.data.length > 131072) throw new Error('SANDBOX_OUTPUT_FRAME')
              const stream = message.type === 'stdout' ? stdout : stderr
              const bytes = decodeSandboxBytes(message.data, 65536)
              if (stream.readableLength + stream.writableLength + bytes.length > SANDBOX_WIRE_LIMIT) throw new Error('SANDBOX_OUTPUT_BACKPRESSURE')
              stream.write(bytes)
            } else if (message.type === 'ack') {
              const done = pending.get(Number(message.inputSeq)); if (!done) throw new Error('SANDBOX_ACK_REPLAY')
              pending.delete(Number(message.inputSeq)); done(message.error ? new Error(String(message.error)) : undefined)
            } else if (message.type === 'exit') { exited = true; events.emit('exit', message.code, message.signal) }
            else if (message.type === 'refused') { mayHaveStarted = false; fail(String(message.reason)) }
            else if (message.type === 'error') events.emit('error', new Error(String(message.reason)))
            else if (message.type === 'observation-end') { if (!message.complete) events.emit('error', new Error('SANDBOX_OBSERVATION_INCOMPLETE')); finish() }
            else throw new Error('SANDBOX_EVENT_UNKNOWN')
          } catch (error) { fail((error as Error).message); return }
        }
        } catch (error) { fail((error as Error).message) }
      })
      socket.once('error', error => fail(error.message))
      socket.once('close', () => { if (!closed) fail('SANDBOX_CONNECTION_LOST') })
      const handle = Object.assign(events, {
        stdin, stdout, stderr,
        cancel() { if (closed || exited) return; try { send({ type: 'cancel' }) } catch (error) { fail((error as Error).message) } },
        // A live control channel must outlast the caller's bounded observation.
        // Unref before observation-end lets a worker exit look like grant-wide loss.
        unref() { if (closed) socket.unref() },
      })
      Object.defineProperties(handle, { pid: { get: () => pid }, mayHaveStarted: { get: () => mayHaveStarted } })
      return handle as SandboxChild
    },
  }
}

/** Fixed repository mechanism fixture. Paths are data, never Perl source. */
export const detachedFixtureProgram = "if (fork() == 0) { POSIX::setsid(); open(my $p, '>', $ARGV[0]) or die $!; print $p $$; close $p; select(undef,undef,undef,1.5); exit 0; } exit 0;"
export const detachedFixtureArgs = (cwd: string): string[] => ['-MPOSIX', '-e', detachedFixtureProgram, '--', join(cwd, 'detached-pid')]
/** Translate only the existing repository fixture in explicit QA transport; host admission accepts the fixed form only. */
export function normalizeDetachedFixture(request: SandboxLaunchRequest): SandboxLaunchRequest {
  if (JSON.stringify(request.args) === JSON.stringify(detachedFixtureArgs(request.cwd))) return request
  if (/[\\'\r\n]/.test(request.cwd)) throw new Error('SANDBOX_QA_DETACHED_SHAPE')
  const old = detachedFixtureProgram.replace('$ARGV[0]', "'" + join(request.cwd, 'detached-pid') + "'")
  if (JSON.stringify(request.args) !== JSON.stringify(['-MPOSIX', '-e', old])) throw new Error('SANDBOX_QA_DETACHED_SHAPE')
  return { ...request, args: detachedFixtureArgs(request.cwd) }
}
/** Explicit QA transport; lack of capability never triggers an unsandboxed retry. */
export function configuredSandboxLaunchPort(): SandboxLaunchPort {
  const raw = process.env.DSH_QA_SANDBOX_BROKER
  if (!raw) return directSandboxLaunchPort
  const value = JSON.parse(raw) as SandboxBrokerAddress
  if (Object.keys(value).sort().join(',') !== 'epoch,runId,socketPath' || typeof value.socketPath !== 'string' || typeof value.runId !== 'string' || !Number.isSafeInteger(value.epoch)) throw new Error('SANDBOX_QA_ADDRESS')
  const base = createExternalSandboxLaunchPort(value), routes = process.env.DSH_QA_SANDBOX_ROUTES ? JSON.parse(process.env.DSH_QA_SANDBOX_ROUTES) as Record<string, SandboxBrokerAddress> : undefined
  if (!routes) return base
  if (Object.keys(routes).sort().join(',') !== 'detached-cancel,detached-timeout') throw new Error('SANDBOX_QA_ROUTES')
  for (const address of Object.values(routes)) if (!address || Object.keys(address).sort().join(',') !== 'epoch,runId,socketPath' || typeof address.socketPath !== 'string' || typeof address.runId !== 'string' || !Number.isSafeInteger(address.epoch)) throw new Error('SANDBOX_QA_ROUTES')
  return { open(request) {
    if (request.executable === '/usr/bin/perl' && request.args[0] === '-MPOSIX' && [100, 2000].includes(request.timeoutMs)) return createExternalSandboxLaunchPort(routes[request.timeoutMs === 100 ? 'detached-timeout' : 'detached-cancel']!).open(normalizeDetachedFixture(request))
    return base.open(request)
  } }
}
export function sandboxFixtureProfile(profile: string): string {
  const extra = process.env.DSH_QA_SANDBOX_PROFILE
  if (!process.env.DSH_QA_SANDBOX_BROKER) { if (extra) throw new Error('SANDBOX_QA_PROFILE_WITHOUT_PORT'); return profile }
  const combined = profile + '\n' + (extra ?? '')
  parseSandboxPolicy(combined)
  return combined
}
