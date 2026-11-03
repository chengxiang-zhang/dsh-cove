/** Shared wire vocabulary for the web-all right-pane additions. */

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
