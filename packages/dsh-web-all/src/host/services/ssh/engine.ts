/**
 * ssh host 服务域 —— 引擎层（全新实现；行为契约参考旧包）。
 *
 * ssh2 驱动：持久连接池（空闲回收）、非交互 exec、PTY shell、SFTP
 * 传输、本地端口转发隧道、集群并发。机密只从 store 读取，不出引擎。
 */
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type {
  ClusterResult,
  ExecResult,
  RemoteDirEntry,
  TransferProgress,
  TunnelInfo,
} from '../../../core/ssh/protocol.ts'
import type { HostStore } from './store.ts'
import { makeHostVerifier } from './host-keys.ts'

/** 连接池记录。 */
interface PoolRecord {
  client: Client
  lastUsedAt: number
  disposed: boolean
  /** Reconnect after stored trust or connection configuration changes. */
  configuration: string
  /** Last verified public peer key, including subsequent successful rekeys. */
  readonly peerKey: Buffer | undefined
}

/** 隧道记录（真 listener + 活 socket 跟踪 + 钉住的池连接）。 */
interface TunnelRecord {
  info: TunnelInfo
  server: NetServer
  alias: string
  sockets: Set<Socket>
}

/**
 * 默认命令超时：exec / cluster 未显式传 timeoutMs 时使用。
 *
 * 没有兜底值时 ssh2 的 exec 没有上限：远端命令不返回（`tail -f`、等待输入、
 * 卡住的 NFS 挂载）就会让 agent 的调用无限等待。默认 2 分钟足以覆盖调查类命令，
 * 长任务由调用方显式传更大的 timeoutMs。
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000

/**
 * 显式超时的上限：调用方可以要求更长，但不能把一个连接（以及一次 agent 调用）
 * 无限期挂住——超过这个值的请求会被夹到上限而不是原样下发。
 */
export const MAX_EXEC_TIMEOUT_MS = 60 * 60 * 1000

/** cluster 并发上限：显式 maxWorkers 只在这个范围内生效，任何情况都不超过主机数。 */
export const MAX_CLUSTER_WORKERS = 32

/**
 * 解析 cluster 的并发数：未要求（缺省、非数、非正数）时保持历史行为——所有目标
 * 同时开跑；显式要求时夹到 [1, min(主机数, MAX_CLUSTER_WORKERS)]。
 * @param requested - 调用方要求的并发数。
 * @param total - 本次目标主机数。
 * @returns 实际并发数。
 */
export function clusterWorkerLimit(requested: number | undefined, total: number): number {
  if (total <= 0) return 1
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return total
  return Math.max(1, Math.min(Math.floor(requested), Math.min(total, MAX_CLUSTER_WORKERS)))
}

/** 超时后等待通道自行关闭的宽限期；到期仍未关闭则断开整条连接。 */
export const EXEC_TIMEOUT_GRACE_MS = 3_000

export interface EngineOptions {
  idleTimeoutMs?: number
  connectTimeoutMs?: number
  /**
   * 默认命令超时毫秒。传函数则每次 exec 求值（设置热更新无需重挂插件）；
   * 缺省、非数或非正数一律回退 DEFAULT_EXEC_TIMEOUT_MS。
   */
  execTimeoutMs?: number | (() => number | undefined)
  /** Test/deployment override; default is ~/.ssh/known_hosts, read-only. */
  knownHostsPath?: string
  /** 超时后等待通道关闭的宽限期毫秒（默认 EXEC_TIMEOUT_GRACE_MS）。 */
  execTimeoutGraceMs?: number
}

