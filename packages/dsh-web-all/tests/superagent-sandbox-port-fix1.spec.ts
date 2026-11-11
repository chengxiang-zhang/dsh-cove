import { expect, it } from 'vitest'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createExternalSandboxLaunchPort, SANDBOX_WIRE_LIMIT, type SandboxLaunchRequest } from '../src/host/services/superagent/kernel/sandbox-launch-port.ts'
const config = () => JSON.parse(process.env.DSH_VERIFICATION_BROKER ?? 'null') as {
  root: string; node: string; missingSocket: string; outputFixture: string
  scopes: Record<string, { socketPath: string; runId: string; epoch: number }>
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const request = (script = 'printf ready; read value'): SandboxLaunchRequest => {
  const c = config()
  return { profile: `(version 1)(deny default)(allow process-exec sysctl-read)(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath ${JSON.stringify(dirname(dirname(c.node)))}) (subpath ${JSON.stringify(c.root)}))(allow file-write* (subpath ${JSON.stringify(c.root)}) (literal "/dev/null"))`, executable: '/bin/bash', args: ['-c', script, 'fixture', 'reopened'], cwd: c.root, env: { PATH: '/usr/bin:/bin', HOME: c.root, TMPDIR: c.root, LANG: 'en_US.UTF-8' }, processPolicy: 'single', timeoutMs: 4000 }
}
it('R1 revokes the entire opened grant on disconnect and requires a trusted new generation', async () => {
  const c = config(), address = c.scopes.r1, port = createExternalSandboxLaunchPort(address)
  // A normal observation-end must leave the grant usable.
  const normal = port.open(request('printf "%s" "$1"')); normal.on('error', () => {}); normal.stdout.resume(); normal.stderr.resume()
  let normalExit: number | null = null; normal.once('exit', code => { normalExit = code }); await new Promise(resolve => normal.once('close', resolve)); expect(normalExit).toBe(0)
  const sibling = port.open(request()); const siblingErrors: string[] = []; sibling.on('error', e => siblingErrors.push(e.message)); sibling.stderr.resume()
  const siblingClosed = new Promise<boolean>(resolve => sibling.once('close', () => resolve(true)))
  await new Promise(resolve => sibling.stdout.once('data', resolve))
  const socket = connect(address.socketPath); socket.on('error', () => {}); let buffer = ''
  const ready = new Promise<void>(resolve => socket.on('data', b => { buffer += b; if (buffer.includes('stdout')) resolve() }))
  await new Promise(resolve => socket.once('connect', resolve)); socket.write(JSON.stringify({ version: 1, seq: 1, type: 'open', ...{ runId: address.runId, epoch: address.epoch }, handleId: randomUUID(), request: request() }) + '\n'); await ready
  socket.destroy(); await wait(100)
  const after = port.open(request('printf "%s" "$1"')); let output = '', spawned = false; const errors: string[] = []
  after.on('error', e => errors.push(e.message)); after.once('spawn', () => { spawned = true }); after.stdout.on('data', b => { output += b }); after.stderr.resume(); await new Promise(resolve => after.once('close', resolve))
  const siblingStoppedObserving = await Promise.race([siblingClosed, wait(100).then(() => false)])
  try { expect({ spawned, output }).toEqual({ spawned: false, output: '' }); expect(errors).toContain('SANDBOX_GRANT_REVOKED'); expect(after.mayHaveStarted).toBe(false); expect(siblingStoppedObserving).toBe(true); expect(siblingErrors.length).toBeGreaterThan(0) }
  finally { sibling.cancel(); await siblingClosed }
  const recovered = createExternalSandboxLaunchPort(c.scopes['r1-recovered']).open(request('printf "%s" "$1"')); const recoveryErrors: string[] = []; let exit: number | null = null, recoveryOutput = ''
  recovered.on('error', e => recoveryErrors.push(e.message)); recovered.stdout.on('data', b => { recoveryOutput += b }); recovered.stderr.resume(); recovered.once('exit', code => { exit = code }); await new Promise(resolve => recovered.once('close', resolve))
  expect(recoveryErrors).toEqual([]); expect(exit).toBe(0); expect(recoveryOutput).toBe('reopened')
  console.log(JSON.stringify({ regression: 'R1', errors, spawned, output, siblingStoppedObserving, recoveryOutput }))
})
for (const channel of ['stdout', 'stderr'] as const) it(`R2 bounds the complete paused ${channel} queue before accepting another frame`, async () => {
  const c = config(), r = request(); r.executable = c.node; r.args = ['-e', c.outputFixture, channel]
  const p = createExternalSandboxLaunchPort(c.scopes[`${channel}-overflow`]).open(r), errors: string[] = []
  p.on('error', e => errors.push(e.message)); p[channel === 'stdout' ? 'stderr' : 'stdout'].resume()
  let exit = false; p.on('exit', () => { exit = true }); await new Promise(resolve => p.once('close', resolve))
  const stream = p[channel] as import('node:stream').PassThrough
  console.log(JSON.stringify({ regression: 'R2', channel, errors, readableLength: stream.readableLength, writableLength: stream.writableLength, exit }))
  try { expect(errors).toContain('SANDBOX_OUTPUT_BACKPRESSURE'); expect(stream.readableLength + stream.writableLength).toBeLessThanOrEqual(SANDBOX_WIRE_LIMIT); expect(exit).toBe(false); expect(p.mayHaveStarted).toBe(true) }
  finally { stream.resume() }
})
it('R3 rejects pre-connect write and final callbacks on connection failure and rejects later input', async () => {
  const c = config()
  for (const hasData of [true, false]) {
    const p = createExternalSandboxLaunchPort({ ...c.scopes.default, socketPath: c.missingSocket }).open(request())
    p.on('error', () => {}); let count = 0, error: Error | undefined
    const settled = (e?: Error | null) => { count++; error = e ?? undefined }
    if (hasData) p.stdin.end('pending', settled); else p.stdin.end(settled)
    await new Promise(resolve => p.once('close', resolve)); await wait(30)
    console.log(JSON.stringify({ regression: 'R3', hasData, callbacks: count, error: error?.message, writableLength: p.stdin.writableLength, writableFinished: p.stdin.writableFinished, mayHaveStarted: p.mayHaveStarted }))
    expect(count).toBe(1); expect(error).toBeInstanceOf(Error); expect(p.stdin.writableFinished).toBe(false); expect(p.stdin.writableLength).toBe(0); expect(p.mayHaveStarted).toBe(false)
    const laterWrite = await new Promise<Error | null | undefined>(resolve => p.stdin.write('later', resolve))
    const laterEnd = await new Promise<Error | null | undefined>(resolve => p.stdin.end(resolve))
    expect(laterWrite).toBeInstanceOf(Error); expect(laterEnd).toBeInstanceOf(Error); expect(count).toBe(1)
  }
})

it('keeps successful pre-connect stdin end acknowledgements successful', async () => {
  const c = config(), r = request('while IFS= read -r line; do printf "%s\\n" "$line"; printf "%s\\n" "$line" >&2; done')
  const p = createExternalSandboxLaunchPort(c.scopes['r1-recovered']).open(r), errors: string[] = []
  let output = '', count = 0, failure: Error | null | undefined
  p.on('error', e => errors.push(e.message)); p.stdout.on('data', b => { output += b }); p.stderr.resume()
  p.stdin.end('valid-input\n', (error?: Error | null) => { count++; failure = error })
  await new Promise(resolve => p.once('close', resolve)); await wait(10)
  expect(errors).toEqual([]); expect(output).toBe('valid-input\n'); expect(count).toBe(1); expect(failure == null).toBe(true); expect(p.stdin.writableFinished).toBe(true)
})
