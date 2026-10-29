/**
 * Integrate the remote-web-ui account session with DSH's own BrowserAuth.
 *
 * DSH 0.2 does not yet publish a replaceable Web authentication provider.
 * The connection service nevertheless owns one BrowserAuth object used by all
 * native admission paths: frontend index, `/api`, and `/api/remote.mux`.
 * This adapter composes (never disables) that object with the account session:
 * a valid native launch-token cookie OR a valid remote-web-ui session is
 * accepted. The original methods are restored exactly on disposal.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Private DSH BrowserAuth shape required by the compatibility adapter. */
export interface BrowserAuthLike {
  isAuthenticated(request: IncomingMessage): boolean
  authorizeIndex(request: IncomingMessage, response: ServerResponse): boolean
  authenticatedUrl(baseUrl: string): string
}

/** Private subset of the DSH connection service. */
export interface BrowserConnectionLike {
  browserAuth?: BrowserAuthLike
}

export interface IntegratedAuthOptions {
  /** Live feature flag so settings changes do not require re-patching methods. */
  enabled(): boolean
  /** Validate and touch the account session carried by this request. */
  hasSession(request: IncomingMessage): boolean
  /** Login route on the same DSH origin. */
  loginPath?: string
}

/** Only same-origin absolute paths may be retained across a login redirect. */
export function safeLoginTarget(rawUrl: string | undefined): string {
  try {
    const candidate = rawUrl ?? '/'
    if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/'
    const url = new URL(candidate, 'http://dsh.invalid')
    if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) return '/'
    if (url.pathname === '/login' || url.pathname.startsWith('/api/gateway/')) return '/'
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return '/'
  }
}

/** Locate the private BrowserAuth object and fail closed on SDK shape drift. */
export function browserAuthOf(connection: BrowserConnectionLike): BrowserAuthLike {
  const auth = connection.browserAuth
  if (
    auth === undefined
    || typeof auth.isAuthenticated !== 'function'
    || typeof auth.authorizeIndex !== 'function'
    || typeof auth.authenticatedUrl !== 'function'
  ) {
    throw new Error('remote-web-ui: connection.browserAuth shape changed; integrated WebAuth refuses to mount')
  }
  return auth
}

/**
 * Compose account sessions into DSH BrowserAuth.
 *
 * The Host/Origin fence remains owned by Connection and still runs before API
 * admission. This adapter changes authentication only; it never marks an
 * untrusted Host as trusted.
 */
export function installIntegratedBrowserAuth(
  connection: BrowserConnectionLike,
  options: IntegratedAuthOptions,
): () => void {
  const auth = browserAuthOf(connection)
  const originalIsAuthenticated = auth.isAuthenticated
  const originalAuthorizeIndex = auth.authorizeIndex
  const originalAuthenticatedUrl = auth.authenticatedUrl
  const loginPath = options.loginPath ?? '/login'

  const nativeAuthenticated = (request: IncomingMessage): boolean =>
    originalIsAuthenticated.call(auth, request)
  const accountAuthenticated = (request: IncomingMessage): boolean =>
    options.enabled() && options.hasSession(request)

  auth.isAuthenticated = (request: IncomingMessage): boolean =>
    nativeAuthenticated(request) || accountAuthenticated(request)

  auth.authorizeIndex = (request: IncomingMessage, response: ServerResponse): boolean => {
    if (!options.enabled()) return originalAuthorizeIndex.call(auth, request, response)

    // Preserve the native launch-token exchange and its clean redirect. An
    // invalid token deliberately keeps the native 401 rather than being treated
    // as an account-login attempt.
    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    if (url.searchParams.has('token') || nativeAuthenticated(request)) {
      return originalAuthorizeIndex.call(auth, request, response)
    }
    if (accountAuthenticated(request)) return true

    const target = safeLoginTarget(request.url)
    response.writeHead(302, {
      'cache-control': 'no-store',
      'location': `${loginPath}?next=${encodeURIComponent(target)}`,
      'referrer-policy': 'no-referrer',
    })
    response.end()
    return false
  }

  // The CLI's printed launch-token URL remains the local break-glass path.
  auth.authenticatedUrl = (baseUrl: string): string =>
    originalAuthenticatedUrl.call(auth, baseUrl)

  return () => {
    auth.isAuthenticated = originalIsAuthenticated
    auth.authorizeIndex = originalAuthorizeIndex
    auth.authenticatedUrl = originalAuthenticatedUrl
  }
}
