/** CDP 直连模式单测：配置默认值、子进程参数与失败边界。 */
import { describe, expect, it } from 'vitest'
import { resolvePlaywrightSessionsConfig } from '../src/core/playwright-sessions/contracts.ts'
import { sessionBrowserArgs, type SessionBrowserOptions } from '../src/host/services/playwright-sessions/child.ts'

function options(overrides: Partial<SessionBrowserOptions> = {}): SessionBrowserOptions {
  return {
    cliPath: '/tmp/@playwright/mcp/cli.js',
    sessionId: 'session-abc',
    sessionsRoot: '/tmp/pw-sessions',
    env: {},
    mode: 'launch',
    cdpEndpoint: '',
    headless: true,
    browserChannel: 'chrome',
    executablePath: '',
    allowedHosts: ['*'],
    allowedOrigins: [],
    blockedOrigins: [],
    toolCallTimeoutMs: 120_000,
    ...overrides,
  }
}

describe('playwright-sessions cdp config', () => {
  it('keeps the configured endpoint and drops the per-action approval gate', () => {
    const resolved = resolvePlaywrightSessionsConfig({ mode: 'cdp', cdpEndpoint: 'http://127.0.0.1:9222' })
    expect(resolved.mode).toBe('cdp')
    expect(resolved.cdpEndpoint).toBe('http://127.0.0.1:9222')
    expect(resolved.approvalPolicy).toBe('never')
    expect(resolved.unsafeTools).toBe(true)
    expect(resolved.liveView).toBe(false)
  })

  it('still defaults the endpoint to empty and live view to off', () => {
    expect(resolvePlaywrightSessionsConfig().cdpEndpoint).toBe('')
    expect(resolvePlaywrightSessionsConfig({ mode: 'cdp', liveView: true }).liveView).toBe(false)
  })
})

describe('playwright-sessions cdp child arguments', () => {
  it('attaches over --cdp-endpoint without a profile or extension handshake', () => {
    const args = sessionBrowserArgs(
      options({ mode: 'cdp', cdpEndpoint: 'http://127.0.0.1:9222' }),
      '/tmp/pw-sessions/session-abc',
      '/tmp/pw-sessions/session-abc/output',
    )
    expect(args).toContain('--cdp-endpoint')
    expect(args[args.indexOf('--cdp-endpoint') + 1]).toBe('http://127.0.0.1:9222')
    expect(args).not.toContain('--extension')
    expect(args).not.toContain('--user-data-dir')
    expect(args).not.toContain('--headless')
  })

  it('fails loudly when cdp mode has no endpoint', () => {
    expect(() => sessionBrowserArgs(
      options({ mode: 'cdp' }),
      '/tmp/pw-sessions/session-abc',
      '/tmp/pw-sessions/session-abc/output',
    )).toThrow(/requires a cdpEndpoint/)
  })

  it('keeps launch and extension arguments unchanged', () => {
    const launch = sessionBrowserArgs(options(), '/tmp/p/session-abc', '/tmp/p/session-abc/output')
    expect(launch).toContain('--headless')
    expect(launch[launch.indexOf('--user-data-dir') + 1]).toBe('/tmp/p/session-abc')

    const hosted = sessionBrowserArgs(options({ liveView: true }), '/tmp/p/session-abc', '/tmp/p/session-abc/output', 'ws://127.0.0.1:4000/devtools/browser/x')
    expect(hosted[hosted.indexOf('--cdp-endpoint') + 1]).toBe('ws://127.0.0.1:4000/devtools/browser/x')

    const extension = sessionBrowserArgs(options({ mode: 'extension' }), '/tmp/p/session-abc', '/tmp/p/session-abc/output')
    expect(extension).toContain('--extension')
    expect(extension[extension.indexOf('--browser') + 1]).toBe('chrome')
    expect(extension).not.toContain('--user-data-dir')
  })
})
