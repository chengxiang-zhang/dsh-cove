/**
 * Host access-trust fence: the single admission rule every privileged web-all
 * host route family consults (loopback, or a deployment-declared trusted
 * authority carrying an authenticated browser session).
 *
 * The route-level cases pin the production wiring: the deployment's canonical
 * browser entry (Host = a `--trusted-host` authority, loopback socket because
 * the same-host reverse proxy connects to 127.0.0.1) must reach the panels,
 * while a forged Host, a missing session, a cross-site marker or a non-loopback
 * socket must stay refused.
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  isLoopbackRequest, isTrustedHostRequest, matchesTrustedAuthority,
} from '../src/host/services/access-trust/trust.ts'
import {
  accessTrustOf, browserSessionPredicateOf, register as registerAccessTrust, trustedAuthoritiesOf,
  ACCESS_TRUST_SERVICE, type AccessTrust,
} from '../src/host/services/access-trust/index.ts'
import { registerGitRoutes } from '../src/host/services/git-graph/routes.ts'
import type { GitService } from '../src/host/services/git-graph/service.ts'
import { makePlaywrightControlRoutes } from '../src/host/services/playwright-sessions/routes.ts'
import { makeMemoirRoutes } from '../src/host/services/memoir/routes.ts'
import { makeRoutes as makeSshRoutes } from '../src/host/services/ssh/routes.ts'
import { makeScheduleModeRoutes } from '../src/host/services/schedule-mode/routes.ts'
import { makeWorktreeRoutes } from '../src/host/services/worktree/routes.ts'
import { registerWorktreeRoutes } from '../src/host/services/worktree/routes.ts'
import { registerWorkspaceModelRoutes } from '../src/host/services/worktree/workspace-model-routes.ts'
import { register as registerRightPane } from '../src/host/services/right-pane/index.ts'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

const CANONICAL = 'dsh.studio-mac.vpn'

interface RequestOptions {
  url: string
  method?: string
  host?: string
  origin?: string
  site?: string
  address?: string
  body?: unknown
  cookie?: string
}

function request(options: RequestOptions): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  const headers: Record<string, string> = {}
  if (options.host !== undefined) headers.host = options.host
  if (options.origin !== undefined) headers.origin = options.origin
  if (options.site !== undefined) headers['sec-fetch-site'] = options.site
  if (options.cookie !== undefined) headers.cookie = options.cookie
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  Object.assign(req, {
    url: options.url,
    method: options.method ?? 'GET',
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
    headers,
    [Symbol.asyncIterator]: async function* () {
      if (options.body !== undefined) yield Buffer.from(JSON.stringify(options.body))
    },
  })
  return req
}

function response(): { res: ServerResponse; status(): number; body(): Record<string, unknown> } {
  let status = 0
  const chunks: string[] = []
  const res = {
    writeHead(code: number) { status = code; return this },
    end(chunk?: string | Buffer) { if (chunk !== undefined) chunks.push(chunk.toString()); return this },
  } as unknown as ServerResponse
  return { res, status: () => status, body: () => JSON.parse(chunks.join('') || '{}') as Record<string, unknown> }
}

/** A minimal cordis-like context: optional service lookup plus route capture. */
function context(services: Record<string, unknown> = {}): {
  ctx: Context
  store: Map<string, unknown>
  routes: WebRoute[]
  upgrades: Array<{ path: string; handler: (req: IncomingMessage) => void }>
} {
  const store = new Map<string, unknown>(Object.entries(services))
  const routes: WebRoute[] = []
  const upgrades: Array<{ path: string; handler: (req: IncomingMessage) => void }> = []
  const ctx = {
    get: (name: string, strict?: boolean) => {
      if (store.has(name)) return store.get(name)
      if (strict === false) return undefined
      throw new Error(`service not found: ${name}`)
    },
    provide: (name: string, value: unknown) => {
      store.set(name, value)
      return () => { store.delete(name) }
    },
    webServer: {
      register: (route: WebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (route: { path: string; handler: (req: IncomingMessage) => void }) => { upgrades.push(route); return () => {} },
    },
    logger: { warn: () => {}, info: () => {} },
  }
  return { ctx: ctx as unknown as Context, store, routes, upgrades }
}

/** A deployment context: webRuntime authorities plus a connection whose
 *  BrowserAuth answers `authenticated`. */
function deployment(options: { authorities?: string[]; authenticated?: boolean } = {}) {
  const authenticated = options.authenticated ?? false
  const auth = { isAuthenticated: vi.fn(() => authenticated) }
  const built = context({
    webRuntime: { trustedHosts: options.authorities ?? [CANONICAL] },
    connection: { browserAuth: auth },
  })
  registerAccessTrust(built.ctx)
  return { ...built, auth }
}

function handlerOf(routes: WebRoute[], path: string): WebRoute['handler'] {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`route ${path} not registered`)
  return route.handler
}

