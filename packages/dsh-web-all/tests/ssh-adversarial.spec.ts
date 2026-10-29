import { generateKeyPairSync, createHmac } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { Server, utils, Client, type Connection, type AuthContext } from 'ssh2'
import type { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshHostEntry } from '../src/core/ssh/protocol.ts'
import { SshEngine } from '../src/host/services/ssh/engine.ts'
import { HostStore } from '../src/host/services/ssh/store.ts'
import { hostKeyFingerprint, makeHostVerifier } from '../src/host/services/ssh/host-keys.ts'

// Only controlled fixture syscalls fail. No home/config discovery is exercised.
const faults = vi.hoisted(() => ({ syscall: '', random: false }))
vi.mock('node:fs', async original => {
  const real = await original<typeof import('node:fs')>()
  const wrap = (name: string, fn: Function) => (...args: unknown[]) => {
    if (faults.syscall === name) throw Object.assign(new Error(`fixture ${name} failure`), { code: 'EIO' })
    return fn(...args)
  }
  return { ...real, fchmodSync: wrap('fchmodSync', real.fchmodSync), writeFileSync: wrap('writeFileSync', real.writeFileSync), renameSync: wrap('renameSync', real.renameSync) }
})
vi.mock('node:crypto', async original => {
  const real = await original<typeof import('node:crypto')>()
  return { ...real, randomBytes: (size: number) => faults.random ? Buffer.alloc(size, 0xab) : real.randomBytes(size) }
})

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const parsed = utils.parseKey(privateKey)
if (parsed instanceof Error) throw parsed
const key = parsed.getPublicSSH()
const pin = hostKeyFingerprint(key)
const wrongKey = Buffer.from('ephemeral wrong public key')
const entry = (extra: Partial<SshHostEntry> = {}): SshHostEntry => ({
  alias: 'fixture', host: 'server.invalid', port: 22, user: 'fixture-user',
  auth: { kind: 'password', password: 'ephemeral-only-password' }, proxyJump: [], tags: [], createdAt: 1, updatedAt: 1, ...extra,
})
const roots: string[] = []
let root: string
const cleanups: Array<() => Promise<void>> = []
const allFixtureClients = new Set<Client>()
const realConnect = Client.prototype.connect
async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`bounded fixture timeout: ${label}`)), timeoutMs) })])
  } finally { clearTimeout(timer) }
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ssh-adversarial-'))); roots.push(root)
  vi.spyOn(Client.prototype, 'connect').mockImplementation(function(this: Client, config) {
    // Instrument only fixture instances for deterministic teardown, not behavior.
    this.on('error', () => {})
    allFixtureClients.add(this)
    this.once('close', () => { allFixtureClients.delete(this) })
    return realConnect.call(this, config)
  })
})
afterEach(async () => {
  faults.syscall = ''; faults.random = false
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await bounded(cleanup(), 'fixture cleanup')
  } finally {
    for (const client of allFixtureClients) client.destroy()
    vi.restoreAllMocks()
  }
  const temporaryRoot = fs.realpathSync(tmpdir())
  for (const path of roots.splice(0)) {
    // Resolve and check every deletion target, never use user or configured homes.
    expect(resolve(path)).toBe(path)
    expect(path.startsWith(`${temporaryRoot}/ssh-adversarial-`)).toBe(true)
    expect(fs.realpathSync(path)).toBe(path)
    fs.rmSync(path, { recursive: true, force: true })
    expect(fs.existsSync(path)).toBe(false)
  }
})
function known(contents: string): string {
  const path = join(root, 'known_hosts')
  fs.writeFileSync(path, contents)
  return path
}

