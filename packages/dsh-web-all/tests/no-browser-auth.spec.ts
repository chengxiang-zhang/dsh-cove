import { describe, expect, it, vi } from 'vitest'
import {
  bypassBrowserAuthentication,
  register,
  type BrowserConnectionLike,
} from '../src/host/services/no-browser-auth/index.ts'

function context(connection: BrowserConnectionLike) {
  return {
    get: (id: string) => id === 'connection' ? connection : undefined,
    logger: { info: vi.fn(), warn: vi.fn() },
  }
}

describe('no-browser-auth service domain', () => {
  it('replaces only isAuthenticated and restores the exact method', () => {
    const original = vi.fn((_request: unknown) => false)
    const connection = { browserAuth: { isAuthenticated: original } }
    const restore = bypassBrowserAuthentication(connection)

    expect(connection.browserAuth.isAuthenticated({ from: 'browser' })).toBe(true)
    expect(original).not.toHaveBeenCalled()

    restore()
    expect(connection.browserAuth.isAuthenticated).toBe(original)
    expect(connection.browserAuth.isAuthenticated({ from: 'browser' })).toBe(false)
  })

  it('fails loudly when the private SDK surface is absent', () => {
    expect(() => bypassBrowserAuthentication({})).toThrow(/browserAuth\.isAuthenticated is missing/)
  })

  it('is disabled by default inside web-all', () => {
    const original = vi.fn(() => false)
    const connection = { browserAuth: { isAuthenticated: original } }
    const ctx = context(connection)

    const dispose = register(ctx as never)
    expect(connection.browserAuth.isAuthenticated({})).toBe(false)
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('explicit opt-in'))
    dispose()
  })

  it('patches only after explicit opt-in and warns about the security boundary', () => {
    const original = vi.fn(() => false)
    const connection = { browserAuth: { isAuthenticated: original } }
    const ctx = context(connection)

    const dispose = register(ctx as never, { enabled: true })
    expect(connection.browserAuth.isAuthenticated({})).toBe(true)
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Host/Origin fence still applies'))

    dispose()
    expect(connection.browserAuth.isAuthenticated).toBe(original)
  })
})
