/**
 * ssh host 服务域 —— 主机配置存储（全新实现；行为契约参考旧包）。
 *
 * 持久化 $DSH_HOME/dsh-ssh.json；~/.ssh/config 只读导入（解析 Host 块）。
 * 机密（密码/key path/passphrase）仅在文件内，不进入任何投影。
 */
import { closeSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync, readSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isHostKeyFingerprint } from '../../../core/ssh/protocol.ts'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SshHostEntry, SshHostSummary } from '../../../core/ssh/protocol.ts'

export function storePath(dshHome?: string): string {
  return join(dshHome ?? (process.env.DSH_HOME ?? join(homedir(), '.dsh')), 'dsh-ssh.json')
}

export function sshConfigPath(): string {
  return join(homedir(), '.ssh', 'config')
}

const SCHEMA_VERSION = 1
const ALIAS_RE = /^[A-Za-z0-9._-]+$/

interface StoreFile {
  version: number
  hosts: SshHostEntry[]
}

function validateEntry(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return 'body must be a JSON object'
  const p = payload as Record<string, unknown>
  if (typeof p.host !== 'string' || p.host.trim() === '') return 'host is required'
  if (typeof p.user !== 'string' || p.user.trim() === '') return 'user is required'
  if (p.auth !== undefined) {
    const auth = p.auth as Record<string, unknown>
    if (typeof auth !== 'object' || auth === null) return 'auth must be an object'
    if (auth.kind !== 'key' && auth.kind !== 'password' && auth.kind !== 'agent') return 'auth.kind must be key, password or agent'
    if (auth.kind === 'key' && (typeof auth.keyPath !== 'string' || auth.keyPath.trim() === '')) return 'auth.keyPath is required for key auth'
  }
  if (p.hostKeyFingerprint !== undefined && !isHostKeyFingerprint(p.hostKeyFingerprint)) return 'hostKeyFingerprint must be a canonical SHA256 fingerprint'
  if (p.port !== undefined && (typeof p.port !== 'number' || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) return 'invalid port'
  if (p.proxyJump !== undefined && (!Array.isArray(p.proxyJump) || p.proxyJump.some(x => typeof x !== 'string' || x === ''))) return 'proxyJump must be a string array'
  const alias = p.alias
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) return 'alias must be letters, digits, dots, hyphens or underscores'
  return null
}

export interface HostStoreOptions {
  /** Bound synchronous contention waits; an orphan lock is never stolen. */
  lockTimeoutMs?: number
}

export class HostStoreBusyError extends Error {
  readonly code = 'SSH_HOST_STORE_BUSY'
  constructor() { super('SSH host store is busy; retry later or inspect its orphan lock with all writers stopped'); this.name = 'HostStoreBusyError' }
}

/** 主机配置存储。 Locks cover the whole read-modify-save, not just rename. */
export class HostStore {
  readonly path: string
  private readonly sshConfigOverride: string | undefined
  private readonly lockPath: string
  private readonly lockTimeoutMs: number

