/**
 * Unified host request-trust fence for the web-all plugin route families.
 *
 * Every privileged host surface of this plugin (Git workbench, Agent Browser
 * control plane, worktree mutations, SSH, memoir, schedule mode, workbench
 * reads) previously carried its own ad-hoc loopback check. Those checks were
 * inconsistent: some demanded a loopback socket AND a loopback Host, others
 * only the socket — and behind a same-host reverse proxy (the documented
 * NetBird topology: browser -> nginx:80 -> 127.0.0.1:3080 with Host preserved)
 * every request arrives on a loopback socket, so the socket-only variants let
 * unauthenticated remote browsers through while the Host-checking variants
 * refused the deployment's own canonical entry.
 *
 * This module is the single rule:
 *
 * 1. the socket must be loopback (the plugin never serves a public listener);
 * 2. the Host authority must be loopback, OR a deployment-declared trusted
 *    authority (`ctx.webRuntime.trustedHosts`: the invocation-derived LAN
 *    literals plus `--trusted-host`) carrying an authenticated browser
 *    session — the same admission decision DSH itself applies to `/api`;
 * 3. `sec-fetch-site: cross-site` is refused;
 * 4. when an `Origin` is attached it must be same-origin with the Host.
 *
 * The socket address is authoritative and `X-Forwarded-For` is never trusted:
 * a proxy that shapes requests as loopback (this plugin's own server-mode
 * gateway) is indistinguishable from a local browser by design, which is why
 * the trusted-authority branch additionally demands the browser session.
 * @module dsh-web-all/host-access-trust
 */

import type { IncomingMessage } from 'node:http'

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
export function isIPv4Loopback(v4: string): boolean {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** One parsed `trustedHosts` entry in canonical form. */
interface CanonicalAuthority {
  /** Bare hostname, lowercased by WHATWG parsing (`[::1]` keeps its brackets). */
  hostname: string
  /** `hostname:port` when the entry wrote an explicit port, else undefined. */
  hostWithPort?: string
}

/**
 * Parse one declared authority, rejecting anything that is not a bare
 * `host[:port]` that survives WHATWG parsing unchanged. This mirrors the SDK's
 * own `trustedHosts` assertion: a path, userinfo, query, fragment, surrounding
 * whitespace or a non-canonical spelling (`0x7f.0.0.1`, zero-padded port) would
 * silently widen or move the grant, so it fails closed here just as at config
 * load. Any explicit port counts (including `:80` / `:443`), because the
 * deployment wrote the authority it serves.
 */
function canonicalAuthority(entry: string): CanonicalAuthority | undefined {
  if (entry === '') return undefined
  let url: URL
  try {
    url = new URL(`http://${entry}`)
  } catch {
    return undefined
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined
  if (!(url.pathname === '' || url.pathname === '/')) return undefined
  if (url.hostname === '') return undefined
  // `new URL('http://host:80')` drops the default port, so read the written
  // port from an https parse, whose default port differs.
  let explicitPort = url.port
  if (explicitPort === '') {
    try {
      explicitPort = new URL(`https://${entry}`).port
    } catch {
      return undefined
    }
  }
  const canonical = explicitPort === '' ? url.hostname : `${url.hostname}:${explicitPort}`
  if (canonical !== entry.toLowerCase()) return undefined
  return explicitPort === ''
    ? { hostname: url.hostname }
    : { hostname: url.hostname, hostWithPort: canonical }
}

/**
 * Whether a request Host matches one declared trusted authority. An entry with
 * an explicit port matches that exact authority; a port-less entry matches the
 * hostname on any port (the shape the CLI derives for IP-literal serving,
 * where the bound port may be OS-assigned). Both sides compare through WHATWG
 * normalization, so case and a redundant `:80` never decide trust.
 */
export function matchesTrustedAuthority(hostUrl: URL, authorities: readonly string[]): boolean {
  return authorities.some((entry) => {
    const parsed = canonicalAuthority(entry)
    if (parsed === undefined) return false
    return parsed.hostWithPort === undefined
      ? parsed.hostname === hostUrl.hostname
      : parsed.hostWithPort === hostUrl.host
  })
}

/** Admission inputs for one request. */
export interface HostTrustOptions {
  /** Non-loopback authorities this deployment serves (`host` or `host:port`). */
  trustedAuthorities?: readonly string[]
  /** Browser-session admission for a trusted non-loopback authority; absent denies. */
  isAuthenticated?: (request: IncomingMessage) => boolean
}

/** Parse the request Host header; undefined when absent or unparsable. */
export function hostUrlOf(request: IncomingMessage): URL | undefined {
  const host = request.headers?.host
  if (typeof host !== 'string' || host === '') return undefined
  // Host is an authority, not a URL. WHATWG parsing otherwise silently drops
  // userinfo, paths, fragments and control whitespace before the trust check.
  if (/[\s\\/?#@]/.test(host)) return undefined
  try {
    return new URL(`http://${host}`)
  } catch {
    return undefined
  }
}

/** Browser same-origin markers: cross-site is refused, an Origin must match the Host. */
function sameOriginMarkers(request: IncomingMessage, hostUrl: URL): boolean {
  const headers = request.headers ?? {}
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Whether a request may reach a loopback privilege surface (the strict
 * loopback-only rule: loopback socket AND loopback Host AND same-origin
 * markers). Use this for surfaces that must never accept a remote browser.
 */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const hostUrl = hostUrlOf(request)
  if (hostUrl === undefined || !isLoopbackHostname(hostUrl.hostname)) return false
  return sameOriginMarkers(request, hostUrl)
}

/**
 * Whether a request may reach a privileged plugin host surface: loopback, or a
 * deployment-declared trusted authority carrying an authenticated browser
 * session. Fails closed whenever the Host is unparsable, the authority is not
 * declared, or no session predicate is available.
 * @param request - the incoming HTTP request (or upgrade request).
 * @param options - deployment authorities and the browser-session predicate.
 * @returns true when the request is trusted.
 */
export function isTrustedHostRequest(request: IncomingMessage, options: HostTrustOptions = {}): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const hostUrl = hostUrlOf(request)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname)) {
    if (!matchesTrustedAuthority(hostUrl, options.trustedAuthorities ?? [])) return false
    let authenticated = false
    try {
      authenticated = options.isAuthenticated?.(request) === true
    } catch {
      authenticated = false
    }
    if (!authenticated) return false
  }
  return sameOriginMarkers(request, hostUrl)
}