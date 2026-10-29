/**
 * Remote-access domain: the per-request Host-ownership boot script, the
 * credential-free posture readout, and the plain-HTTP shims every served index
 * document carries.
 *
 * The route cases pin the reverse-proxy deployment (nginx connects to
 * 127.0.0.1, so the socket is loopback while the browser authority is
 * `dsh.<machine>`): the declared, session-authenticated entry may claim Host
 * ownership and gets the provenance marker; an undeclared Host, a sessionless
 * remote browser and a non-GET request get nothing.
 */
import { EventEmitter } from 'node:events'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'
import { register as registerAccessTrust } from '../src/host/services/access-trust/index.ts'
import {
  CLIPBOARD_SHIM_SCRIPT,
  HOST_ACCESS_BOOT_PATH,
  HOST_ACCESS_MARKER_COOKIE,
  HOST_ACCESS_SESSION_PATH,
  UUID_POLYFILL_SCRIPT,
  hostAccessBootScript,
  makeRemoteAccessRoutes,
  register as registerRemoteAccess,
  type RemoteAccessDeps,
} from '../src/host/services/remote-access/index.ts'

const CANONICAL = 'dsh.studio-mac'
const SERVICES = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src/host/services')

interface RequestOptions {
  url: string
  method?: string
  host?: string
  origin?: string
  address?: string
  headers?: Record<string, string>
}

function request(options: RequestOptions): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  const headers: Record<string, string> = { ...options.headers }
  if (options.host !== undefined) headers.host = options.host
  if (options.origin !== undefined) headers.origin = options.origin
  Object.assign(req, {
    url: options.url,
    method: options.method ?? 'GET',
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
    headers,
    [Symbol.asyncIterator]: async function* () {},
  })
  return req
}

function response(): {
  res: ServerResponse
  status(): number
  headers(): Record<string, string | string[] | undefined>
  text(): string
  json(): Record<string, unknown>
} {
  let status = 0
  let headers: Record<string, string | string[] | undefined> = {}
  let text = ''
  const res = {
    writeHead(code: number, next?: Record<string, string | string[]>) { status = code; headers = next ?? {}; return this },
    end(chunk?: string | Buffer) { if (chunk !== undefined) text += chunk.toString(); return this },
  } as unknown as ServerResponse
  return { res, status: () => status, headers: () => headers, text: () => text, json: () => JSON.parse(text || '{}') as Record<string, unknown> }
}

function deploy(overrides: Partial<RemoteAccessDeps> = {}): RemoteAccessDeps {
  return {
    isTrusted: () => false,
    trustedAuthorities: () => [CANONICAL],
    isAuthenticated: () => false,
    ...overrides,
  }
}

function handlerOf(routes: WebRoute[], path: string): WebRoute['handler'] {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`route ${path} not registered`)
  return route.handler
}

describe('host ownership boot script', () => {
  it('claims the Host for an admitted remote entry and mints the provenance marker', async () => {
    const routes = makeRemoteAccessRoutes(deploy({ isTrusted: () => true }))
    const out = response()
    await handlerOf(routes, HOST_ACCESS_BOOT_PATH)(request({ url: HOST_ACCESS_BOOT_PATH, host: CANONICAL, origin: `http://${CANONICAL}` }) as never, out.res as never)
    expect(out.status()).toBe(200)
    expect(out.headers()['content-type']).toBe('application/javascript; charset=utf-8')
    expect(out.headers()['cache-control']).toBe('no-store')
    expect(out.text()).toContain('ownsHost')
    const cookie = String(out.headers()['set-cookie'])
    expect(cookie).toContain(`${HOST_ACCESS_MARKER_COOKIE}=1`)
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).not.toContain('Secure')
  })

  it('answers a no-op without a marker for an undeclared or sessionless entry', async () => {
    const routes = makeRemoteAccessRoutes(deploy())
    const out = response()
    await handlerOf(routes, HOST_ACCESS_BOOT_PATH)(request({ url: HOST_ACCESS_BOOT_PATH, host: 'evil.example', origin: 'http://evil.example' }) as never, out.res as never)
    expect(out.status()).toBe(200)
    expect(out.text()).not.toContain('ownsHost')
    expect(out.headers()['set-cookie']).toBeUndefined()
  })

  it('claims ownership on a loopback page without a marker', async () => {
    const routes = makeRemoteAccessRoutes(deploy({ isTrusted: () => true }))
    const out = response()
    await handlerOf(routes, HOST_ACCESS_BOOT_PATH)(request({ url: HOST_ACCESS_BOOT_PATH, host: '127.0.0.1:3080' }) as never, out.res as never)
    expect(out.text()).toContain('ownsHost')
    expect(out.headers()['set-cookie']).toBeUndefined()
  })

  it('marks the cookie Secure only when the request arrived over TLS', async () => {
    const routes = makeRemoteAccessRoutes(deploy({ isTrusted: () => true }))
    const out = response()
    await handlerOf(routes, HOST_ACCESS_BOOT_PATH)(
      request({ url: HOST_ACCESS_BOOT_PATH, host: CANONICAL, headers: { 'x-forwarded-proto': 'https' } }) as never,
      out.res as never,
    )
    expect(String(out.headers()['set-cookie'])).toContain('Secure')
  })

  it('rejects non-GET boot requests with an allow header', async () => {
    const routes = makeRemoteAccessRoutes(deploy())
    const out = response()
    await handlerOf(routes, HOST_ACCESS_BOOT_PATH)(request({ url: HOST_ACCESS_BOOT_PATH, method: 'POST', host: CANONICAL }) as never, out.res as never)
    expect(out.status()).toBe(405)
    expect(out.headers().allow).toBe('GET')
  })
})

