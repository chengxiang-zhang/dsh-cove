import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { makePlaywrightControlRoutes, trustedPlaywrightControlRequest } from '../src/host/services/playwright-sessions/routes.ts'

function request(url: string, options: { method?: string; address?: string; host?: string; origin?: string; site?: string; body?: unknown } = {}) {
  const req = new EventEmitter() as EventEmitter & { url: string; method: string; headers: Record<string, string>; socket: { remoteAddress: string }; [Symbol.asyncIterator](): AsyncIterator<Buffer> }
  req.url = url; req.method = options.method ?? 'GET'; req.socket = { remoteAddress: options.address ?? '127.0.0.1' }
  req.headers = { host: options.host ?? '127.0.0.1:3080', ...(options.origin ? { origin: options.origin } : {}), ...(options.site ? { 'sec-fetch-site': options.site } : {}), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) }
  req[Symbol.asyncIterator] = async function* () { if (options.body !== undefined) yield Buffer.from(JSON.stringify(options.body)) }
  return req
}

function response() {
  const chunks: string[] = []
  return { status: 0, body: chunks, writeHead(status: number) { this.status = status }, end(value?: string) { if (value) chunks.push(value) } }
}

describe('playwright control routes', () => {
  it('requires loopback and same-origin browser requests', () => {
    expect(trustedPlaywrightControlRequest(request('/'))).toBe(true)
    expect(trustedPlaywrightControlRequest(request('/', { address: '10.0.0.2' }))).toBe(false)
    expect(trustedPlaywrightControlRequest(request('/', { site: 'cross-site' }))).toBe(false)
    expect(trustedPlaywrightControlRequest(request('/', { origin: 'http://evil.test' }))).toBe(false)
  })

  it('returns status without exposing another owner identity', async () => {
    const controller = { status: vi.fn(() => ({ mode: 'extension', state: 'disconnected', ownedByThisSession: false, busy: true, liveView: false })) }
    const route = makePlaywrightControlRoutes(controller as never)[0]
    const res = response()
    await route.handler(request('/api/playwright-sessions/status?sessionId=s2') as never, res as never)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body.join('')).value).toEqual({ mode: 'extension', state: 'disconnected', ownedByThisSession: false, busy: true, liveView: false })
  })

  it('connects only with a JSON session id', async () => {
    const controller = { connect: vi.fn(async () => ({ mode: 'extension', state: 'connected', ownedByThisSession: true, busy: false, liveView: false })) }
    const route = makePlaywrightControlRoutes(controller as never)[0]
    const res = response()
    await route.handler(request('/api/playwright-sessions/connect', { method: 'POST', body: { sessionId: 's1' } }) as never, res as never)
    expect(res.status).toBe(200)
    expect(controller.connect).toHaveBeenCalledWith('s1')
  })
})
