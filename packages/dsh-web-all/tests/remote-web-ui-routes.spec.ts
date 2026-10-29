import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const serverUrl = new URL('../src/host/services/remote-web-ui/server.ts', import.meta.url)
const buildUrl = new URL('../tsdown.config.ts', import.meta.url)

describe('native remote Web route ownership', () => {
  it('keeps authentication routes and omits the retired /m surface', async () => {
    const source = await readFile(serverUrl, 'utf8')

    expect(source).toContain("path: '/login'")
    expect(source).toContain("path: '/api/gateway/auth/providers'")
    expect(source).toContain("path: '/auth'")
    expect(source).toContain("path: '/login', handler: integratedLoginHandler")
    expect(source).toContain("path: GATEWAY_API_PREFIX, handler: integratedGatewayHandler")
    expect(source).not.toContain('isLoopback: isLoopbackClient')
    expect(source).not.toContain("path: '/m'")
    expect(source).not.toContain("'/m/api")
    expect(source).not.toContain('makeMobileRoutes')
    expect(source).not.toContain('makeMobileApiRoutes')
  })

  it('builds only the host and native client bundles', async () => {
    const source = await readFile(buildUrl, 'utf8')

    expect(source).not.toContain('mobileBundle')
    expect(source).not.toContain('remote-web-ui-mobile')
  })
})
