/**
 * The fence and the repository scope, enumerated instead of remembered.
 *
 * Every privileged route in this domain has to answer an untrusted request with
 * 403 *before* it reaches the manager, and every route that carries an explicit
 * repository path has to refuse a repository outside the workspaces the host has
 * registered. Both are rules about the whole file rather than about one handler,
 * so they are asserted over the registered routes: a route that forgets either
 * fails here even when its own tests pass - the failure mode that put the
 * earlier holes in this surface.
 *
 * The context below provides no access-trust service, so `accessTrustOf` falls
 * back to the strict loopback rule, and these fake requests have no loopback
 * socket: untrusted by construction. The scope tests provide the trust service
 * so the refusal they assert cannot be the fence's.
 */

import { describe, expect, it } from 'vitest'
import { isInsidePath } from '../src/core/worktree/paths.ts'
import { registerWorktreeRoutes } from '../src/host/services/worktree/routes.ts'

/** Every path this domain must mount, read and mutation alike. */
const EXPECTED_PATHS = [
  '/worktree/tree',
  '/worktree/lane',
  '/worktree/lane/create',
  '/worktree/lane/bind',
  '/worktree/lane/rollback',
  '/worktree/create',
  '/worktree/remove',
  '/worktree/init',
  '/worktree/pr-create',
  '/worktree/status',
  '/worktree/cleanup',
]

interface CapturedRoute {
  path: string
  handler: (req: unknown, res: unknown) => Promise<void>
}

interface CaptureOptions {
  /** Provide an access-trust service that admits everything (scope tests). */
  trusted?: boolean
  /** Workspace paths the fake registry reports (its `list()`). */
  workspaces?: string[]
}

function captureRoutes(manager: unknown, lanes: unknown, options: CaptureOptions = {}): CapturedRoute[] {
  const routes: CapturedRoute[] = []
  const ctx = {
    get: (name: string) => (options.trusted === true && name === 'webAllAccessTrust'
      ? { isTrusted: () => true }
      : undefined),
    ...(options.workspaces === undefined
      ? {}
      : { workspaceRegistry: { list: () => options.workspaces!.map((path) => ({ path })) } }),
    webServer: {
      register: (route: CapturedRoute) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  registerWorktreeRoutes(ctx as never, manager as never, lanes as never)
  return routes
}

/**
 * A manager that records every method it is asked to perform.
 * Without `record` each method throws: reaching the manager at all is the bug.
 */
function fakeManager(options: { record?: boolean } = {}) {
  const calls: string[] = []
  const method = (name: string, value: unknown = { name: 'x', path: '/repo/.dsh/workspaces/x' }) =>
    async (): Promise<unknown> => {
      calls.push(name)
      if (options.record !== true) throw new Error(`${name} must not be reached`)
      return value
    }
  return {
    calls,
    manager: {
      getIndex: method('getIndex', { projects: [] }),
      laneForPath: async () => { calls.push('laneForPath'); return null },
      ensureLane: method('ensureLane'),
      create: method('create'),
      remove: method('remove'),
      init: method('init'),
      prCreate: method('prCreate'),
      status: method('status', {}),
      cleanup: method('cleanup'),
      rollbackCreate: method('rollbackCreate'),
    },
  }
}

/** The lane orchestrator, recorded the same way. */
function fakeLanes(options: { record?: boolean } = {}) {
  const calls: string[] = []
  const fail = (name: string) => async (): Promise<never> => {
    calls.push(name)
    throw new Error(`${name} must not be reached`)
  }
  return {
    calls,
    lanes: {
      createLane: options.record === true
        ? async () => { calls.push('createLane'); return {} }
        : fail('createLane'),
      bindLaneSession: options.record === true
        ? async () => { calls.push('bindLaneSession'); return {} }
        : fail('bindLaneSession'),
      rollbackLane: options.record === true
        ? async () => { calls.push('rollbackLane') }
        : fail('rollbackLane'),
      laneForPath: async () => { calls.push('laneForPath'); return null },
    },
  }
}

function fakeResponse() {
  const state = { status: 0, body: '' }
  return {
    state,
    res: {
      writeHead: (status: number) => { state.status = status },
      end: (body: string) => { state.body = body },
    },
  }
}

/** A request with no loopback socket, an optional JSON body, and a Host header. */
function fakeRequest(method: string, url: string, body?: unknown) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers: { 'content-type': 'application/json', host: 'dsh.local' },
    socket: undefined,
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload)
    },
  }
}

