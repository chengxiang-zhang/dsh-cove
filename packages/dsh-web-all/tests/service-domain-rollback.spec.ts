import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerWorktreeRoutes } from '../src/host/services/worktree/routes.ts'
import { installLaneWorkspaceRetirement, type LaneRetirementManager } from '../src/host/services/worktree/index.ts'
import { registerWorkspaceModelRoutes } from '../src/host/services/worktree/workspace-model-routes.ts'
import type { WorktreeManager } from '../src/host/services/worktree/manager.ts'
import type { WorkspaceModelManager } from '../src/host/services/worktree/workspace-model.ts'
import { registerServerMode } from '../src/host/services/remote-web-ui/server.ts'
import { AccountStore } from '../src/host/services/remote-web-ui/server-mode/accounts.ts'
import { notifyFamilyConfigChange } from '../src/host/services/family-config.ts'

const runtime = vi.hoisted(() => ({
  timers: new Set<unknown>(),
  gateways: [] as Array<{ start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; release(): void; reject(error: Error): void }>,
}))

vi.mock('node:timers', () => {
  const timer = () => {
    const handle = { unref: vi.fn() }
    runtime.timers.add(handle)
    return handle
  }
  return { setTimeout: vi.fn(timer), setInterval: vi.fn(timer) }
})
vi.mock('../src/host/services/remote-web-ui/server-mode/lan.ts', () => ({ lanIPv4Addresses: () => [] }))
vi.mock('../src/host/services/remote-web-ui/server-mode/gateway.ts', () => ({
  Gateway: class {
    secure = false
    port = 3082
    start: ReturnType<typeof vi.fn>
    close = vi.fn(async () => {})
    constructor() {
      let release!: () => void
      let reject!: (error: Error) => void
      const pending = new Promise<void>((resolve, fail) => { release = resolve; reject = fail })
      this.start = vi.fn(() => pending)
      runtime.gateways.push({ start: this.start, close: this.close, release, reject })
    }
  },
}))

function fixture(options: { failRoute?: number; failOn?: boolean; failPort?: boolean; failDispose?: boolean } = {}) {
  const activeRoutes = new Set<string>()
  const released: string[] = []
  const events = new Set<string>()
  const auth = {
    isAuthenticated: vi.fn(() => false),
    authorizeIndex: vi.fn(() => false),
    authenticatedUrl: vi.fn((value: string) => value),
  }
  const originalAuth = { ...auth }
  let registrations = 0
  const register = vi.fn((route: WebRoute) => {
    registrations++
    if (registrations === options.failRoute) throw new Error('route acquisition failed')
    activeRoutes.add(route.path)
    return () => {
      activeRoutes.delete(route.path)
      released.push(route.path)
      if (options.failDispose && route.path === '/api/gateway') throw new Error('route release failed')
    }
  })
  const ctx = {
    connection: { browserAuth: auth },
    get: () => undefined,
    webServer: {
      get port() { if (options.failPort) throw new Error('port unavailable'); return 3080 },
      register,
    },
    on: (event: string) => {
      if (options.failOn) throw new Error('event acquisition failed')
      events.add(event)
      return () => { events.delete(event) }
    },
  } as unknown as Context
  // The store constructors only probe these nonexistent files; no credentials
  // are loaded and no test writes or real listeners are needed.
  const env = { dshHome: `/tmp/dsh-domain-rollback-${randomUUID()}` }
  return { ctx, activeRoutes, released, events, auth, originalAuth, register, env }
}

