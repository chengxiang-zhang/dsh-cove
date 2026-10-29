import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Server, utils, type AuthContext, type Connection } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import type { SshHostEntry } from '../src/core/ssh/protocol.ts'
import { SshEngine } from '../src/host/services/ssh/engine.ts'
import { HostStore } from '../src/host/services/ssh/store.ts'
import { hostKeyFingerprint, makeHostVerifier } from '../src/host/services/ssh/host-keys.ts'

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const parsed = utils.parseKey(privateKey)
if (parsed instanceof Error) throw parsed
const publicKey = parsed.getPublicSSH()
const cleanup: Array<() => Promise<void>> = []
const roots: string[] = []
function root(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ssh-concurrency-fixes-')))
  roots.push(dir)
  return dir
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture exceeded 2000ms')), 2000) })]) }
  finally { clearTimeout(timer) }
}
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await bounded(dispose())
  for (const dir of roots.splice(0)) {
    if (!dir.startsWith(`${realpathSync(tmpdir())}/ssh-concurrency-fixes-`) || realpathSync(dir) !== dir) throw new Error('unexpected cleanup target')
    rmSync(dir, { recursive: true, force: true })
  }
})
const entry = (extra: Partial<SshHostEntry> = {}): SshHostEntry => ({ alias: 'fixture', host: 'fixture.invalid', port: 22, user: 'fixture', auth: { kind: 'password', password: 'test-only' }, tags: [], proxyJump: [], createdAt: 1, updatedAt: 1, ...extra })

async function fixture() {
  const dir = root()
  const peers = new Set<Connection>()
  const auth: AuthContext[] = []
  let connections = 0
  const server = new Server({ hostKeys: [privateKey] }, peer => {
    connections++
    peers.add(peer)
    peer.on('error', () => {})
    peer.once('close', () => { peers.delete(peer) })
    peer.on('authentication', context => { auth.push(context) })
    peer.on('ready', () => peer.on('session', accept => {
      const session = accept()
      session.on('pty', yes => { yes?.() })
      session.on('shell', yes => { yes().end() })
    }))
  })
  await bounded(new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no fixture address')
  const store = new HostStore(join(dir, 'hosts.json'), join(dir, 'absent-config'))
  const host = entry({ host: '127.0.0.1', port: address.port, hostKeyFingerprint: hostKeyFingerprint(publicKey) })
  store.upsert(host)
  const engine = new SshEngine(store, { knownHostsPath: join(dir, 'absent-known'), connectTimeoutMs: 1000 })
  cleanup.push(async () => {
    engine.dispose()
    for (const peer of peers) peer.end()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const waitAuth = async () => {
    await bounded((async () => { while (auth.length === 0) await delay(1) })())
  }
  return { engine, store, host, auth, waitAuth, get connections() { return connections } }
}

describe('SSH connection ownership and admission', () => {
  it('shares a failed flight, cleans it, and permits a later explicitly trusted retry', async () => {
    const f = await fixture()
    const first = f.engine.acquire('fixture')
    const second = f.engine.acquire('fixture')
    const settled = Promise.allSettled([first, second])
    await f.waitAuth()
    f.store.upsert({ ...f.host, hostKeyFingerprint: hostKeyFingerprint(Buffer.from('wrong fixture')) })
    f.auth.splice(0).forEach(context => context.accept())
    expect((await bounded(settled)).map(row => row.status)).toEqual(['rejected', 'rejected'])
    expect(f.connections).toBe(1)
    expect(f.engine.pool.size).toBe(0)
    f.store.upsert(f.host)
    const retry = f.engine.acquire('fixture')
    await f.waitAuth()
    f.auth.splice(0).forEach(context => context.accept())
    expect(await bounded(retry)).toBeDefined()
    expect(f.connections).toBe(2)
    expect(f.engine.pool.size).toBe(1)
  })

  it('cancels independent pending PTY authentication without waiting for the server', async () => {
    const f = await fixture()
    const pending = f.engine.openShell('fixture', { cols: 80, rows: 24 })
    const rejected = expect(pending).rejects.toThrow(/disposed/)
    await f.waitAuth()
    f.engine.dispose()
    await bounded(rejected)
    await expect(f.engine.openShell('fixture', { cols: 80, rows: 24 })).rejects.toThrow(/disposed/)
    expect(f.engine.pool.size).toBe(0)
  })

  it('does not open a command when disposal wins the warm-acquire continuation', async () => {
    const f = await fixture()
    const initial = f.engine.acquire('fixture')
    await f.waitAuth()
    f.auth.splice(0).forEach(context => context.accept())
    await bounded(initial)
    const disposing = f.engine.acquire('fixture').then(() => { f.engine.dispose() })
    const exec = f.engine.exec('fixture', 'never-admitted')
    await bounded(disposing)
    expect(await bounded(exec)).toMatchObject({ success: false, error: 'SSH engine disposed' })
  })

  it('rejects an endpoint change during authentication even if the old public key remains trusted', async () => {
    const f = await fixture()
    const pending = f.engine.acquire('fixture')
    const rejected = expect(pending).rejects.toThrow(/configuration changed/)
    await f.waitAuth()
    f.store.upsert({ ...f.host, user: 'different-identity' })
    f.auth.splice(0).forEach(context => context.accept())
    await bounded(rejected)
    expect(f.engine.pool.size).toBe(0)
  })
})

describe('bounded known-host parsing', () => {
  it('evaluates repeated star literals without regex backtracking', () => {
    const dir = root()
    const path = join(dir, 'known_hosts')
    writeFileSync(path, `${'*a'.repeat(28)}b.invalid ssh-rsa ${publicKey.toString('base64')}\n`)
    const start = performance.now()
    expect(makeHostVerifier(entry({ host: `${'a'.repeat(48)}.invalid` }), path)(publicKey)).toBe(false)
    expect(performance.now() - start).toBeLessThan(100)
  })
  it.each(['ssh-ed25519', 'bogus-type'])('does not grant trust to an RSA blob labeled %s', type => {
    const path = join(root(), 'known_hosts')
    writeFileSync(path, `fixture.invalid ${type} ${publicKey.toString('base64')}\n`)
    expect(makeHostVerifier(entry(), path)(publicKey)).toBe(false)
  })
})

describe('SSH committed store fail-closed behavior', () => {
  it.each(['{truncated', 'null', '{"version":2,"hosts":[]}', '{"version":1,"hosts":[{"alias":"incomplete"}]}'])('preserves unreadable schema bytes %s', contents => {
    const dir = root()
    const path = join(dir, 'hosts.json')
    writeFileSync(path, contents)
    const store = new HostStore(path, join(dir, 'absent-config'))
    expect(() => store.list()).toThrow(/corrupt|unsupported/)
    expect(() => store.upsert(entry())).toThrow(/refusing/)
    expect(() => store.remove('fixture')).toThrow(/refusing/)
    expect(readFileSync(path, 'utf8')).toBe(contents)
  })

  it('observes successive synchronous writes from different HostStore instances', () => {
    const dir = root()
    const path = join(dir, 'hosts.json')
    const first = new HostStore(path)
    const second = new HostStore(path)
    first.upsert(entry())
    second.upsert(entry({ alias: 'other' }))
    first.upsert(entry({ alias: 'third' }))
    expect(second.list().map(host => host.alias)).toEqual(['fixture', 'other', 'third'])
  })
})
