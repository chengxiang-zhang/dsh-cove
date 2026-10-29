/**
 * 宿主信任补丁的单测：
 * - 回环判定与标记 cookie 解析（网关标记 + 远程访问域标记）；
 * - applyGatewayHostOwnership 改写 connection / transport 并失效 remote.$host 缓存；
 * - mountGatewayTrust 的分支：回环页面不动、有标记同步补、老壳依次探测
 *   /api/gateway/session 与 /api/dsh-access/session，默认探测走真实 HTTP。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  ACCESS_SESSION_PATH,
  GATEWAY_MARKER_COOKIE,
  HOST_ACCESS_MARKER_COOKIE,
  applyGatewayHostOwnership,
  hasGatewayMarker,
  hasHostAccessMarker,
  isLoopbackHostname,
  mountGatewayTrust,
} from '../src/client/trust.ts'

function makeCtx(connection: object | undefined, remote: object | undefined) {
  return {
    get: (name: string) => {
      if (name === 'connection') return connection
      if (name === 'remote') return remote
      return undefined
    },
  } as never
}

describe('gateway host trust', () => {
  it('classifies loopback hostnames', () => {
    for (const host of ['localhost', '127.0.0.1', '127.9.9.9', '::1']) expect(isLoopbackHostname(host), host).toBe(true)
    for (const host of ['dsh.mac', '192.168.200.1', '100.64.0.11', '127.0.0.1.example.com']) expect(isLoopbackHostname(host), host).toBe(false)
  })

  it('reads the provenance marker from a cookie string', () => {
    expect(hasGatewayMarker(`${GATEWAY_MARKER_COOKIE}=1`)).toBe(true)
    expect(hasGatewayMarker(`a=b; ${GATEWAY_MARKER_COOKIE}=1; c=d`)).toBe(true)
    expect(hasGatewayMarker(`${GATEWAY_MARKER_COOKIE}=0`)).toBe(false)
    expect(hasGatewayMarker('dsh_gw_session=secret')).toBe(false)
    expect(hasGatewayMarker(undefined)).toBe(false)
  })

  it('reads the reverse-proxied remote-access marker', () => {
    expect(hasHostAccessMarker(`${HOST_ACCESS_MARKER_COOKIE}=1`)).toBe(true)
    expect(hasHostAccessMarker(`a=b; ${HOST_ACCESS_MARKER_COOKIE}=1`)).toBe(true)
    expect(hasHostAccessMarker(`${HOST_ACCESS_MARKER_COOKIE}=0`)).toBe(false)
    expect(hasHostAccessMarker('dsh_access_host_session=secret')).toBe(false)
    expect(hasHostAccessMarker(undefined)).toBe(false)
    // The two markers are independent: neither implies the other.
    expect(hasHostAccessMarker(`${GATEWAY_MARKER_COOKIE}=1`)).toBe(false)
    expect(hasGatewayMarker(`${HOST_ACCESS_MARKER_COOKIE}=1`)).toBe(false)
  })

  it('rewrites the connection, the transport and the remote host cache', () => {
    const connection = { isLoopback: false }
    const remote = { hostFacts: { home: '/Users/tester', isLoopback: false } }
    const transport: Record<string, unknown> = {}
    const changed = applyGatewayHostOwnership({ connection, remote, transport })
    expect(changed).toBe(true)
    expect(connection.isLoopback).toBe(true)
    expect(transport.ownsHost).toBe(true)
    expect('hostFacts' in remote).toBe(false)
  })

  it('tolerates frozen targets', () => {
    const connection = Object.freeze({ isLoopback: false })
    expect(() => applyGatewayHostOwnership({ connection: connection as { isLoopback?: boolean } })).not.toThrow()
    expect(connection.isLoopback).toBe(false)
  })

  it('leaves loopback pages untouched', () => {
    const connection = { isLoopback: true }
    const dispose = mountGatewayTrust(makeCtx(connection, {}), { hostname: '127.0.0.1' }, '')
    expect(connection.isLoopback).toBe(true)
    dispose()
  })

  it('applies synchronously when the provenance marker is present', () => {
    const connection = { isLoopback: false }
    const remote = { hostFacts: { isLoopback: false } }
    mountGatewayTrust(makeCtx(connection, remote), { hostname: 'dsh.mac' }, `${GATEWAY_MARKER_COOKIE}=1`)
    expect(connection.isLoopback).toBe(true)
    expect('hostFacts' in remote).toBe(false)
  })

  it('trusts a boot-script declaration on an unmarked page', () => {
    const connection = { isLoopback: false }
    const previous = (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
    ;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = { ownsHost: true }
    try {
      mountGatewayTrust(makeCtx(connection, {}), { hostname: 'dsh.mac' }, '')
      expect(connection.isLoopback).toBe(true)
    } finally {
      ;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = previous
    }
  })

  it('probes the gateway session for an unmarked, undeclared page', async () => {
    const connection = { isLoopback: false }
    const probe = vi.fn(async () => true)
    const previous = (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
    delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
    try {
      mountGatewayTrust(makeCtx(connection, {}), { hostname: 'dsh.mac' }, '', probe)
      expect(probe).toHaveBeenCalledWith('/api/gateway/session')
      await vi.waitFor(() => { expect(connection.isLoopback).toBe(true) })
    } finally {
      ;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = previous
    }
  })

  it('keeps the memory store when the gateway says the page is not signed in', async () => {
    const connection = { isLoopback: false }
    const previous = (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
    delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
    try {
      mountGatewayTrust(makeCtx(connection, {}), { hostname: 'dsh.mac' }, '', async () => false)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(connection.isLoopback).toBe(false)
    } finally {
      ;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = previous
    }
  })

  it('applies ownership synchronously from the remote-access marker', () => {
    const connection = { isLoopback: false }
    const remote = { hostFacts: { isLoopback: false } }
    mountGatewayTrust(makeCtx(connection, remote), { hostname: 'dsh.mac' }, `${HOST_ACCESS_MARKER_COOKIE}=1`)
    expect(connection.isLoopback).toBe(true)
    expect('hostFacts' in remote).toBe(false)
  })

  it('falls back to the remote-access admission probe when no gateway answers', async () => {
    const connection = { isLoopback: false }
    const paths: string[] = []
    const probe = vi.fn(async (path: string) => {
      paths.push(path)
      return path === ACCESS_SESSION_PATH
    })
    const previous = (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
    delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
    try {
      mountGatewayTrust(makeCtx(connection, {}), { hostname: 'dsh.mac' }, '', probe)
      await vi.waitFor(() => { expect(connection.isLoopback).toBe(true) })
      expect(paths).toEqual(['/api/gateway/session', ACCESS_SESSION_PATH])
    } finally {
      ;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = previous
    }
  })

  it('keeps the memory store when the remote-access probe refuses too', async () => {
    const connection = { isLoopback: false }
    const previous = (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
    delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
    try {
      mountGatewayTrust(makeCtx(connection, {}), { hostname: 'evil.example' }, '', async () => false)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(connection.isLoopback).toBe(false)
    } finally {
      ;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = previous
    }
  })

  it('applies ownership through the default probe against a real posture response', async () => {
    // The default probe is the path every reverse-proxied cached shell takes, so
    // exercise it over a real socket instead of an injected stub: the gateway
    // path answers 404, the remote-access path answers `owners: true`.
    const server: Server = createServer((req, res) => {
      if (req.url === ACCESS_SESSION_PATH) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ authority: { host: 'dsh.mac', loopback: false, declared: true }, session: true, owners: true }))
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const realFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), base)
      calls.push(url.pathname)
      return realFetch(url, init)
    }) as typeof fetch

    const connection = { isLoopback: false }
    const remote = { hostFacts: { isLoopback: false } }
    const previous = (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
    delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
    try {
      mountGatewayTrust(makeCtx(connection, remote), { hostname: 'dsh.mac' }, '')
      await vi.waitFor(() => { expect(connection.isLoopback).toBe(true) })
      expect('hostFacts' in remote).toBe(false)
      expect(calls).toEqual(['/api/gateway/session', ACCESS_SESSION_PATH])
    } finally {
      globalThis.fetch = realFetch
      ;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = previous
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  })
})