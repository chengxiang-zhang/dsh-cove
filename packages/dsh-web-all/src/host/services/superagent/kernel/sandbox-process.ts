import { dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { configuredSandboxLaunchPort, sandboxFixtureProfile } from './sandbox-launch-port.ts'
import { existsSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ActionReceipt, ExecutionEnvelope } from './actions.ts'
import type { Ref } from '../protocol/managed-work.ts'
export interface SandboxProcess<Result> {
  readonly closed: Promise<Result>
  onLine(listener: (line: string) => void): () => void
  writeLine(operation: Ref, line: string): Promise<void>
}
/** Host-only stdio handle. Every frame must be durably admitted before touching stdin. */
export function openSandboxProcess<Result>(
  e: ExecutionEnvelope,
  signal: AbortSignal,
  liveFence: () => boolean,
  admitFrame: (ref: Ref, line: string) => void,
  reconcile: (receipt: ActionReceipt) => Result
): SandboxProcess<Result> {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))
    throw new Error('SANDBOX_UNSUPPORTED')
  const root = realpathSync(e.workspace.root),
    executable = realpathSync(e.spec.executable)
  if (root !== e.workspace.root || signal.aborted || e.expiresAt <= Date.now() || !liveFence())
    throw new Error('EXECUTION_FENCED')
  const child = configuredSandboxLaunchPort().open(sandboxProcessLaunchParameters(e))
  const MAX_FRAME_BYTES = 1048576,
    MAX_PENDING_FRAMES = 4,
    MAX_PENDING_BYTES = 2 * (MAX_FRAME_BYTES + 1)
  let pendingBytes = 0
  const writes = new Set<(error?: Error) => void>()
  const decoder = new StringDecoder('utf8')
  const listeners = new Set<(line: string) => void>()
  let buffer = '',
    stderr = '',
    ended = false,
    exited = false,
    code: number | null = null,
    reason = ''
  let drain: ReturnType<typeof setTimeout> | undefined
  let resolve!: (result: Result) => void, reject!: (error: unknown) => void
  const closed = new Promise<Result>((yes, no) => {
    resolve = yes
    reject = no
  })
  const kill = () => child.cancel()
  const finish = () => {
    if (ended) return
    ended = true
    clearInterval(monitor)
    clearTimeout(timeout)
    if (drain) clearTimeout(drain)
    signal.removeEventListener('abort', abort)
    for (const settle of [...writes]) settle(new Error('STDIN_CLOSED'))
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    child.unref()
    listeners.clear()
    const stopped = exited && e.spec.processPolicy === 'single'
    try {
      resolve(
        reconcile({
          status: stopped ? (code === 0 && !reason ? 'confirmed' : 'failed') : 'unknown',
          stopped,
          evidenceRefs: [`process:${child.pid}:${randomUUID()}`],
          ...(code === null ? {} : { exitCode: code }),
          ...(reason ? { reason } : {}),
          observation: { stdout: '', stderr, observedAt: Date.now() }
        })
      )
    } catch (error) {
      reject(error)
    }
  }
  const boundedDrain = () => {
    if (!drain) drain = setTimeout(finish, 200)
  }
  const stop = (why: string) => {
    if (ended) return
    reason ||= why
    kill()
    boundedDrain()
  }
  const abort = () => stop('CONTROL_REVOKED')
  signal.addEventListener('abort', abort, { once: true })
  const monitor = setInterval(() => {
    try {
      if (!liveFence()) stop('LIVE_FENCE_REVOKED')
    } catch {
      stop('LEDGER_UNAVAILABLE')
    }
  }, 25)
  const timeout = setTimeout(
    () => stop('TIMEOUT'),
    Math.min(e.spec.timeoutMs, Math.max(1, e.expiresAt - Date.now()))
  )
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk)
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        stop('JSONL_FRAME_TOO_LARGE')
        return
      }
      for (const listener of listeners)
        try {
          listener(line)
        } catch {
          stop('JSONL_LISTENER_FAILED')
        }
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) stop('JSONL_FRAME_TOO_LARGE')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-65536)
  })
  child.on('error', (error) => {
    reason = error.message
    boundedDrain()
  })
  child.once('exit', (exitCode) => {
    exited = true
    code = exitCode
    if (ended) {
      // The owned handle can report exit after the bounded drain recorded unknown.
      // This is same-execution evidence, never a PID lookup or children-domain proof.
      if (e.spec.processPolicy === 'single') {
        try { reconcile({ status: code === 0 && !reason ? 'confirmed' : 'failed', stopped: true, evidenceRefs: [`process:${child.pid}:${randomUUID()}`], ...(code === null ? {} : { exitCode: code }), ...(reason ? { reason } : {}), observation: { stdout: '', stderr, observedAt: Date.now() } }) } catch { /* A closed ledger retains unknown; do not claim a persisted reconciliation. */ }
      }
      return
    }
    kill()
    boundedDrain()
  })
  child.once('close', finish)
  // stdin failures surface through write callbacks; never allow an unhandled EPIPE.
  child.stdin.on('error', () => stop('STDIN_CLOSED'))
  return Object.freeze({
    closed,
    onLine(listener: (line: string) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async writeLine(ref: Ref, line: string) {
      if (ended || signal.aborted || !liveFence()) throw new Error('EXECUTION_FENCED')
      const bytes = Buffer.byteLength(line) + 1
      if (line.includes('\n') || bytes - 1 > MAX_FRAME_BYTES) throw new Error('INVALID_JSONL_FRAME')
      if (writes.size >= MAX_PENDING_FRAMES || pendingBytes + bytes > MAX_PENDING_BYTES)
        throw new Error('STDIN_BACKPRESSURE')
      // No wait queue: reserve memory synchronously before the durable frame admission.
      pendingBytes += bytes
      await new Promise<void>((yes, no) => {
        let settled = false,
          timer: ReturnType<typeof setTimeout> | undefined
        const settle = (error?: Error) => {
          if (settled) return
          settled = true
          pendingBytes -= bytes
          writes.delete(settle)
          if (timer) clearTimeout(timer)
          if (error) no(error)
          else yes()
        }
        writes.add(settle)
        try {
          admitFrame(ref, line)
        } catch (error) {
          settle(error as Error)
          return
        }
        timer = setTimeout(
          () => {
            settle(new Error('STDIN_WRITE_TIMEOUT'))
            stop('STDIN_WRITE_TIMEOUT')
          },
          Math.min(5000, e.spec.timeoutMs)
        )
        // Keep payload and delimiter in separate bounded wire writes, queued atomically.
        let remaining = 2
        const acknowledge = (error?: Error | null) => { if (error) settle(error); else if (--remaining === 0) settle() }
        child.stdin.write(Buffer.from(line), acknowledge)
        child.stdin.write('\n', acknowledge)
      })
    }
  })
}

