import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const load = () => import('../src/host/services/superagent/kernel/sandbox-launch-port.ts').catch(() => null)
const context = (scope?: string) => {
  const raw = process.env.DSH_VERIFICATION_BROKER
  if (!raw) throw new Error('EXPLICIT_ISOLATED_BROKER_REQUIRED')
  const value = JSON.parse(raw)
  return { ...value, ...(scope ? value.scopes[scope] : {}) } as { socketPath: string; runId: string; epoch: number; root: string; collector: string }
}
const profile = (root: string, fork = false) => `(version 1)(deny default)(allow process-exec process-info*)${fork ? '(allow process-fork)' : ''}(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath ${JSON.stringify(root)}))(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))`
async function run(readRoot: string, args: string[], input?: Buffer) {
  const api = await load(); expect(api, 'a real explicit broker launch port is required').not.toBeNull()
  const c = context(), port = api!.createExternalSandboxLaunchPort(c)
  const p = port.open({ profile: profile(readRoot), executable: '/bin/bash', args, cwd: c.root, env: { PATH: '/usr/bin:/bin', HOME: c.root, TMPDIR: c.root, LANG: 'en_US.UTF-8' }, processPolicy: 'single', timeoutMs: 3000 })
  const out: Buffer[] = [], err: Buffer[] = []; let code: number | null = null, reason = ''
  p.stdout.on('data', chunk => out.push(chunk)); p.stderr.on('data', chunk => err.push(chunk))
  p.on('error', error => { reason = error.message }); p.on('exit', value => { code = value })
  const closed = new Promise<void>(resolve => p.on('close', resolve))
  if (input) p.stdin.end(input); else p.stdin.end()
  await closed
  return { stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), code, reason, mayHaveStarted: p.mayHaveStarted }
}
it('preserves bad inner sensitivity while always protecting the independent collector', async () => {
  const api = await load(); expect(api).not.toBeNull()
  const c = context(), inner = join(c.root, 'inner'), canary = join(c.root, 'inner-negative')
  const args = ['-c', 'for p in "$1" "$2"; do if [ -r "$p" ]; then IFS= read -r value < "$p"; printf "%s" "$value"; else printf denied; fi; printf "\\n"; done', 'probe', canary, c.collector]
  expect(await run(inner, args)).toMatchObject({ stdout: 'denied\ndenied\n', code: 0, reason: '' })
  expect(await run(c.root, args)).toMatchObject({ stdout: 'INNER-CANARY\ndenied\n', code: 0, reason: '' })
})
it('round trips native bytes through broker pipes with separate stdout and stderr', async () => {
  const api = await load(); expect(api).not.toBeNull()
  const c = context(), payload = Buffer.from(('A'.repeat(65535) + '\n').repeat(16))
  // Shell builtins keep this a single native process, without asserting descendant cessation.
  const result = await run(c.root, ['-c', 'while IFS= read -r line; do printf "%s\\n" "$line"; printf "%s\\n" "$line" >&2; done'], payload)
  expect(result.code).toBe(0); expect(result.reason).toBe('')
  expect(Buffer.byteLength(result.stdout)).toBe(1024 * 1024); expect(result.stdout === payload.toString()).toBe(true); expect(result.stderr === result.stdout).toBe(true)
})
it('rejects unknown profile syntax before invoking the host compiler', async () => {
  const api = await load(); expect(api).not.toBeNull()
  const c = context(), p = api!.createExternalSandboxLaunchPort(c).open({ profile: '(version 1)(deny default)(import "/tmp/untrusted")', executable: '/bin/bash', args: [], cwd: c.root, env: { PATH: '/usr/bin:/bin', HOME: c.root, TMPDIR: c.root, LANG: 'en_US.UTF-8' }, processPolicy: 'single', timeoutMs: 1000 })
  const errors: string[] = []; p.on('error', e => errors.push(e.message)); await new Promise<void>(resolve => p.on('close', resolve))
  expect(errors).toContain('SANDBOX_POLICY_UNSUPPORTED'); expect(p.mayHaveStarted).toBe(false)
  expect(readFileSync(join(c.root, 'inner-negative'), 'utf8')).toBe('INNER-CANARY')
})

