import { configuredSandboxLaunchPort, sandboxFixtureProfile } from './sandbox-launch-port.ts'
import { realpathSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ExecutionEnvelope, ActionReceipt } from './actions.ts'
export interface SandboxResult { receipt: ActionReceipt; stdout: string; stderr: string }
const literal = (s: string) => JSON.stringify(s)
/** An OS sandbox is inherited by children. No caller-supplied profile, env or bypass. */
export async function runSandbox(e: ExecutionEnvelope, signal: AbortSignal, liveFence: () => boolean): Promise<SandboxResult> {
 const failure = (reason: string): SandboxResult => ({ receipt: { status: 'failed', stopped: true, evidenceRefs: [`sandbox:${randomUUID()}`], reason }, stdout: '', stderr: '' })
 if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return failure('SANDBOX_UNSUPPORTED')
 let root: string, executable: string
 try { root = realpathSync(e.workspace.root); executable = realpathSync(e.spec.executable) } catch { return failure('EXECUTION_PATH_MISSING') }
 if (root !== e.workspace.root || signal.aborted || e.expiresAt <= Date.now() || !liveFence()) return failure('EXECUTION_FENCED')
 // Candidate execution has no QA/collector write roots or inherited credentials. Network remains denied.
 const profile = `(version 1)(deny default)(allow process-exec process-info*)${e.spec.processPolicy === 'children' ? '(allow process-fork)' : ''}(allow sysctl-read)(allow mach-lookup (global-name "com.apple.system.logger"))(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/private/etc") (subpath "/sbin") (subpath "/System") (subpath "/Library/Apple") (subpath "/opt/homebrew") (subpath "/private/var/db") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (subpath ${literal(root)}) (literal ${literal(executable)}))(allow file-write* (subpath ${literal(root)}) (literal "/dev/null"))`
 return await new Promise(resolve => {
  const child = configuredSandboxLaunchPort().open({ profile: sandboxFixtureProfile(profile), executable, args: e.spec.args, cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'en_US.UTF-8' }, processPolicy: e.spec.processPolicy, timeoutMs: e.spec.timeoutMs })
  child.stdin.end()
  let stdout = '', stderr = '', reason = '', finished = false
  let parentExited = false, exitCode: number | null = null, exitSignal: string | null = null
  let drain: ReturnType<typeof setTimeout> | undefined
  const killGroup = () => child.cancel()
  const receipt = (): ActionReceipt => ({
   status: e.spec.processPolicy === 'children' || !parentExited ? 'unknown' : exitCode === 0 && !reason ? 'confirmed' : 'failed',
   stopped: parentExited && e.spec.processPolicy === 'single', evidenceRefs: [`process:${child.pid}:${randomUUID()}`],
   ...(exitCode === null ? {} : { exitCode }), ...(reason || exitSignal ? { reason: reason || String(exitSignal) } : {}),
  })
  // Exit observes the owned parent. Close additionally waits on inherited pipes, which
  // detached descendants can hold indefinitely. Never use pipe closure as stop evidence.
  const boundedDrain = () => { if (!drain && !finished) drain = setTimeout(() => { reason ||= 'OUTPUT_DRAIN_TIMEOUT'; done(receipt()) },200) }
  const stop = (why: string) => { if (finished) return; reason ||= why; killGroup(); boundedDrain() }
  const aborted = () => stop('CONTROL_REVOKED'); signal.addEventListener('abort',aborted,{ once: true })
  const timeout = setTimeout(() => stop('TIMEOUT'),Math.min(e.spec.timeoutMs,Math.max(1,e.expiresAt - Date.now())))
  const monitor = setInterval(() => { try { if (!liveFence()) stop('LIVE_FENCE_REVOKED') } catch { stop('LEDGER_UNAVAILABLE') } },25)
  const cap = (old: string, chunk: Buffer) => (old + chunk.toString()).slice(-65536)
  const out = (chunk: Buffer) => { stdout = cap(stdout,chunk) }, err = (chunk: Buffer) => { stderr = cap(stderr,chunk) }
  child.stdout.on('data',out); child.stderr.on('data',err)
  const done = (result: ActionReceipt) => {
   if (finished) return; finished = true
   clearTimeout(timeout); clearInterval(monitor); if (drain) clearTimeout(drain)
   signal.removeEventListener('abort',aborted)
   child.removeListener('exit',onExit); child.removeListener('close',onClose)
   child.stdout.removeListener('data',out); child.stderr.removeListener('data',err)
   // Releasing local read ends bounds our observation, not the remote writer's life.
   child.stdout.destroy(); child.stderr.destroy(); child.unref()
   resolve({ receipt: result, stdout, stderr })
  }
  const onExit = (code: number | null, signal: string | null) => { parentExited = true; exitCode = code; exitSignal = signal; killGroup(); boundedDrain() }
  const onClose = () => done(receipt())
  child.on('error', error => {
   reason ||= error.message
   done({ status: child.mayHaveStarted ? 'unknown' : 'failed', stopped: !child.mayHaveStarted, evidenceRefs: [`spawn:${randomUUID()}`], reason })
  })
  child.once('exit',onExit); child.once('close',onClose)
 })
}
