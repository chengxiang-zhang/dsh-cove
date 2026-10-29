import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PairTokenStore } from '../src/core/remote-web-ui/security.ts'
import { makeRemoteRoutes } from '../src/host/services/remote-web-ui/index.ts'

interface TestServer {
  port: number
  close(): Promise<void>
}

interface ResponseResult {
  status: number
  headers: IncomingMessage['headers']
  body: Buffer
}

const servers: TestServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

async function serve(routes: WebRoute[], host = '127.0.0.1'): Promise<TestServer> {
  const server: Server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://route.invalid').pathname
    const route = routes.find(candidate => candidate.kind === 'prefix'
      ? pathname === candidate.path || pathname.startsWith(`${candidate.path}/`)
      : pathname === candidate.path)
    if (route === undefined) {
      response.writeHead(404).end()
      return
    }
    void Promise.resolve(route.handler(request, response)).catch((error) => {
      response.writeHead(500, { 'content-type': 'text/plain' }).end(String(error))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address() as AddressInfo
  const wrapped = {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error == null ? resolve() : reject(error))),
  }
  servers.push(wrapped)
  return wrapped
}

async function call(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string | Buffer; host?: string } = {},
): Promise<ResponseResult> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: options.host ?? '127.0.0.1',
      port,
      method,
      path,
      headers: options.headers,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    request.once('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

function bodyJson<T>(result: ResponseResult): T {
  return JSON.parse(result.body.toString('utf8')) as T
}

function makeStore(options: { now?: () => number } = {}): PairTokenStore {
  let tokenSerial = 0
  let idSerial = 0
  return new PairTokenStore({
    ttlMs: 1_000,
    now: options.now,
    randomToken: () => `secret-${++tokenSerial}`,
    randomId: () => (++idSerial).toString(16).padStart(24, '0'),
  })
}

function routes(store: PairTokenStore, options: Parameters<typeof makeRemoteRoutes>[0] = { logger: { warn: vi.fn() } }): WebRoute[] {
  return makeRemoteRoutes({ logger: { warn: vi.fn() }, tokenStore: store, ...options })
}

describe('remote-web-ui pair tokens', () => {
  it('expires tokens and never exposes bearer secrets in status', async () => {
    let now = 10_000
    const store = makeStore({ now: () => now })
    const issued = store.issue('phone')

    expect(store.authenticate(issued.token)).toMatchObject({ id: issued.id, label: 'phone', expiresAt: 11_000 })
    expect(JSON.stringify(store.list())).not.toContain(issued.token)
    expect(store.list()).toEqual([{ id: issued.id, label: 'phone', createdAt: 10_000, expiresAt: 11_000 }])

    now = 11_000
    expect(store.authenticate(issued.token)).toBeUndefined()
    expect(store.list()).toEqual([])
  })

  it('keeps create, list, and revoke loopback-only and revokes immediately', async () => {
    const store = makeStore()
    const server = await serve(routes(store))

    const create = await call(server.port, 'POST', '/api/pair/pair', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'tablet' }),
    })
    expect(create.status).toBe(201)
    const created = bodyJson<{ token: string; id: string; expiresAt: number }>(create)

    const status = await call(server.port, 'GET', '/api/pair/status')
    expect(status.status).toBe(200)
    const listed = bodyJson<{ tokens: Array<Record<string, unknown>> }>(status)
    expect(listed.tokens).toEqual([expect.objectContaining({ id: created.id, label: 'tablet', expiresAt: created.expiresAt })])
    expect(listed.tokens[0]).not.toHaveProperty('token')
    expect(status.body.toString('utf8')).not.toContain(created.token)

    const revoke = await call(server.port, 'POST', '/api/pair/revoke', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: created.id }),
    })
    expect(revoke.status).toBe(200)
    expect(store.authenticate(created.token)).toBeUndefined()

    const lanAddress = localLanAddress()
    if (lanAddress !== undefined) {
      const remote = await serve(routes(makeStore()), '0.0.0.0')
      const nonLoopback = await call(remote.port, 'GET', '/api/pair/status', { host: lanAddress })
      expect(nonLoopback.status).toBe(403)
    }
  })

  it('refuses a remote browser that reaches the plugin through a same-host proxy', async () => {
    // The documented topology (browser -> nginx -> 127.0.0.1:3080) makes every
    // remote request arrive on a loopback socket, so the socket address alone
    // would admit it; the Host check is what keeps the pairing surface local.
    const store = makeStore()
    const server = await serve(routes(store))
    const forged = await call(server.port, 'POST', '/api/pair/pair', {
      headers: { host: 'dsh.laptop-b', origin: 'http://dsh.laptop-b', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'attacker' }),
    })
    expect(forged.status).toBe(403)
    expect(store.list()).toEqual([])
    expect((await call(server.port, 'GET', '/api/pair/status', { headers: { host: 'dsh.laptop-b', origin: 'http://dsh.laptop-b' } })).status).toBe(403)
    expect((await call(server.port, 'GET', '/api/pair/status', { headers: { host: 'localhost:3080' } })).status).toBe(200)
  })
})

