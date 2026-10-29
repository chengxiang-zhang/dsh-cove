import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostStore } from '../src/host/services/ssh/store.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { SSH_API, type TunnelInfo } from '../src/core/ssh/protocol.ts'
import { makeRoutes, type SshRoutesDeps } from '../src/host/services/ssh/routes.ts'
import type { SshEngine } from '../src/host/services/ssh/engine.ts'

/** 造一个假的 engine（只实现路由要用的方法）。 */
function fakeEngine(): SshEngine {
  const tunnels = new Map<string, TunnelInfo>()
  const next = { id: 1 }
  return {
    list: (query?: string) => {
      const entries = [
        { alias: 'dev', host: '192.168.1.2', port: 22, user: 'zcx', auth: { kind: 'key' as const }, proxyJump: [], tags: [], environment: 'prod', createdAt: 1, updatedAt: 1 },
        { alias: 'prod', host: '10.0.0.1', port: 22, user: 'root', auth: { kind: 'key' as const }, proxyJump: [], tags: ['db'], createdAt: 1, updatedAt: 1 },
      ]
      const needle = query?.trim().toLowerCase()
      const filtered = needle === undefined || needle === '' ? entries : entries.filter(e => e.alias.toLowerCase().includes(needle))
      return filtered.map(e => ({
        alias: e.alias, host: e.host, port: e.port, user: e.user, auth: e.auth.kind, keyReady: true,
        proxyJump: e.proxyJump, description: undefined, environment: e.environment, tags: e.tags, location: undefined, createdAt: e.createdAt, updatedAt: e.updatedAt,
      }))
    },
    find: () => undefined,
    acquire: vi.fn(async () => { throw new Error('unused') }),
    exec: vi.fn(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: 'ok', stderr: '', durationMs: 1 })),
    cluster: vi.fn(async () => [{ alias: 'dev', ok: true, exitCode: 0, stdout: 'ok', stderr: '' }]),
    ls: vi.fn(async () => [{ name: 'a', type: 'dir', size: 0, mtimeMs: 1 }]),
    listTunnels: () => [...tunnels.values()],
    tunnel: vi.fn(async (alias: string, localPort: number, remoteHost: string, remotePort: number) => {
      const info: TunnelInfo = { id: `tun-${next.id++}`, alias, localPort: localPort === 0 ? 40000 + next.id : localPort, remoteHost, remotePort, state: 'forwarding', startedAt: Date.now() }
      tunnels.set(info.id, info)
      return info
    }),
    stopTunnel: (id: string) => { const exists = tunnels.delete(id); return exists },
    stopAllTunnels: () => { const n = tunnels.size; tunnels.clear(); return n },
    upload: vi.fn(async () => ({ bytes: 0, files: 0 })),
    download: vi.fn(async () => ({ bytes: 0 })),
    openShell: vi.fn(),
    dispose: () => {},
  } as unknown as SshEngine
}

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  Object.assign(req, {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  })
  return req
}

async function run(deps: SshRoutesDeps, method: string, url: string, body?: unknown): Promise<{ status: number; text: string }> {
  const req = makeReq(method, url, body)
  let status = 0
  let text = ''
  const res = new EventEmitter() as unknown as ServerResponse & { writeHead(code: number): unknown; end(chunk?: string | Buffer): unknown; write(chunk: string | Buffer): boolean; writableEnded: boolean }
  Object.assign(res, {
    writeHead(code: number) { status = code; return this },
    end(chunk?: string | Buffer) { if (chunk !== undefined) text += chunk.toString(); this.emit('finish'); return this },
    write(chunk: string | Buffer) { text += chunk.toString(); return true },
    writableEnded: false,
  })
  const routes = makeRoutes(deps)
  const pathname = new URL(url, 'http://x').pathname
  const route = routes.find(r => r.kind === 'exact' && pathname === r.path)
  if (route === undefined) throw new Error(`no route for ${url}`)
  await (route as { handler(req: IncomingMessage, res: ServerResponse): Promise<void> }).handler(req, res as ServerResponse)
  return { status, text }
}