describe('authority posture readout', () => {
  it('reports the declared authority without requiring a session', async () => {
    const routes = makeRemoteAccessRoutes(deploy())
    const out = response()
    await handlerOf(routes, HOST_ACCESS_SESSION_PATH)(request({ url: HOST_ACCESS_SESSION_PATH, host: CANONICAL, origin: `http://${CANONICAL}` }) as never, out.res as never)
    expect(out.status()).toBe(200)
    expect(out.json()).toEqual({
      authority: { host: CANONICAL, loopback: false, declared: true },
      session: false,
      owners: false,
    })
  })

  it('reports an undeclared Host and a forged authority', async () => {
    const routes = makeRemoteAccessRoutes(deploy())
    const out = response()
    await handlerOf(routes, HOST_ACCESS_SESSION_PATH)(request({ url: HOST_ACCESS_SESSION_PATH, host: 'evil.example' }) as never, out.res as never)
    expect(out.json()).toEqual({
      authority: { host: 'evil.example', loopback: false, declared: false },
      session: false,
      owners: false,
    })
  })

  it('reports loopback as declared and owners without a marker', async () => {
    const routes = makeRemoteAccessRoutes(deploy({ isTrusted: () => true }))
    const out = response()
    await handlerOf(routes, HOST_ACCESS_SESSION_PATH)(request({ url: HOST_ACCESS_SESSION_PATH, host: '127.0.0.1:3080' }) as never, out.res as never)
    expect(out.json()).toMatchObject({ authority: { loopback: true, declared: true }, owners: true })
    expect(out.headers()['set-cookie']).toBeUndefined()
  })

  it('reports the session and the fence decision separately', async () => {
    const routes = makeRemoteAccessRoutes(deploy({ isTrusted: () => true, isAuthenticated: () => true }))
    const out = response()
    await handlerOf(routes, HOST_ACCESS_SESSION_PATH)(request({ url: HOST_ACCESS_SESSION_PATH, host: CANONICAL }) as never, out.res as never)
    expect(out.json()).toMatchObject({ session: true, owners: true })
    expect(String(out.headers()['set-cookie'])).toContain(`${HOST_ACCESS_MARKER_COOKIE}=1`)
  })

  it('never consults the browser session for a caller the fence refuses', async () => {
    // 未过围栏的调用方连会话判定都不该触发：它拿不到任何会话信息，
    // 也不该让宿主为它花一次会话查找。
    const isAuthenticated = vi.fn(() => true)
    const routes = makeRemoteAccessRoutes(deploy({ isTrusted: () => false, isAuthenticated }))
    const out = response()
    await handlerOf(routes, HOST_ACCESS_SESSION_PATH)(request({ url: HOST_ACCESS_SESSION_PATH, host: 'evil.example' }) as never, out.res as never)
    expect(out.json()).toMatchObject({ authority: { declared: false }, session: false, owners: false })
    expect(isAuthenticated).not.toHaveBeenCalled()
  })
})

/**
 * Host ownership is decided per request by one fenced owner. A second,
 * host-independent claim (an inline index row) would hand the privileged
 * settings plane to any page the deployment never declared, so this pins the
 * claim to the remote-access boot script's admitted branch.
 */
describe('the Host ownership claim has one owner', () => {
  it('appears in no host module other than the fenced boot script', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) { walk(path); continue }
        if (!name.endsWith('.ts')) continue
        const text = readFileSync(path, 'utf8')
        if (!/ownsHost/u.test(text)) continue
        const relativePath = relative(SERVICES, path)
        if (relativePath === 'remote-access/boot-scripts.ts') continue
        // The other mentions are prose pointing at the owner, not claims.
        const claims = text.split('\n').filter(line => /ownsHost/u.test(line) && !/^\s*(?:\*|\/\/)/u.test(line))
        if (claims.length > 0) offenders.push(`${relativePath}: ${claims.join(' | ')}`)
      }
    }
    walk(SERVICES)
    expect(offenders).toEqual([])
  })
})

