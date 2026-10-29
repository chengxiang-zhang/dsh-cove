/** Shared wire vocabulary for the web-all right-pane additions (git, browser). */

export type BrowserNavigateResult =
  | { kind: 'ok'; url: string }
  | { kind: 'blocked'; reason: 'scheme' | 'loopback' | 'self-origin' }
  | { kind: 'invalid' }

const FORBIDDEN_BROWSER_SCHEMES = /^(?:javascript|data|file|about|blob|vbscript|mailto|tel|ftp|ws|wss):/iu

export function isLoopbackHostname(value: string): boolean {
  const hostname = value.replace(/^\[|\]$/gu, '').toLowerCase()
  if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0') return true
  const octets = hostname.split('.')
  return octets.length === 4 && octets[0] === '127' && octets.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/** Detailed secure navigation verdict for the sidebar browser. */
export function evaluateBrowserUrl(value: string, selfOrigin?: string): BrowserNavigateResult {
  const trimmed = value.trim()
  if (trimmed === '') return { kind: 'invalid' }
  if (FORBIDDEN_BROWSER_SCHEMES.test(trimmed)) return { kind: 'blocked', reason: 'scheme' }
  const candidate = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try { url = new URL(candidate) } catch { return { kind: 'invalid' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'blocked', reason: 'scheme' }
  if (selfOrigin) {
    try { if (url.origin === new URL(selfOrigin).origin) return { kind: 'blocked', reason: 'self-origin' } } catch { /* ignore malformed owner origin */ }
  }
  if (isLoopbackHostname(url.hostname)) return { kind: 'blocked', reason: 'loopback' }
  return { kind: 'ok', url: url.href }
}

export interface GitStatusEntry {
  path: string
  xy: string
}

/**
 * Native `dsh-resource://file/...` address builder mirroring the official
 * sidebar-files vocabulary, so produced files open in the DSH document
 * preview instead of a plugin file window.
 */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/session/'

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

function encodePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/')
}

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}

function isAbsoluteWorkspacePath(value: string): boolean {
  return value.startsWith('/') || isWindowsStylePath(value)
}

/** The address of a file read through one session, mirroring the official encoder. */
export function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '')
  return `${FILE_ADDRESS_PREFIX}${encodeSegment(sessionId)}/${encodePath(normalized)}`
}

/** Map a caller-held path to its session-scoped resource address (official semantics). */
export function fileAddressFor(sessionId: string, cwd: string | undefined, path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized)
  const root = cwd === undefined ? '' : cwd.replace(/\\/gu, '/').replace(/\/+$/u, '')
  if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '')
  if (root !== '' && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1))
  return sessionFileAddress(sessionId, normalized)
}
