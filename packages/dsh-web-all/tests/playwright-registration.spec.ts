import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  require: vi.fn(), control: vi.fn(), live: vi.fn(), managerDispose: vi.fn(), controllerDispose: vi.fn(),
}))
vi.mock('node:module', async importOriginal => ({
  ...await importOriginal<typeof import('node:module')>(),
  createRequire: () => Object.assign(mocks.require, { resolve: (name: string) => name }),
}))
vi.mock('../src/host/services/playwright-sessions/routes.ts', () => ({ registerPlaywrightControlRoutes: mocks.control }))
vi.mock('../src/host/services/playwright-sessions/live-view.ts', () => ({ registerLiveViewUpgrade: mocks.live }))
vi.mock('../src/host/services/playwright-sessions/manager.ts', () => ({
  SessionBrowserManager: class { disposeAll = mocks.managerDispose; ids = () => []; contextOf = () => undefined },
}))
vi.mock('../src/host/services/playwright-sessions/controller.ts', () => ({
  PlaywrightSessionsController: class { dispose = mocks.controllerDispose },
}))
import { register } from '../src/host/services/playwright-sessions/index.ts'

const paths: string[] = []
afterEach(() => {
  for (const path of paths.splice(0)) {
    if (!path.startsWith(`${realpathSync(tmpdir())}/playwright-registration-`)) throw new Error('unexpected temporary cleanup target')
    rmSync(path, { recursive: true, force: true })
  }
  vi.resetAllMocks()
})
function setup(tools: unknown[] = []) {
  const calls: string[] = []
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'playwright-registration-')))
  paths.push(root)
  mocks.control.mockImplementation(() => () => { calls.push('routes') })
  mocks.live.mockImplementation(() => () => { calls.push('live') })
  mocks.controllerDispose.mockImplementation(async () => { calls.push('controller') })
  mocks.managerDispose.mockImplementation(async () => { calls.push('manager') })
  mocks.require.mockReturnValue({ tools: { resolveCLIConfigForMCP: () => ({}), filteredTools: () => tools } })
  const ctx = { tools: { register: vi.fn(() => () => { calls.push('tool') }) }, on: vi.fn(() => () => {}) }
  return { calls, root, ctx }
}

describe('Playwright registration rollback', () => {
  it('cleans control and live surfaces when tool enumeration rejects', async () => {
    const { calls, root, ctx } = setup()
    mocks.require.mockImplementation(() => { throw new Error('tool API changed') })
    await expect(register(ctx as never, { sessionsRoot: root, liveView: true })).rejects.toThrow('tool API changed')
    expect(calls).toEqual(['live', 'routes', 'controller', 'manager'])
  })

  it('cleans every resource when the bundle exposes an empty tool list', async () => {
    const { calls, root, ctx } = setup()
    await expect(register(ctx as never, { sessionsRoot: root, liveView: true })).rejects.toThrow('tool list is empty')
    expect(calls).toEqual(['live', 'routes', 'controller', 'manager'])
  })

  it('rolls back earlier tools and live view when a later tool registration fails', async () => {
    const tool = (name: string) => ({ schema: { name, inputSchema: { type: 'object', properties: {} } } })
    const { calls, root, ctx } = setup([tool('browser_tabs'), tool('browser_close')])
    ctx.tools.register.mockImplementationOnce(() => () => { calls.push('tool') })
      .mockImplementationOnce(() => { throw new Error('duplicate tool') })
    await expect(register(ctx as never, { sessionsRoot: root, liveView: true })).rejects.toThrow('duplicate tool')
    expect(calls).toEqual(['tool', 'live', 'routes', 'controller', 'manager'])
  })

  it('cleans resources when owner aborts during asynchronous enumeration', async () => {
    const { calls, root, ctx } = setup()
    const owner = new AbortController()
    mocks.require.mockReturnValue({ tools: { resolveCLIConfigForMCP: () => new Promise(() => {}), filteredTools: () => [] } })
    const pending = register(ctx as never, { sessionsRoot: root, liveView: true }, owner.signal)
    owner.abort(new Error('owner aborted'))
    await expect(pending).rejects.toThrow('owner aborted')
    expect(calls).toEqual(['live', 'routes', 'controller', 'manager'])
  })
})