describe('ssh routes — restored legacy contract', () => {
  it('lists hosts with GET /hosts?query=', async () => {
    const engine = fakeEngine()
    const deps = { store: { find: () => undefined } as never, engine, logger: { warn: () => {} } }
    const { status, text } = await run(deps, 'GET', `${SSH_API.hosts}?query=dev`)
    expect(status).toBe(200)
    const body = JSON.parse(text) as { hosts: Array<{ alias: string }> }
    expect(body.hosts.map(h => h.alias)).toEqual(['dev'])
  })

  it('creates a host with POST /hosts returning {host}', async () => {
    const engine = fakeEngine()
    const upsert = vi.fn(() => ({ entry: { alias: 'new', createdAt: 1, updatedAt: 1 }, created: true }))
    const summarize = vi.fn(() => ({ alias: 'new', host: 'x', port: 22, user: 'u', auth: 'key', keyReady: true, proxyJump: [], tags: [] }))
    const store = { find: () => undefined, upsert, summarize } as never
    const deps = { store, engine, logger: { warn: () => {} } }
    const { status, text } = await run(deps, 'POST', SSH_API.hosts, { alias: 'new', host: 'x', user: 'u' })
    expect(status).toBe(201)
    expect(JSON.parse(text)).toHaveProperty('host.alias', 'new')
    expect(upsert).toHaveBeenCalled()
  })

  it('patches a host with PATCH /hosts?alias=', async () => {
    const engine = fakeEngine()
    const store = {
      find: () => ({ alias: 'dev', host: 'a', port: 22, user: 'u', auth: { kind: 'key' }, proxyJump: [], tags: [] }),
      upsert: vi.fn((input: unknown) => ({ entry: input as never, created: false })),
      summarize: vi.fn(() => ({ alias: 'dev', host: 'b', port: 22, user: 'u', auth: 'key', keyReady: true, proxyJump: [], tags: [] })),
    } as never
    const deps = { store, engine, logger: { warn: () => {} } }
    const { status } = await run(deps, 'PATCH', `${SSH_API.hosts}?alias=dev`, { host: 'b' })
    expect(status).toBe(200)
  })

  it('configures, validates, preserves and explicitly removes identity pins through host routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-route-pin-'))
    try {
      const store = new HostStore(join(dir, 'hosts.json'), join(dir, 'unused-config'))
      const deps = { store, engine: fakeEngine(), logger: { warn: () => {} } }
      const fingerprint = `SHA256:${'A'.repeat(43)}`
      const body = { alias: 'pinned', host: 'fixture.test', user: 'tester', port: 22, auth: { kind: 'password', password: 'fixture-password' }, proxyJump: [], tags: [], hostKeyFingerprint: fingerprint }
      expect((await run(deps, 'POST', SSH_API.hosts, { ...body, hostKeyFingerprint: 'invalid' })).status).toBe(400)
      const created = await run(deps, 'POST', SSH_API.hosts, body)
      expect(created.status).toBe(201)
      expect(JSON.parse(created.text).host.hostKeyFingerprint).toBe(fingerprint)
      const url = `${SSH_API.hosts}?alias=pinned`
      expect((await run(deps, 'PATCH', url, { description: 'keep pin' })).status).toBe(200)
      expect(store.find('pinned')?.hostKeyFingerprint).toBe(fingerprint)
      expect((await run(deps, 'PATCH', url, { hostKeyFingerprint: 123 })).status).toBe(400)
      expect(store.find('pinned')?.hostKeyFingerprint).toBe(fingerprint)
      expect((await run(deps, 'PATCH', url, { hostKeyFingerprint: null })).status).toBe(200)
      expect(store.find('pinned')?.hostKeyFingerprint).toBeUndefined()
      expect(store.find('pinned')?.auth.password).toBe('fixture-password')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('imports ssh config returning {result: ImportResult}', async () => {
    const engine = fakeEngine()
    const store = {
      find: () => undefined,
      importSshConfig: () => ({ imported: [{ alias: 'a' }], skipped: ['bad'] }),
    } as never
    const deps = { store, engine, logger: { warn: () => {} } }
    const { status, text } = await run(deps, 'POST', SSH_API.importSshConfig)
    expect(status).toBe(200)
    const body = JSON.parse(text) as { result: { parsed: number; added: number; skipped: number; skippedNames: string[] } }
    expect(body.result.parsed).toBe(2)
    expect(body.result.added).toBe(1)
    expect(body.result.skippedNames).toEqual(['bad'])
  })

  it('tests a host returning {result: TestResult}', async () => {
    const engine = fakeEngine()
    const deps = { store: { find: () => undefined } as never, engine, logger: { warn: () => {} } }
    const { status, text } = await run(deps, 'POST', SSH_API.test, { alias: 'dev' })
    expect(status).toBe(200)
    const body = JSON.parse(text) as { result: { ok: boolean; latencyMs: number } }
    expect(body.result.ok).toBe(true)
    expect(typeof body.result.latencyMs).toBe('number')
  })

  it('executes a command returning {result: ExecResult}', async () => {
    const engine = fakeEngine()
    const deps = { store: { find: () => undefined } as never, engine, logger: { warn: () => {} } }
    const { status, text } = await run(deps, 'POST', SSH_API.exec, { alias: 'dev', command: 'ls' })
    expect(status).toBe(200)
    expect(JSON.parse(text)).toHaveProperty('result.success', true)
  })

  it('lists a remote dir with GET /ls?alias&path', async () => {
    const engine = fakeEngine()
    const deps = { store: { find: () => undefined } as never, engine, logger: { warn: () => {} } }
    const { status, text } = await run(deps, 'GET', `${SSH_API.ls}?alias=dev&path=/tmp`)
    expect(status).toBe(200)
    const body = JSON.parse(text) as { entries: Array<{ name: string }> }
    expect(body.entries[0]?.name).toBe('a')
  })

  it('lists tunnels with POST /tunnel {action:list}', async () => {
    const engine = fakeEngine()
    const deps = { store: { find: () => undefined } as never, engine, logger: { warn: () => {} } }
    const { status, text } = await run(deps, 'POST', SSH_API.tunnel, { action: 'list' })
    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({ tunnels: [] })
  })

  it('starts a tunnel with POST /tunnel {action:start}', async () => {
    const engine = fakeEngine()
    const deps = { store: { find: () => undefined } as never, engine, logger: { warn: () => {} } }
    const { status, text } = await run(deps, 'POST', SSH_API.tunnel, { action: 'start', alias: 'dev', remotePort: 5432, remoteHost: '127.0.0.1' })
    expect(status).toBe(200)
    const body = JSON.parse(text) as { tunnel: TunnelInfo }
    expect(body.tunnel.alias).toBe('dev')
    expect(engine.listTunnels()).toHaveLength(1)
  })

  it('stops a tunnel with POST /tunnel {action:stop}', async () => {
    const engine = fakeEngine()
    const deps = { store: { find: () => undefined } as never, engine, logger: { warn: () => {} } }
    await run(deps, 'POST', SSH_API.tunnel, { action: 'start', alias: 'dev', remotePort: 5432 })
    const first = engine.listTunnels()[0]
    const { status, text } = await run(deps, 'POST', SSH_API.tunnel, { action: 'stop', tunnelId: first.id })
    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({ ok: true })
    expect(engine.listTunnels()).toHaveLength(0)
  })

  it('uploads through POST /upload with alias+remotePath query params', async () => {
    const engine = fakeEngine()
    const upload = vi.fn(async () => ({ bytes: 42, files: 1 }))
    ;(engine as unknown as { upload: typeof upload }).upload = upload
    const deps = { store: { find: () => undefined } as never, engine, logger: { warn: () => {} } }
    const req = makeReq('POST', `${SSH_API.upload}?alias=dev&remotePath=/tmp/x.bin`, 'payload')
    let status = 0
    let text = ''
    const res = new EventEmitter() as unknown as ServerResponse & { writeHead(code: number): unknown; end(chunk?: string | Buffer): unknown; write(chunk: string | Buffer): boolean; writableEnded: boolean }
    Object.assign(res, {
      writeHead(code: number) { status = code; return this },
      end(chunk?: string | Buffer) { if (chunk !== undefined) text += chunk.toString(); this.emit('finish'); return this },
      write(chunk: string | Buffer) { text += chunk.toString(); return true },
      writableEnded: false,
    })
    const routes = makeRoutes(deps)
    const route = routes.find(r => r.kind === 'exact' && r.path === SSH_API.upload)
    const finished = new Promise<void>((resolve) => { res.once('finish', () => resolve()) })
    const pending = (route as { handler(req: IncomingMessage, res: ServerResponse): Promise<void> }).handler(req, res as ServerResponse)
    req.emit('data', Buffer.from('payload'))
    req.emit('end')
    await Promise.all([pending, finished])
    expect(status).toBe(200)
    expect(text).toContain('"ok":true')
    expect(upload).toHaveBeenCalled()
  })

  it('keeps the terminal path route (upgrade handled by registerUpgrade)', async () => {
    const engine = fakeEngine()
    const deps = { store: { find: () => undefined } as never, engine, logger: { warn: () => {} } }
    const routes = makeRoutes(deps)
    const route = routes.find(r => r.path === SSH_API.terminal)
    expect(route).toBeDefined()
  })
})
