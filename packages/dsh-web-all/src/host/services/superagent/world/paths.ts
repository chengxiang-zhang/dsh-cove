/**
 * Scope paths: the vocabulary every other world-model answer is expressed in.
 *
 * `04` says scope is a path, not a whitelist: one string states "this whole
 * machine is readable, only this repository is writable". Mandates inherit
 * strictly downward, so prefix comparison must be segment-wise.
 * `local/~/code/dsh` is not an ancestor of `local/~/code/dsh-web`; a raw string
 * prefix test would silently widen a grant to every repository whose name starts
 * with the same letters.
 *
 * Canonical form, which is what every function here returns:
 *
 *   local/                              realm root (the only form keeping a trailing slash)
 *   local/~/code/dsh-web                one repository on this machine
 *   netbird/<host>                      one machine on the private network
 *   netbird/<host>/~/code/dsh-web       a repository on that machine
 *   netbird/<host>/session/<id>         one executor session there
 *   external/<domain>/<org>             an outside organization
 *
 * Empty segments collapse (`local//x` is `local/x`); a trailing slash is dropped
 * except on a realm root; `..` and `.` segments are rejected, because a path that
 * can escape its realm is not a scope path. A bare realm root is valid for all
 * three realms: it is the widest scope the model can express and the last element
 * of `ancestors`. Nothing here reads ssh configuration, resolves DNS or touches
 * the network; the adapters that discover machines are T15.
 */

/** The three realms of `04`. A path's first segment is always one of them. */
export type Realm = 'local' | 'netbird' | 'external'

/** A scope path in canonical form. See the file header for the grammar. */
export type ScopePath = string

/** Error code for a string that cannot be a scope path. */
export const PATH_INVALID = 'PATH_INVALID'

/** Thrown by every exported function here for a malformed path. `code` is the contract. */
export class ScopePathError extends Error {
  readonly code: string = PATH_INVALID

  constructor(raw: string, reason: string) {
    super(`${PATH_INVALID}: ${reason}: ${JSON.stringify(raw)}`)
    this.name = 'ScopePathError'
  }
}

export interface ParsedScopePath {
  realm: Realm
  /** Only `netbird` paths name a host; the domain of an `external` path is `rest[0]`. */
  host?: string
  /** Every segment after the realm, so for a `netbird` path `host` repeats `rest[0]`. */
  rest: string[]
}

const REALMS: readonly string[] = ['local', 'netbird', 'external']

/**
 * Validates and splits a raw string. Shared by every entry point so that
 * normalization, prefix tests and ancestor walks agree on what is legal.
 */
function segmentsOf(raw: string): string[] {
  if (typeof raw !== 'string' || raw.length === 0) throw new ScopePathError(raw, 'empty path')
  const segments = raw.split('/').filter((segment) => segment.length > 0)
  for (const segment of segments) {
    if (segment === '..' || segment === '.') throw new ScopePathError(raw, `relative segment '${segment}'`)
  }
  const realm = segments[0]
  if (realm === undefined) throw new ScopePathError(raw, 'no realm')
  if (!REALMS.includes(realm)) throw new ScopePathError(raw, `unknown realm '${realm}'`)
  return segments
}

/** Splits a scope path. Throws `PATH_INVALID` (as `ScopePathError`) on anything else. */
export function parsePath(raw: string): ParsedScopePath {
  const segments = segmentsOf(raw)
  const realm = segments[0] as Realm
  const rest = segments.slice(1)
  if (realm === 'netbird' && rest.length > 0) return { realm, host: rest[0], rest }
  return { realm, rest }
}

/**
 * Canonical form: `//` collapsed, trailing slash dropped, realm root kept as
 * `local/`. Two equal scopes always normalize to the same string, which is what
 * lets mandate rows be compared after the fact (`local/x/` and `local/x` are one
 * scope, so they tie rather than one silently beating the other).
 */
export function normalizePath(raw: string): ScopePath {
  const parsed = parsePath(raw)
  return parsed.rest.length === 0 ? `${parsed.realm}/` : `${parsed.realm}/${parsed.rest.join('/')}`
}

/** Segment-wise prefix test: `local/~/code/dsh` is not a prefix of `.../dsh-web`. */
export function isPrefix(ancestor: ScopePath, path: ScopePath): boolean {
  const a = segmentsOf(ancestor)
  const p = segmentsOf(path)
  if (a.length > p.length) return false
  return a.every((segment, index) => segment === p[index])
}

/**
 * Ancestors of a path, nearest first, ending with the realm root. The path itself
 * is not its own ancestor; a realm root has none. Used to walk a grant upward and
 * to expand a scope into the scopes it implies.
 */
export function ancestors(path: ScopePath): ScopePath[] {
  const parsed = parsePath(path)
  if (parsed.rest.length === 0) return []
  const out: ScopePath[] = []
  for (let take = parsed.rest.length - 1; take > 0; take -= 1) {
    out.push(`${parsed.realm}/${parsed.rest.slice(0, take).join('/')}`)
  }
  out.push(`${parsed.realm}/`)
  return out
}