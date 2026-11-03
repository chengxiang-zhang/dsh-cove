import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerWorktreeRoutes } from '../src/host/services/worktree/routes.ts'
import { installLaneWorkspaceRetirement, type LaneRetirementManager } from '../src/host/services/worktree/index.ts'
import { registerWorkspaceModelRoutes } from '../src/host/services/worktree/workspace-model-routes.ts'
import type { WorktreeManager } from '../src/host/services/worktree/manager.ts'
import type { WorkspaceModelManager } from '../src/host/services/worktree/workspace-model.ts'
import { notifyFamilyConfigChange } from '../src/host/services/family-config.ts'

const runtime = vi.hoisted(() => ({
  timers: new Set<unknown>(),
}))

vi.mock('node:timers', () => {
  const timer = () => {
    const handle = { unref: vi.fn() }
    runtime.timers.add(handle)
    return handle
  }
  return { setTimeout: vi.fn(timer), setInterval: vi.fn(timer) }
})


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