beforeEach(() => {
  runtime.timers.clear()
  runtime.gateways.length = 0
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(handle => { runtime.timers.delete(handle) })
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(handle => { runtime.timers.delete(handle) })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('worktree retirement subscription rollback', () => {
  it('unsubscribes activity when acquiring the stop listener throws', () => {
    const active = new Set<string>()
    const ctx = {
      on: (event: string) => {
        if (event === 'workspace/session-stop') throw new Error('stop listener failed')
        active.add(event)
        return () => { active.delete(event) }
      },
    } as unknown as Context
    expect(() => installLaneWorkspaceRetirement(ctx, {} as LaneRetirementManager)).toThrow('stop listener failed')
    expect(active.size).toBe(0)
  })

  it('unsubscribes both listeners when workspace injection throws', () => {
    const active = new Set<string>()
    const ctx = {
      on: (event: string) => { active.add(event); return () => { active.delete(event) } },
      inject: () => { throw new Error('workspace fiber failed') },
    } as unknown as Context
    expect(() => installLaneWorkspaceRetirement(ctx, {} as LaneRetirementManager)).toThrow('workspace fiber failed')
    expect(active.size).toBe(0)
  })
})

describe('worktree route acquisition rollback', () => {
  it.each([
    ['worktree', (ctx: Context) => registerWorktreeRoutes(ctx, {} as WorktreeManager)],
    ['workspace-model', (ctx: Context) => registerWorkspaceModelRoutes(ctx, {} as WorkspaceModelManager)],
  ] as const)('releases the first %s route when the second acquisition fails', (_name, register) => {
    const built = fixture({ failRoute: 2 })
    expect(() => register(built.ctx)).toThrow('route acquisition failed')
    expect(built.released).toHaveLength(1)
    expect(built.activeRoutes.size).toBe(0)
  })

  it('rolls back an acquired compatibility route when the first normal route fails', () => {
    const built = fixture({ failRoute: 2 })
    expect(() => registerWorktreeRoutes(built.ctx, {} as WorktreeManager, undefined, {
      resolveProjectRoot: () => undefined,
      logger: { warn: () => {} },
    })).toThrow('route acquisition failed')
    expect(built.released).toEqual(['/worktree/pr-create'])
    expect(built.activeRoutes.size).toBe(0)
  })

  it('releases all model routes in reverse order and only once', () => {
    const built = fixture()
    const dispose = registerWorkspaceModelRoutes(built.ctx, {} as WorkspaceModelManager)
    dispose()
    dispose()
    expect(built.released).toEqual([
      '/workspace-model/clear', '/workspace-model/set', '/workspace-model/get', '/workspace-model/list',
    ])
    expect(built.activeRoutes.size).toBe(0)
  })
})

describe('remote server-mode acquisition rollback', () => {
  it('restores BrowserAuth if setup fails immediately after patching it', () => {
    const built = fixture({ failPort: true })
    expect(() => registerServerMode(built.ctx, {}, built.env)).toThrow('port unavailable')
    expect(built.auth).toEqual(built.originalAuth)
    expect(runtime.timers.size).toBe(0)
  })

  it('clears both timers and restores BrowserAuth when index subscription fails', () => {
    const built = fixture({ failOn: true })
    expect(() => registerServerMode(built.ctx, {}, built.env)).toThrow('event acquisition failed')
    expect(runtime.timers.size).toBe(0)
    expect(built.auth).toEqual(built.originalAuth)
  })

  it('rolls back routes, timers, index listener and settings watcher after a later route throws', () => {
    const built = fixture({ failRoute: 2 })
    expect(() => registerServerMode(built.ctx, {}, built.env)).toThrow('route acquisition failed')
    expect(built.released).toEqual(['/login'])
    expect(built.activeRoutes.size).toBe(0)
    expect(built.events.size).toBe(0)
    expect(runtime.timers.size).toBe(0)
    expect(built.auth).toEqual(built.originalAuth)
    const attempts = built.register.mock.calls.length
    notifyFamilyConfigChange()
    expect(built.register).toHaveBeenCalledTimes(attempts)
  })

  it('rolls back a partial settings-driven route replacement without leaving new routes', () => {
    const built = fixture({ failRoute: 6 })
    const dispose = registerServerMode(built.ctx, {}, built.env)
    expect(built.activeRoutes.size).toBe(4)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    notifyFamilyConfigChange()
    expect(warn).toHaveBeenCalled()
    expect(built.activeRoutes.size).toBe(0)
    expect(built.released).toEqual([
      '/api/gateway', '/auth', '/api/gateway/auth/providers', '/login', '/login',
    ])
    dispose()
    expect(runtime.timers.size).toBe(0)
    expect(built.events.size).toBe(0)
    expect(built.auth).toEqual(built.originalAuth)
  })

  it('continues cleanup after a route disposer throws', () => {
    const built = fixture({ failDispose: true })
    const dispose = registerServerMode(built.ctx, {}, built.env)
    expect(() => dispose()).toThrow('service resource cleanup failed')
    expect(built.activeRoutes.size).toBe(0)
    expect(built.events.size).toBe(0)
    expect(runtime.timers.size).toBe(0)
    expect(built.auth).toEqual(built.originalAuth)
    expect(() => dispose()).not.toThrow()
  })

  it('does not start a queued gateway after synchronous disposal', async () => {
    vi.spyOn(AccountStore.prototype, 'isEmpty').mockReturnValue(false)
    const built = fixture()
    const dispose = registerServerMode(built.ctx, { legacyGatewayEnabled: true }, built.env)
    dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.gateways).toHaveLength(0)
  })

  it('closes a gateway after asynchronous startup rejects', async () => {
    vi.spyOn(AccountStore.prototype, 'isEmpty').mockReturnValue(false)
    const built = fixture()
    const dispose = registerServerMode(built.ctx, { legacyGatewayEnabled: true }, built.env)
    await Promise.resolve()
    const gateway = runtime.gateways[0]
    gateway.reject(new Error('listen failed after allocating server'))
    await Promise.resolve()
    await Promise.resolve()
    expect(gateway.close).toHaveBeenCalledOnce()
    dispose()
    await Promise.resolve()
    expect(gateway.close).toHaveBeenCalledOnce()
  })

  it('closes a gateway whose asynchronous start settles after disposal', async () => {
    vi.spyOn(AccountStore.prototype, 'isEmpty').mockReturnValue(false)
    const built = fixture()
    const dispose = registerServerMode(built.ctx, { legacyGatewayEnabled: true }, built.env)
    await Promise.resolve()
    expect(runtime.gateways).toHaveLength(1)
    const gateway = runtime.gateways[0]
    expect(gateway.start).toHaveBeenCalledOnce()
    dispose()
    gateway.release()
    await Promise.resolve()
    await Promise.resolve()
    expect(gateway.close).toHaveBeenCalledOnce()
    expect(built.activeRoutes.size).toBe(0)
    expect(runtime.timers.size).toBe(0)
    expect(built.auth).toEqual(built.originalAuth)
  })
})