describe('remote-web-ui bearer gateway', () => {
  it('rejects missing, unknown, and expired bearer tokens without calling fetch', async () => {
    let now = 5_000
    const store = makeStore({ now: () => now })
    const issued = store.issue('phone')
    const fetchMock = vi.fn<typeof fetch>()
    const server = await serve(routes(store, { logger: { warn: vi.fn() }, fetch: fetchMock }))

    expect((await call(server.port, 'GET', '/api/gateway/api/health')).status).toBe(401)
    expect((await call(server.port, 'GET', '/api/gateway/api/health', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    now = issued.expiresAt
    expect((await call(server.port, 'GET', '/api/gateway/api/health', { headers: { authorization: `Bearer ${issued.token}` } })).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    '/api/gateway/api/pair/status',
    '/api/gateway/api/gateway/api/health',
    '/api/gateway/http://169.254.169.254/latest/meta-data',
    '/api/gateway//example.com/api/health',
    '/api/gateway/api/../pair/status',
    '/api/gateway/api/%2e%2e/pair/status',
    '/api/gateway/api/%2f%2fevil.example/path',
    '/api/gateway/api/%5cevil',
    '/api/gateway/api//health',
  ])('rejects SSRF, recursion, or traversal target %s', async (path) => {
    const store = makeStore()
    const issued = store.issue('phone')
    const fetchMock = vi.fn<typeof fetch>()
    const server = await serve(routes(store, { logger: { warn: vi.fn() }, fetch: fetchMock }))

    const result = await call(server.port, 'GET', path, { headers: { authorization: `Bearer ${issued.token}` } })
    expect(result.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards method, query, body, content type, status, and response while stripping credentials and hop headers', async () => {
    const store = makeStore()
    const issued = store.issue('phone')
    const seen: { url?: string; init?: RequestInit } = {}
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      seen.url = String(input)
      seen.init = init
      return new Response('upstream-body', {
        status: 207,
        headers: {
          'content-type': 'text/custom',
          'x-upstream': 'yes',
          'set-cookie': 'upstream=secret',
          connection: 'x-hop',
          'x-hop': 'remove-me',
        },
      })
    })
    const server = await serve(routes(store, {
      logger: { warn: vi.fn() },
      fetch: fetchMock,
      targetOrigin: 'http://internal.invalid:4312',
    }))

    const result = await call(server.port, 'PATCH', '/api/gateway/api/widgets?id=7', {
      headers: {
        authorization: `Bearer ${issued.token}`,
        cookie: 'browser=secret',
        origin: 'https://remote.example',
        referer: 'https://remote.example/app',
        connection: 'x-client-hop',
        'x-client-hop': 'remove-me',
        'content-type': 'application/vnd.test+json',
        'x-safe': 'kept',
      },
      body: '{"value":1}',
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(seen.url).toBe('http://internal.invalid:4312/api/widgets?id=7')
    expect(seen.init?.method).toBe('PATCH')
    expect(Buffer.from(seen.init?.body as ArrayBuffer).toString('utf8')).toBe('{"value":1}')
    const forwarded = new Headers(seen.init?.headers)
    expect(forwarded.get('content-type')).toBe('application/vnd.test+json')
    expect(forwarded.get('x-safe')).toBe('kept')
    expect(forwarded.get('host')).toBe('internal.invalid:4312')
    expect(forwarded.get('authorization')).toBeNull()
    expect(forwarded.get('cookie')).toBeNull()
    expect(forwarded.get('origin')).toBeNull()
    expect(forwarded.get('referer')).toBeNull()
    expect(forwarded.get('connection')).toBeNull()
    expect(forwarded.get('x-client-hop')).toBeNull()

    expect(result.status).toBe(207)
    expect(result.headers['content-type']).toBe('text/custom')
    expect(result.headers['x-upstream']).toBe('yes')
    expect(result.headers['set-cookie']).toBeUndefined()
    expect(result.headers['x-hop']).toBeUndefined()
    expect(result.body.toString('utf8')).toBe('upstream-body')
  })

  it('enforces request/response bounds and upstream timeouts', async () => {
    const store = makeStore()
    const issued = store.issue('phone')
    const auth = { authorization: `Bearer ${issued.token}` }

    const requestFetch = vi.fn<typeof fetch>()
    const requestServer = await serve(routes(store, { logger: { warn: vi.fn() }, fetch: requestFetch, maxRequestBytes: 4 }))
    expect((await call(requestServer.port, 'POST', '/api/gateway/api/data', { headers: auth, body: '12345' })).status).toBe(413)
    expect(requestFetch).not.toHaveBeenCalled()

    const responseFetch = vi.fn<typeof fetch>(async () => new Response('12345', { status: 200 }))
    const responseServer = await serve(routes(store, { logger: { warn: vi.fn() }, fetch: responseFetch, maxResponseBytes: 4 }))
    expect((await call(responseServer.port, 'GET', '/api/gateway/api/data', { headers: auth })).status).toBe(502)

    const timeoutFetch = vi.fn<typeof fetch>(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const timeoutServer = await serve(routes(store, { logger: { warn: vi.fn() }, fetch: timeoutFetch, timeoutMs: 5 }))
    expect((await call(timeoutServer.port, 'GET', '/api/gateway/api/data', { headers: auth })).status).toBe(504)
  })
})

function localLanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}