async function fixture(holdAuthentication = false) {
  const sockets = new Set<Socket>()
  const connections = new Set<Connection>()
  const returnedClients = new Set<Client>()
  const authQueue: AuthContext[] = []
  let authCount = 0
  let commands = 0
  let sftpRequests = 0
  const server = new Server({ hostKeys: [privateKey] }, client => {
    connections.add(client)
    client.on('error', () => {})
    client.on('close', () => { connections.delete(client) })
    client.on('authentication', auth => {
      authCount++
      if (holdAuthentication) authQueue.push(auth)
      else auth.accept()
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('pty', acceptPty => { acceptPty?.() })
      session.on('shell', acceptShell => { const stream = acceptShell(); stream.on('data', (data: Buffer) => stream.write(data)) })
      session.on('exec', acceptExec => { commands++; const stream = acceptExec(); stream.exit(0); stream.end('executed') })
      session.on('sftp', (_accept, reject) => { sftpRequests++; reject() })
    }))
  })
  // Observe all raw sockets, including peers stalled before the ssh2 connection event.
  ;(server as unknown as { _srv: import('node:net').Server })._srv.on('connection', socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => { sockets.delete(socket) })
  })
  await bounded(new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) }), 'server listen')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture listener needs TCP address')
  const store = new HostStore(join(root, 'hosts.json'), join(root, 'absent-ssh-config'))
  store.upsert(entry({ host: '127.0.0.1', port: address.port, hostKeyFingerprint: pin }))
  const path = known('')
  const engine = new SshEngine(store, { knownHostsPath: path, connectTimeoutMs: 1500, execTimeoutMs: 1500 })
  cleanups.push(async () => {
    engine.dispose()
    for (const client of returnedClients) client.destroy()
    for (const client of connections) client.end()
    const closed = [...sockets].map(socket => new Promise<void>(yes => { socket.once('close', () => yes()); socket.destroy() }))
    await Promise.all(closed)
    await new Promise<void>(yes => server.close(() => yes()))
    expect(sockets.size).toBe(0)
  })
  async function waitAuth(count = 1) {
    const deadline = Date.now() + 1500
    while (authQueue.length < count) {
      if (Date.now() >= deadline) throw new Error(`fixture expected ${count} pending authentications; got ${authQueue.length}`)
      await delay(5)
    }
  }
  const acquire = () => {
    const pending = engine.acquire('fixture').then(client => { returnedClients.add(client); return client })
    void pending.catch(() => {})
    return pending
  }
  return { server, sockets, connections, store, engine, path, acquire, waitAuth,
    release: () => { for (const auth of authQueue.splice(0)) auth.accept() },
    get authCount() { return authCount }, get commands() { return commands }, get sftpRequests() { return sftpRequests }, port: address.port,
  }
}

