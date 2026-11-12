import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, chmodSync, readdirSync, lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const cleanup = (root: string) => { const unlock = (p: string) => { if (!lstatSync(p).isDirectory()) return; chmodSync(p, 0o700); for (const name of readdirSync(p)) unlock(join(p, name)) }; unlock(root); rmSync(root, { recursive: true, force: true }) }
const load = () => import('../src/host/services/superagent/executors/project-snapshot.ts').catch(() => null)
it('binds canonical directories through parent aliases while rejecting a symlink copy target', async () => {
  const api = await load(); const root = mkdtempSync(join(tmpdir(), 'sealed-alias-'))
  try {
    const source = join(root, 'source'), actual = join(root, 'actual'), alias = join(root, 'alias')
    mkdirSync(source); mkdirSync(actual); symlinkSync('actual', alias)
    writeFileSync(join(source, 'main.ts'), 'export const value = 1')
    const seal = api!.sealProjectInputs({ sourceRoot: source, sourceFiles: ['main.ts'], dependencyRoots: [], tools: [], destination: join(alias, 'sealed'), provenance: { source: 'fixture', revision: 'fixture' } })
    expect(seal.root).toBe(join(realpathSync(actual), 'sealed'))
    expect(api!.verifyProjectSeal(seal)).toBe(true)
    const copy = join(alias, 'copy'); mkdirSync(copy)
    api!.copyVerifiedProjectSource(seal, copy)
    expect(readFileSync(join(copy, 'main.ts'), 'utf8')).toBe('export const value = 1')
    const target = join(actual, 'target'); mkdirSync(target); symlinkSync('target', join(actual, 'copy-link'))
    expect(() => api!.copyVerifiedProjectSource(seal, join(alias, 'copy-link'))).toThrow('PROJECT_COPY_DESTINATION')
    expect(readdirSync(target)).toEqual([])
  } finally { cleanup(root) }
})
it('seals only explicit public source and dependency/tool bytes without executing hooks', async () => {
  const api = await load(); expect(api, 'sealed project preparation must exist').not.toBeNull()
  const root = mkdtempSync(join(tmpdir(), 'sealed-project-'))
  try {
    const source = join(root, 'source'), deps = join(root, 'deps'), tools = join(root, 'tools')
    for (const dir of [source, deps, tools]) mkdirSync(dir)
    writeFileSync(join(source, 'package.json'), '{"scripts":{"prepare":"touch SHOULD_NOT_EXIST"}}')
    writeFileSync(join(source, 'main.ts'), 'export const publicValue = 1')
    writeFileSync(join(source, '.env'), 'synthetic-private')
    writeFileSync(join(source, 'unrelated.txt'), 'not listed')
    writeFileSync(join(deps, 'dep.js'), 'module.exports = 1')
    symlinkSync('dep.js', join(deps, 'alias.js'))
    writeFileSync(join(tools, 'node'), 'fixed synthetic tool')
    const sealed = api!.sealProjectInputs({ sourceRoot: source, sourceFiles: ['package.json', 'main.ts'], dependencyRoots: [{ name: 'modules', path: deps }], tools: [{ name: 'node', path: join(tools, 'node') }], destination: join(root, 'sealed'), provenance: { source: 'dirty-working-tree', revision: 'fixture' } })
    expect(existsSync(join(sealed.sourceRoot, '.env'))).toBe(false)
    expect(existsSync(join(sealed.sourceRoot, 'unrelated.txt'))).toBe(false)
    expect(existsSync(join(source, 'SHOULD_NOT_EXIST'))).toBe(false)
    expect(readFileSync(join(sealed.dependencyRoots.modules, 'alias.js'), 'utf8')).toBe('module.exports = 1')
    const digest = sealed.digest
    writeFileSync(join(source, 'main.ts'), 'changed after sealing')
    expect(readFileSync(join(sealed.sourceRoot, 'main.ts'), 'utf8')).toBe('export const publicValue = 1')
    expect(api!.verifyProjectSeal(sealed)).toBe(true)
    expect(sealed.digest).toBe(digest)
  } finally { cleanup(root) }
})
it('rejects secret-like source paths, source symlink escapes and dependency escapes', async () => {
  const api = await load(); expect(api).not.toBeNull()
  const root = mkdtempSync(join(tmpdir(), 'sealed-denial-'))
  try {
    const source = join(root, 'source'), deps = join(root, 'deps'); mkdirSync(source); mkdirSync(deps)
    writeFileSync(join(root, 'outside'), 'synthetic-private'); symlinkSync('../outside', join(source, 'public.ts')); symlinkSync('../outside', join(deps, 'outside.js'))
    const config = { sourceRoot: source, sourceFiles: ['public.ts'], dependencyRoots: [{ name: 'modules', path: deps }], tools: [], destination: join(root, 'sealed'), provenance: { source: 'fixture', revision: 'fixture' } }
    expect(() => api!.sealProjectInputs(config)).toThrow('PROJECT_SOURCE_SYMLINK')
    for (const name of ['.env', '.sa-target', '../outside', 'auth.json', 'node_modules/data']) expect(() => api!.sealProjectInputs({ ...config, sourceFiles: [name] })).toThrow('PROJECT_SOURCE_PATH')
    writeFileSync(join(source, 'safe.ts'), 'safe')
    expect(() => api!.sealProjectInputs({ ...config, sourceFiles: ['safe.ts'] })).toThrow('PROJECT_DEPENDENCY_ESCAPE')
  } finally { cleanup(root) }
})
it('detects sealed content mutation and rejects duplicate or missing source inputs', async () => {
  const api = await load(); expect(api).not.toBeNull()
  const root = mkdtempSync(join(tmpdir(), 'sealed-change-'))
  try {
    const source = join(root, 'source'); mkdirSync(source); writeFileSync(join(source, 'a.ts'), 'a')
    const config = { sourceRoot: source, sourceFiles: ['a.ts'], dependencyRoots: [], tools: [], destination: join(root, 'sealed'), provenance: { source: 'fixture', revision: 'fixture' } }
    expect(() => api!.sealProjectInputs({ ...config, sourceFiles: ['a.ts', 'a.ts'] })).toThrow('PROJECT_SOURCE_DUPLICATE')
    const sealed = api!.sealProjectInputs(config)
    const { chmodSync } = await import('node:fs'); chmodSync(join(sealed.sourceRoot, 'a.ts'), 0o600); writeFileSync(join(sealed.sourceRoot, 'a.ts'), 'corrupt')
    expect(api!.verifyProjectSeal(sealed)).toBe(false)
  } finally { cleanup(root) }
})
it('binds exact inventory, execution roots and executable modes and copies only verified source', async () => {
  const api = await load(); const root = mkdtempSync(join(tmpdir(), 'sealed-exact-'))
  try {
    const source = join(root, 'source'); mkdirSync(source); writeFileSync(join(source, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const seal = api!.sealProjectInputs({sourceRoot:source,sourceFiles:['run.sh'],dependencyRoots:[],tools:[],destination:join(root,'sealed'),provenance:{source:'fixture',revision:'fixture'}})
    expect(api!.verifyProjectSeal({...seal,sourceRoot:source})).toBe(false)
    expect(api!.verifyProjectSeal({...seal,tools:{node:'/usr/bin/true'}})).toBe(false)
    expect(api!.verifyProjectSeal({...seal,dependencyRoots:{other:source}})).toBe(false)
    const copy=join(root,'copy');mkdirSync(copy);api!.copyVerifiedProjectSource(seal,copy)
    expect(lstatSync(join(copy,'run.sh')).mode&0o111).not.toBe(0)
    chmodSync(join(seal.sourceRoot,'run.sh'),0o400)
    expect(api!.verifyProjectSeal(seal)).toBe(false)
    chmodSync(join(seal.sourceRoot,'run.sh'),0o500)
    expect(api!.verifyProjectSeal(seal)).toBe(true)
    chmodSync(seal.sourceRoot,0o700);writeFileSync(join(seal.sourceRoot,'extra.ts'),'unlisted')
    expect(api!.verifyProjectSeal(seal)).toBe(false)
    const rejected=join(root,'rejected');mkdirSync(rejected)
    expect(()=>api!.copyVerifiedProjectSource(seal,rejected)).toThrow('PROJECT_SEAL_CHANGED')
    expect(readdirSync(rejected)).toEqual([])
  } finally { cleanup(root) }
})
