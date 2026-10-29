/**
 * Both host WebSocket upgrades carry the shared host access fence, and neither
 * had a topology-level test: `ssh` only asserted the upgrade path exists, and
 * the live view had no fence assertion at all. A same-host reverse proxy makes
 * every remote request arrive on a loopback socket, so these cases pin the
 * refusal that a socket-only check would let through.
 *
 * The admitted direction asserts the next guard instead of a real WebSocket
 * handshake: an admitted request without its required query parameter answers
 * 400, which proves the fence let it past.
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { register as registerAccessTrust } from '../src/host/services/access-trust/index.ts'
import { registerTerminalUpgrade } from '../src/host/services/ssh/terminal-ws.ts'
import { registerLiveViewUpgrade } from '../src/host/services/playwright-sessions/live-view.ts'

const disposers: Array<() => void> = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose() })

const CANONICAL = 'dsh.studio-mac'

interface UpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
}

interface RequestOptions {
  url: string
  host?: string
  origin?: string
  address?: string
}

function request(options: RequestOptions): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  const headers: Record<string, string> = {}
  if (options.host !== undefined) headers.host = options.host
  if (options.origin !== undefined) headers.origin = options.origin
  Object.assign(req, {
    url: options.url,
    method: 'GET',
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
    headers,
  })
  return req
}

function socket(): { duplex: Duplex; written(): string; destroyed(): boolean } {
  let text = ''
  let destroyed = false
  const duplex = {
    write(chunk: string | Buffer) { text += chunk.toString(); return true },
    destroy() { destroyed = true; return duplex },
  } as unknown as Duplex
  return { duplex, written: () => text, destroyed: () => destroyed }
}

function harness(authenticated: boolean): { ctx: Context; upgrades: UpgradeRoute[] } {
  const store = new Map<string, unknown>([
    ['webRuntime', { trustedHosts: [CANONICAL] }],
    ['connection', { browserAuth: { isAuthenticated: vi.fn(() => authenticated) } }],
  ])
  const upgrades: UpgradeRoute[] = []
  const ctx = {
    get: (name: string, strict?: boolean) => {
      if (store.has(name)) return store.get(name)
      if (strict === false) return undefined
      throw new Error(`service not found: ${name}`)
    },
    provide: (name: string, value: unknown) => { store.set(name, value); return () => { store.delete(name) } },
    webServer: { registerUpgrade: (route: UpgradeRoute) => { upgrades.push(route); return () => {} } },
    logger: { warn: () => {}, info: () => {} },
  } as unknown as Context
  registerAccessTrust(ctx)
  return { ctx, upgrades }
}

function terminalUpgrade(authenticated: boolean): UpgradeRoute {
  const built = harness(authenticated)
  disposers.push(registerTerminalUpgrade(built.ctx, { engine: {} as never, store: {} as never }))
  const route = built.upgrades.find(candidate => candidate.path === '/api/dsh-ssh/terminal')
  if (route === undefined) throw new Error('terminal upgrade not registered')
  return route
}

function liveViewUpgrade(authenticated: boolean): UpgradeRoute {
  const built = harness(authenticated)
  disposers.push(registerLiveViewUpgrade(built.ctx, async () => null))
  const route = built.upgrades.find(candidate => candidate.path === '/playwright-sessions/ws/browser')
  if (route === undefined) throw new Error('live-view upgrade not registered')
  return route
}

describe('host upgrade fences', () => {
  it('ssh terminal: refuses a forged Host that arrives through a same-host proxy', () => {
    const route = terminalUpgrade(true)
    const out = socket()
    route.handler(request({ url: '/api/dsh-ssh/terminal?alias=box', host: 'evil.example', origin: 'http://evil.example' }), out.duplex, Buffer.alloc(0))
    expect(out.written()).toContain('403 Forbidden')
    expect(out.destroyed()).toBe(true)
  })

  it('ssh terminal: refuses a sessionless canonical browser and admits it with a session', () => {
    const refused = terminalUpgrade(false)
    const denied = socket()
    refused.handler(request({ url: '/api/dsh-ssh/terminal', host: CANONICAL, origin: `http://${CANONICAL}` }), denied.duplex, Buffer.alloc(0))
    expect(denied.written()).toContain('403 Forbidden')

    const admitted = terminalUpgrade(true)
    const allowed = socket()
    admitted.handler(request({ url: '/api/dsh-ssh/terminal', host: CANONICAL, origin: `http://${CANONICAL}` }), allowed.duplex, Buffer.alloc(0))
    expect(allowed.written()).toContain('400 Bad Request')
    expect(allowed.written()).not.toContain('403')
  })

  it('ssh terminal: keeps the local page working', () => {
    const route = terminalUpgrade(false)
    const out = socket()
    route.handler(request({ url: '/api/dsh-ssh/terminal', host: '127.0.0.1:3080' }), out.duplex, Buffer.alloc(0))
    expect(out.written()).toContain('400 Bad Request')
  })

  it('agent-browser live view: refuses a forged Host and a sessionless canonical browser', () => {
    const route = liveViewUpgrade(true)
    const forged = socket()
    route.handler(request({ url: '/playwright-sessions/ws/browser?sessionId=s1', host: 'evil.example', origin: 'http://evil.example' }), forged.duplex, Buffer.alloc(0))
    expect(forged.written()).toContain('403 Forbidden')

    const sessionless = liveViewUpgrade(false)
    const denied = socket()
    sessionless.handler(request({ url: '/playwright-sessions/ws/browser?sessionId=s1', host: CANONICAL, origin: `http://${CANONICAL}` }), denied.duplex, Buffer.alloc(0))
    expect(denied.written()).toContain('403 Forbidden')
  })

  it('agent-browser live view: admits the canonical entry with a session', () => {
    const route = liveViewUpgrade(true)
    const out = socket()
    route.handler(request({ url: '/playwright-sessions/ws/browser', host: CANONICAL, origin: `http://${CANONICAL}` }), out.duplex, Buffer.alloc(0))
    expect(out.written()).toContain('400 Bad Request')
    expect(out.written()).not.toContain('403')
  })
})