describe('trust predicate', () => {
  it('accepts a loopback request with same-origin markers', () => {
    expect(isTrustedHostRequest(request({ url: '/', host: '127.0.0.1:3080' }))).toBe(true)
    expect(isTrustedHostRequest(request({ url: '/', host: 'localhost:3080', origin: 'http://localhost:3080' }))).toBe(true)
    expect(isLoopbackRequest(request({ url: '/', host: '127.0.0.1:3080' }))).toBe(true)
  })

  it('requires a declared authority and an authenticated session off loopback', () => {
    const base = { url: '/git/status', host: CANONICAL, origin: `http://${CANONICAL}` }
    expect(isTrustedHostRequest(request(base), { trustedAuthorities: [CANONICAL], isAuthenticated: () => true })).toBe(true)
    // No session predicate at all -> fail closed.
    expect(isTrustedHostRequest(request(base), { trustedAuthorities: [CANONICAL] })).toBe(false)
    // Declared authority but an unauthenticated browser -> refused.
    expect(isTrustedHostRequest(request(base), { trustedAuthorities: [CANONICAL], isAuthenticated: () => false })).toBe(false)
    // Undeclared (forged) authority -> refused even with a session.
    expect(isTrustedHostRequest(request({ ...base, host: 'evil.example.com', origin: 'http://evil.example.com' }), { trustedAuthorities: [CANONICAL], isAuthenticated: () => true })).toBe(false)
    // The socket address stays authoritative: a non-loopback peer is refused.
    expect(isTrustedHostRequest(request({ ...base, address: '100.64.0.12' }), { trustedAuthorities: [CANONICAL], isAuthenticated: () => true })).toBe(false)
    // No Host header -> refused.
    expect(isTrustedHostRequest(request({ url: '/' }), { trustedAuthorities: [CANONICAL], isAuthenticated: () => true })).toBe(false)
  })

  it('refuses cross-site markers and mismatched origins', () => {
    expect(isTrustedHostRequest(request({ url: '/', host: '127.0.0.1:3080', site: 'cross-site' }))).toBe(false)
    expect(isTrustedHostRequest(request({ url: '/', host: '127.0.0.1:3080', origin: 'http://evil.test' }))).toBe(false)
    expect(isLoopbackRequest(request({ url: '/', host: '127.0.0.1:3080', origin: 'http://evil.test' }))).toBe(false)
    expect(isTrustedHostRequest(request({ url: '/', host: CANONICAL, origin: 'http://other.test' }), { trustedAuthorities: [CANONICAL], isAuthenticated: () => true })).toBe(false)
  })

  it('never treats a missing or reshaped Host as loopback Host', () => {
    expect(isLoopbackRequest(request({ url: '/', host: CANONICAL }))).toBe(false)
    expect(isLoopbackRequest(request({ url: '/', host: 'localhost.evil.test' }))).toBe(false)
    expect(isLoopbackRequest(request({ url: '/' }))).toBe(false)
  })

  it('matches authorities with the SDK semantics (port-less matches any port)', () => {
    const host = (value: string): URL => new URL(`http://${value}`)
    expect(matchesTrustedAuthority(host('dsh.studio-mac:80'), ['dsh.studio-mac'])).toBe(true)
    expect(matchesTrustedAuthority(host('dsh.studio-mac:8080'), ['dsh.studio-mac'])).toBe(true)
    expect(matchesTrustedAuthority(host('dsh.studio-mac:8080'), ['dsh.studio-mac:8080'])).toBe(true)
    expect(matchesTrustedAuthority(host('dsh.studio-mac:9090'), ['dsh.studio-mac:8080'])).toBe(false)
    expect(matchesTrustedAuthority(host('dsh.studio-mac'), ['DSH.Studio-Mac'])).toBe(true)
    expect(matchesTrustedAuthority(host('dsh.studio-mac'), ['dsh.studio-mac '])).toBe(false)
    expect(matchesTrustedAuthority(host('dsh.studio-mac'), ['/dsh.studio-mac'])).toBe(false)
    expect(matchesTrustedAuthority(host('dsh.studio-mac'), ['dsh.studio-mac/path'])).toBe(false)
    expect(matchesTrustedAuthority(host('dsh.studio-mac'), ['user@dsh.studio-mac'])).toBe(false)
    expect(matchesTrustedAuthority(host('dsh.studio-mac'), ['127.0.0.1'])).toBe(false)
  })
})