export function sandboxProcessLaunchParameters(e: Pick<ExecutionEnvelope, 'nativeRuntime'> & { workspace: Pick<ExecutionEnvelope['workspace'], 'root'>; spec: Pick<ExecutionEnvelope['spec'], 'executable' | 'args' | 'processPolicy' | 'timeoutMs'> }) {
  const root = realpathSync(e.workspace.root), executable = realpathSync(e.spec.executable)
  const literal = JSON.stringify
  const runtime = e.nativeRuntime
  if (runtime && realpathSync(runtime.root) !== runtime.root) throw new Error('NATIVE_RUNTIME_IDENTITY')
  const ancestors = new Set<string>()
  if (runtime)
    for (const leaf of [runtime.root, root, executable, ...(runtime.readonlyRuntimeRoots ?? [])]) {
      let parent = dirname(leaf)
      while (parent !== '/') {
        ancestors.add(parent)
        parent = dirname(parent)
      }
    }
  const metadata = runtime
    ? `(allow file-read-metadata (literal \"/var\") (literal \"/etc\") (literal \"/tmp\") ${[...ancestors].map((path) => `(literal ${literal(path)})`).join(' ')})`
    : ''
  const loopback = runtime?.loopbackServer
    ? '(allow network-bind (local ip \"localhost:*\"))(allow network-inbound (local ip \"localhost:*\"))'
    : ''
  const runtimeReads = runtime?.readonlyRuntimeRoots?.length
    ? `(allow file-read* ${runtime.readonlyRuntimeRoots.map((path) => `(subpath ${literal(path)})`).join(' ')})`
    : ''
  const runtimeProfile = runtime
    ? `(allow file-read* file-write* (subpath ${literal(runtime.root)}))(allow network-outbound)(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))(allow file-read* (literal "/Library/Preferences/com.apple.networkd.plist") (literal "/Library/Preferences/com.apple.security.plist") (literal "/Library/Preferences/.GlobalPreferences.plist"))(allow mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.networkd") (global-name "com.apple.dnssd.service") (global-name \"com.apple.system.opendirectoryd.libinfo\") (global-name \"com.apple.trustd.agent\") (global-name "com.apple.trustd") (global-name \"com.apple.SystemConfiguration.configd\"))`
    : ''
  const profile = `(version 1)(deny default)(allow process-exec process-info*)${e.spec.processPolicy === 'children' ? '(allow process-fork)' : ''}(allow sysctl-read)(allow mach-lookup (global-name "com.apple.system.logger"))(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/private/etc") (subpath "/sbin") (subpath "/System") (subpath "/Library/Apple") (subpath "/opt/homebrew") (subpath "/private/var/db") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (subpath ${literal(root)}) (literal ${literal(executable)}))(allow file-write* (subpath ${literal(root)}) (literal "/dev/null"))${runtimeProfile}${metadata}${runtimeReads}${loopback}`
  return {
    profile: sandboxFixtureProfile(profile), executable, args: e.spec.args, cwd: root,
    env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'en_US.UTF-8', ...(runtime ? { [runtime.stateDirectoryVariable]: runtime.root } : {}) },
    processPolicy: e.spec.processPolicy, timeoutMs: e.spec.timeoutMs,
  }
}
