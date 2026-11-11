import { constants, openSync, fstatSync, closeSync, readFileSync, writeFileSync, mkdirSync, lstatSync, readdirSync, realpathSync, readlinkSync, symlinkSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { join, relative, dirname, isAbsolute, normalize, resolve } from 'node:path'
import { createHash } from 'node:crypto'

interface FileEntry { readonly path: string; readonly kind: 'file' | 'link' | 'excluded' | 'directory'; readonly digest: string; readonly bytes: number; readonly executable: boolean }
export interface ProjectSeal {
  readonly root: string
  readonly sourceRoot: string
  readonly dependencyRoots: Readonly<Record<string, string>>
  readonly tools: Readonly<Record<string, string>>
  readonly provenance: Readonly<{ source: string; revision: string }>
  readonly manifest: readonly FileEntry[]
  readonly digest: string
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const within = (root: string, path: string) => { const p = relative(root, path); return p === '' || (!p.startsWith('..') && !isAbsolute(p)) }
const nameOK = (name: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(name)
const privatePart = /^(?:\.git|\.env(?:\..*)?|\.sa-target(?:.*)?|\.npmrc|\.netrc|\.ssh|\.aws|\.codex|\.claude|auth\.json|credentials(?:\.(?:json|ini|yaml|yml))?|.*\.pem|.*\.key)$/i
function sourcePath(name: string): void {
  if (typeof name !== 'string' || !name || name.length > 4096 || isAbsolute(name) || normalize(name) !== name || name.includes('\\') || name.split('/').some(x => x === '..' || privatePart.test(x) || x === 'node_modules')) throw new Error('PROJECT_SOURCE_PATH')
}
/** Trusted preparation only: explicit file list, no Git checkout, hooks, filters, imports or installs. */
export function sealProjectInputs(input: {
  sourceRoot: string; sourceFiles: readonly string[]
  dependencyRoots: readonly { name: string; path: string }[]
  tools: readonly { name: string; path: string }[]
  dependencyExcludes?: readonly { rootName: string; path: string; reason: string }[]
  sourceAliases?: readonly { path: string; sourcePrefix: string }[]
  destination: string; provenance: { source: string; revision: string }
}): ProjectSeal {
  const source = realpathSync(input.sourceRoot), destination = input.destination
  if (!isAbsolute(destination) || existsSync(destination) || within(source, destination) || input.sourceFiles.length > 50000 || input.dependencyRoots.length > 8 || input.tools.length > 16) throw new Error('PROJECT_SEAL_DESTINATION')
  const unique = new Set<string>()
  for (const path of input.sourceFiles) { sourcePath(path); if (unique.has(path)) throw new Error('PROJECT_SOURCE_DUPLICATE'); unique.add(path) }
  const dependencies = input.dependencyRoots.map(x => ({ name: x.name, source: realpathSync(x.path), destination: join(destination, 'dependencies', x.name) }))
  if (dependencies.some(x => !nameOK(x.name) || within(x.source, destination)) || new Set(dependencies.map(x => x.name)).size !== dependencies.length || input.tools.some(x => !nameOK(x.name)) || new Set(input.tools.map(x => x.name)).size !== input.tools.length) throw new Error('PROJECT_INPUT_NAME')
  const manifest: FileEntry[] = []; let total = 0
  const add = (path: string, kind: FileEntry['kind'], bytes: Buffer, executable = false) => {
    total += bytes.length
    if (total > 4 * 1024 ** 3 || manifest.length >= 250000) throw new Error('PROJECT_SEAL_BUDGET')
    manifest.push(Object.freeze({ path: relative(destination, path), kind, digest: hash(bytes), bytes: bytes.length, executable }))
  }
  const file = (from: string, to: string) => {
    const fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.size > 256 * 1024 ** 2) throw new Error('PROJECT_INPUT_FILE')
      const bytes = readFileSync(fd), after = fstatSync(fd)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) throw new Error('PROJECT_INPUT_CHANGED')
      const executable = !!(before.mode & 0o111)
      mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, bytes, { flag: 'wx', mode: executable ? 0o500 : 0o400 }); add(to, 'file', bytes, executable)
    } finally { closeSync(fd) }
  }
  const copyDependency = (from: string, to: string, depth: number) => {
    if (depth > 40) throw new Error('PROJECT_DEPENDENCY_DEPTH')
    const mutableCache = dependencies.some(d => dirname(from) === d.source && ['.vite', '.vite-temp', '.cache'].includes(relative(d.source, from)))
    if (mutableCache) { add(to, 'excluded', Buffer.from('mutable dependency-tool cache excluded; regenerated only in private run node_modules')); return }
    const excluded = input.dependencyExcludes?.find(x => dependencies.some(d => d.name === x.rootName && join(d.source, x.path) === from))
    if (excluded) { if (!excluded.reason || isAbsolute(excluded.path) || excluded.path.split('/').includes('..')) throw new Error('PROJECT_EXCLUSION_INVALID'); add(to, 'excluded', Buffer.from(excluded.reason)); return }
    const stat = lstatSync(from)
    if (stat.isSymbolicLink()) {
      const target = realpathSync(from), owner = dependencies.find(x => within(x.source, target))
      const alias = input.sourceAliases?.find(x => within(realpathSync(x.path), target))
      if (!owner && !alias) throw new Error('PROJECT_DEPENDENCY_ESCAPE:' + from + ':' + target)
      if (alias) sourcePath(alias.sourcePrefix)
      const translated = owner ? join(owner.destination, relative(owner.source, target)) : join(destination, 'source', alias!.sourcePrefix, relative(realpathSync(alias!.path), target))
      const link = relative(dirname(to), translated)
      mkdirSync(dirname(to), { recursive: true }); symlinkSync(link, to); add(to, 'link', Buffer.from(link)); return
    }
    if (stat.isDirectory()) { mkdirSync(to, { recursive: true }); for (const name of readdirSync(from).sort()) { if (privatePart.test(name) && !input.dependencyExcludes?.some(x => dependencies.some(d => d.name === x.rootName && join(d.source, x.path) === join(from, name)))) throw new Error('PROJECT_DEPENDENCY_PRIVATE_PATH'); copyDependency(join(from, name), join(to, name), depth + 1) }; return }
    if (!stat.isFile()) throw new Error('PROJECT_DEPENDENCY_TYPE')
    file(from, to)
  }
  try {
    mkdirSync(destination, { mode: 0o700 }); mkdirSync(join(destination, 'source'))
    for (const path of [...input.sourceFiles].sort()) {
      let current = source
      for (const part of path.split('/')) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error('PROJECT_SOURCE_SYMLINK') }
      file(current, join(destination, 'source', path))
    }
    for (const dep of dependencies) copyDependency(dep.source, dep.destination, 0)
    const toolPaths: Record<string, string> = {}
    for (const tool of input.tools) { const target = join(destination, 'tools', tool.name); file(realpathSync(tool.path), target); toolPaths[tool.name] = target }
    const directories = (path: string) => { for (const name of readdirSync(path)) { const child = join(path, name); if (lstatSync(child).isDirectory()) { add(child, 'directory', Buffer.alloc(0)); directories(child) } } }; directories(destination)
    manifest.sort((a, b) => a.path.localeCompare(b.path))
    const provenance = Object.freeze({ ...input.provenance }), bindings = { root: destination, sourceRoot: join(destination, 'source'), dependencyRoots: Object.fromEntries(dependencies.map(d => [d.name, d.destination])), tools: toolPaths }, digest = hash(JSON.stringify({ provenance, manifest, bindings }))
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ version: 2, provenance, manifest, bindings, digest }), { flag: 'wx', mode: 0o400 })
    // The runtime sandbox must also exclude write access; modes are not the security boundary.
    const freezeDirectories = (path: string) => { for (const name of readdirSync(path)) { const child = join(path, name); if (lstatSync(child).isDirectory()) freezeDirectories(child) }; chmodSync(path, 0o500) }
    freezeDirectories(destination)
    return Object.freeze({ root: destination, sourceRoot: join(destination, 'source'), dependencyRoots: Object.freeze(Object.fromEntries(dependencies.map(d => [d.name, d.destination]))), tools: Object.freeze(toolPaths), provenance, manifest: Object.freeze(manifest), digest })
  } catch (error) { if (existsSync(destination)) rmSync(destination, { recursive: true, force: true }); throw error }
}
function sealBindings(seal: ProjectSeal) { return { root: seal.root, sourceRoot: seal.sourceRoot, dependencyRoots: seal.dependencyRoots, tools: seal.tools } }
export function verifyProjectSeal(seal: ProjectSeal): boolean {
  try {
    if (realpathSync(seal.root) !== seal.root || seal.sourceRoot !== join(seal.root, 'source')) return false
    for (const [name, path] of Object.entries(seal.dependencyRoots)) if (!nameOK(name) || path !== join(seal.root, 'dependencies', name)) return false
    for (const [name, path] of Object.entries(seal.tools)) if (!nameOK(name) || path !== join(seal.root, 'tools', name)) return false
    const bindings = sealBindings(seal), expected = { version: 2, provenance: seal.provenance, manifest: seal.manifest, bindings, digest: seal.digest }
    if (hash(JSON.stringify({ provenance: seal.provenance, manifest: seal.manifest, bindings })) !== seal.digest || readFileSync(join(seal.root, 'manifest.json'), 'utf8') !== JSON.stringify(expected)) return false
    const entries = new Map<string, FileEntry>()
    for (const entry of seal.manifest) {
      if (!entry.path || isAbsolute(entry.path) || normalize(entry.path) !== entry.path || entry.path.includes('\\') || entry.path.split('/').some(x => x === '..' || !x) || entries.has(entry.path) || entry.path === 'manifest.json' || !['file','directory','link','excluded'].includes(entry.kind)) return false
      entries.set(entry.path, entry)
    }
    for (const path of [seal.sourceRoot, ...Object.values(seal.dependencyRoots)]) if (entries.get(relative(seal.root, path))?.kind !== 'directory') return false
    for (const path of Object.values(seal.tools)) if (entries.get(relative(seal.root, path))?.kind !== 'file') return false
    const seen = new Set<string>()
    const walk = (dir: string): boolean => readdirSync(dir).every(name => {
      const path = join(dir, name), rel = relative(seal.root, path)
      if (rel === 'manifest.json') return lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()
      const entry = entries.get(rel); if (!entry || entry.kind === 'excluded') return false
      seen.add(rel); const stat = lstatSync(path)
      if (entry.kind === 'directory') return stat.isDirectory() && !stat.isSymbolicLink() && walk(path)
      if (entry.kind === 'link') { const link = readlinkSync(path); return stat.isSymbolicLink() && !isAbsolute(link) && within(seal.root, resolve(dirname(path), link)) && hash(link) === entry.digest }
      return stat.isFile() && !stat.isSymbolicLink() && stat.size === entry.bytes && !!(stat.mode & 0o111) === entry.executable && hash(readFileSync(path)) === entry.digest
    })
    return walk(seal.root) && [...entries.values()].every(e => e.kind === 'excluded' || seen.has(e.path))
  } catch { return false }
}
/** Copy exact verified bytes, never recursively include a newly introduced entry. */
export function copyVerifiedProjectSource(seal: ProjectSeal, destination: string): void {
  if (!verifyProjectSeal(seal)) throw new Error('PROJECT_SEAL_CHANGED')
  if (realpathSync(destination) !== destination || readdirSync(destination).length) throw new Error('PROJECT_COPY_DESTINATION')
  const entries = seal.manifest.filter(e => e.path.startsWith('source/'))
  for (const entry of entries.filter(e => e.kind === 'directory').sort((a,b) => a.path.length-b.path.length)) mkdirSync(join(destination, entry.path.slice(7)), { recursive: true })
  for (const entry of entries.filter(e => e.kind !== 'directory')) {
    if (entry.kind !== 'file') throw new Error('PROJECT_SOURCE_TYPE')
    const from = join(seal.root, entry.path), fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = fstatSync(fd), bytes = readFileSync(fd), after = fstatSync(fd)
      if (!before.isFile() || before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs || !!(before.mode & 0o111) !== entry.executable || bytes.length !== entry.bytes || hash(bytes) !== entry.digest) throw new Error('PROJECT_SEAL_CHANGED')
      const to = join(destination, entry.path.slice(7)); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, bytes, { flag: 'wx', mode: entry.executable ? 0o700 : 0o600 })
    } finally { closeSync(fd) }
  }
  if (!verifyProjectSeal(seal)) throw new Error('PROJECT_SEAL_CHANGED')
}
