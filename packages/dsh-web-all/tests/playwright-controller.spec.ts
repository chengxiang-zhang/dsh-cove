import { describe, expect, it, vi } from 'vitest'
import { PlaywrightSessionsController } from '../src/host/services/playwright-sessions/controller.ts'
import { resolvePlaywrightSessionsConfig } from '../src/core/playwright-sessions/contracts.ts'

function harness(fail = false) {
  const calls: string[] = []
  const browser = { call: vi.fn(async (name: string) => { calls.push(name); if (fail) throw new Error('missing extension'); return { content: [], isError: false } }) }
  const manager = {
    get: vi.fn(async () => browser),
    dispose: vi.fn(async () => undefined),
  }
  const controller = new PlaywrightSessionsController({
    config: resolvePlaywrightSessionsConfig({ mode: 'extension' }),
    manager: manager as never,
    sessionExists: async id => id !== 'missing',
  })
  return { controller, manager, calls }
}

describe('PlaywrightSessionsController', () => {
  it('takes one attended lease and warms up the extension with a read-only tab list', async () => {
    const { controller, calls } = harness()
    const status = await controller.connect('s1')
    expect(status).toMatchObject({ state: 'connected', ownedByThisSession: true, busy: false })
    expect(calls).toEqual(['browser_tabs'])
    expect(controller.status('s2')).toMatchObject({ state: 'disconnected', busy: true, ownedByThisSession: false })
  })

  it('rejects a second owner instead of evicting the active session', async () => {
    const { controller } = harness()
    await controller.connect('s1')
    await expect(controller.connect('s2')).rejects.toMatchObject({ code: 'busy' })
  })

  it('releases the lease after failed extension startup', async () => {
    const { controller, manager } = harness(true)
    await expect(controller.connect('s1')).rejects.toMatchObject({ code: 'connect-failed' })
    expect(manager.dispose).toHaveBeenCalledWith('s1')
    expect(controller.status('s2').busy).toBe(false)
  })

  it('disconnects only the owner and leaves external Chrome ownership untouched', async () => {
    const { controller, manager } = harness()
    await controller.connect('s1')
    await expect(controller.disconnect('s2')).rejects.toMatchObject({ code: 'not-owner' })
    await expect(controller.disconnect('s1')).resolves.toMatchObject({ state: 'disconnected' })
    expect(manager.dispose).toHaveBeenCalledWith('s1')
  })

  it('fails closed for missing sessions and non-owners', async () => {
    const { controller } = harness()
    await expect(controller.connect('missing')).rejects.toMatchObject({ code: 'not-found' })
    expect(() => controller.requireOwner('s1')).toThrow(/Connect this session/)
  })
})
