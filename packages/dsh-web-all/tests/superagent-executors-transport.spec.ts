/**
 * Executor transport (T19 addendum): endpoint resolution and the HTTP transport.
 *
 * The HTTP side is exercised against a real loopback server that answers the same
 * `/api` envelopes the web host answers, so the wire shape is part of the test:
 * `agentPresets/list`, `session/create`, `session/selectModel`, `session/prompt`,
 * `session/cancel`, `session/projections`, `session/page`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureExecutorSession } from '../src/host/services/superagent/executors/transport/bind-executor-session.ts'
import { EndpointError, realmOfTarget, resolveEndpoint, scopePathOf } from '../src/host/services/superagent/executors/transport/endpoint.ts'
import { createHttpTransport } from '../src/host/services/superagent/executors/transport/http.ts'
import { createInprocTransport } from '../src/host/services/superagent/executors/transport/inproc.ts'
import { createTransportFactory } from '../src/host/services/superagent/executors/transport/index.ts'
import type { ExecutorCreateRequest, ExecutorCreateResult, ExecutorSnapshot, ExecutorTransport } from '../src/host/services/superagent/executors/transport/types.ts'

const config = {
  transport: 'http' as const,
  localBaseUrl: 'http://127.0.0.1:1',
  hosts: [
    { host: 'pc-tower', addr: '100.108.210.74' },
    { host: 't470p', baseUrl: 'http://100.108.181.163', trustedHost: 'dsh.zcx-t470p.netbird' },
  ],
}

describe('transport endpoints', () => {
  it('1. a bare or local target lands on loopback with no credentials', () => {
    expect(realmOfTarget(null)).toEqual({ realm: 'local' })
    expect(realmOfTarget('local/repo')).toEqual({ realm: 'local' })
    const endpoint = resolveEndpoint(undefined, config)
    expect(endpoint).toMatchObject({ realm: 'local', baseUrl: 'http://127.0.0.1:1', headers: {} })
  })

  it('2. netbird/<host>/... resolves to the allowlisted address and canonical Host', () => {
    expect(realmOfTarget('netbird/pc-tower/~/code/x')).toEqual({ realm: 'netbird', host: 'pc-tower' })
    expect(resolveEndpoint('netbird/pc-tower/~/code/x', config)).toEqual({
      realm: 'netbird', host: 'pc-tower', baseUrl: 'http://100.108.210.74', headers: { Host: 'dsh.pc-tower.netbird' },
    })
    expect(resolveEndpoint('netbird/t470p/x', config)).toMatchObject({
      baseUrl: 'http://100.108.181.163', headers: { Host: 'dsh.zcx-t470p.netbird' },
    })
  })

  it('3. unlisted machines, external targets and scopeless machines are refused', () => {
    expect(() => resolveEndpoint('netbird/unknown/x', config)).toThrow(EndpointError)
    expect(() => resolveEndpoint('external/acme/org', config)).toThrow(/external/)
    expect(() => resolveEndpoint('netbird/noaddr/x', { ...config, hosts: [{ host: 'noaddr' }] })).toThrow(/no address/)
    expect(scopePathOf('netbird/pc-tower/x')).toBe('netbird/pc-tower/x')
    expect(scopePathOf(null)).toBeUndefined()
  })

  it('4. the in-process factory refuses a remote target instead of running it locally', () => {
    const factory = createTransportFactory({ config: { transport: 'inproc' }, controller: () => { throw new Error('unused') } })
    expect(factory.forTarget('local/x')).toMatchObject({ kind: 'inproc' })
    expect(() => factory.forTarget('netbird/pc-tower/x')).toThrow(/cannot run work on another machine/)
  })
})

interface Wire { method: string; args: Record<string, unknown> }

/** A loopback stand-in for the web host's Remote surface. */
function fakeHost(options: { presets?: string[]; cursor?: number; events?: unknown[]; refuseModel?: boolean; holdProjection?: (release: () => void) => void; duplicateCreate?: boolean } = {}) {
  const calls: Wire[] = []
  const state = {
    presets: options.presets ?? ['standard', 'superagent-executor'],
    cursor: options.cursor ?? 0,
    events: options.events ?? [] as unknown[],
    exists: true,
    headers: {} as Record<string, unknown>,
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let body: { method: string; payload: { args: Record<string, unknown> } }
      try { body = JSON.parse(text) as typeof body } catch { res.writeHead(400); res.end(); return }
      state.headers = req.headers
      calls.push({ method: body.method, args: body.payload.args })
      const ok = (value: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: 't', result: { ok: true, value } }))
      }
      switch (body.method) {
        case 'agentPresets/list': ok({ presets: state.presets.map(id => ({ id })) }); return
        case 'session/create': {
          const request = body.payload.args.request as { sessionId: string; agentPreset?: string; cwd: string }
          if (options.duplicateCreate && calls.filter(c => c.method === 'session/create').length === 1) { res.end(JSON.stringify({ result: { ok: false, error: { code: 'SESSION_CWD_CONFLICT', message: `session "${request.sessionId}" belongs to "/stale", not "${request.cwd}"` } } })); return }
          ok({ sessionId: request.sessionId, agentPreset: request.agentPreset ?? 'standard' }); return
        }
        case 'session/selectModel': {
          if (options.refuseModel) { res.end(JSON.stringify({ result: { ok: false, error: { code: 'MODEL_UNAVAILABLE', message: 'required route refused' } } })); return }
          const request = body.payload.args.request as { provider: string; model: string }
          ok({ selected: { provider: request.provider, model: request.model } }); return
        }
        case 'session/projections': { const reply = () => ok(state.exists ? { asOfSeq: state.cursor, values: {} } : null); if (options.holdProjection) options.holdProjection(reply); else reply(); return }
        case 'session/page': {
          const request = body.payload.args.request as { throughSeq: number }
          const events = state.events.filter((e) => {
            const seq = (e as { seq?: number }).seq
            return typeof seq === 'number' && seq <= request.throughSeq
          })
          ok({ records: events.map(event => ({ type: 'event', event })), hasMore: false }); return
        }
        case 'session/prompt': ok({ accepted: true }); return
        case 'session/cancel': ok({ accepted: true }); return
        default: {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'server-response', rpcId: 't', result: { ok: false, error: { code: 'gateway/not-found', message: `no ${body.method}` } } }))
        }
      }
    })
  })
  return { server, calls, state }
}