it('preserves multibyte argv split inside a UTF-8 code point on the real wire', async () => {
  const { connect } = await import('node:net'), { randomUUID } = await import('node:crypto')
  const c = context(), socket = connect(c.socketPath), messages: Record<string, unknown>[] = []
  let buffered = ''
  socket.on('data', b => { buffered += b.toString(); let n: number; while ((n = buffered.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffered.slice(0, n))); buffered = buffered.slice(n + 1) } })
  await new Promise<void>(resolve => socket.once('connect', resolve))
  const frame = Buffer.from(JSON.stringify({ version: 1, seq: 1, type: 'open', ...{ runId: c.runId, epoch: c.epoch }, handleId: randomUUID(), request: { profile: profile(c.root), executable: '/bin/bash', args: ['-c', 'printf "%s" "$1"', 'fixture', '中文'], cwd: c.root, env: { PATH: '/usr/bin:/bin', HOME: c.root, TMPDIR: c.root, LANG: 'en_US.UTF-8' }, processPolicy: 'single', timeoutMs: 2000 } }) + '\n')
  const split = frame.indexOf(Buffer.from('中')) + 1
  socket.write(frame.subarray(0, split)); await new Promise(resolve => setTimeout(resolve, 30)); socket.write(frame.subarray(split))
  await new Promise<void>(resolve => socket.once('close', resolve))
  expect(Buffer.concat(messages.filter(m => m.type === 'stdout').map(m => Buffer.from(String(m.data), 'base64'))).toString()).toBe('中文')
})
it('cancels a blocked input without claiming that the cancelled input was consumed', async () => {
  const api = await load(); expect(api).not.toBeNull(); const c = context()
  const p = api!.createExternalSandboxLaunchPort(c).open({ profile: profile(c.root), executable: '/bin/bash', args: ['-c', 'printf ready; while :; do :; done'], cwd: c.root, env: { PATH: '/usr/bin:/bin', HOME: c.root, TMPDIR: c.root, LANG: 'en_US.UTF-8' }, processPolicy: 'single', timeoutMs: 3000 })
  const errors: string[] = []; p.on('error', e => errors.push(e.message))
  await new Promise(resolve => p.stdout.once('data', resolve))
  let acked = false, rejected = false
  p.stdin.write(Buffer.alloc(1024 * 1024, 65), error => { if (error) rejected = true; else acked = true })
  await new Promise(resolve => setTimeout(resolve, 30)); expect(acked).toBe(false)
  const exited = new Promise(resolve => p.once('exit', (code, signal) => resolve({ code, signal }))), closed = new Promise(resolve => p.once('close', resolve))
  const start = Date.now(); p.cancel(); expect(await exited).toEqual({ code: null, signal: 'SIGKILL' }); await closed
  expect(Date.now() - start).toBeLessThan(1000); expect(acked).toBe(false); expect(rejected).toBe(true)
})

it('refuses malformed UTF-8 before launch and keeps the command side effect absent', async () => {
  const { connect } = await import('node:net'), { randomUUID } = await import('node:crypto'), { existsSync } = await import('node:fs')
  const c = context(), marker = join(c.root, 'invalid-wire-marker'), socket = connect(c.socketPath)
  const messages: Record<string, unknown>[] = []; let buffer = ''
  socket.on('data', b => { buffer += b; let n: number; while ((n = buffer.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffer.slice(0, n))); buffer = buffer.slice(n + 1) } })
  await new Promise<void>(resolve => socket.once('connect', resolve))
  const data = Buffer.from(JSON.stringify({ version: 1, seq: 1, type: 'open', runId: c.runId, epoch: c.epoch, handleId: randomUUID(), request: { profile: profile(c.root), executable: '/bin/bash', args: ['-c', 'printf changed > "$1" #INVALIDBYTE', 'fixture', marker], cwd: c.root, env: { PATH: '/usr/bin:/bin', HOME: c.root, TMPDIR: c.root, LANG: 'en_US.UTF-8' }, processPolicy: 'single', timeoutMs: 2000 } }) + '\n')
  data[data.indexOf(Buffer.from('INVALIDBYTE'))] = 255
  socket.write(data); await new Promise<void>(resolve => socket.once('close', resolve))
  expect(messages.some(m => m.type === 'spawned')).toBe(false); expect(existsSync(marker)).toBe(false)
})
it('does not accept an old epoch or candidate-requested credential environment', async () => {
  const api = await load(); expect(api).not.toBeNull(); const c = context()
  for (const mode of ['epoch', 'credentials', 'log-trace', 'log-without-native']) {
    const p = api!.createExternalSandboxLaunchPort({ ...c, epoch: mode === 'epoch' ? c.epoch - 1 : c.epoch }).open({ profile: profile(c.root), executable: '/bin/bash', args: ['-c', 'printf unsafe'], cwd: c.root, env: { PATH: '/usr/bin:/bin', HOME: c.root, TMPDIR: c.root, LANG: 'en_US.UTF-8', ...(mode === 'credentials' ? { AWS_SECRET_ACCESS_KEY: 'candidate' } : mode === 'log-trace' ? { CODEX_HOME: c.root, RUST_LOG: 'trace' } : mode === 'log-without-native' ? { RUST_LOG: 'error' } : {}) }, processPolicy: 'single', timeoutMs: 1000 })
    const errors: string[] = []; p.on('error', e => errors.push(e.message)); await new Promise<void>(resolve => p.once('close', resolve))
    expect(p.mayHaveStarted).toBe(false); expect(errors).toContain(mode === 'epoch' ? 'SANDBOX_OPEN_FENCED' : 'SANDBOX_ENV_SCHEMA')
  }
})
it('records real nested direct sandbox failure instead of silently running without isolation', async () => {
  const api = await load(); expect(api).not.toBeNull(); const c = context()
  const p = api!.directSandboxLaunchPort.open({ profile: profile(c.root), executable: '/bin/bash', args: ['-c', 'printf should-not-run'], cwd: c.root, env: { PATH: '/usr/bin:/bin', HOME: c.root, TMPDIR: c.root, LANG: 'en_US.UTF-8' }, processPolicy: 'single', timeoutMs: 1000 })
  const output: Buffer[] = []; p.stdout.on('data', b => output.push(b)); let code: number | null = null
  p.on('error', () => {}); p.once('exit', value => { code = value }); await new Promise<void>(resolve => p.once('close', resolve))
  expect(code).toBe(71); expect(Buffer.concat(output).length).toBe(0)
})

