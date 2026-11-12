/**
 * Transport selection (T19 addendum): one factory, two implementations.
 *
 * The factory is created once by the composition root. Each dispatch asks it for the
 * transport of its target:
 *
 * - `inproc` ignores the target and returns the single in-process transport; a target
 *   that names another machine is refused instead of silently run locally.
 * - `http` resolves the target to an endpoint and caches one transport per endpoint.
 */

import type { SessionControllerFace } from '../../host-ports.ts'
import { createHttpTransport } from './http.ts'
import { createInprocTransport } from './inproc.ts'
import { EndpointError, realmOfTarget, resolveEndpoint, type ExecutorTransportConfig } from './endpoint.ts'
import type { ExecutorTransport } from './types.ts'

export interface ExecutorTransportDeps {
  config: ExecutorTransportConfig
  controller: () => SessionControllerFace
}

export interface ExecutorTransportFactory {
  readonly kind: 'inproc' | 'http'
  /** The transport that must run work for this world scope path. Throws `EndpointError`. */
  forTarget(target: string | null | undefined): ExecutorTransport
  dispose(): void
}

export function createTransportFactory(deps: ExecutorTransportDeps): ExecutorTransportFactory {
  const kind = deps.config.transport ?? 'http'
  if (kind === 'inproc') {
    const inproc = createInprocTransport(deps.controller)
    return {
      kind,
      forTarget(target) {
        if (realmOfTarget(target).realm !== 'local') {
          throw new EndpointError('HOST_UNSUPPORTED', 'the in-process transport cannot run work on another machine')
        }
        return inproc
      },
      dispose() { inproc.dispose() },
    }
  }
  const cache = new Map<string, ExecutorTransport>()
  return {
    kind,
    forTarget(target) {
      const endpoint = resolveEndpoint(target, deps.config)
      const key = `${endpoint.baseUrl}|${endpoint.headers.Host ?? ''}`
      const hit = cache.get(key)
      if (hit !== undefined) return hit
      const transport = createHttpTransport({ config: deps.config, target })
      cache.set(key, transport)
      return transport
    },
    dispose() {
      for (const transport of cache.values()) transport.dispose()
      cache.clear()
    },
  }
}

export type { ExecutorTransport, ExecutorEventLike, ExecutorSnapshot, ExecutorCreateRequest, ExecutorCreateResult } from './types.ts'
export { ensureExecutorSession } from './bind-executor-session.ts'
export { EndpointError, realmOfTarget, resolveEndpoint, scopePathOf } from './endpoint.ts'
export type { ExecutorTransportConfig, ExecutorHostConfig } from './endpoint.ts'
export { HttpTransportError } from './http.ts'