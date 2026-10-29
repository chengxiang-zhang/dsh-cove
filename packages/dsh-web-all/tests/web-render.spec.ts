import { describe, expect, it, vi } from 'vitest'
import {
  defaultUserDataDir,
  effectiveConfig,
  WEB_RENDER_PROVIDER_ID,
  WEB_RENDER_SETTINGS_NAMESPACE,
  WebRenderError,
} from '../src/host/services/web-render/contracts.ts'
import { register } from '../src/host/services/web-render/index.ts'
import { RenderFetchProvider } from '../src/host/services/web-render/provider.ts'

/** 只实现本域用到的 ctx.inject，捕获被注册的 provider。 */
function fakeContext() {
  const providers: Array<{ id: string }> = []
  const ctx = {
    inject: (_deps: readonly string[], callback: (c: unknown) => void): void => {
      callback({
        web: {
          registerFetchProvider(provider: { id: string }) {
            providers.push(provider)
            return () => { providers.splice(providers.indexOf(provider), 1) }
          },
        },
      })
    },
  }
  return { ctx, providers }
}

/** 指向不存在路径的 provider：available() 必为 false，且不会真的启动浏览器。 */
function unavailableProvider() {
  return new RenderFetchProvider(
    () => effectiveConfig({ executablePath: '/nonexistent/chrome-does-not-exist' }),
    '',
  )
}

describe('web-render contracts', () => {
  it('exposes the settings namespace and provider id the profile pin depends on', () => {
    expect(WEB_RENDER_SETTINGS_NAMESPACE).toBe('web-render')
    expect(WEB_RENDER_PROVIDER_ID).toBe('browser')
  })

  it('resolves defaults when nothing is configured', () => {
    const config = effectiveConfig(undefined)
    expect(config.enabled).toBe(true)
    expect(config.headless).toBe(true)
    expect(config.extract).toBe('html')
    expect(config.browserChannels).toEqual(['chrome', 'msedge', 'chromium'])
    expect(config.maxBodyChars).toBe(200_000)
  })

  it('keeps explicit values over defaults', () => {
    const config = effectiveConfig({ extract: 'text', headless: false, maxBodyChars: 1_000 })
    expect(config.extract).toBe('text')
    expect(config.headless).toBe(false)
    expect(config.maxBodyChars).toBe(1_000)
  })

  it('derives the persistent profile directory from dshHome', () => {
    expect(defaultUserDataDir('/tmp/home')).toBe('/tmp/home/cache/web-render/chrome-profile')
  })

  it('reports failures as WebError-shaped errors with a routable code', () => {
    const error = new WebRenderError('boom', 'WEB_INVALID_URL')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('WebError')
    expect(error.code).toBe('WEB_INVALID_URL')
  })
})

describe('web-render registration', () => {
  it('registers exactly one browser provider and unregisters on dispose', () => {
    const { ctx, providers } = fakeContext()
    const dispose = register(ctx as never, { config: {}, dshHome: '/tmp/home' })

    expect(providers).toHaveLength(1)
    expect(providers[0]?.id).toBe(WEB_RENDER_PROVIDER_ID)

    dispose()
    expect(providers).toHaveLength(0)
  })

  it('stays absent when the namespace disables it', () => {
    const { ctx, providers } = fakeContext()
    const dispose = register(ctx as never, { config: { enabled: false } })

    expect(providers).toHaveLength(0)
    expect(() => dispose()).not.toThrow()
  })

  it('warns at registration when no browser is launchable, yet still registers', () => {
    // pin 指向 browser，缺席会变成 WEB_PROVIDER_CONFIGURED_MISSING —— 所以
    // 即使没有浏览器也必须注册，让错误在抓取时以可操作的形式暴露。
    const { ctx, providers } = fakeContext()
    const warn = vi.fn()
    register(ctx as never, {
      config: { executablePath: '/nonexistent/chrome-does-not-exist' },
      logger: { warn },
    })

    expect(providers).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('未找到可用浏览器'))
  })
})

describe('web-render provider availability', () => {
  it('is unavailable when the configured binary is missing', () => {
    expect(unavailableProvider().available()).toBe(false)
  })

  it('is unavailable when no channel can launch', () => {
    const provider = new RenderFetchProvider(() => effectiveConfig({ browserChannels: [] }), '')
    expect(provider.available()).toBe(false)
  })

  it('stops being available once disposed', async () => {
    const { ctx, providers } = fakeContext()
    register(ctx as never, { config: { executablePath: '/nonexistent/chrome-does-not-exist' }, logger: { warn: () => {} } })
    const provider = providers[0] as unknown as RenderFetchProvider
    await provider.dispose()
    expect(provider.available()).toBe(false)
  })
})

describe('web-render fetch validation (no browser launched)', () => {
  it('rejects non-http(s) schemes with WEB_INVALID_URL', async () => {
    await expect(unavailableProvider().fetch({ url: 'ftp://example.com/a' }))
      .rejects.toMatchObject({ code: 'WEB_INVALID_URL', name: 'WebError' })
  })

  it('rejects malformed URLs with WEB_INVALID_URL', async () => {
    await expect(unavailableProvider().fetch({ url: 'not-a-url' }))
      .rejects.toMatchObject({ code: 'WEB_INVALID_URL' })
  })

  it('rejects an already-aborted call with WEB_ABORTED', async () => {
    await expect(unavailableProvider().fetch({ url: 'https://example.com' }, AbortSignal.abort()))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })
})