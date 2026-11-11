import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

type SymbolAtom = { symbol: string }
type StringAtom = { string: string }
export type SandboxForm = Array<SymbolAtom | StringAtom | SandboxForm>
export interface SandboxDomain {
  readonly readRoots: readonly string[]
  readonly readPaths?: readonly string[]
  readonly writeRoots: readonly string[]
  readonly executableRoots: readonly string[]
  readonly metadataPaths: readonly string[]
  readonly fixturePorts: readonly number[]
  readonly unixSockets: readonly string[]
}
const operations = new Set(['process-exec', 'process-fork', 'process-info*', 'sysctl-read', 'mach-lookup', 'file-read*', 'file-read-metadata', 'file-write*', 'network-outbound', 'network-inbound', 'network-bind', 'system-socket', 'signal'])
const sym = (x: unknown): string | undefined => x && !Array.isArray(x) && typeof x === 'object' && 'symbol' in x ? String(x.symbol) : undefined
const str = (x: unknown): string | undefined => x && !Array.isArray(x) && typeof x === 'object' && 'string' in x ? String(x.string) : undefined
const bad = (): never => { throw new Error('SANDBOX_POLICY_UNSUPPORTED') }
/** Parses data only. No Scheme evaluator, includes, regexes, macros or extension grants. */
export function parseSandboxPolicy(input: string): SandboxForm[] {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 65536) return bad()
  let position = 0, nodes = 0
  const whitespace = () => { while (/\s/.test(input[position] ?? '') && position < input.length) position++ }
  const read = (depth: number): SandboxForm | SymbolAtom | StringAtom => {
    whitespace()
    if (++nodes > 4096 || depth > 6 || position >= input.length) return bad()
    const c = input[position++]
    if (c === '(') {
      const items: SandboxForm = []
      while (true) { whitespace(); if (input[position] === ')') { position++; return items }; if (position >= input.length) return bad(); items.push(read(depth + 1)) }
    }
    if (c === '"') {
      const start = position - 1
      while (position < input.length) {
        const next = input[position++]
        if (next === '\\') { position++; continue }
        if (next === '"') {
          let value: unknown
          try { value = JSON.parse(input.slice(start, position)) } catch { return bad() }
          if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return bad()
          return { string: value }
        }
      }
      return bad()
    }
    if (!/[A-Za-z0-9_*.-]/.test(c)) return bad()
    const start = position - 1
    while (position < input.length && /[A-Za-z0-9_*.-]/.test(input[position])) position++
    return { symbol: input.slice(start, position) }
  }
  const forms: SandboxForm[] = []
  while (position < input.length) { whitespace(); if (position === input.length) break; const form = read(0); if (!Array.isArray(form)) return bad(); forms.push(form); if (forms.length > 256) return bad() }
  if (JSON.stringify(forms[0]) !== JSON.stringify([{ symbol: 'version' }, { symbol: '1' }]) || JSON.stringify(forms[1]) !== JSON.stringify([{ symbol: 'deny' }, { symbol: 'default' }])) return bad()
  const predicate = (form: SandboxForm): void => {
    const name = sym(form[0])
    if (['literal', 'subpath', 'global-name'].includes(name ?? '')) {
      const value = str(form[1]); if (form.length !== 2 || value === undefined) return bad()
      if (name !== 'global-name' && (!isAbsolute(value) || normalize(value) !== value)) return bad()
      return
    }
    if (name === 'target' && form.length === 2 && ['self', 'children'].includes(sym(form[1]) ?? '')) return
    if (['remote', 'local'].includes(name ?? '') && form.length === 3 && sym(form[1]) === 'ip' && /^localhost:(?:\*|[1-9]\d{0,4})$/.test(str(form[2]) ?? '')) return
    if (name === 'socket-domain' && form.length === 2 && sym(form[1]) === 'AF_SYSTEM') return
    if (name === 'socket-protocol' && form.length === 2 && sym(form[1]) === '2') return
    if (name === 'require-all' && form.length === 3 && form.slice(1).every(Array.isArray)) { for (const child of form.slice(1)) predicate(child as SandboxForm); return }
    return bad()
  }
  for (const form of forms.slice(2)) {
    if (sym(form[0]) !== 'allow') return bad()
    let index = 1
    while (index < form.length && !Array.isArray(form[index])) { if (!operations.has(sym(form[index]) ?? '')) return bad(); index++ }
    if (index === 1) return bad()
    for (; index < form.length; index++) { if (!Array.isArray(form[index])) return bad(); predicate(form[index] as SandboxForm) }
  }
  return forms
}
export function serializeSandboxPolicy(forms: readonly SandboxForm[]): string {
  const render = (x: SandboxForm | SymbolAtom | StringAtom): string => Array.isArray(x) ? `(${x.map(render).join(' ')})` : 'string' in x ? JSON.stringify(x.string) : x.symbol
  return forms.map(render).join('\n')
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex')
const pathPredicate = (kind: 'subpath' | 'literal', path: string): string => {
  if (!isAbsolute(path) || normalize(path) !== path || /[\x00-\x1f\x7f]/.test(path)) throw new Error('SANDBOX_DOMAIN_INVALID')
  return `(${kind} ${JSON.stringify(path)})`
}
/** Domain is created by the trusted host before candidate startup, never from a request. */
export function constrainSandboxPolicy(input: string, domain: SandboxDomain): { profile: string; originalDigest: string; normalizedDigest: string; effectiveDigest: string } {
  const normalized = serializeSandboxPolicy(parseSandboxPolicy(input))
  if (!domain.readRoots.length || !domain.writeRoots.length || !domain.executableRoots.length || domain.fixturePorts.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error('SANDBOX_DOMAIN_INVALID')
  const read = [...domain.readRoots.map(p => pathPredicate('subpath', p)), ...(domain.readPaths ?? []).map(p => pathPredicate('literal', p))], write = domain.writeRoots.map(p => pathPredicate('subpath', p))
  const metadata = domain.metadataPaths.map(p => pathPredicate('literal', p)), executables = domain.executableRoots.map(p => pathPredicate('subpath', p))
  const denyOutside = (ops: string, predicates: string[]) => predicates.length ? `(deny ${ops} (require-not (require-any ${predicates.join(' ')})))` : `(deny ${ops})`
  const unix = domain.unixSockets.map(p => pathPredicate('literal', p))
  const ports = domain.fixturePorts.map(p => `(remote ip "localhost:${p}")`), local = domain.fixturePorts.map(p => `(local ip "localhost:${p}")`)
  const profile = [normalized,
    denyOutside('file-read*', [...read, ...metadata]), denyOutside('file-read-data file-read-xattr', read), denyOutside('file-write*', write),
    denyOutside('process-exec', executables), '(deny process-info* (target others))', '(deny signal (target others))',
    '(deny mach-lookup (require-not (global-name "com.apple.system.logger")))', '(deny system-socket)',
    denyOutside('network-outbound', [...ports, ...unix]), denyOutside('network-inbound', [...local, ...unix]), '(deny network-bind)',
  ].join('\n')
  return { profile, originalDigest: digest(input), normalizedDigest: digest(normalized), effectiveDigest: digest(profile) }
}