describe('worktree route fence', () => {
  it('mounts exactly the expected routes', () => {
    const { manager } = fakeManager()
    const { lanes } = fakeLanes()

    expect(captureRoutes(manager, lanes).map((route) => route.path).sort())
      .toEqual([...EXPECTED_PATHS].sort())
  })

  it('refuses every route for an untrusted request, before any work', async () => {
    const { manager, calls } = fakeManager()
    const { lanes, calls: laneCalls } = fakeLanes()
    const routes = captureRoutes(manager, lanes)

    for (const route of routes) {
      let forbidden = false
      // Either method: a route answers 405 for the one it does not serve, so the
      // fence has to be visible on at least one of them.
      for (const method of ['GET', 'POST']) {
        const { state, res } = fakeResponse()
        await route.handler(fakeRequest(method, route.path), res)
        if (state.status === 403) forbidden = true
        else expect([403, 405], `${route.path} ${method} answered ${state.status}`).toContain(state.status)
      }
      expect(forbidden, `${route.path} never answered 403 to an untrusted request`).toBe(true)
    }

    expect(calls, 'an untrusted request reached the manager').toEqual([])
    expect(laneCalls, 'an untrusted request reached the lane orchestrator').toEqual([])
  })
})

describe('worktree route repository scope', () => {
  it('refuses a repository outside every registered workspace, before any work', async () => {
    const { manager, calls } = fakeManager()
    const { lanes, calls: laneCalls } = fakeLanes()
    const routes = captureRoutes(manager, lanes, { trusted: true, workspaces: ['/repo'] })
    const route = routes.find((candidate) => candidate.path === '/worktree/create')

    const { state, res } = fakeResponse()
    await route?.handler(fakeRequest('POST', '/worktree/create', { repoPath: '/outside', branch: 'feature/x' }), res)

    expect(state.status, 'the refusal is a domain error, not a fence 403').toBe(400)
    expect(JSON.parse(state.body)).toMatchObject({ ok: false, code: 'workspace-unknown' })
    expect(calls, 'the refused request reached the manager').toEqual([])
    expect(laneCalls).toEqual([])
  })

  it('lets a repository inside a registered workspace through to the manager', async () => {
    const { manager, calls } = fakeManager({ record: true })
    const { lanes } = fakeLanes({ record: true })
    // The workspace is a parent directory: containment, not path equality.
    const routes = captureRoutes(manager, lanes, { trusted: true, workspaces: ['/workspaces'] })
    const route = routes.find((candidate) => candidate.path === '/worktree/status')

    const { state, res } = fakeResponse()
    await route?.handler(fakeRequest('POST', '/worktree/status', { repoPath: '/workspaces/repo' }), res)

    expect(state.status).toBe(200)
    expect(calls).toContain('status')
  })

  it('scopes the lane routes as well, not only the worktree ones', async () => {
    const { manager } = fakeManager()
    const { lanes, calls: laneCalls } = fakeLanes()
    const routes = captureRoutes(manager, lanes, { trusted: true, workspaces: ['/repo'] })
    const route = routes.find((candidate) => candidate.path === '/worktree/lane/create')

    const { state, res } = fakeResponse()
    await route?.handler(fakeRequest('POST', '/worktree/lane/create', { repoPath: '/elsewhere', branch: 'feature/x' }), res)

    expect(JSON.parse(state.body)).toMatchObject({ code: 'workspace-unknown' })
    expect(laneCalls, 'the refused lane request reached the orchestrator').toEqual([])
  })
})

describe('isInsidePath', () => {
  it('is segment-aware rather than a string prefix', () => {
    expect(isInsidePath('/repo', '/repo')).toBe(true)
    expect(isInsidePath('/repo', '/repo/sub')).toBe(true)
    expect(isInsidePath('/repo/', '/repo/sub/')).toBe(true)
    // The prefix trap: a sibling whose name merely starts with the root's.
    expect(isInsidePath('/repo', '/repo-other')).toBe(false)
    expect(isInsidePath('/repo', '/')).toBe(false)
    expect(isInsidePath('/repo', '/repo2/sub')).toBe(false)
  })
})