  constructor(path?: string, sshConfigOverride?: string, options: HostStoreOptions = {}) {
    this.path = resolve(path ?? storePath())
    this.sshConfigOverride = sshConfigOverride
    this.lockPath = `${this.path}.lock`
    const timeout = options.lockTimeoutMs ?? 2000
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 10_000) throw new Error('invalid SSH host store lock timeout')
    this.lockTimeoutMs = timeout
  }

  private mutate<T>(operation: (file: StoreFile, assertOwned: () => void) => T): T {
    mkdirSync(resolve(this.path, '..'), { recursive: true })
    const lock = resolve(this.lockPath)
    if (lock !== `${this.path}.lock`) throw new Error('unexpected SSH host store lock path')
    const token = randomBytes(32).toString('hex')
    const owner = JSON.stringify({ token, pid: process.pid, createdAt: Date.now() })
    const deadline = performance.now() + this.lockTimeoutMs
    const wait = new Int32Array(new SharedArrayBuffer(4))
    let fd: number
    while (true) {
      try { fd = openSync(lock, 'wx+', 0o600); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const remaining = deadline - performance.now()
        if (remaining <= 0) throw new HostStoreBusyError()
        Atomics.wait(wait, 0, 0, Math.min(10, remaining))
      }
    }
    const identity = fstatSync(fd)
    let initialized = false
    const assertOwned = (): void => {
      const named = lstatSync(lock)
      const actual = fstatSync(fd)
      if (!named.isFile() || named.dev !== identity.dev || named.ino !== identity.ino || actual.size !== Buffer.byteLength(owner)) {
        throw new Error('SSH host store lock ownership changed; refusing mutation or lock removal')
      }
      const bytes = Buffer.alloc(Buffer.byteLength(owner))
      if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || bytes.toString('utf8') !== owner) {
        throw new Error('SSH host store lock ownership changed; refusing mutation or lock removal')
      }
    }
    try {
      fchmodSync(fd, 0o600)
      const bytes = Buffer.from(owner)
      let written = 0
      while (written < bytes.length) {
        const count = writeSync(fd, bytes, written, bytes.length - written)
        if (count <= 0) throw new Error('SSH host store lock owner could not be written')
        written += count
      }
      initialized = true
      assertOwned()
      return operation(this.load(), assertOwned)
    } finally {
      try {
        if (initialized) {
          assertOwned()
          // Only this exact resolved path, inode and random owner token may be
          // removed. Crash/orphan locks are deliberately left for an operator;
          // PID reuse and timestamps are not safe proof that a writer is dead.
          if (resolve(lock) !== this.lockPath) throw new Error('unexpected SSH host store lock removal path')
          unlinkSync(lock)
        } else {
          const named = lstatSync(lock)
          if (named.isFile() && named.dev === identity.dev && named.ino === identity.ino && named.size === 0) unlinkSync(lock)
        }
      } finally { closeSync(fd) }
    }
  }

  private load(): StoreFile {
    let text: string
    try { text = readFileSync(this.path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: SCHEMA_VERSION, hosts: [] }
      throw new Error('SSH host store cannot be read; refusing to replace it', { cause: error })
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid store object')
      const file = parsed as Partial<StoreFile>
      if (file.version !== SCHEMA_VERSION || !Array.isArray(file.hosts)) throw new Error('unsupported SSH host store schema')
      const aliases = new Set<string>()
      for (const host of file.hosts) {
        if (validateEntry(host) !== null || host.auth === undefined || !Array.isArray(host.tags) || host.tags.some(tag => typeof tag !== 'string')
            || !Array.isArray(host.proxyJump) || !Number.isFinite(host.createdAt) || !Number.isFinite(host.updatedAt) || aliases.has(host.alias)) throw new Error('invalid SSH host store entry')
        aliases.add(host.alias)
      }
      return file as StoreFile
    } catch (error) {
      throw new Error('SSH host store is corrupt or unsupported; refusing to replace it', { cause: error })
    }
  }

  private save(file: StoreFile, assertOwned: () => void): void {
    assertOwned()
    const dir = resolve(this.path, '..')
    mkdirSync(dir, { recursive: true })
    // Atomic replacement also repairs legacy permissive store modes. Never
    // create secrets through a predictable path, regardless of process umask.
    const temp = `${this.path}.${randomBytes(16).toString('hex')}.tmp`
    if (resolve(temp) !== temp || resolve(temp, '..') !== dir || !temp.startsWith(`${this.path}.`) || !temp.endsWith('.tmp')) throw new Error('unexpected SSH host store temporary path')
    const removeTemp = (): void => {
      if (resolve(temp) !== temp || resolve(temp, '..') !== dir || !temp.startsWith(`${this.path}.`) || !temp.endsWith('.tmp')) throw new Error('unexpected SSH host store temporary removal path')
      unlinkSync(temp)
    }
    const fd = openSync(temp, 'wx', 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, JSON.stringify(file, null, 2), 'utf8')
      closeSync(fd)
    } catch (error) {
      try { closeSync(fd) } catch { /* already closed */ }
      removeTemp()
      throw error
    }
    try {
      assertOwned()
      renameSync(temp, this.path)
    } catch (error) {
      removeTemp()
      throw error
    }
  }

  list(): SshHostEntry[] {
    return this.load().hosts
  }

  find(alias: string): SshHostEntry | undefined {
    return this.list().find(entry => entry.alias === alias)
  }

  /** 安全投影（不含机密）。 */
  summarize(entry: SshHostEntry): SshHostSummary {
    const keyReady = entry.auth.kind === 'key' && entry.auth.keyPath !== undefined
      ? existsSync(entry.auth.keyPath)
      : false
    return {
      alias: entry.alias,
      host: entry.host,
      hostKeyFingerprint: entry.hostKeyFingerprint,
      port: entry.port,
      user: entry.user,
      auth: entry.auth.kind,
      keyReady,
      proxyJump: entry.proxyJump,
      description: entry.description,
      environment: entry.environment,
      tags: entry.tags,
      location: entry.location,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }
  }

  upsert(input: Omit<SshHostEntry, 'createdAt' | 'updatedAt' | 'alias'> & { alias: string }): { entry: SshHostEntry; created: boolean } {
    const invalid = validateEntry(input)
    if (invalid !== null) throw new Error(invalid)
    return this.mutate((file, assertOwned) => this.upsertOwned(file, input, assertOwned))
  }

  private upsertOwned(file: StoreFile, input: Omit<SshHostEntry, 'createdAt' | 'updatedAt' | 'alias'> & { alias: string }, assertOwned: () => void): { entry: SshHostEntry; created: boolean } {
    const now = Date.now()
    const existing = file.hosts.find(h => h.alias === input.alias)
    const entry: SshHostEntry = existing === undefined
      ? { ...input, createdAt: now, updatedAt: now }
      : { ...existing, ...input, updatedAt: now }
    if (existing === undefined) file.hosts.push(entry)
    else file.hosts = file.hosts.map(h => h.alias === input.alias ? entry : h)
    this.save(file, assertOwned)
    return { entry, created: existing === undefined }
  }

  remove(alias: string): boolean {
    return this.mutate((file, assertOwned) => {
      const before = file.hosts.length
      file.hosts = file.hosts.filter(h => h.alias !== alias)
      if (file.hosts.length === before) return false
      this.save(file, assertOwned)
      return true
    })
  }

  /** 从 ~/.ssh/config 导入 Host 块（只读解析，不写回）。 */
  importSshConfig(): { imported: SshHostEntry[]; skipped: string[] } {
    const configPath = this.sshConfigOverride ?? sshConfigPath()
    if (!existsSync(configPath)) return { imported: [], skipped: [] }
    const text = readFileSync(configPath, 'utf8')
    const imported: SshHostEntry[] = []
    const skipped: string[] = []
    let currentHost: string | undefined
    let current: Record<string, string> = {}
    const flush = (): void => {
      if (currentHost === undefined || currentHost === '*' || !ALIAS_RE.test(currentHost)) {
        if (currentHost !== undefined && currentHost !== '*') skipped.push(currentHost)
        return
      }
      const host = current['HostName'] ?? currentHost
      const port = Number(current['Port'] ?? 22)
      const user = current['User'] ?? process.env.USER ?? 'root'
      const auth: SshHostEntry['auth'] = current['IdentityFile'] !== undefined
        ? { kind: 'key', keyPath: current['IdentityFile'] }
        : { kind: 'agent' }
      imported.push({
        alias: currentHost,
        host,
        port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
        user,
        auth,
        proxyJump: current['ProxyJump'] !== undefined ? current['ProxyJump'].split(/[\s,]+/).filter(Boolean) : [],
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line === '' || line.startsWith('#')) continue
      const m = /^Host\s+(.+)$/i.exec(line)
      if (m !== null) {
        flush()
        currentHost = m[1]!.trim()
        current = {}
        continue
      }
      const kv = /^(\w+)\s+(.+)$/.exec(line)
      if (kv !== null && currentHost !== undefined) {
        current[kv[1]!] = kv[2]!.trim()
      }
    }
    flush()
    const committed: SshHostEntry[] = []
    for (const entry of imported) {
      this.mutate((file, assertOwned) => {
        // The existence check belongs to the same lock as the write. Another
        // process may add this alias while config parsing is still in flight.
        if (file.hosts.some(host => host.alias === entry.alias)) return
        const invalid = validateEntry(entry)
        if (invalid !== null) throw new Error(invalid)
        committed.push(this.upsertOwned(file, entry, assertOwned).entry)
      })
    }
    return { imported: committed, skipped }
  }
}