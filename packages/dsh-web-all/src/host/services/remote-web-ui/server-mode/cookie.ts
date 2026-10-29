/**
 * Cookie read/write helpers for the server-mode gateway. The gateway owns
 * the auth domain: it sets its own HttpOnly session cookie on the public
 * origin and strips any upstream Set-Cookie it proxies.
 */

/** Read one cookie value from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    if (key === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** Build a Set-Cookie header value. */
export function makeSetCookie(
  name: string,
  value: string,
  options: {
    /** Only set under TLS. */
    secure?: boolean
    /** Browser-side lifetime hint; the server still enforces real expiry. */
    maxAgeSeconds?: number
  } = {},
): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (options.secure) parts.push('Secure')
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${String(options.maxAgeSeconds)}`)
  return parts.join('; ')
}

/**
 * Build a Set-Cookie for a non-secret, browser-readable marker (no HttpOnly).
 * The gateway writes dsh_gw this way so the client half can recognise "served
 * by our gateway" synchronously, while the real session cookie stays HttpOnly.
 */
export function makeReadableCookie(
  name: string,
  value: string,
  options: { secure?: boolean; maxAgeSeconds?: number } = {},
): string {
  const parts = [`${name}=${value}`, 'Path=/', 'SameSite=Lax']
  if (options.secure) parts.push('Secure')
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${String(options.maxAgeSeconds)}`)
  return parts.join('; ')
}

/** Build a Set-Cookie header value that clears a cookie. */
export function makeClearCookie(name: string, options: { secure?: boolean } = {}): string {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}