/**
 * Host access-trust service domain: the single admission decision every
 * privileged web-all host route family consults (see `./trust.ts` for the
 * rule itself).
 *
 * The deployment's browser authorities come from whichever service the loaded
 * SDK generation hangs them on: `ctx.webStartup.trustedHosts` from
 * `@deepseek-ai/dsh-web-app` 0.2.1 on (`--trusted-host`, the same list the
 * bundle patch hands the `/api` fence), or `ctx.webRuntime.trustedHosts` on the
 * earlier SDKs that provided it. Browser-session admission comes from the
 * connection service's private `BrowserAuth`, the same object DSH uses for
 * `/api`; `no-browser-auth` may replace it when a deployment explicitly opts
 * into the network-gate mode.
 * Both are read per request so a late mount (or a settings-driven repatch) is
 * picked up without remounting.
 *
 * Fail-closed: a missing authority service, a missing/reshaped `BrowserAuth`,
 * an undeclared Host, or a request without a session predicate falls back to
 * the strict loopback rule.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import { isLoopbackRequest, isTrustedHostRequest, type HostTrustOptions } from './trust.ts'

/** Cordis service name carrying the admission decision. */
export const ACCESS_TRUST_SERVICE = 'webAllAccessTrust'

/** The admission decision one request is asked for. */
export interface AccessTrust {
  /** Whether this request may reach a privileged host surface. */
  isTrusted(request: IncomingMessage): boolean
}

/** Private `BrowserAuth` subset this domain depends on. */
interface BrowserAuthLike {
  isAuthenticated(request: IncomingMessage): boolean
}

/** Private `connection` subset this domain depends on. */
interface BrowserConnectionLike {
  browserAuth?: BrowserAuthLike
}

/**
 * Services that carry the browser entry authorities, in SDK generation order.
 *
 * Two SDK generations expose the same list under different services:
 * `@deepseek-ai/dsh-web-app` 0.2.1 and later provide `webStartup`, which is
 * what the bundle patch hands the `/api` fence, while earlier releases provide
 * `webRuntime` next to `webApp`. Consulting one name only leaves the list empty
 * on the other generation, and an empty list is not a harmless fallback: every
 * non-loopback Host then reads as undeclared, so `authority.declared` is false,
 * the boot script is a no-op, and privileged host routes answer 403.
 */
const AUTHORITY_SERVICES = ['webStartup', 'webRuntime'] as const

/** Subset of the authority service this domain depends on. */
interface TrustedHostsLike {
  trustedHosts?: string[]
}

type ContextWithGet = Context & { get?: (id: string, strict?: boolean) => unknown }

/** Optional service lookup that never throws on a missing or reshaped service. */
function optionalService<T>(ctx: Context, name: string): T | undefined {
  const get = (ctx as ContextWithGet).get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, name, false) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * Authorities this deployment declares as its browser entries (never trusted as a wildcard).
 *
 * The first authority service the SDK provides decides, even when its list is
 * empty: that is a deployment which declared nothing, and consulting the other
 * name would let a stale service widen the grant.
 */
export function trustedAuthoritiesOf(ctx: Context): readonly string[] {
  for (const name of AUTHORITY_SERVICES) {
    const service = optionalService<TrustedHostsLike>(ctx, name)
    if (service === undefined) continue
    const hosts = service.trustedHosts
    return Array.isArray(hosts) ? hosts.filter((entry): entry is string => typeof entry === 'string') : []
  }
  return []
}

/**
 * Browser-session admission, read fresh per request because both the
 * integrated-auth adapter and the legacy bypass patch the same method.
 * @returns the predicate, or undefined when the connection shape is unavailable.
 */
export function browserSessionPredicateOf(ctx: Context): ((request: IncomingMessage) => boolean) | undefined {
  return (request: IncomingMessage): boolean => {
    const auth = optionalService<BrowserConnectionLike>(ctx, 'connection')?.browserAuth
    if (auth === undefined || typeof auth.isAuthenticated !== 'function') return false
    try {
      return auth.isAuthenticated(request) === true
    } catch {
      return false
    }
  }
}

/** Live admission options for one request. */
export function hostTrustOptionsOf(ctx: Context): HostTrustOptions {
  return {
    trustedAuthorities: trustedAuthoritiesOf(ctx),
    isAuthenticated: browserSessionPredicateOf(ctx),
  }
}

/**
 * Mount the service domain.
 * @param ctx - host plugin context.
 * @returns the disposer releasing the provided service.
 */
export function register(ctx: Context): () => void {
  const trust: AccessTrust = {
    isTrusted: (request: IncomingMessage): boolean => isTrustedHostRequest(request, hostTrustOptionsOf(ctx)),
  }
  const dispose = ctx.provide(ACCESS_TRUST_SERVICE, trust)
  return () => { void dispose() }
}

/**
 * Resolve the admission decision for one route family. Families resolve this
 * through their own `register(ctx)` and keep serving the strict loopback rule
 * whenever the service is not (or not yet) provided, so a partially mounted
 * plugin can never widen access.
 * @param ctx - the context the family was mounted on.
 * @returns the per-request admission decision.
 */
export function accessTrustOf(ctx: Context): AccessTrust {
  return {
    isTrusted: (request: IncomingMessage): boolean => {
      const provided = optionalService<AccessTrust>(ctx, ACCESS_TRUST_SERVICE)
      if (provided !== undefined && typeof provided.isTrusted === 'function') {
        try {
          return provided.isTrusted(request) === true
        } catch {
          return false
        }
      }
      return isLoopbackRequest(request)
    },
  }
}