const closers: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const close of closers.splice(0)) await close() })

async function serve(options: Parameters<typeof fakeHost>[0] = {}) {
  const host = fakeHost(options)
  await new Promise<void>(resolve => host.server.listen(0, '127.0.0.1', resolve))
  const port = (host.server.address() as AddressInfo).port
  closers.push(() => new Promise<void>(resolve => host.server.close(() => resolve())))
  return { ...host, port }
}

const event = (type: string, seq: number, data: Record<string, unknown> = {}) => ({ type, seq, time: 1000 + seq, data })

describe('http executor transport', () => {
  it('5. create sends the attempt identity and degrades a missing preset to standard', async () => {
    const host = await serve({ presets: ['standard'] })
    const transport = createHttpTransport({ config: { ...config, localBaseUrl: `http://127.0.0.1:${host.port}` } })
    const created = await transport.create({ sessionId: 'sa-x-C-1-a1', cwd: '/tmp/seat', preset: 'superagent-executor' })
    expect(created).toEqual({ sessionId: 'sa-x-C-1-a1', agentPreset: 'standard', presetDegraded: { asked: 'superagent-executor', used: 'standard' } })
    transport.dispose()
    expect(host.calls.map(c => c.method)).toEqual(['agentPresets/list', 'session/create'])
    expect(host.calls[1]?.args).toEqual({ request: { sessionId: 'sa-x-C-1-a1', cwd: '/tmp/seat', agentPreset: 'standard' } })
  })

  it('6. create pins the model through session/selectModel and prompts through session/prompt', async () => {
    const host = await serve()
    const transport = createHttpTransport({ config: { ...config, localBaseUrl: `http://127.0.0.1:${host.port}` } })
    await transport.create({ sessionId: 'sa-x-C-1-a1', cwd: '/tmp/seat', preset: 'superagent-executor',
      model: { provider: 'kaon-router', model: 'kaon/deepseek-v4.1-flash', effort: 'high' } })
    await transport.prompt({ sessionId: 'sa-x-C-1-a1', requestId: 'dispatch:a1', mode: 'queue', text: 'brief' })
    await transport.cancel('sa-x-C-1-a1')
    transport.dispose()
    expect(host.calls.map(c => c.method)).toEqual(['agentPresets/list', 'session/create', 'session/selectModel', 'session/prompt', 'session/cancel'])
    expect(host.calls[2]?.args).toEqual({ request: { sessionId: 'sa-x-C-1-a1', provider: 'kaon-router', model: 'kaon/deepseek-v4.1-flash', reasoningEffort: 'high' } })
    expect(host.calls[3]?.args).toEqual({ request: { sessionId: 'sa-x-C-1-a1', mode: 'queue', content: [{ type: 'text', text: 'brief' }], requestId: 'dispatch:a1' } })
  })

  it('7. snapshot reads the cursor from the projection and the tail from the page', async () => {
    const host = await serve({ cursor: 12, events: [event('turn/start', 10), event('tool/call', 11), event('turn/end', 12)] })
    const transport = createHttpTransport({ config: { ...config, localBaseUrl: `http://127.0.0.1:${host.port}` } })
    const snapshot = await transport.snapshot('sa-x-C-1-a1')
    transport.dispose()
    expect(snapshot).toMatchObject({ exists: true, running: false, cursor: 12 })
    expect(snapshot.events.map(e => e.type)).toEqual(['turn/start', 'tool/call', 'turn/end'])
  })

  it('8. a missing session is "does not exist", not an error', async () => {
    const host = await serve()
    host.state.exists = false
    const transport = createHttpTransport({ config: { ...config, localBaseUrl: `http://127.0.0.1:${host.port}` } })
    expect(await transport.snapshot('sa-x-C-1-a1')).toEqual({ exists: false, running: false, cursor: 0, events: [] })
    transport.dispose()
  })

  it('9. watch forwards events that appear after it starts, and stops when asked', async () => {
    const host = await serve({ cursor: 1, events: [event('turn/start', 1, { turn: 1 })] })
    const transport = createHttpTransport({ config: { ...config, localBaseUrl: `http://127.0.0.1:${host.port}`, pollMs: 15 } })
    const seen: number[] = []
    const stop = transport.watch('sa-x-C-1-a1', e => seen.push(e.seq))
    await expect.poll(() => seen).toContain(1)
    host.state.events.push(event('tool/call', 2, { name: 'bash', callId: 'c1' }))
    host.state.cursor = 2
    await expect.poll(() => seen).toContain(2)
    stop()
    const afterStop = seen.length
    host.state.events.push(event('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }))
    host.state.cursor = 3
    await new Promise(resolve => setTimeout(resolve, 80))
    transport.dispose()
    expect(seen).toContain(2)
    expect(seen.length).toBe(afterStop)
  })

  it('10. a Host-trusting machine gets the canonical Host header', async () => {
    const host = await serve()
    const transport = createHttpTransport({ config: { ...config, hosts: [{ host: 'pc-tower', baseUrl: `http://127.0.0.1:${host.port}` }] }, target: 'netbird/pc-tower/x' })
    await transport.create({ sessionId: 'sa-x-C-1-a1', cwd: '/home/pc/code/x', preset: 'standard' })
    transport.dispose()
    expect(host.state.headers.host).toBe('dsh.pc-tower.netbird')
  })

  it('12. the mux push channel delivers events before the slow poll does', async () => {
    const server = createServer((req, res) => { res.writeHead(404); res.end() })
    const wss = new WebSocketServer({ noServer: true })
    let stream = ''
    let socket: WebSocket | undefined
    server.on('upgrade', (req, sock, head) => {
      if (req.url !== '/api/remote.mux') { sock.destroy(); return }
      wss.handleUpgrade(req, sock, head, ws => {
        socket = ws
        ws.on('message', (raw: WebSocket.RawData) => {
          const frame = JSON.parse(raw.toString()) as { type: string; streamId: string }
          if (frame.type !== 'open') return
          stream = frame.streamId
          ws.send(JSON.stringify({ type: 'item', streamId: stream,
            value: { type: 'snapshot', header: { version: 1 }, cursor: 1, records: [], hasMore: false, projections: { asOfSeq: 1, values: {} } } }))
        })
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    closers.push(() => new Promise<void>(resolve => { wss.close(); server.close(() => resolve()) }))

    // A five second poll interval: only the push channel can deliver this quickly.
    const transport = createHttpTransport({ config: { ...config, localBaseUrl: `http://127.0.0.1:${port}`, pollMs: 5000 } })
    const seen: number[] = []
    const stop = transport.watch('sa-x-C-1-a1', event => seen.push(event.seq))
    await new Promise(resolve => setTimeout(resolve, 120))
    socket?.send(JSON.stringify({ type: 'item', streamId: stream, value: { type: 'event', event: event('tool/call', 2, { name: 'bash', callId: 'c1' }) } }))
    await new Promise(resolve => setTimeout(resolve, 200))
    stop()
    transport.dispose()
    expect(seen).toContain(2)
  })

  it('11. the in-process transport answers the same interface from a controller', async () => {
    const calls: string[] = []
    const controller = {
      async create(req: { sessionId?: string }) { calls.push('create'); return { sessionId: req.sessionId } },
      async prompt() { calls.push('prompt'); return { accepted: true } },
      cancel() { calls.push('cancel') },
      async inspect() { return { events: [event('turn/start', 1), event('turn/end', 2)] } },
    }
    const transport = createInprocTransport(() => controller)
    expect(await transport.snapshot('s1')).toMatchObject({ exists: true, running: false, cursor: 2 })
    await transport.create({ sessionId: 'sa-x-C-1-a1', cwd: '/tmp', preset: 'superagent-executor' })
    await transport.prompt({ sessionId: 'sa-x-C-1-a1', requestId: 'r', mode: 'queue', text: 't' })
    transport.cancel('sa-x-C-1-a1')
    expect(calls).toEqual(['create', 'prompt', 'cancel'])
    expect(transport.watch('s1', () => undefined)()).toBeUndefined()
  })
})

describe('ensureExecutorSession', () => {
  it('12. engine cwd-conflict text cannot authorize cancelling a session without ownership attestation', async () => {
    const wanted = '/Users/leo/.dsh/superagent/work/C-3'
    const stale = '/var/folders/x/sa-e2e-tmp/seat/work/C-3'
    const calls: string[] = []
    let createN = 0
    const transport: ExecutorTransport = {
      kind: 'http',
      async create(req: ExecutorCreateRequest): Promise<ExecutorCreateResult> {
        createN += 1
        calls.push(`create:${req.cwd}`)
        if (createN === 1) throw new Error(`session "${req.sessionId}" belongs to "${stale}", not "${req.cwd}"`)
        return { sessionId: req.sessionId, agentPreset: 'superagent-executor' }
      },
      async prompt() { /* unused */ },
      async cancel(sessionId) { calls.push(`cancel:${sessionId}`) },
      async snapshot(): Promise<ExecutorSnapshot> {
        // HTTP today reports existence without cwd; without the error-text path this
        // would be mis-read as "reattach" and keep the stale seat.
        return { exists: true, running: false, cursor: 0, events: [] }
      },
      watch() { return () => undefined },
      dispose() { /* unused */ },
    }
    await expect(ensureExecutorSession(transport, { sessionId: 'sa-x-C-3-a1', cwd: wanted, preset: 'superagent-executor' })).rejects.toThrow('belongs to')
    expect(calls).toEqual([`create:${wanted}`])
  })
})
it('propagates a required HTTP model refusal after create and never prompts the default route', async () => {
  const host = await serve({ refuseModel: true })
  const transport = createHttpTransport({ config: { ...config, localBaseUrl: `http://127.0.0.1:${host.port}` } })
  try {
    await expect((async () => {
      const session = await ensureExecutorSession(transport, { sessionId: 'refused', cwd: '/authorized', model: { provider: 'required', model: 'required' } })
      await transport.prompt({ sessionId: session.sessionId, requestId: 'prompt', text: 'execute', mode: 'queue' })
    })()).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
    expect(host.calls.map(c => c.method)).toEqual(['session/create', 'session/selectModel'])
  } finally { transport.dispose() }
})

it('dispose closes active HTTP sockets and rejects future watches without caller stop', async () => {
  const host = await serve(), wss = new WebSocketServer({ server: host.server })
  let ready!: () => void, socket!: WebSocket, stream = ''
  const opened = new Promise<void>(resolve => { ready = resolve })
  wss.on('connection', ws => { socket = ws; ws.on('message', raw => { stream = JSON.parse(raw.toString()).streamId; ready() }) })
  const transport = createHttpTransport({ config: { ...config, localBaseUrl: `http://127.0.0.1:${host.port}` } })
  const seen: number[] = [], stop = transport.watch('active', e => seen.push(e.seq))
  try {
    await opened
    transport.dispose()
    socket.send(JSON.stringify({ type: 'item', streamId: stream, value: { type: 'event', event: event('turn/end', 1) } }))
    await expect.poll(() => wss.clients.size).toBe(0)
    expect(seen).toEqual([])
    expect(() => transport.watch('later', () => {})).toThrow('TRANSPORT_DISPOSED')
  } finally { stop(); for (const ws of wss.clients) ws.terminate(); wss.close(); transport.dispose() }
})

it('dispose during an in-flight HTTP poll cannot deliver or schedule another poll', async () => {
  let release!: () => void, ready!: () => void
  const entered = new Promise<void>(resolve => { ready = resolve })
  const host = await serve({ cursor: 1, events: [event('turn/end', 1)], holdProjection: done => { if (release) done(); else { release = done; ready() } } })
  const transport = createHttpTransport({ config: { ...config, localBaseUrl: `http://127.0.0.1:${host.port}`, pollMs: 1 } })
  const seen: number[] = [], stop = transport.watch('active', e => seen.push(e.seq))
  try {
    await entered; vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); transport.dispose(); release()
    // A separate completed HTTP request is a barrier for the released response.
    await transport.create({ sessionId: 'barrier', cwd: '/authorized' })
    expect(seen).toEqual([])
    expect(host.calls.filter(c => c.method === 'session/page')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => transport.watch('later', () => {})).toThrow('TRANSPORT_DISPOSED')
  } finally { stop(); transport.dispose() }
})

it.each(['MODEL_UNAVAILABLE', 'PRESET_UNAVAILABLE', 'HOST_PROTOCOL', 'SESSION_EXISTS'])('never reattaches a %s refusal based on an unattested snapshot cwd', async code => {
  const failure = Object.assign(Error(code), { code })
  const transport: ExecutorTransport = { kind: 'http', create: async () => { throw failure }, snapshot: async () => ({ exists: true, running: false, cursor: 0, events: [] }), cancel: async () => { throw Error('must not cancel') }, prompt: async () => { throw Error('must not prompt') }, watch: () => () => {}, dispose() {} }
  await expect(ensureExecutorSession(transport, { sessionId: 'attempt', cwd: '/authorized' })).rejects.toBe(failure)
})

it.each(['MODEL_UNAVAILABLE', 'PRESET_UNAVAILABLE', 'HOST_PROTOCOL'])('preserves %s even when its message contains conflict-shaped text', async code => {
  const failure = Object.assign(Error('session "attempt" belongs to "/stale", not "/authorized"'), { code })
  const transport: ExecutorTransport = { kind: 'http', create: async () => { throw failure }, snapshot: async () => ({ exists: true, running: false, cursor: 0, events: [], cwd: '/authorized' }), cancel: async () => { throw Error('must not cancel setup refusal') }, prompt: async () => {}, watch: () => () => {}, dispose() {} }
  await expect(ensureExecutorSession(transport, { sessionId: 'attempt', cwd: '/authorized' })).rejects.toBe(failure)
})

it('does not infer create-stage authority from an unmarked conflict-shaped exception', async () => {
  const failure = Error('session "attempt" belongs to "/stale", not "/authorized"')
  const transport: ExecutorTransport = { kind: 'http', create: async () => { throw failure }, snapshot: async () => ({ exists: true, running: false, cursor: 0, events: [] }), cancel: async () => { throw Error('must not cancel unmarked failure') }, prompt: async () => {}, watch: () => () => {}, dispose() {} }
  await expect(ensureExecutorSession(transport, { sessionId: 'attempt', cwd: '/authorized' })).rejects.toBe(failure)
})

it('preserves an actual HTTP create-stage conflict without cancelling an ownership-unknown session', async () => {
  const host = await serve({ duplicateCreate: true })
  const transport = createHttpTransport({ config: { ...config, localBaseUrl: `http://127.0.0.1:${host.port}` } })
  try {
    await expect(ensureExecutorSession(transport, { sessionId: 'attempt', cwd: '/authorized', model: { provider: 'required', model: 'required' } })).rejects.toMatchObject({ code: 'SESSION_CWD_CONFLICT' })
    expect(host.calls.map(c => c.method)).toEqual(['session/create'])
  } finally { transport.dispose() }
})
