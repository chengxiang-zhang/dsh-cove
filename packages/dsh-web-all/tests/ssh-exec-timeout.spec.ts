/**
 * ssh_exec 超时契约（回归门禁）：
 *
 *   1. 未显式传 timeoutMs 时用插件默认超时（DEFAULT_EXEC_TIMEOUT_MS），不再无限等待；
 *   2. 超时必须真的终结远端命令——关闭通道（sshd 随通道关闭清理进程组），
 *      宽限期内通道仍未关闭则断开整条连接，脏连接不进池；
 *   3. 超时后迟到的通道立即清理，不留孤儿进程；
 *   4. 调用方显式 timeoutMs 优先于配置默认值；cluster 走同一条默认值。
 *
 * ssh2 被替换为假 Client，测试只关心引擎的超时/清理编排。
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { utils } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { hostKeyFingerprint } from '../src/host/services/ssh/host-keys.ts'
import type { SshHostEntry } from '../src/core/ssh/protocol.ts'
import { DEFAULT_EXEC_TIMEOUT_MS, SshEngine } from '../src/host/services/ssh/engine.ts'
import type { HostStore } from '../src/host/services/ssh/store.ts'

const h = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void

  /** 极简事件发射器：不依赖 node:events（vi.hoisted 早于 import 求值）。 */
  class FakeEmitter {
    private readonly handlers = new Map<string, Handler[]>()
    on(event: string, handler: Handler): this {
      const list = this.handlers.get(event)
      if (list === undefined) this.handlers.set(event, [handler])
      else list.push(handler)
      return this
    }
    once(event: string, handler: Handler): this {
      const wrapper: Handler = (...args: unknown[]) => { this.off(event, wrapper); handler(...args) }
      return this.on(event, wrapper)
    }
    off(event: string, handler: Handler): this {
      const list = this.handlers.get(event)
      if (list !== undefined) this.handlers.set(event, list.filter(item => item !== handler))
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args)
    }
  }

  class FakeStream extends FakeEmitter {
    readonly stderr = new FakeEmitter()
    readonly signalCalls: string[] = []
    closeCalls = 0
    /** 关闭时是否同步回 close 事件（模拟守规矩的服务端）。 */
    emitCloseOnClose = false
    signal(name: string): void { this.signalCalls.push(name) }
    close(): void {
      this.closeCalls += 1
      if (this.emitCloseOnClose) this.emit('close', null)
    }
  }

  class FakeClient extends FakeEmitter {
    readonly execCalls: Array<{ command: string; callback: (error?: Error, stream?: FakeStream) => void }> = []
    endCalls = 0
    connectConfig: unknown
    constructor() {
      super()
      clients.push(this)
    }
    connect(config: unknown): void {
      this.connectConfig = config
      const verifier = (config as { hostVerifier?: (key: Buffer) => boolean }).hostVerifier
      if (verifier === undefined || !verifier(handshake.key)) {
        this.emit('error', new Error('fixture server identity rejected'))
        return
      }
      this.emit('ready')
    }
    destroy(): void { this.end() }
    end(): void {
      this.endCalls += 1
      this.emit('close')
    }
    exec(command: string, callback: (error?: Error, stream?: FakeStream) => void): void {
      this.execCalls.push({ command, callback })
    }
  }

  const clients: FakeClient[] = []
  const handshake: { key: Buffer } = { key: Buffer.alloc(0) }
  return { FakeEmitter, FakeStream, FakeClient, clients, handshake }
})

vi.mock('ssh2', async original => {
  const actual = await original<typeof import('ssh2') & { default?: typeof import('ssh2') }>()
  return { Client: h.FakeClient as unknown as typeof import('ssh2').Client, utils: actual.utils ?? actual.default?.utils }
})

// A real ephemeral wire-format public key exercises production host verification;
// only the transport/timing is fake. No real known_hosts or credentials are read.
const ephemeralPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const parsedKey = utils.parseKey(ephemeralPrivateKey)
if (parsedKey instanceof Error) throw parsedKey
h.handshake.key = parsedKey.getPublicSSH()

const ENTRY: SshHostEntry = {
  alias: 'dev',
  host: '10.0.0.9',
  hostKeyFingerprint: hostKeyFingerprint(h.handshake.key),
  port: 22,
  user: 'tester',
  auth: { kind: 'password', password: 'pw' },
  proxyJump: [],
  tags: [],
  createdAt: 1,
  updatedAt: 1,
}

const absentKnownHostsPath = join(tmpdir(), `ssh-timeout-absent-${randomUUID()}`, 'known_hosts')
function makeEngine(options: ConstructorParameters<typeof SshEngine>[1] = {}): SshEngine {
  return new SshEngine(makeStore(), { ...options, knownHostsPath: absentKnownHostsPath })
}

function makeStore(): HostStore {
  return {
    find: (alias: string) => (alias === ENTRY.alias ? ENTRY : undefined),
    list: () => [ENTRY],
    summarize: () => ENTRY,
  } as unknown as HostStore
}

/** 冲干净微任务链（connect → acquire → exec 的 Promise 组装）。 */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 25; index += 1) await Promise.resolve()
}

function lastClient(): InstanceType<typeof h.FakeClient> {
  const client = h.clients.at(-1)
  if (client === undefined) throw new Error('no fake client was created')
  return client
}

