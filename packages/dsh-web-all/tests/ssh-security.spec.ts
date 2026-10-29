import { createHmac, generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, utils, type ClientChannel } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SshHostEntry } from '../src/core/ssh/protocol.ts'
import { SshEngine } from '../src/host/services/ssh/engine.ts'
import { hostKeyFingerprint, makeHostVerifier } from '../src/host/services/ssh/host-keys.ts'
import { HostStore } from '../src/host/services/ssh/store.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ssh-security-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const entry = (extra: Partial<SshHostEntry> = {}): SshHostEntry => ({
  alias: 'test', host: 'server.test', port: 22, user: 'tester', auth: { kind: 'password', password: 'fixture-password' },
  proxyJump: [], tags: [], createdAt: 1, updatedAt: 1, ...extra,
})

// Ephemeral fixture keys, never user keys or real credentials.
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const parsed = utils.parseKey(privateKey)
if (parsed instanceof Error) throw parsed
const publicKey = parsed.getPublicSSH()
const fingerprint = hostKeyFingerprint(publicKey)
const otherKey = Buffer.from('a different fixture key')
function knownHosts(contents: string): string {
  const path = join(dir, 'known_hosts')
  writeFileSync(path, contents)
  return path
}

describe('SSH host identity', () => {
  it('requires known_hosts or an exact explicit pin and never writes TOFU', () => {
    const path = join(dir, 'missing-known-hosts')
    expect(makeHostVerifier(entry(), path)(publicKey)).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(makeHostVerifier(entry({ hostKeyFingerprint: fingerprint }), path)(publicKey)).toBe(true)
    expect(makeHostVerifier(entry({ hostKeyFingerprint: fingerprint }), path)(otherKey)).toBe(false)
    expect(makeHostVerifier(entry({ hostKeyFingerprint: 'SHA256:invalid' }), path)(publicKey)).toBe(false)
  })
  it('matches normal, hashed, non-22 and negated OpenSSH patterns', () => {
    const key = publicKey.toString('base64')
    expect(makeHostVerifier(entry(), knownHosts(`server.test ssh-rsa ${key}\n`))(publicKey)).toBe(true)
    expect(makeHostVerifier(entry(), knownHosts(`server.test ssh-rsa ${key}\n`))(otherKey)).toBe(false)
    const host = '[server.test]:2222'
    const salt = Buffer.from('fixture-hash-salt')
    const hash = createHmac('sha1', salt).update(host).digest('base64')
    const path = knownHosts(`|1|${salt.toString('base64')}|${hash} ssh-rsa ${key}\n`)
    expect(makeHostVerifier(entry({ port: 2222 }), path)(publicKey)).toBe(true)
    expect(makeHostVerifier(entry(), path)(publicKey)).toBe(false)
    expect(makeHostVerifier(entry({ port: 2222 }), knownHosts(`${host} ssh-rsa ${key}\n`))(publicKey)).toBe(true)
    expect(makeHostVerifier(entry(), knownHosts(`*.test,!server.test ssh-rsa ${key}\n`))(publicKey)).toBe(false)
  })
  it('never treats a CA as a raw key and honors revocation even with a pin', () => {
    const key = publicKey.toString('base64')
    expect(makeHostVerifier(entry(), knownHosts(`@cert-authority server.test ssh-rsa ${key}`))(publicKey)).toBe(false)
    expect(makeHostVerifier(entry({ hostKeyFingerprint: fingerprint }), knownHosts(`@revoked server.test ssh-rsa ${key}`))(publicKey)).toBe(false)
    expect(makeHostVerifier(entry({ hostKeyFingerprint: hostKeyFingerprint(otherKey) }), knownHosts(`server.test ssh-rsa ${key}`))(publicKey)).toBe(false)
  })
  it.each(['unchanged', 'revoked', 'deleted', 'replaced'] as const)('rechecks %s known_hosts before reusing a warm connection', async change => {
    let authentications = 0
    let activeStream: ClientChannel | undefined
    const server = new Server({ hostKeys: [privateKey] }, client => {
      client.on('error', () => {})
      client.on('authentication', ctx => { authentications += 1; ctx.accept() })
      client.on('ready', () => client.on('session', accept => {
        const session = accept()
        session.on('exec', acceptExec => { const stream = acceptExec(); stream.exit(0); stream.end('fixture-ok') })
        session.on('pty', acceptPty => { acceptPty?.() })
        session.on('shell', acceptShell => {
          const stream = acceptShell()
          stream.on('data', (data: Buffer) => { stream.write(data) })
        })
      }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture listener has no TCP address')
    const port = address.port
    const host = `[127.0.0.1]:${port}`
    const trustedLine = `${host} ssh-rsa ${publicKey.toString('base64')}\n`
    const path = knownHosts(trustedLine)
    const store = new HostStore(join(dir, 'hosts.json'), join(dir, 'unused-config'))
    store.upsert(entry({ host: '127.0.0.1', port }))
    const engine = new SshEngine(store, { knownHostsPath: path, connectTimeoutMs: 2000 })
    try {
      expect((await engine.exec('test', 'fixture')).stdout).toBe('fixture-ok')
      const pooled = await engine.acquire('test')
      activeStream = await new Promise<ClientChannel>((resolve, reject) => {
        pooled.shell((error, stream) => { if (error) reject(error); else resolve(stream) })
      })
      const tunnel = await engine.tunnel('test', 0, '127.0.0.1', 80)
      if (change === 'revoked') writeFileSync(path, `${trustedLine}@revoked ${trustedLine}`)
      if (change === 'deleted') {
        expect(path).toBe(join(dir, 'known_hosts'))
        rmSync(path)
      }
      if (change === 'replaced') writeFileSync(path, `${host} ssh-rsa ${otherKey.toString('base64')}\n`)

      if (change === 'unchanged') {
        expect(await engine.acquire('test')).toBe(pooled)
        expect((await engine.exec('test', 'fixture')).stdout).toBe('fixture-ok')
      } else {
        await expect(engine.acquire('test')).rejects.toThrow('SSH host key is no longer trusted')
        expect(await engine.exec('test', 'fixture')).toMatchObject({ success: false, error: 'SSH host key is no longer trusted' })
        await expect(engine.ls('test', '/fixture')).rejects.toThrow('SSH host key is no longer trusted')
        await expect(engine.tunnel('test', 0, '127.0.0.1', 80)).rejects.toThrow('SSH host key is no longer trusted')
      }
      expect(authentications).toBe(1)
      expect(engine.pool.get('test')?.client).toBe(pooled)
      expect(engine.pool.get('test')?.disposed).toBe(false)
      expect(engine.listTunnels()).toEqual([expect.objectContaining({ id: tunnel.id, state: 'forwarding' })])
      // Rejection of new work must not close a channel already using the pool.
      const echoed = new Promise<string>((resolve, reject) => {
        activeStream!.once('data', (data: Buffer) => resolve(data.toString()))
        activeStream!.once('error', reject)
        activeStream!.write('still-active')
      })
      expect(await echoed).toBe('still-active')
      if (change !== 'unchanged') {
        writeFileSync(path, trustedLine)
        expect(await engine.acquire('test')).toBe(pooled)
        expect(authentications).toBe(1)
      }
    } finally {
      activeStream?.close()
      engine.dispose()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  it('enforces real exec, PTY, SFTP and tunnel identity before authentication', async () => {
    let authentications = 0
    const server = new Server({ hostKeys: [privateKey] }, client => {
      client.on('error', () => {})
      client.on('authentication', ctx => { authentications += 1; ctx.accept() })
      client.on('ready', () => client.on('session', accept => {
        const session = accept()
        session.on('pty', acceptPty => { acceptPty?.() })
        session.on('exec', acceptExec => { const stream = acceptExec(); stream.exit(0); stream.end('fixture-ok') })
        session.on('shell', acceptShell => { acceptShell().end('fixture-shell') })
      }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture listener has no TCP address')
    const port = address.port
    const store = new HostStore(join(dir, 'hosts.json'), join(dir, 'unused-config'))
    const engine = new SshEngine(store, { knownHostsPath: join(dir, 'absent'), connectTimeoutMs: 2000 })
    const update = (pin?: string) => store.upsert(entry({ host: '127.0.0.1', port, hostKeyFingerprint: pin }))
    try {
      for (const pin of [undefined, hostKeyFingerprint(otherKey)]) {
        update(pin)
        expect((await engine.exec('test', 'echo fixture')).success).toBe(false)
        await expect(engine.openShell('test', { cols: 80, rows: 24 })).rejects.toThrow(/verification/i)
        await expect(engine.ls('test', '/fixture')).rejects.toThrow(/verification/i)
        await expect(engine.upload('test', '/never-read', '/fixture')).rejects.toThrow(/verification/i)
        await expect(engine.download('test', '/fixture', '/never-written')).rejects.toThrow(/verification/i)
        await expect(engine.tunnel('test', 0, '127.0.0.1', 80)).rejects.toThrow(/verification/i)
      }
      expect(authentications).toBe(0)
      update(fingerprint)
      expect((await engine.exec('test', 'echo fixture')).stdout).toBe('fixture-ok')
      const shell = await engine.openShell('test', { cols: 80, rows: 24 })
      shell.close()
      const tunnel = await engine.tunnel('test', 0, '127.0.0.1', 80)
      expect(tunnel.state).toBe('forwarding')
      engine.stopTunnel(tunnel.id)
      update(hostKeyFingerprint(otherKey))
      expect((await engine.exec('test', 'echo fixture')).success).toBe(false)
      store.upsert(entry({ host: '127.0.0.1', port, hostKeyFingerprint: fingerprint, proxyJump: ['jump'] }))
      expect((await engine.exec('test', 'echo fixture')).error).toMatch(/ProxyJump/)
    } finally {
      engine.dispose()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('SSH credential storage', () => {
  it('creates and updates 0600 under umask 022 without predictable temp paths', () => {
    const previous = process.umask(0o022)
    try {
      const path = join(dir, 'hosts.json')
      const victim = join(dir, 'sentinel')
      writeFileSync(victim, 'untouched')
      symlinkSync(victim, `${path}.tmp`)
      const store = new HostStore(path, join(dir, 'unused-config'))
      store.upsert(entry({ auth: { kind: 'key', keyPath: '/fixture-only', passphrase: 'fixture-passphrase' } }))
      expect(statSync(path).mode & 0o777).toBe(0o600)
      chmodSync(path, 0o644)
      store.upsert(entry())
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(readFileSync(victim, 'utf8')).toBe('untouched')
      expect(readdirSync(dir).sort()).toEqual(['hosts.json', 'hosts.json.tmp', 'sentinel'])
      expect(store.find('test')?.auth.password).toBe('fixture-password')
      expect(store.summarize(store.find('test')!)).not.toHaveProperty('password')
    } finally { process.umask(previous) }
  })
  it('rejects malformed pins and projects canonical pins', () => {
    const store = new HostStore(join(dir, 'hosts.json'), join(dir, 'unused-config'))
    expect(() => store.upsert(entry({ hostKeyFingerprint: 'bad' }))).toThrow(/hostKeyFingerprint/)
    expect(store.summarize(store.upsert(entry({ hostKeyFingerprint: fingerprint })).entry).hostKeyFingerprint).toBe(fingerprint)
  })
})
