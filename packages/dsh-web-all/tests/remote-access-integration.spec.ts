/**
 * Integration chain for the reverse-proxied entry, served over a real socket:
 * the domain's index rows -> the SDK's own index renderer -> the served boot
 * script -> the per-request decision -> the client claim the script performs.
 *
 * The unit specs pin each piece; this one pins them together, because the
 * reported failure (Settings -> Models "settings are unavailable in this
 * browser") only appears when the row is rendered as a parser-blocking script
 * whose handler consults the same fence the panels use.
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { renderIndexInjections } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { register as registerAccessTrust } from '../src/host/services/access-trust/index.ts'
import { HOST_ACCESS_MARKER_COOKIE, register as registerRemoteAccess } from '../src/host/services/remote-access/index.ts'

const CANONICAL = 'dsh.studio-mac'
const SESSION_COOKIE = 'dsh_session=1'
const INDEX_HTML = '<!doctype html><html><head><title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()) })))
})

interface InjectionRow {
  kind: string
  placement?: string
  src?: string
  text?: string
}

/** A deployment context: authorities plus a cookie-backed browser session. */
function deployment(): { ctx: Context; routes: WebRoute[]; rows(): InjectionRow[] } {
  const routes: WebRoute[] = []
  const listeners: Array<(table: InjectionRow[]) => void> = []
  const store = new Map<string, unknown>([
    ['webRuntime', { trustedHosts: [CANONICAL] }],
    ['connection', {
      browserAuth: {
        isAuthenticated: (request: { headers: Record<string, unknown> }) => String(request.headers.cookie ?? '').includes(SESSION_COOKIE),
      },
    }],
  ])
  const ctx = {
    get: (name: string, strict?: boolean) => {
      if (store.has(name)) return store.get(name)
      if (strict === false) return undefined
      throw new Error(`service not found: ${name}`)
    },
    provide: (name: string, value: unknown) => { store.set(name, value); return () => { store.delete(name) } },
    webServer: { register: (route: WebRoute) => { routes.push(route); return () => {} } },
    on: (event: string, listener: (table: InjectionRow[]) => void) => {
      if (event === 'webserver/index-inject') listeners.push(listener)
      return () => {}
    },
    logger: { warn: () => {}, info: () => {} },
  } as unknown as Context
  // Mount in assembly order: the fence first, then the domain that consults it.
  registerAccessTrust(ctx)
  registerRemoteAccess(ctx)
  return {
    ctx,
    routes,
    rows: () => {
      const table: InjectionRow[] = []
      for (const listener of listeners) listener(table)
      return table
    },
  }
}

/** Serve the domain's routes plus a DSH-like index fallback. */
async function serve(deploymentResult: { routes: WebRoute[]; rows(): InjectionRow[] }): Promise<number> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://index.invalid').pathname
    const route = deploymentResult.routes.find(candidate => candidate.path === pathname)
    if (route !== undefined) {
      void Promise.resolve(route.handler(request, response)).catch(() => { response.writeHead(500).end() })
      return
    }
    if (pathname === '/' || pathname === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(renderIndexInjections(INDEX_HTML, deploymentResult.rows()))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  servers.push(server)
  return (server.address() as AddressInfo).port
}

async function call(
  port: number,
  path: string,
  options: { host?: string; cookie?: string; method?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return await new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (options.host !== undefined) headers.host = options.host
    if (options.cookie !== undefined) headers.cookie = options.cookie
    const request = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

describe('reverse-proxied entry end to end', () => {
  it('serves the boot row as a parser-blocking head script ahead of the app mount', async () => {
    const port = await serve(deployment())
    const page = await call(port, '/', { host: `evil.example` })
    expect(page.status).toBe(200)
    expect(page.body).toContain('<script src="/web-all/remote-access/boot.js"></script>')
    expect(page.body.indexOf('/web-all/remote-access/boot.js')).toBeLessThan(page.body.indexOf('<body'))
    expect(page.body).toContain('crypto.randomUUID')
    expect(page.body).toContain('navigator')
  })

  it('claims Host ownership for the declared, session-bearing entry only', async () => {
    const port = await serve(deployment())

    const admitted = await call(port, '/web-all/remote-access/boot.js', { host: CANONICAL, cookie: SESSION_COOKIE })
    expect(admitted.status).toBe(200)
    expect(admitted.headers['content-type']).toContain('application/javascript')
    expect(admitted.headers['cache-control']).toBe('no-store')
    expect(admitted.body).toContain('ownsHost')
    const cookie = String(admitted.headers['set-cookie'])
    expect(cookie).toContain(`${HOST_ACCESS_MARKER_COOKIE}=1`)
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('SameSite=Lax')
    // The client reads the marker from document.cookie, so it must stay readable.
    expect(cookie).not.toContain('HttpOnly')

    const sessionless = await call(port, '/web-all/remote-access/boot.js', { host: CANONICAL })
    expect(sessionless.body).not.toContain('ownsHost')

    const forged = await call(port, '/web-all/remote-access/boot.js', { host: 'evil.example', cookie: SESSION_COOKIE })
    expect(forged.body).not.toContain('ownsHost')
    expect(forged.headers['set-cookie']).toBeUndefined()

    const local = await call(port, '/web-all/remote-access/boot.js', { host: '127.0.0.1:3080' })
    expect(local.body).toContain('ownsHost')
    expect(local.headers['set-cookie']).toBeUndefined()
  })

  it('turns the served decision into the client claim it declares', async () => {
    const port = await serve(deployment())
    const admitted = await call(port, '/web-all/remote-access/boot.js', { host: CANONICAL, cookie: SESSION_COOKIE })
    const sandbox: Record<string, unknown> = { __DSH_TRANSPORT__: { streamBaseUrl: '/api/remote.mux' } }
    new Function('globalThis', admitted.body)(sandbox)
    expect((sandbox.__DSH_TRANSPORT__ as { ownsHost?: boolean }).ownsHost).toBe(true)

    const refused = await call(port, '/web-all/remote-access/boot.js', { host: 'evil.example' })
    const untouched: Record<string, unknown> = { __DSH_TRANSPORT__: {} }
    new Function('globalThis', refused.body)(untouched)
    expect((untouched.__DSH_TRANSPORT__ as { ownsHost?: boolean }).ownsHost).toBeUndefined()
  })

  it('publishes the credential-free posture the audit and client probe read', async () => {
    const port = await serve(deployment())

    const declared = await call(port, '/api/dsh-access/session', { host: CANONICAL })
    expect(declared.status).toBe(200)
    expect(JSON.parse(declared.body)).toEqual({
      authority: { host: CANONICAL, loopback: false, declared: true },
      session: false,
      owners: false,
    })

    const authenticated = await call(port, '/api/dsh-access/session', { host: CANONICAL, cookie: SESSION_COOKIE })
    expect(JSON.parse(authenticated.body)).toMatchObject({ session: true, owners: true })

    const forged = await call(port, '/api/dsh-access/session', { host: 'evil.example' })
    expect(JSON.parse(forged.body)).toMatchObject({ authority: { declared: false }, owners: false })
  })
})