describe('service domain registration', () => {
  it('mounts both routes and the three index rows', () => {
    const routes: WebRoute[] = []
    let inject: ((table: Array<Record<string, unknown>>) => void) | undefined
    const store = new Map<string, unknown>()
    const ctx = {
      get: (name: string, strict?: boolean) => {
        if (store.has(name)) return store.get(name)
        if (strict === false) return undefined
        throw new Error(`service not found: ${name}`)
      },
      provide: (name: string, value: unknown) => { store.set(name, value); return () => { store.delete(name) } },
      webServer: { register: (route: WebRoute) => { routes.push(route); return () => {} } },
      on: (event: string, listener: (table: Array<Record<string, unknown>>) => void) => {
        if (event === 'webserver/index-inject') inject = listener
        return () => {}
      },
      logger: { warn: () => {}, info: () => {} },
    } as unknown as Context
    // The fence the domain consults must exist, exactly as the assembly mounts it.
    registerAccessTrust(ctx)

    const dispose = registerRemoteAccess(ctx)
    expect(routes.map(route => route.path)).toEqual([HOST_ACCESS_BOOT_PATH, HOST_ACCESS_SESSION_PATH])

    const table: Array<Record<string, unknown>> = []
    inject?.(table)
    expect(table).toEqual([
      { kind: 'script-src', placement: 'head', src: HOST_ACCESS_BOOT_PATH },
      { kind: 'script', placement: 'head', text: UUID_POLYFILL_SCRIPT },
      { kind: 'script', placement: 'head', text: CLIPBOARD_SHIM_SCRIPT },
    ])
    expect(() => { dispose() }).not.toThrow()
  })

  it('serves the ownership decision through the shared fence service', async () => {
    const routes: WebRoute[] = []
    const store = new Map<string, unknown>([
      ['webRuntime', { trustedHosts: [CANONICAL] }],
      ['connection', { browserAuth: { isAuthenticated: vi.fn(() => true) } }],
    ])
    const ctx = {
      get: (name: string, strict?: boolean) => {
        if (store.has(name)) return store.get(name)
        if (strict === false) return undefined
        throw new Error(`service not found: ${name}`)
      },
      provide: (name: string, value: unknown) => { store.set(name, value); return () => { store.delete(name) } },
      webServer: { register: (route: WebRoute) => { routes.push(route); return () => {} } },
      on: () => () => {},
      logger: { warn: () => {}, info: () => {} },
    } as unknown as Context
    registerAccessTrust(ctx)
    registerRemoteAccess(ctx)

    const admitted = response()
    await handlerOf(routes, HOST_ACCESS_BOOT_PATH)(request({ url: HOST_ACCESS_BOOT_PATH, host: CANONICAL, origin: `http://${CANONICAL}` }) as never, admitted.res as never)
    expect(admitted.text()).toContain('ownsHost')

    const forged = response()
    await handlerOf(routes, HOST_ACCESS_BOOT_PATH)(request({ url: HOST_ACCESS_BOOT_PATH, host: 'evil.example', origin: 'http://evil.example' }) as never, forged.res as never)
    expect(forged.text()).not.toContain('ownsHost')
  })
})

describe('injected script bodies execute', () => {
  it('sets ownsHost only for an admitted page', () => {
    const admitted: Record<string, unknown> = {}
    new Function('globalThis', hostAccessBootScript(true))(admitted)
    expect((admitted.__DSH_TRANSPORT__ as { ownsHost?: boolean }).ownsHost).toBe(true)

    const refused: Record<string, unknown> = {}
    new Function('globalThis', hostAccessBootScript(false))(refused)
    expect(refused.__DSH_TRANSPORT__).toBeUndefined()
  })

  it('mints a v4 uuid when the platform has no crypto.randomUUID', () => {
    let draw = 0
    const sandbox: Record<string, unknown> = {
      crypto: {
        getRandomValues: (array: Uint8Array) => {
          for (let i = 0; i < array.length; i += 1) array[i] = (draw + i * 7) % 256
          draw += 1
          return array
        },
      },
    }
    new Function('globalThis', UUID_POLYFILL_SCRIPT)(sandbox)
    const mint = (sandbox.crypto as { randomUUID(): string }).randomUUID
    const value = mint()
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(mint()).not.toBe(value)
  })

  it('backs copy with execCommand and rejects reads when the clipboard is absent', async () => {
    class FakeNavigator {}
    const navigator = new FakeNavigator() as unknown as { clipboard?: { writeText(text: string): Promise<void>; readText(): Promise<string> } }
    const copied: string[] = []
    const document = {
      createElement: () => ({ value: '', style: {} as Record<string, string>, setAttribute: () => {}, select: () => {} }),
      body: { appendChild: () => {}, removeChild: () => {} },
      execCommand: (command: string) => { copied.push(command); return true },
    }
    new Function('globalThis', 'navigator', 'document', 'Navigator', CLIPBOARD_SHIM_SCRIPT)({}, navigator, document, FakeNavigator)

    expect(navigator.clipboard).toBeDefined()
    await expect(navigator.clipboard?.writeText('hello')).resolves.toBeUndefined()
    expect(copied).toEqual(['copy'])
    await expect(navigator.clipboard?.readText()).rejects.toThrow(/unavailable/u)
  })

  it('never replaces a real clipboard object', () => {
    const real = { writeText: async () => {}, readText: async () => '' }
    const navigator = { clipboard: real }
    new Function('globalThis', 'navigator', 'document', 'Navigator', CLIPBOARD_SHIM_SCRIPT)({}, navigator, {}, class {})
    expect(navigator.clipboard).toBe(real)
  })
})