function connectConfigOf(store: HostStore, alias: string, knownHostsPath?: string): ConnectConfig {
  const entry = store.find(alias)
  if (entry === undefined) throw new Error(`host not found: ${alias}`)
  // ProxyJump was previously ignored. Until verified per-hop dialing exists,
  // reject rather than silently connect directly to the wrong trust endpoint.
  if (entry.proxyJump.length > 0) throw new Error('ProxyJump is not supported safely; configure a directly reachable host with a verified host key')
  const cfg: ConnectConfig = {
    host: entry.host,
    port: entry.port,
    username: entry.user,
    readyTimeout: 15_000,
    hostVerifier: makeHostVerifier(entry, knownHostsPath),
  }
  switch (entry.auth.kind) {
    case 'key':
      cfg.privateKey = privateKeyOf(entry.auth.keyPath ?? '')
      if (entry.auth.passphrase !== undefined) cfg.passphrase = entry.auth.passphrase
      break
    case 'password':
      cfg.password = entry.auth.password
      break
    case 'agent': {
      // Node 的 ssh2 无内置 agent；退化用本机默认密钥路径探测。
      const defaultKeys = [joinHome('.ssh', 'id_ed25519'), joinHome('.ssh', 'id_rsa')]
      const key = defaultKeys.find(p => existsSync(p))
      if (key !== undefined) cfg.privateKey = privateKeyOf(key)
      break
    }
  }
  return cfg
}

function joinHome(...parts: string[]): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return [home, ...parts].join('/')
}

/** 读取私钥文件（不存在则抛错）。 */
function privateKeyOf(path: string): string | Buffer {
  try {
    return readFileSync(path)
  } catch (error) {
    throw new Error(`cannot read private key: ${path} (${error instanceof Error ? error.message : String(error)})`)
  }
}

/** 键盘交互认证回调（终端 2FA）。 */
export type KeyboardInteractiveHandler = (
  name: string,
  instructions: string,
  instructionsLang: string,
  prompts: Array<{ prompt: string; echo: boolean }>,
  finish: (responses: string[]) => void,
) => void

/** 交互 shell 会话。 */
export interface ShellSession {
  /** 远程输出。 */
  onData?: (data: Buffer) => void
  /** 通道关闭。 */
  onExit?: (code: number | null, error?: string) => void
  /** 写入输入。 */
  send(data: string): void
  /** 调整 PTY 尺寸。 */
  resize(cols: number, rows: number): void
  /** 关闭会话与通道。 */
  close(): void
  /** 暂停输出（背压）。 */
  pause(): void
  /** 恢复输出。 */
  resume(): void
}

/** 与 ssh2 连接建立的 promise。 */
function connectClient(config: ConnectConfig, timeoutMs: number, onKeyboardInteractive?: KeyboardInteractiveHandler, signal?: AbortSignal, own?: (client: Client) => void): Promise<Client> {
  return new Promise((resolvePromise, rejectPromise) => {
    const client = new Client()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      client.destroy()
      rejectPromise(error)
    }
    const abort = (): void => { fail(new Error('SSH engine disposed')) }
    // Keep the error handler installed through transport shutdown.
    client.on('error', fail)
    client.once('close', () => { fail(new Error('SSH connection closed before ready')) })
    client.once('ready', () => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(client)
    })
    own?.(client)
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => { fail(new Error(`ssh connect timed out after ${timeoutMs}ms`)) }, timeoutMs)
    if (onKeyboardInteractive !== undefined) {
      client.on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
        onKeyboardInteractive(name, instructions, instructionsLang, prompts.map(p => ({ prompt: p.prompt, echo: Boolean(p.echo) })), finish)
      })
    }
    try { client.connect(config) } catch (error) { fail(error) }
  })
}

export class SshEngine {
  readonly pool = new Map<string, PoolRecord>()
  readonly tunnels = new Map<string, TunnelRecord>()
  private nextTunnelId = 0
  private disposed = false
  private readonly abort = new AbortController()
  private readonly clients = new Set<Client>()
  private readonly pending = new Map<string, Promise<Client>>()
  private readonly opts: { idleTimeoutMs: number; connectTimeoutMs: number; execTimeoutGraceMs: number }
  private readonly knownHostsPath: string | undefined
  private readonly execTimeoutSource: () => number | undefined
  private readonly sweepTimer: ReturnType<typeof setInterval>

  constructor(private readonly store: HostStore, options: EngineOptions = {}) {
    this.opts = {
      idleTimeoutMs: options.idleTimeoutMs ?? 30 * 60 * 1000,
      connectTimeoutMs: options.connectTimeoutMs ?? 20_000,
      execTimeoutGraceMs: options.execTimeoutGraceMs ?? EXEC_TIMEOUT_GRACE_MS,
    }
    this.knownHostsPath = options.knownHostsPath
    const source = options.execTimeoutMs
    this.execTimeoutSource = typeof source === 'function' ? source : () => source
    this.sweepTimer = setInterval(() => this.sweep(), Math.max(10_000, this.opts.idleTimeoutMs / 4))
    this.sweepTimer.unref?.()
  }