describe('access-trust service', () => {
  it('reads the deployment authorities from webRuntime and fails closed without it', () => {
    expect(trustedAuthoritiesOf(deployment({ authorities: [CANONICAL, '127.0.0.1'] }).ctx)).toEqual([CANONICAL, '127.0.0.1'])
    expect(trustedAuthoritiesOf(context().ctx)).toEqual([])
    expect(trustedAuthoritiesOf(context({ webRuntime: {} }).ctx)).toEqual([])
  })

  it('binds the live BrowserAuth method instead of a snapshot', () => {
    const built = context({ connection: { browserAuth: { isAuthenticated: () => false } } })
    const predicate = browserSessionPredicateOf(built.ctx)
    expect(predicate?.(request({ url: '/', host: CANONICAL }))).toBe(false)
    // remote-web-ui or no-browser-auth repatch the same object; the predicate follows.
    const connection = built.store.get('connection') as { browserAuth: { isAuthenticated: () => boolean } }
    connection.browserAuth.isAuthenticated = () => true
    expect(predicate?.(request({ url: '/', host: CANONICAL }))).toBe(true)
    // A missing connection service denies instead of throwing.
    expect(browserSessionPredicateOf(context().ctx)?.(request({ url: '/', host: CANONICAL }))).toBe(false)
  })

  it('provides the decision and falls back to strict loopback when absent', () => {
    const built = deployment({ authenticated: true })
    const provided = built.store.get(ACCESS_TRUST_SERVICE) as AccessTrust
    expect(provided.isTrusted(request({ url: '/', host: CANONICAL }))).toBe(true)
    expect(provided.isTrusted(request({ url: '/', host: 'evil.example.com' }))).toBe(false)

    const bare = context()
    const fallback = accessTrustOf(bare.ctx)
    expect(fallback.isTrusted(request({ url: '/', host: '127.0.0.1:3080' }))).toBe(true)
    expect(fallback.isTrusted(request({ url: '/', host: CANONICAL, address: '127.0.0.1' }))).toBe(false)
  })

  it('survives a provider that throws instead of widening access', () => {
    const built = context({ [ACCESS_TRUST_SERVICE]: { isTrusted: () => { throw new Error('boom') } } })
    expect(accessTrustOf(built.ctx).isTrusted(request({ url: '/', host: '127.0.0.1:3080' }))).toBe(false)
  })
})