it('rejects duplicate open identity and records a disconnected parent separately from caller success', async () => {
  const { connect } = await import('node:net'), { randomUUID } = await import('node:crypto')
  const c = context('legacy-disconnect'), handleId = randomUUID()
  const open = { version: 1, seq: 1, type: 'open', runId: c.runId, epoch: c.epoch, handleId, request: { profile: profile(c.root), executable: '/bin/bash', args: ['-c', 'printf disconnect-ready; read value'], cwd: c.root, env: { PATH: '/usr/bin:/bin', HOME: c.root, TMPDIR: c.root, LANG: 'en_US.UTF-8' }, processPolicy: 'single', timeoutMs: 2000 } }
  const socket = connect(c.socketPath); let buffer = '', sawExit = false
  const ready = new Promise<void>(resolve => socket.on('data', bytes => { buffer += bytes; let n: number; while ((n = buffer.indexOf('\n')) >= 0) { const m = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1); if (m.type === 'stdout') resolve(); if (m.type === 'exit') sawExit = true } }))
  await new Promise<void>(resolve => socket.once('connect', resolve)); socket.write(JSON.stringify(open) + '\n'); await ready
  const replay = connect(c.socketPath); let raw = ''; replay.on('data', b => { raw += b })
  await new Promise<void>(resolve => replay.once('connect', resolve)); replay.write(JSON.stringify(open) + '\n'); await new Promise<void>(resolve => replay.once('close', resolve))
  expect(raw).toContain('SANDBOX_OPEN_LIMIT_OR_REPLAY')
  socket.destroy(); await new Promise<void>(resolve => socket.once('close', resolve)); expect(sawExit).toBe(false)
})

it('bounds silent pre-open connections and concurrent live launches', async () => {
  const { connect } = await import('node:net'), api = await load(); expect(api).not.toBeNull(); const c = context()
  const idle = connect(c.socketPath); idle.on('error', () => {}); idle.resume()
  const idleClosed = new Promise<boolean>(resolve => idle.once('close', () => resolve(true)))
  expect(await Promise.race([idleClosed, new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1500))])).toBe(true)
  const live: { p: import('../src/host/services/superagent/kernel/sandbox-launch-port.ts').SandboxChild; closed: Promise<void> }[] = []
  try {
    for (let i = 0; i < 8; i++) {
      const p = api!.createExternalSandboxLaunchPort(c).open({ profile: profile(c.root), executable: '/bin/bash', args: ['-c', 'printf ready; read value'], cwd: c.root, env: { PATH: '/usr/bin:/bin', HOME: c.root, TMPDIR: c.root, LANG: 'en_US.UTF-8' }, processPolicy: 'single', timeoutMs: 3000 })
      p.on('error', () => {}); live.push({ p, closed: new Promise<void>(resolve => p.once('close', resolve)) }); await new Promise(resolve => p.stdout.once('data', resolve))
    }
    const overflow = await run(c.root, ['-c', 'printf should-not-run'])
    expect(overflow).toMatchObject({ mayHaveStarted: false, reason: 'SANDBOX_OPEN_LIMIT_OR_REPLAY', stdout: '' })
  } finally { idle.destroy(); for (const { p } of live) p.cancel(); await Promise.all(live.map(x => x.closed)) }
})
it('requires a host-registered launch even when an executable lies inside the maximum domain', async () => {
  const c = context(), result = await run(c.root, ['-c', 'printf unregistered'])
  expect(result).toMatchObject({ stdout: '', mayHaveStarted: false, reason: 'SANDBOX_REGISTERED_LAUNCH_REQUIRED' })
})
it('does not launch when the trusted collector cannot persist admission', async () => {
  const api = await load(); expect(api).not.toBeNull(); const c = context('collector-fault')
  const p = api!.createExternalSandboxLaunchPort(c).open({ profile: profile(c.root), executable: '/bin/bash', args: ['-c', 'printf collector-fault'], cwd: c.root, env: { PATH: '/usr/bin:/bin', HOME: c.root, TMPDIR: c.root, LANG: 'en_US.UTF-8' }, processPolicy: 'single', timeoutMs: 1000 })
  p.on('error', () => {}); await new Promise<void>(resolve => p.once('close', resolve))
  expect(p.pid).toBeUndefined()
})