  /**
   * 本次执行的超时上限：调用方显式值优先，其次配置，最后插件默认值；任何来源
   * 都被夹到 MAX_EXEC_TIMEOUT_MS，非法值回退默认超时。
   */
  resolveExecTimeoutMs(timeoutMs?: number): number {
    const raw = timeoutMs ?? this.execTimeoutSource()
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_EXEC_TIMEOUT_MS
    return Math.min(Math.floor(raw), MAX_EXEC_TIMEOUT_MS)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    clearInterval(this.sweepTimer)
    for (const client of this.clients) client.destroy()
    this.clients.clear()
    this.pool.clear()
    this.pending.clear()
    for (const id of [...this.tunnels.keys()]) this.stopTunnel(id)
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('SSH engine disposed')
  }

  private ownClient = (client: Client): void => {
    this.clients.add(client)
    client.once('close', () => { this.clients.delete(client) })
  }

  private configuration(alias: string): string {
    this.assertActive()
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`host not found: ${alias}`)
    return createHash('sha256').update(JSON.stringify(entry)).digest('hex')
  }

  /** Run after every async handshake; never admit work against a stale snapshot. */
  private validateReady(alias: string, configuration: string, peerKey: Buffer | undefined): void {
    if (this.configuration(alias) !== configuration) throw new Error('SSH host configuration changed during connection')
    const entry = this.store.find(alias)!
    if (peerKey === undefined || !makeHostVerifier(entry, this.knownHostsPath)(peerKey)) throw new Error('SSH host key is no longer trusted')
  }

  private async dial(alias: string, onKeyboardInteractive?: KeyboardInteractiveHandler): Promise<PoolRecord> {
    const configuration = this.configuration(alias)
    const config = connectConfigOf(this.store, alias, this.knownHostsPath)
    const verify = makeHostVerifier(this.store.find(alias)!, this.knownHostsPath)
    let peerKey: Buffer | undefined
    config.hostVerifier = (key: Buffer): boolean => {
      if (!verify(key)) return false
      peerKey = Buffer.from(key)
      return true
    }
    const client = await connectClient(config, this.opts.connectTimeoutMs, onKeyboardInteractive, this.abort.signal, this.ownClient)
    try { this.validateReady(alias, configuration, peerKey) }
    catch (error) { client.destroy(); throw error }
    const record: PoolRecord = { client, lastUsedAt: Date.now(), disposed: false, configuration, get peerKey() { return peerKey } }
    client.once('close', () => { record.disposed = true })
    return record
  }

  list(query?: string) {
    const needle = query?.trim().toLowerCase()
    const entries = this.store.list()
    return (needle === undefined || needle === ''
      ? entries
      : entries.filter(e => e.alias.toLowerCase().includes(needle) || e.host.toLowerCase().includes(needle)))
      .map(e => this.store.summarize(e))
  }

  find(alias: string) {
    const entry = this.store.find(alias)
    return entry === undefined ? undefined : this.store.summarize(entry)
  }

  /** 取连接（池内复用）。 */
  async acquire(alias: string): Promise<Client> {
    const configuration = this.configuration(alias)
    const existing = this.pool.get(alias)
    if (existing !== undefined && !existing.disposed && existing.configuration === configuration) {
      // Current trust controls new work, not already active channels/tunnels.
      this.validateReady(alias, configuration, existing.peerKey)
      existing.lastUsedAt = Date.now()
      return existing.client
    }
    const joining = this.pending.get(alias)
    if (joining !== undefined) {
      const client = await joining
      this.admitPooled(alias, client)
      return client
    }
    if (existing !== undefined) existing.client.end()
    const pending = this.dial(alias).then(record => {
      try { this.validateReady(alias, record.configuration, record.peerKey) }
      catch (error) { record.client.destroy(); throw error }
      this.pool.set(alias, record)
      return record.client
    })
    this.pending.set(alias, pending)
    try {
      const client = await pending
      this.admitPooled(alias, client)
      return client
    } finally { if (this.pending.get(alias) === pending) this.pending.delete(alias) }
  }

  private admitPooled(alias: string, client: Client): void {
    this.assertActive()
    const record = this.pool.get(alias)
    if (record === undefined || record.client !== client || record.disposed) throw new Error('SSH connection is no longer available')
    this.validateReady(alias, record.configuration, record.peerKey)
  }

  private sweep(): void {
    const cutoff = Date.now() - this.opts.idleTimeoutMs
    for (const [alias, record] of [...this.pool.entries()]) {
      if (record.lastUsedAt < cutoff || record.disposed) {
        record.client.end()
        this.pool.delete(alias)
      }
    }
  }

  /** 执行一条远程命令（未显式传 timeoutMs 时用插件默认超时）。 */
  async exec(alias: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    const startedAt = Date.now()
    const limitMs = this.resolveExecTimeoutMs(timeoutMs)
    const fail = (error: unknown): ExecResult => ({
      success: false, exitCode: null, timedOut: false, stdout: '', stderr: '',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })
    let client: Client
    try {
      client = await this.acquire(alias)
      this.admitPooled(alias, client)
    } catch (error) {
      return fail(error)
    }
    return new Promise<ExecResult>((resolvePromise) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let channel: ClientChannel | undefined
      let graceTimer: ReturnType<typeof setTimeout> | undefined

      const clearGrace = (): void => {
        if (graceTimer === undefined) return
        clearTimeout(graceTimer)
        graceTimer = undefined
      }
      /**
       * 关闭通道。sshd 在通道关闭时清理该 session 的进程组，所以远端命令会随
       * 通道一起死；`signal` 只是尽力而为（部分服务端不支持该请求）。
       */
      const closeChannel = (stream: ClientChannel): void => {
        try { stream.signal('KILL') } catch { /* 服务端可能不支持 signal 请求 */ }
        try { stream.close() } catch { /* 通道已消失 */ }
      }
      /**
       * 超时终结：先挂宽限计时（通道若立刻关闭，这里的事件处理会撤销它），
       * 再关通道杀掉远端命令；宽限期内通道仍未关闭（连接已挂死）就断开整条
       * 连接——脏连接不能留在池里被后续命令复用。
       */
      const terminate = (): void => {
        clearGrace()
        graceTimer = setTimeout(() => {
          graceTimer = undefined
          try { client.end() } catch { /* 已断开 */ }
        }, this.opts.execTimeoutGraceMs)
        if (channel !== undefined) closeChannel(channel)
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        terminate()
        resolvePromise({
          success: false, exitCode: null, timedOut: true, stdout, stderr,
          durationMs: Date.now() - startedAt,
        })
      }, limitMs)
      client.exec(command, (error, stream) => {
        if (error !== undefined) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolvePromise(fail(error))
          }
          return
        }
        if (settled) {
          // 超时之后迟到的通道：立即清理，别留下孤儿进程。
          closeChannel(stream)
          clearGrace()
          return
        }
        channel = stream
        stream.on('data', (chunk: Buffer) => { if (!settled) stdout += chunk.toString('utf8') })
        stream.stderr.on('data', (chunk: Buffer) => { if (!settled) stderr += chunk.toString('utf8') })
        stream.on('close', (code: number | null) => {
          clearGrace()
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolvePromise({
            success: code === 0,
            exitCode: code,
            timedOut: false,
            stdout,
            stderr,
            durationMs: Date.now() - startedAt,
          })
        })
        stream.on('error', (streamError: Error) => {
          clearGrace()
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolvePromise(fail(streamError))
        })
      })
    })
  }

  /**
   * 集群并发执行。`maxWorkers` 是真实生效的上限（历史上这个参数被忽略，
   * 每台主机各开一条连接）；未要求时保持历史行为，所有目标同时开跑。
   */
  async cluster(options: { command: string; aliases?: string[]; environment?: string; tags?: string[]; timeoutMs?: number; maxWorkers?: number }): Promise<ClusterResult[]> {
    const targets = this.resolveClusterTargets(options)
    const limit = clusterWorkerLimit(options.maxWorkers, targets.length)
    const results = new Array<ClusterResult>(targets.length)
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor
        cursor += 1
        const alias = targets[index]
        if (alias === undefined) return
        const exec = await this.exec(alias, options.command, options.timeoutMs)
        results[index] = {
          alias,
          ok: exec.success,
          exitCode: exec.exitCode,
          timedOut: exec.timedOut,
          stdout: exec.stdout,
          stderr: exec.stderr,
          durationMs: exec.durationMs,
          error: exec.error,
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, worker))
    return results
  }

  /** 解析集群目标：显式 aliases，或按 environment/tags 过滤全部主机。 */
  private resolveClusterTargets(options: { aliases?: string[]; environment?: string; tags?: string[] }): string[] {
    if (options.aliases !== undefined && options.aliases.length > 0) return options.aliases
    const entries = this.store.list()
    return entries
      .filter(entry => {
        if (options.environment !== undefined && entry.environment !== options.environment) return false
        if (options.tags !== undefined && options.tags.length > 0 && !options.tags.some(tag => entry.tags.includes(tag))) return false
        return true
      })
      .map(entry => entry.alias)
  }

  /** 打开交互 shell（PTY；独立连接，支持键盘交互 2FA 与背压）。 */
  async openShell(alias: string, size: { cols: number; rows: number }, onKeyboardInteractive?: KeyboardInteractiveHandler): Promise<ShellSession> {
    const record = await this.dial(alias, onKeyboardInteractive)
    const client = record.client
    try { this.validateReady(alias, record.configuration, record.peerKey) }
    catch (error) { client.destroy(); throw error }
    return new Promise((resolvePromise, rejectPromise) => {
      const aborted = (): void => { client.destroy(); rejectPromise(new Error('SSH engine disposed')) }
      this.abort.signal.addEventListener('abort', aborted, { once: true })
      client.shell({
        term: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
      }, (error, stream) => {
        this.abort.signal.removeEventListener('abort', aborted)
        if (error !== undefined) {
          client.end()
          rejectPromise(error)
          return
        }
        try { this.validateReady(alias, record.configuration, record.peerKey) }
        catch (error) { stream.close(); client.destroy(); rejectPromise(error); return }
        let paused = false
        const session: ShellSession = {
          onData: undefined,
          onExit: undefined,
          send: (data) => { if (stream.writable) stream.write(data) },
          resize: (cols, rows) => { stream.setWindow(Math.max(2, cols), Math.max(1, rows), 0, 0) },
          close: () => {
            try { stream.end() } catch { /* gone */ }
            client.end()
          },
          pause: () => { paused = true; stream.pause() },
          resume: () => { if (paused) { paused = false; stream.resume() } },
        }
        stream.on('data', (chunk: Buffer) => { if (!paused) session.onData?.(chunk) })
        stream.on('close', (code: number | null) => { session.onExit?.(code); client.end() })
        stream.on('error', (streamError: Error) => { session.onExit?.(null, streamError.message); client.end() })
        resolvePromise(session)
      })
    })
  }

  /** SFTP 列出目录。 */
  async ls(alias: string, remotePath: string): Promise<RemoteDirEntry[]> {
    const client = await this.acquire(alias)
    this.admitPooled(alias, client)
    return new Promise((resolvePromise, rejectPromise) => {
      client.sftp((error, sftp) => {
        if (error !== undefined) { rejectPromise(error); return }
        sftp.readdir(remotePath, (listError, list) => {
          if (listError !== undefined) { rejectPromise(listError); return }
          resolvePromise(list.map(item => ({
            name: item.filename,
            type: item.attrs.isDirectory() ? 'dir' as const : 'file' as const,
            size: item.attrs.size,
            mtimeMs: item.attrs.mtime * 1000,
            mode: item.attrs.mode,
          })))
        })
      })
    })
  }

  /** 本地端口转发（隧道）：loopback 监听 + forwardOut 管道 + 活 socket 跟踪。 */
  async tunnel(alias: string, localPort: number, remoteHost: string, remotePort: number): Promise<TunnelInfo> {
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error('remotePort must be an integer in 1..65535')
    if (localPort !== 0 && (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)) throw new Error('localPort must be an integer in 1..65535')
    if (this.store.find(alias) === undefined) throw new Error(`alias '${alias}' not found — add it first`)
    const host = remoteHost === '' ? '127.0.0.1' : remoteHost
    const id = `tun-${this.nextTunnelId}`
    this.nextTunnelId += 1
    const info: TunnelInfo = { id, alias, localPort: 0, remoteHost: host, remotePort, state: 'connecting', startedAt: Date.now() }
    const client = await this.acquire(alias)
    this.admitPooled(alias, client)
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
      client.forwardOut('127.0.0.1', 0, host, remotePort, (error, stream) => {
        if (error !== undefined) { socket.destroy(); return }
        const destroy = (): void => { try { socket.destroy() } catch { /* gone */ } try { stream.close() } catch { /* gone */ } }
        stream.on('error', destroy)
        socket.on('error', destroy)
        stream.on('close', destroy)
        socket.on('close', destroy)
        stream.pipe(socket).pipe(stream)
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(localPort === 0 ? 0 : localPort, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
    } catch (error) {
      server.close()
      throw error
    }
    if (this.disposed) { server.close(); throw new Error('SSH engine disposed') }
    const address = server.address() as { port: number } | null
    info.localPort = address?.port ?? 0
    info.state = 'forwarding'
    const record: TunnelRecord = { info, server, alias, sockets }
    this.tunnels.set(id, record)
    return info
  }

  /** 全部活动隧道（按 id 排序稳定）。 */
  listTunnels(): TunnelInfo[] {
    return [...this.tunnels.values()]
      .sort((a, b) => a.info.startedAt - b.info.startedAt)
      .map(record => ({ ...record.info }))
  }

  /** 停止一条隧道（关闭 listener、活 socket 与转发管道）。 */
  stopTunnel(id: string): boolean {
    const record = this.tunnels.get(id)
    if (record === undefined) return false
    this.tunnels.delete(id)
    record.info.state = 'failed'
    for (const socket of [...record.sockets]) { try { socket.destroy() } catch { /* gone */ } }
    record.sockets.clear()
    record.server.close()
    return true
  }

  /** 停止某主机的全部隧道（alias 为空则全部）。 */
  stopAllTunnels(alias?: string): number {
    let stopped = 0
    for (const [id, record] of [...this.tunnels.entries()]) {
      if (alias === undefined || record.alias === alias) {
        if (this.stopTunnel(id)) stopped += 1
      }
    }
    return stopped
  }

  /** 上传（单文件；NDJSON 进度回调，老协议 TransferProgress 结构）。 */
  async upload(alias: string, localPath: string, remotePath: string, onProgress?: (progress: TransferProgress) => void): Promise<{ bytes: number; files: number }> {
    const client = await this.acquire(alias)
    this.admitPooled(alias, client)
    const { statSync } = await import('node:fs')
    const totalBytes = statSync(localPath).size
    this.admitPooled(alias, client)
    return new Promise((resolvePromise, rejectPromise) => {
      client.sftp((error, sftp) => {
        if (error !== undefined) { rejectPromise(error); return }
        sftp.fastPut(localPath, remotePath, (putError) => {
          if (putError !== undefined) { rejectPromise(putError); return }
          onProgress?.({ phase: 'done', file: localPath, transferred: totalBytes, total: totalBytes, percent: 100 })
          resolvePromise({ bytes: totalBytes, files: 1 })
        })
      })
    })
  }

  /** 下载远程文件到本地（fastGet；进度回调，老协议 TransferProgress 结构）。 */
  async download(alias: string, remotePath: string, localPath: string, onProgress?: (progress: TransferProgress) => void): Promise<{ bytes: number }> {
    const client = await this.acquire(alias)
    this.admitPooled(alias, client)
    return new Promise((resolvePromise, rejectPromise) => {
      client.sftp((error, sftp) => {
        if (error !== undefined) { rejectPromise(error); return }
        sftp.stat(remotePath, (statError, attrs) => {
          if (statError !== undefined) { rejectPromise(statError); return }
          sftp.fastGet(remotePath, localPath, (getError) => {
            if (getError !== undefined) { rejectPromise(getError); return }
            const bytes = attrs.size
            onProgress?.({ phase: 'done', file: remotePath, transferred: bytes, total: bytes, percent: 100 })
            resolvePromise({ bytes })
          })
        })
      })
    })
  }
}