describe('ssh exec timeout', () => {
  it('fires the default timeout, closes the channel and drops a wedged connection', async () => {
    vi.useFakeTimers()
    try {
      const engine = makeEngine({ execTimeoutMs: 30, execTimeoutGraceMs: 25 })
      const pending = engine.exec('dev', 'tail -f /var/log/syslog')
      await flushMicrotasks()
      const stream = new h.FakeStream()
      lastClient().execCalls[0]!.callback(undefined, stream)
      stream.emit('data', Buffer.from('partial line\n'))

      vi.advanceTimersByTime(29)
      expect(stream.closeCalls).toBe(0)

      vi.advanceTimersByTime(1)
      const result = await pending
      expect(result.timedOut).toBe(true)
      expect(result.success).toBe(false)
      expect(result.exitCode).toBeNull()
      expect(result.stdout).toBe('partial line\n')
      expect(stream.signalCalls).toEqual(['KILL'])
      expect(stream.closeCalls).toBe(1)
      // 通道没有自行关闭：宽限期内不动连接，到期才断开整条连接。
      expect(lastClient().endCalls).toBe(0)
      vi.advanceTimersByTime(24)
      expect(lastClient().endCalls).toBe(0)
      vi.advanceTimersByTime(1)
      expect(lastClient().endCalls).toBe(1)
      engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the pooled connection when the channel closes inside the grace period', async () => {
    vi.useFakeTimers()
    try {
      const engine = makeEngine({ execTimeoutMs: 20, execTimeoutGraceMs: 40 })
      const pending = engine.exec('dev', 'sleep 60')
      await flushMicrotasks()
      const stream = new h.FakeStream()
      stream.emitCloseOnClose = true
      lastClient().execCalls[0]!.callback(undefined, stream)

      vi.advanceTimersByTime(20)
      const result = await pending
      expect(result.timedOut).toBe(true)
      expect(stream.closeCalls).toBe(1)

      vi.advanceTimersByTime(500)
      expect(lastClient().endCalls).toBe(0)
      engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a channel that arrives after the timeout instead of orphaning the command', async () => {
    vi.useFakeTimers()
    try {
      const engine = makeEngine({ execTimeoutMs: 20, execTimeoutGraceMs: 50 })
      const pending = engine.exec('dev', 'yes')
      await flushMicrotasks()
      vi.advanceTimersByTime(20)
      const result = await pending
      expect(result.timedOut).toBe(true)

      const late = new h.FakeStream()
      lastClient().execCalls[0]!.callback(undefined, late)
      expect(late.signalCalls).toEqual(['KILL'])
      expect(late.closeCalls).toBe(1)
      vi.advanceTimersByTime(500)
      expect(lastClient().endCalls).toBe(0)
      engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets an explicit timeoutMs override the configured default in both directions', async () => {
    vi.useFakeTimers()
    try {
      const slowDefault = makeEngine({ execTimeoutMs: 10_000, execTimeoutGraceMs: 10 })
      const shortRun = slowDefault.exec('dev', 'sleep 60', 15)
      await flushMicrotasks()
      const shortStream = new h.FakeStream()
      lastClient().execCalls[0]!.callback(undefined, shortStream)
      vi.advanceTimersByTime(15)
      expect((await shortRun).timedOut).toBe(true)
      slowDefault.dispose()

      const fastDefault = makeEngine({ execTimeoutMs: 15, execTimeoutGraceMs: 10 })
      const longRun = fastDefault.exec('dev', 'build', 10_000)
      await flushMicrotasks()
      const longStream = new h.FakeStream()
      lastClient().execCalls[0]!.callback(undefined, longStream)
      vi.advanceTimersByTime(40)
      longStream.emit('close', 0)
      const longResult = await longRun
      expect(longResult.timedOut).toBe(false)
      expect(longResult.success).toBe(true)
      fastDefault.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies the configured default to cluster runs', async () => {
    vi.useFakeTimers()
    try {
      const engine = makeEngine({ execTimeoutMs: 25, execTimeoutGraceMs: 10 })
      const pending = engine.cluster({ aliases: ['dev'], command: 'sleep 60' })
      await flushMicrotasks()
      const stream = new h.FakeStream()
      lastClient().execCalls[0]!.callback(undefined, stream)
      vi.advanceTimersByTime(25)
      const results = await pending
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({ alias: 'dev', ok: false, timedOut: true })
      expect(stream.closeCalls).toBe(1)
      engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves the timeout from the call, then the live config source, then the plugin default', () => {
    const engine = makeEngine({ execTimeoutMs: 0 })
    try {
      expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(120_000)
      expect(engine.resolveExecTimeoutMs()).toBe(DEFAULT_EXEC_TIMEOUT_MS)
      expect(engine.resolveExecTimeoutMs(5_000)).toBe(5_000)
      expect(engine.resolveExecTimeoutMs(0)).toBe(DEFAULT_EXEC_TIMEOUT_MS)
      expect(engine.resolveExecTimeoutMs(-1)).toBe(DEFAULT_EXEC_TIMEOUT_MS)
      expect(engine.resolveExecTimeoutMs(Number.NaN)).toBe(DEFAULT_EXEC_TIMEOUT_MS)

      let configured: number | undefined
      const hot = makeEngine({ execTimeoutMs: () => configured })
      try {
        expect(hot.resolveExecTimeoutMs()).toBe(DEFAULT_EXEC_TIMEOUT_MS)
        configured = 7
        expect(hot.resolveExecTimeoutMs()).toBe(7)
        expect(hot.resolveExecTimeoutMs(3)).toBe(3)
        configured = undefined
        expect(hot.resolveExecTimeoutMs()).toBe(DEFAULT_EXEC_TIMEOUT_MS)
      } finally {
        hot.dispose()
      }
    } finally {
      engine.dispose()
    }
  })
})