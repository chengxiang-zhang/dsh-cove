/**
 * Executor endpoint resolution (T19 addendum).
 *
 * A commitment's `target` is a world scope path (`04`): `local/<repo>`,
 * `netbird/<machine>/<path>` or `external/<domain>/<org>`. The realm and the machine
 * decide which host runs the work; this file turns that decision into the HTTP
 * endpoint the transport calls.
 *
 * Only two realms are dispatchable today:
 *
 * - `local` - this machine's own web host, reached on loopback. The host fence
 *   treats a loopback Host as trusted, so no credentials are involved.
 * - `netbird` - a peer that declares `noBrowserAuth` (the fleet default). The request
 *   carries the machine's canonical `Host`, exactly like its nginx entry does.
 *
 * `external` and password-protected entries are refused here rather than half
 * supported: the design keeps the credential surface at zero for phase one.
 */

export type ExecutorRealm = 'local' | 'netbird' | 'external'

/** One dispatchable machine. `addr` is its NetBird address; `baseUrl` overrides it. */
export interface ExecutorHostConfig {
  host: string
  addr?: string
  baseUrl?: string
  /** Exact `Host` header the target's fence trusts; defaults to `dsh.<host>.netbird`. */
  trustedHost?: string
}

export interface ExecutorTransportConfig {
  /** `http` is the default; `inproc` keeps the historical in-process session. */
  transport?: 'http' | 'inproc'
  /** Loopback base URL of this machine's own web host. */
  localBaseUrl?: string
  /** Machines reachable over NetBird; unlisted machines are refused. */
  hosts?: readonly ExecutorHostConfig[]
  /** Capability-probe cache lifetime. */
  probeTtlMs?: number
  /** Event poll interval while an attempt runs. */
  pollMs?: number
  /** Per-request timeout. */
  timeoutMs?: number
  /** Events requested per page (also the probe tail size). */
  maxEventPage?: number
}

export interface ResolvedEndpoint {
  realm: ExecutorRealm
  host?: string
  baseUrl: string
  headers: Readonly<Record<string, string>>
}

/** A target this transport cannot reach, with the reason a brief can quote. */
export class EndpointError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

const NETBIRD = /^netbird\/([^/]+)(\/.*)?$/
const LOCAL = /^local(\/.*)?$/
const EXTERNAL = /^external(\/.*)?$/

/** The realm and machine a scope path names; a bare path is local. */
export function realmOfTarget(target: string | null | undefined): { realm: ExecutorRealm; host?: string } {
  if (target === null || target === undefined || target.trim() === '') return { realm: 'local' }
  const value = target.trim()
  const netbird = NETBIRD.exec(value)
  if (netbird !== null) return { realm: 'netbird', host: netbird[1] }
  if (LOCAL.test(value)) return { realm: 'local' }
  if (EXTERNAL.test(value)) return { realm: 'external' }
  return { realm: 'local' }
}

/** The scope path `place` should land on: the target itself, or nothing for a bare request. */
export function scopePathOf(target: string | null | undefined): string | undefined {
  if (target === null || target === undefined || target.trim() === '') return undefined
  return target.trim()
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '')

/**
 * Resolve the endpoint for one target, or throw `EndpointError`.
 * @param target - the commitment's world scope path.
 * @param config - the executor transport configuration.
 */
export function resolveEndpoint(target: string | null | undefined, config: ExecutorTransportConfig): ResolvedEndpoint {
  const { realm, host } = realmOfTarget(target)
  if (realm === 'external') throw new EndpointError('HOST_UNSUPPORTED', 'external targets are not dispatchable')
  if (realm === 'local') {
    return { realm, baseUrl: trimSlash(config.localBaseUrl ?? 'http://127.0.0.1:3080'), headers: {} }
  }
  const entry = (config.hosts ?? []).find(h => h.host === host)
  if (entry === undefined) throw new EndpointError('HOST_UNKNOWN', `machine ${host ?? '?'} is not in the dispatch allowlist`)
  const baseUrl = entry.baseUrl ?? (entry.addr === undefined
    ? (() => { throw new EndpointError('HOST_UNKNOWN', `machine ${entry.host} has no address`) })()
    : `http://${entry.addr}`)
  return {
    realm,
    host,
    baseUrl: trimSlash(baseUrl),
    headers: { Host: entry.trustedHost ?? `dsh.${entry.host}.netbird` },
  }
}