describe('SSH adversarial lifecycle and trust races', () => {
  it('single-flights concurrent acquisition so no connection escapes pool ownership', async () => {
    const f = await fixture(true)
    const first = f.acquire(); const second = f.acquire()
    await f.waitAuth()
    // Give the second request a bounded chance to start; a correct singleflight
    // implementation needs only one pending authentication, so do not require two.
    await delay(20)
    f.release()
    const clients = await bounded(Promise.all([first, second]), 'concurrent acquire')
    f.engine.dispose()
    const deadline = Date.now() + 300
    while (f.connections.size > 0 && Date.now() < deadline) await delay(5)
    expect.soft(new Set(clients).size, 'two simultaneous operations must not strand an untracked SSH client').toBe(1)
    expect(f.connections.size, 'all created clients must belong to engine disposal').toBe(0)
  })

  it('dispose rejects pending acquire and prevents late pool resurrection', async () => {
    const f = await fixture(true)
    const pending = f.acquire()
    await f.waitAuth()
    f.engine.dispose()
    f.release()
    const result = await bounded(Promise.allSettled([pending]), 'disposed pending acquire')
    expect(result[0].status, 'disposed service cannot return a new authenticated client').toBe('rejected')
    expect(f.engine.pool.size).toBe(0)
  })

  it('dispose permanently rejects new acquire instead of reconnecting', async () => {
    const f = await fixture()
    f.engine.dispose()
    const result = await bounded(Promise.allSettled([f.acquire()]), 'post-dispose acquire')
    expect(result[0].status).toBe('rejected')
    expect(f.authCount).toBe(0)
  })

  it.each(['delete-host', 'replace-pin', 'revoke-known-host'] as const)('rejects NEW exec if %s occurs after key verification but before ready', async mutation => {
    const f = await fixture(true)
    if (mutation === 'revoke-known-host') {
      f.store.upsert(entry({ host: '127.0.0.1', port: f.port, hostKeyFingerprint: undefined }))
      fs.writeFileSync(f.path, `[127.0.0.1]:${f.port} ssh-rsa ${key.toString('base64')}\n`)
    }
    const pending = f.engine.exec('fixture', 'must-not-execute', 1500)
    await f.waitAuth()
    if (mutation === 'delete-host') f.store.remove('fixture')
    if (mutation === 'replace-pin') f.store.upsert(entry({ host: '127.0.0.1', port: f.port, hostKeyFingerprint: hostKeyFingerprint(wrongKey) }))
    if (mutation === 'revoke-known-host') fs.writeFileSync(f.path, `@revoked [127.0.0.1]:${f.port} ssh-rsa ${key.toString('base64')}\n`)
    f.release()
    const result = await bounded(pending, 'trust changed before exec admission')
    expect.soft(result.success, 'no exec channel existed at mutation time; this is not an existing-channel exception').toBe(false)
    expect(f.commands).toBe(0)
  })

  it('revalidates a pin replaced during an independent PTY handshake', async () => {
    const f = await fixture(true)
    const pending = f.engine.openShell('fixture', { cols: 80, rows: 24 })
    void pending.catch(() => {})
    await f.waitAuth()
    f.store.upsert(entry({ host: '127.0.0.1', port: f.port, hostKeyFingerprint: hostKeyFingerprint(wrongKey) }))
    f.release()
    const result = await bounded(Promise.allSettled([pending]), 'PTY admission')
    if (result[0].status === 'fulfilled') result[0].value.close()
    expect(result[0].status).toBe('rejected')
  })

  it.each(['SFTP', 'tunnel'] as const)('does not admit a new %s surface after trust changes during connection startup', async surface => {
    const f = await fixture(true)
    f.store.upsert(entry({ host: '127.0.0.1', port: f.port, hostKeyFingerprint: undefined }))
    fs.writeFileSync(f.path, `[127.0.0.1]:${f.port} ssh-rsa ${key.toString('base64')}\n`)
    const pending = surface === 'SFTP' ? f.engine.ls('fixture', '/fixture') : f.engine.tunnel('fixture', 0, '127.0.0.1', 80)
    const settled = Promise.allSettled([pending])
    await f.waitAuth()
    fs.writeFileSync(f.path, `@revoked [127.0.0.1]:${f.port} ssh-rsa ${key.toString('base64')}\n`)
    f.release()
    const result = await bounded(settled, `${surface} startup revocation`)
    if (surface === 'tunnel') {
      expect.soft(result[0].status).toBe('rejected')
      expect(f.engine.listTunnels()).toEqual([])
    } else {
      expect(result[0].status).toBe('rejected')
      expect(f.sftpRequests, 'protocol request must not reach the server after revocation').toBe(0)
    }
  })

  it('keeps a trusted unchanged rekey usable and blocks new operations after revocation', async () => {
    const f = await fixture()
    const client = await bounded(f.acquire(), 'initial rekey connection')
    const serverClient = [...f.connections][0]
    await bounded(new Promise<void>(yes => serverClient.rekey(yes)), 'SSH rekey')
    expect(await f.engine.acquire('fixture')).toBe(client)
    fs.writeFileSync(f.path, `@revoked [127.0.0.1]:${f.port} ssh-rsa ${key.toString('base64')}\n`)
    await expect(f.engine.acquire('fixture')).rejects.toThrow(/trusted/)
    expect(f.commands).toBe(0)
  })

  it.each(['exec', 'PTY', 'SFTP-list', 'upload', 'download', 'tunnel'] as const)('rejects unknown key before authentication through %s', async route => {
    const f = await fixture()
    f.store.upsert(entry({ host: '127.0.0.1', port: f.port, hostKeyFingerprint: undefined }))
    let result: unknown
    if (route === 'exec') result = await bounded(f.engine.exec('fixture', 'blocked'), route)
    else {
      const pending = route === 'PTY' ? f.engine.openShell('fixture', { cols: 80, rows: 24 })
        : route === 'SFTP-list' ? f.engine.ls('fixture', '/fixture')
        : route === 'upload' ? f.engine.upload('fixture', join(root, 'never-read'), '/fixture')
        : route === 'download' ? f.engine.download('fixture', '/fixture', join(root, 'never-written'))
        : f.engine.tunnel('fixture', 0, '127.0.0.1', 80)
      result = await bounded(Promise.allSettled([pending]), route)
      expect((result as PromiseSettledResult<unknown>[])[0].status).toBe('rejected')
    }
    if (route === 'exec') expect(result).toMatchObject({ success: false })
    expect(f.authCount).toBe(0)
    expect(f.commands).toBe(0)
    expect(fs.existsSync(join(root, 'never-written'))).toBe(false)
  })
})

