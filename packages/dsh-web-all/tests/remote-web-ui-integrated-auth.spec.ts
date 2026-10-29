import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  browserAuthOf,
  installIntegratedBrowserAuth,
  safeLoginTarget,
  type BrowserAuthLike,
} from '../src/host/services/remote-web-ui/server-mode/integrated-auth.ts'

function request(url = '/', cookie?: string): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: cookie === undefined ? { host: 'dsh.test' } : { host: 'dsh.test', cookie },
  } as IncomingMessage
}

function response() {
  const writeHead = vi.fn()
  const end = vi.fn()
  return { value: { writeHead, end } as unknown as ServerResponse, writeHead, end }
}

function nativeAuth() {
  const auth: BrowserAuthLike = {
    isAuthenticated: vi.fn((req: IncomingMessage) => req.headers.cookie === 'native=1'),
    authorizeIndex: vi.fn((req: IncomingMessage, res: ServerResponse) => {
      if (auth.isAuthenticated(req)) return true
      res.writeHead(401)
      res.end()
      return false
    }),
    authenticatedUrl: vi.fn((base: string) => `${base}?token=native`),
  }
  return auth
}

describe('integrated DSH BrowserAuth adapter', () => {
  it('accepts native and account sessions while rejecting neither trust boundary', () => {
    const auth = nativeAuth()
    const account = vi.fn((req: IncomingMessage) => req.headers.cookie === 'account=1')
    installIntegratedBrowserAuth({ browserAuth: auth }, { enabled: () => true, hasSession: account })

    expect(auth.isAuthenticated(request('/', 'native=1'))).toBe(true)
    expect(auth.isAuthenticated(request('/', 'account=1'))).toBe(true)
    expect(auth.isAuthenticated(request('/', 'other=1'))).toBe(false)
  })

  it('redirects unauthenticated index requests to the same-origin login', () => {
    const auth = nativeAuth()
    installIntegratedBrowserAuth({ browserAuth: auth }, { enabled: () => true, hasSession: () => false })
    const res = response()

    expect(auth.authorizeIndex(request('/workspace/abc?tab=chat'), res.value)).toBe(false)
    expect(res.writeHead).toHaveBeenCalledWith(302, expect.objectContaining({
      location: '/login?next=%2Fworkspace%2Fabc%3Ftab%3Dchat',
      'cache-control': 'no-store',
    }))
    expect(res.end).toHaveBeenCalledOnce()
  })

  it('preserves native launch-token exchange and authenticatedUrl', () => {
    const auth = nativeAuth()
    installIntegratedBrowserAuth({ browserAuth: auth }, { enabled: () => true, hasSession: () => false })
    const res = response()

    expect(auth.authorizeIndex(request('/?token=bad'), res.value)).toBe(false)
    expect(res.writeHead).toHaveBeenCalledWith(401)
    expect(auth.authenticatedUrl('http://127.0.0.1:3080/')).toBe('http://127.0.0.1:3080/?token=native')
  })

  it('restores exact native methods and observes a live enable flag', () => {
    const auth = nativeAuth()
    const original = { ...auth }
    let enabled = false
    const dispose = installIntegratedBrowserAuth({ browserAuth: auth }, {
      enabled: () => enabled,
      hasSession: () => true,
    })

    expect(auth.isAuthenticated(request())).toBe(false)
    enabled = true
    expect(auth.isAuthenticated(request())).toBe(true)
    dispose()
    expect(auth.isAuthenticated).toBe(original.isAuthenticated)
    expect(auth.authorizeIndex).toBe(original.authorizeIndex)
    expect(auth.authenticatedUrl).toBe(original.authenticatedUrl)
  })

  it('fails closed when the private DSH shape drifts', () => {
    expect(() => browserAuthOf({})).toThrow(/shape changed/)
    expect(() => browserAuthOf({ browserAuth: { isAuthenticated: () => false } as BrowserAuthLike })).toThrow(/shape changed/)
  })
})

describe('safe login target', () => {
  it('keeps same-origin paths and drops auth loops or authority-like paths', () => {
    expect(safeLoginTarget('/session/one?q=1#x')).toBe('/session/one?q=1#x')
    expect(safeLoginTarget('//evil.example/path')).toBe('/')
    expect(safeLoginTarget('/login?next=/secret')).toBe('/')
    expect(safeLoginTarget('/api/gateway/session')).toBe('/')
  })
})