describe('route families consult the shared fence', () => {
  it('git-graph: refuses a forged Host and admits the canonical entry with a session', async () => {
    const service = { status: async () => null } as unknown as GitService
    const denied = deployment({ authenticated: false })
    registerGitRoutes(denied.ctx, service)
    const gitStatus = handlerOf(denied.routes, '/git')
    const forged = response()
    await gitStatus(request({ url: '/git/status', method: 'POST', host: 'evil.example.com', origin: 'http://evil.example.com', body: { path: '/repo' } }) as never, forged.res as never)
    expect(forged.status()).toBe(403)
    const unauthenticated = response()
    await gitStatus(request({ url: '/git/status', method: 'POST', host: CANONICAL, origin: `http://${CANONICAL}`, body: { path: '/repo' } }) as never, unauthenticated.res as never)
    expect(unauthenticated.status()).toBe(403)
    expect(denied.auth.isAuthenticated).toHaveBeenCalled()

    const allowed = deployment({ authenticated: true })
    registerGitRoutes(allowed.ctx, service)
    const canonical = response()
    await handlerOf(allowed.routes, '/git')(request({ url: '/git/status', method: 'POST', host: CANONICAL, origin: `http://${CANONICAL}`, body: { path: '/repo' } }) as never, canonical.res as never)
    expect(canonical.status()).toBe(200)
    expect(canonical.body()).toMatchObject({ ok: true })

    const local = response()
    await handlerOf(allowed.routes, '/git')(request({ url: '/git/status', method: 'POST', host: '127.0.0.1:3080', body: { path: '/repo' } }) as never, local.res as never)
    expect(local.status()).toBe(200)
  })

  it('playwright control: default fence stays loopback, the mounted fence admits the entry', async () => {
    const controller = { status: () => ({ mode: 'extension', state: 'disconnected', ownedByThisSession: false, busy: false, liveView: false }) }
    const strict = makePlaywrightControlRoutes(controller as never)[0]
    const refused = response()
    await strict.handler(request({ url: '/api/playwright-sessions/status?sessionId=s1', host: CANONICAL }) as never, refused.res as never)
    expect(refused.status()).toBe(403)

    const built = deployment({ authenticated: true })
    const route = makePlaywrightControlRoutes(controller as never, accessTrustOf(built.ctx).isTrusted)[0]
    const accepted = response()
    await route.handler(request({ url: '/api/playwright-sessions/status?sessionId=s1', host: CANONICAL }) as never, accepted.res as never)
    expect(accepted.status()).toBe(200)
    expect(accepted.body()).toMatchObject({ ok: true })
  })

  it('fences are sourced from the service, not from a local loopback check', async () => {
    const denyAll: AccessTrust = { isTrusted: () => false }
    const allowAll: AccessTrust = { isTrusted: () => true }

    // memoir: the guard runs before any store access, so a missing path is a 400.
    const memoirDeps = { store: {} as never, settings: () => ({}) as never, saveSettings: () => {}, logger: { warn: () => {} } }
    const deniedMemoir = response()
    await makeMemoirRoutes({ ...memoirDeps, isTrusted: denyAll.isTrusted })[0].handler(
      request({ url: '/api/dsh-memoir/project', host: '127.0.0.1:3080' }) as never, deniedMemoir.res as never,
    )
    expect(deniedMemoir.status()).toBe(403)
    const allowedMemoir = response()
    await makeMemoirRoutes({ ...memoirDeps, isTrusted: allowAll.isTrusted })[0].handler(
      request({ url: '/api/dsh-memoir/project', host: '127.0.0.1:3080' }) as never, allowedMemoir.res as never,
    )
    expect(allowedMemoir.status()).toBe(400)

    // ssh: GET /hosts answers 200 for an allowed request.
    const sshDeps = { store: {} as never, engine: { list: () => [] } as never, logger: { warn: () => {} } }
    const sshPath = makeSshRoutes({ ...sshDeps, isTrusted: allowAll.isTrusted }).map(route => route.path)
    const deniedSsh = response()
    await makeSshRoutes({ ...sshDeps, isTrusted: denyAll.isTrusted })[0].handler(
      request({ url: sshPath[0] ?? '/', host: '127.0.0.1:3080' }) as never, deniedSsh.res as never,
    )
    expect(deniedSsh.status()).toBe(403)
    const allowedSsh = response()
    await makeSshRoutes({ ...sshDeps, isTrusted: allowAll.isTrusted })[0].handler(
      request({ url: sshPath[0] ?? '/', host: '127.0.0.1:3080' }) as never, allowedSsh.res as never,
    )
    expect(allowedSsh.status()).toBe(200)

    // schedule-mode: GET /tasks answers 200 for an allowed, session-scoped request.
    const engine = { list: async () => ({ available: [], tasks: [] }) } as never
    const deniedSchedule = response()
    await makeScheduleModeRoutes({ engine, logger: { warn: () => {} }, isTrusted: denyAll.isTrusted })[0].handler(
      request({ url: '/api/schedule-mode/tasks?sessionId=s1', host: '127.0.0.1:3080' }) as never, deniedSchedule.res as never,
    )
    expect(deniedSchedule.status()).toBe(403)
    const allowedSchedule = response()
    await makeScheduleModeRoutes({ engine, logger: { warn: () => {} }, isTrusted: allowAll.isTrusted })[0].handler(
      request({ url: '/api/schedule-mode/tasks?sessionId=s1', host: '127.0.0.1:3080' }) as never, allowedSchedule.res as never,
    )
    expect(allowedSchedule.status()).toBe(200)

    // worktree pr-create compatibility route.
    const worktreeDeps = { resolveProjectRoot: () => undefined, runCommand: async () => ({ stdout: '', stderr: '' }), logger: { warn: () => {} } }
    const route = (isTrusted: (req: IncomingMessage) => boolean) => makeWorktreeRoutes({ ...worktreeDeps, isTrusted }).find(candidate => candidate.path === '/worktree/pr-create')
    const deniedWorktree = response()
    await route(denyAll.isTrusted)?.handler(request({ url: '/worktree/pr-create', method: 'POST', host: '127.0.0.1:3080', body: {} }) as never, deniedWorktree.res as never)
    expect(deniedWorktree.status()).toBe(403)
    const allowedWorktree = response()
    await route(allowAll.isTrusted)?.handler(request({ url: '/worktree/pr-create', method: 'POST', host: '127.0.0.1:3080', body: {} }) as never, allowedWorktree.res as never)
    expect(allowedWorktree.status()).toBe(400)
  })

  it('right-pane workbench reads the provided decision', async () => {
    // Mounted before the fence exists: the family falls back to strict loopback.
    const built = context({ workspaceRegistry: { list: () => [] } })
    registerRightPane(built.ctx)
    const handler = handlerOf(built.routes, '/api/workbench')
    const denied = response()
    await handler(request({ url: '/api/workbench/git-status', host: CANONICAL }) as never, denied.res as never)
    expect(denied.status()).toBe(403)

    registerAccessTrust(built.ctx)
    const allowed = response()
    await handler(request({ url: '/api/workbench/git-status', host: '127.0.0.1:3080' }) as never, allowed.res as never)
    expect(allowed.status()).toBe(400)
  })

  it('worktree and workspace-model reads carry the fence instead of leaking host paths', async () => {
    // Host filesystem state (registered repo roots, branches, worktree paths,
    // workspace presets) is privileged: a forged Host, a sessionless remote
    // browser or a request that never reached the plugin may not enumerate it.
    const manager = { getIndex: async () => ({ projects: [{ repoPath: '/repo' }] }) } as never
    const lanes = { laneForPath: async () => null } as never
    const modelManager = { list: () => ({ '/repo': null }), get: () => null } as never

    const denied = deployment({ authenticated: false })
    registerWorktreeRoutes(denied.ctx, manager, lanes)
    registerWorkspaceModelRoutes(denied.ctx, modelManager)

    const forgedTree = response()
    await handlerOf(denied.routes, '/worktree/tree')(request({ url: '/worktree/tree', host: 'evil.example.com' }) as never, forgedTree.res as never)
    expect(forgedTree.status()).toBe(403)
    expect(JSON.stringify(forgedTree.body())).not.toContain('/repo')

    const forgedLane = response()
    await handlerOf(denied.routes, '/worktree/lane')(
      request({ url: '/worktree/lane', method: 'POST', host: 'evil.example.com', origin: 'http://evil.example.com', body: { path: '/repo' } }) as never,
      forgedLane.res as never,
    )
    expect(forgedLane.status()).toBe(403)

    const sessionlessTree = response()
    await handlerOf(denied.routes, '/worktree/tree')(request({ url: '/worktree/tree', host: CANONICAL, origin: `http://${CANONICAL}` }) as never, sessionlessTree.res as never)
    expect(sessionlessTree.status()).toBe(403)

    const forgedList = response()
    await handlerOf(denied.routes, '/workspace-model/list')(request({ url: '/workspace-model/list', host: 'evil.example.com' }) as never, forgedList.res as never)
    expect(forgedList.status()).toBe(403)

    const allowed = deployment({ authenticated: true })
    registerWorktreeRoutes(allowed.ctx, manager, lanes)
    registerWorkspaceModelRoutes(allowed.ctx, modelManager)

    const tree = response()
    await handlerOf(allowed.routes, '/worktree/tree')(request({ url: '/worktree/tree', host: CANONICAL, origin: `http://${CANONICAL}` }) as never, tree.res as never)
    expect(tree.status()).toBe(200)
    expect(tree.body()).toMatchObject({ ok: true })

    const lane = response()
    await handlerOf(allowed.routes, '/worktree/lane')(
      request({ url: '/worktree/lane', method: 'POST', host: CANONICAL, origin: `http://${CANONICAL}`, body: { path: '/repo' } }) as never,
      lane.res as never,
    )
    expect(lane.status()).toBe(200)

    const list = response()
    await handlerOf(allowed.routes, '/workspace-model/list')(request({ url: '/workspace-model/list', host: CANONICAL, origin: `http://${CANONICAL}` }) as never, list.res as never)
    expect(list.status()).toBe(200)

    // The local page keeps working unchanged.
    const local = response()
    await handlerOf(allowed.routes, '/worktree/tree')(request({ url: '/worktree/tree', host: '127.0.0.1:3080' }) as never, local.res as never)
    expect(local.status()).toBe(200)
  })

  it('never treats a present pairing cookie as an allow path', async () => {
    // The pre-0.4 gate read `dsh_remote_pair` for presence only (nothing in this
    // plugin ever minted it), so `Host: evil.example` + `Cookie: dsh_remote_pair=1`
    // passed every worktree mutation. A cookie is not a credential: the fence is
    // the only admission rule now.
    const manager = { getIndex: async () => ({ projects: [] }), remove: async () => ({ name: 'x', path: '/x' }) } as never
    const lanes = { laneForPath: async () => null, createLane: async () => ({ name: 'x', branch: 'x', path: '/x', head: null, created: true }) } as never
    const modelManager = { list: () => ({}), set: async () => ({}) } as never

    const denied = deployment({ authenticated: false })
    registerWorktreeRoutes(denied.ctx, manager, lanes)
    registerWorkspaceModelRoutes(denied.ctx, modelManager)

    const forgedRemove = response()
    await handlerOf(denied.routes, '/worktree/remove')(
      request({
        url: '/worktree/remove',
        method: 'POST',
        host: 'evil.example',
        origin: 'http://evil.example',
        cookie: 'dsh_remote_pair=forged',
        body: { repoPath: '/repo', name: 'x' },
      }) as never,
      forgedRemove.res as never,
    )
    expect(forgedRemove.status()).toBe(403)

    const forgedLane = response()
    await handlerOf(denied.routes, '/worktree/lane/create')(
      request({
        url: '/worktree/lane/create',
        method: 'POST',
        host: 'evil.example',
        origin: 'http://evil.example',
        cookie: 'dsh_remote_pair=forged',
        body: { repoPath: '/repo', branch: 'x' },
      }) as never,
      forgedLane.res as never,
    )
    expect(forgedLane.status()).toBe(403)

    const forgedModel = response()
    await handlerOf(denied.routes, '/workspace-model/set')(
      request({
        url: '/workspace-model/set',
        method: 'POST',
        host: 'evil.example',
        origin: 'http://evil.example',
        cookie: 'dsh_remote_pair=forged',
        body: { path: '/repo', preset: { provider: 'p', model: 'm' } },
      }) as never,
      forgedModel.res as never,
    )
    expect(forgedModel.status()).toBe(403)
  })
})