describe('known_hosts adversarial parsing', () => {
  it.each(['before', 'after'] as const)('honors revoked key %s ordinary trust even with explicit pin', order => {
    const good = `server.invalid ssh-rsa ${key.toString('base64')}\n`
    const revoked = `@revoked ${good}`
    const path = known(order === 'before' ? revoked + good : good + revoked)
    expect(makeHostVerifier(entry({ hostKeyFingerprint: pin }), path)(key)).toBe(false)
  })
  it.each(['ssh-ed25519', 'bogus-key-type'] as const)('does not trust a raw RSA key mislabeled %s', type => {
    const path = known(`server.invalid ${type} ${key.toString('base64')}\n`)
    expect(makeHostVerifier(entry(), path)(key)).toBe(false)
  })
  it('rejects noncanonical base64 instead of decoding ignored garbage into trust', () => {
    const path = known(`server.invalid ssh-rsa ${key.toString('base64')}!!!!\n`)
    expect(makeHostVerifier(entry(), path)(key)).toBe(false)
  })
  it('supports literal IPv6 and non-default-port boundaries without wild regex interpretation', () => {
    const path = known(`[2001:db8::5]:2222 ssh-rsa ${key.toString('base64')}\n`)
    expect(makeHostVerifier(entry({ host: '2001:db8::5', port: 2222 }), path)(key)).toBe(true)
    expect(makeHostVerifier(entry({ host: '2001:db8::5', port: 22 }), path)(key)).toBe(false)
    expect(makeHostVerifier(entry({ host: '2001:db8::6', port: 2222 }), path)(key)).toBe(false)
  })
  it('handles bounded long patterns and malformed hashed/marker lines without granting trust', () => {
    const path = known(`${'a'.repeat(16000)}.invalid ssh-rsa ${key.toString('base64')}\n|1|bad|bad ssh-rsa ${key.toString('base64')}\n@unsupported server.invalid ssh-rsa ${key.toString('base64')}\n`)
    const started = performance.now()
    expect(makeHostVerifier(entry(), path)(key)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
  })
  it('does not let wildcard backtracking stall the shared host event loop', async () => {
    // Run the exact current production verifier in an isolated worker so a
    // pathological regex cannot defeat the test runner's own timeout.
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const source = actualFs.readFileSync(new URL('../src/host/services/ssh/host-keys.ts', import.meta.url), 'utf8')
      .replace("import { isHostKeyFingerprint, type SshHostEntry } from '../../../core/ssh/protocol.ts'", 'const isHostKeyFingerprint = () => false')
    const worker = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      const { stripTypeScriptTypes } = require('node:module');
      (async () => {
        const text = stripTypeScriptTypes(workerData.source, { mode: 'transform' });
        const mod = await import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
        parentPort.postMessage('ready');
        const result = mod.makeHostVerifier(workerData.entry, workerData.path)(Buffer.from(workerData.key));
        parentPort.postMessage({ result });
      })().catch(error => parentPort.postMessage({ error: String(error) }));
    `, { eval: true, workerData: {
      source, entry: entry({ host: `${'a'.repeat(48)}.invalid` }),
      path: known(`${'*a'.repeat(28)}b.invalid ssh-rsa ${key.toString('base64')}\n`), key: [...key],
    } })
    let timer: ReturnType<typeof setTimeout> | undefined
    let startup: ReturnType<typeof setTimeout> | undefined
    const result = await new Promise<unknown>((yes, no) => {
      startup = setTimeout(() => no(new Error('worker startup exceeded fixture bound')), 2000)
      worker.on('error', no)
      worker.on('message', message => {
        if (message === 'ready') {
          clearTimeout(startup)
          timer = setTimeout(() => yes('event-loop-stalled'), 300)
        } else { clearTimeout(startup); clearTimeout(timer); yes(message) }
      })
    }).finally(async () => { clearTimeout(startup); clearTimeout(timer); await worker.terminate() })
    expect(result, 'known_hosts wildcard matching must remain bounded on a hostile line').toEqual({ result: false })
  })

  it('matches an exact hashed IPv6 identity but not its different-port sibling', () => {
    const host = '[2001:db8::5]:2222'
    const salt = Buffer.from('fixture-ephemeral-salt')
    const hash = createHmac('sha1', salt).update(host).digest('base64')
    const path = known(`|1|${salt.toString('base64')}|${hash} ssh-rsa ${key.toString('base64')}\n`)
    expect(makeHostVerifier(entry({ host: '2001:db8::5', port: 2222 }), path)(key)).toBe(true)
    expect(makeHostVerifier(entry({ host: '2001:db8::5', port: 2223 }), path)(key)).toBe(false)
  })
})

describe('credential store adversarial filesystem boundaries', () => {
  it.each(['fchmodSync', 'writeFileSync', 'renameSync'])('preserves committed bytes and cleans all temporary secrets on %s failure', syscall => {
    const path = join(root, 'hosts.json')
    const store = new HostStore(path, join(root, 'absent-config'))
    store.upsert(entry())
    const before = fs.readFileSync(path, 'utf8')
    faults.syscall = syscall
    expect(() => store.upsert(entry({ auth: { kind: 'password', password: 'must-not-commit' } }))).toThrow(/fixture/)
    faults.syscall = ''
    expect(fs.readFileSync(path, 'utf8')).toBe(before)
    expect(fs.readdirSync(root)).toEqual(['hosts.json'])
    expect(store.find('fixture')?.auth.password).toBe('ephemeral-only-password')
  })
  it('does not follow a colliding random temporary symlink or unlink someone else\'s file', () => {
    const path = join(root, 'hosts.json')
    const victim = join(root, 'sentinel')
    fs.writeFileSync(victim, 'untouched')
    const collision = `${path}.${'ab'.repeat(16)}.tmp`
    fs.symlinkSync(victim, collision)
    faults.random = true
    expect(() => new HostStore(path, join(root, 'absent')).upsert(entry())).toThrow(/EEXIST/)
    faults.random = false
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched')
    expect(fs.lstatSync(collision).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path)).toBe(false)
  })
  it.each([0o000, 0o022, 0o077])('persists only 0600 with process umask %s and replaces target symlink, not its victim', mask => {
    const previous = process.umask(mask)
    try {
      const path = join(root, 'hosts.json'); const victim = join(root, 'sentinel')
      // A readable target must be a valid store: corrupt input is intentionally
      // rejected, not silently replaced. The victim bytes still must not change.
      const victimBytes = JSON.stringify({ version: 1, hosts: [entry({ alias: 'existing' })] })
      fs.writeFileSync(victim, victimBytes); fs.symlinkSync(victim, path)
      const store = new HostStore(path, join(root, 'absent'))
      store.upsert(entry())
      expect(fs.statSync(path).mode & 0o777).toBe(0o600)
      expect(fs.lstatSync(path).isSymbolicLink()).toBe(false)
      expect(fs.readFileSync(victim, 'utf8')).toBe(victimBytes)
      expect(store.list().map(host => host.alias).sort()).toEqual(['existing', 'fixture'])
    } finally { process.umask(previous) }
  })
  it('does not silently destroy a corrupt committed store during the next update', () => {
    const path = join(root, 'hosts.json'); const corrupt = '{"hosts":[{"alias":"important"}],truncated'
    fs.writeFileSync(path, corrupt)
    const store = new HostStore(path, join(root, 'absent'))
    expect(() => store.upsert(entry())).toThrow()
    expect(fs.readFileSync(path, 'utf8')).toBe(corrupt)
  })
  // Cross-writer lost-update safety is exercised with independent processes in
  // ssh-cross-process-adversarial.spec.ts, not an impossible synchronous reentry.
})
