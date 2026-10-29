/**
 * ssh cluster/timeout bounds and the terminal path route:
 *
 *   1. `maxWorkers` is part of the cluster contract (core/ssh protocol + the
 *      client half send it) and the engine silently ignored it, so a cluster
 *      run opened one connection per host with no ceiling;
 *   2. an explicit `timeoutMs` had no upper bound, so one call could pin a
 *      connection (and an agent turn) for an arbitrary duration;
 *   3. the terminal prefix route answered 426 to every caller, including an
 *      untrusted one — a privileged route must refuse before it speaks.
 *
 * The engine's ssh2 dependency is mocked exactly as in ssh-exec-timeout.spec.ts.
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { SshHostEntry } from '../src/core/ssh/protocol.ts'
import { SSH_API } from '../src/core/ssh/protocol.ts'
import {
  MAX_CLUSTER_WORKERS, MAX_EXEC_TIMEOUT_MS, SshEngine, clusterWorkerLimit,
} from '../src/host/services/ssh/engine.ts'
import type { HostStore } from '../src/host/services/ssh/store.ts'
import { makeRoutes, type SshRoutesDeps } from '../src/host/services/ssh/routes.ts'

const h = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void
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
    signal(): void {}
    close(): void { this.emit('close', null) }
  }
  class FakeClient extends FakeEmitter {
    connect(): void { this.emit('ready') }
    end(): void { this.emit('close') }
    exec(command: string, callback: (error?: Error, stream?: FakeStream) => void): void {
      const stream = new FakeStream()
      queueMicrotask(() => {
        callback(undefined, stream)
        stream.emit('data', Buffer.from('ok\n'))
        stream.emit('close', 0)
      })
    }
  }
  return { FakeClient }
})

vi.mock('ssh2', () => ({ Client: h.FakeClient as unknown as typeof import('ssh2').Client }))

function entry(alias: string): SshHostEntry {
  return {
    alias, host: '10.0.0.9', port: 22, user: 'tester',
    auth: { kind: 'password', password: 'pw' }, proxyJump: [], tags: [], createdAt: 1, updatedAt: 1,
  }
}

function makeStore(aliases: string[]): HostStore {
  const entries = aliases.map(entry)
  return {
    find: (alias: string) => entries.find(candidate => candidate.alias === alias),
    list: () => entries,
    summarize: (target: SshHostEntry) => target,
  } as unknown as HostStore
}

describe('ssh cluster worker bound', () => {
  it('never exceeds the requested maxWorkers', async () => {
    const aliases = Array.from({ length: 10 }, (_, index) => `box-${index}`)
    const engine = new SshEngine(makeStore(aliases))
    let inFlight = 0
    let peak = 0
    engine.exec = (async (alias: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 2))
      inFlight -= 1
      return { success: true, exitCode: 0, timedOut: false, stdout: alias, stderr: '', durationMs: 2 }
    }) as unknown as SshEngine['exec']

    const results = await engine.cluster({ command: 'uptime', aliases, maxWorkers: 3 })
    expect(results).toHaveLength(10)
    expect(peak).toBe(3)
    engine.dispose()
  })

  it('keeps running every target in parallel when no maxWorkers is asked for', async () => {
    const aliases = ['a', 'b', 'c', 'd']
    const engine = new SshEngine(makeStore(aliases))
    let inFlight = 0
    let peak = 0
    engine.exec = (async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 2))
      inFlight -= 1
      return { success: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 2 }
    }) as unknown as SshEngine['exec']

    await engine.cluster({ command: 'uptime', aliases })
    expect(peak).toBe(4)
    engine.dispose()
  })

  it('clamps the worker count into the supported range', () => {
    expect(clusterWorkerLimit(undefined, 5)).toBe(5)
    expect(clusterWorkerLimit(0, 5)).toBe(5)
    expect(clusterWorkerLimit(Number.NaN, 5)).toBe(5)
    expect(clusterWorkerLimit(2, 5)).toBe(2)
    expect(clusterWorkerLimit(999, 5)).toBe(5)
    expect(clusterWorkerLimit(999, 50)).toBe(MAX_CLUSTER_WORKERS)
  })
})

describe('ssh exec timeout bound', () => {
  it('clamps an explicit timeout to the supported maximum', () => {
    const engine = new SshEngine(makeStore(['dev']))
    expect(engine.resolveExecTimeoutMs(500)).toBe(500)
    expect(engine.resolveExecTimeoutMs(Number.POSITIVE_INFINITY)).toBe(120_000)
    expect(engine.resolveExecTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_EXEC_TIMEOUT_MS)
    engine.dispose()
  })
})

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  Object.assign(req, {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  })
  return req
}

function makeRes(): { res: ServerResponse; result: () => { status: number; text: string } } {
  let status = 0
  let text = ''
  const res = new EventEmitter() as unknown as ServerResponse
  Object.assign(res, {
    writeHead(code: number) { status = code; return this },
    end(chunk?: string | Buffer) { if (chunk !== undefined) text += chunk.toString(); return this },
    write(chunk: string | Buffer) { text += chunk.toString(); return true },
    writableEnded: false,
  })
  return { res, result: () => ({ status, text }) }
}

const fakeEngine = { cluster: vi.fn(async () => []) } as never

describe('ssh cluster route arguments', () => {
  it('forwards maxWorkers to the engine instead of dropping it', async () => {
    const cluster = vi.fn(async () => [])
    const deps: SshRoutesDeps = { store: { find: () => undefined } as never, engine: { cluster } as never, logger: { warn: () => {} } }
    const routes = makeRoutes(deps)
    const route = routes.find(candidate => candidate.kind === 'exact' && candidate.path === SSH_API.cluster)
    const { res, result } = makeRes()
    await (route as { handler(req: IncomingMessage, res: ServerResponse): Promise<void> })
      .handler(makeReq('POST', SSH_API.cluster, { command: 'uptime', aliases: ['a', 'b'], maxWorkers: 2 }), res)
    expect(cluster).toHaveBeenCalledWith(expect.objectContaining({ maxWorkers: 2 }))
    expect(result().status).toBe(200)
  })

  it('drops a non-numeric maxWorkers instead of passing it through', async () => {
    const cluster = vi.fn(async () => [])
    const deps: SshRoutesDeps = { store: { find: () => undefined } as never, engine: { cluster } as never, logger: { warn: () => {} } }
    const routes = makeRoutes(deps)
    const route = routes.find(candidate => candidate.kind === 'exact' && candidate.path === SSH_API.cluster)
    const { res } = makeRes()
    await (route as { handler(req: IncomingMessage, res: ServerResponse): Promise<void> })
      .handler(makeReq('POST', SSH_API.cluster, { command: 'uptime', aliases: ['a'], maxWorkers: 'many' }), res)
    expect(cluster).toHaveBeenCalledWith(expect.objectContaining({ maxWorkers: undefined }))
  })
})

describe('ssh terminal path route', () => {
  it('refuses an untrusted caller before it answers at all', async () => {
    const deps: SshRoutesDeps = {
      store: { find: () => undefined } as never,
      engine: fakeEngine,
      logger: { warn: () => {} },
      isTrusted: () => false,
    }
    const routes = makeRoutes(deps)
    const route = routes.find(candidate => candidate.kind === 'prefix' && candidate.path === SSH_API.terminal)
    const { res, result } = makeRes()
    await (route as { handler(req: IncomingMessage, res: ServerResponse): Promise<void> })
      .handler(makeReq('GET', SSH_API.terminal), res)
    expect(result().status).toBe(403)
    expect(result().text).not.toContain('websocket')
  })

  it('answers 426 for a trusted caller and never opens a shell', async () => {
    const deps: SshRoutesDeps = {
      store: { find: () => undefined } as never,
      engine: { ...(fakeEngine as object), openShell: vi.fn() } as never,
      logger: { warn: () => {} },
      isTrusted: () => true,
    }
    const routes = makeRoutes(deps)
    const route = routes.find(candidate => candidate.kind === 'prefix' && candidate.path === SSH_API.terminal)
    const { res, result } = makeRes()
    await (route as { handler(req: IncomingMessage, res: ServerResponse): Promise<void> })
      .handler(makeReq('GET', SSH_API.terminal), res)
    expect(result().status).toBe(426)
  })
})