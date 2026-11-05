/**
 * Superagent dependency fence (T01).
 *
 * Reads every relative import under SA and checks it against the exact edge
 * table from docs/superagent/README (spec T-01). The same checker is run on a
 * synthetic bad edge so the fence is proven able to fail.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(PKG, 'src')
const SA = join(SRC, 'host', 'services', 'superagent')

const DIR_MODULES = ['protocol', 'kernel', 'world', 'memory', 'rules', 'desk', 'judgment', 'timing', 'surface',
  'executors', 'recovery', 'channels', 'capabilities'] as const
type Module = (typeof DIR_MODULES)[number] | 'host-ports' | 'root' | 'unmapped' | 'outside'

const ALLOWED: Readonly<Record<Exclude<Module, 'root' | 'unmapped' | 'outside'>, readonly Module[]>> = {
  protocol: [],
  kernel: ['protocol'],
  world: ['protocol'],
  memory: ['protocol', 'world'],
  rules: ['protocol', 'world'],
  executors: ['protocol', 'kernel', 'world', 'host-ports'],
  judgment: ['protocol', 'kernel', 'rules', 'memory', 'world', 'executors'],
  desk: ['protocol', 'kernel', 'rules', 'memory', 'world', 'judgment', 'host-ports'],
  timing: ['protocol', 'kernel', 'rules', 'surface'],
  surface: ['protocol', 'kernel', 'rules', 'timing'],
  recovery: ['protocol', 'kernel', 'desk', 'executors', 'world', 'host-ports'],
  channels: ['protocol', 'host-ports'],
  capabilities: ['protocol', 'world'],
  'host-ports': [],
}

// Paths outside SA that channels may import (relative to src/).
const CHANNEL_OUTSIDE_ALLOWED = [
  'core/lark-inbox/',
  'host/services/feishu/',
  'host/services/family-config.ts',
  'host/services/access-trust/',
  'host/services/resources.ts',
]

export interface Edge { file: string; spec: string; from: Module; to: Module; target: string }

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/** Maps an absolute path to its SA module; `outside` when not under SA. */
export function moduleOf(absPath: string, saRoot: string = SA): Module {
  const rel = toPosix(relative(saRoot, absPath))
  if (rel === '' || rel.startsWith('..')) return rel === '' ? 'root' : 'outside'
  const first = rel.split('/')[0] ?? ''
  if ((DIR_MODULES as readonly string[]).includes(first) && rel.includes('/')) return first as Module
  if (rel === 'host-ports.ts' || rel === 'host-ports') return 'host-ports'
  if (rel === 'index.ts' || rel === 'index') return 'root'
  return 'unmapped'
}

/** Pure judgement over an edge list; returns one message per violation. */
export function violations(edges: readonly Edge[], srcRoot: string = SRC): string[] {
  const out: string[] = []
  for (const e of edges) {
    const where = `${e.file}: '${e.spec}' (${e.from} -> ${e.to})`
    if (e.from === 'unmapped') { out.push(`${where}: file is not in any SA module`); continue }
    if (e.from === 'root' || e.from === 'outside') continue
    if (e.to === e.from) continue
    if (e.to === 'outside') {
      if (e.from !== 'channels') { out.push(`${where}: only channels may import outside SA`); continue }
      const rel = toPosix(relative(srcRoot, e.target))
      if (!CHANNEL_OUTSIDE_ALLOWED.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p))) out.push(`${where}: outside path not allowed`)
      continue
    }
    if (!ALLOWED[e.from].includes(e.to)) out.push(`${where}: edge not in table`)
  }
  return out
}

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function importSpecs(source: string): string[] {
  const specs: string[] = []
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (spec !== undefined) specs.push(spec)
  }
  return specs
}

function walk(dir: string, skip?: string): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (skip !== undefined && full === skip) continue
    if (statSync(full).isDirectory()) files.push(...walk(full, skip))
    else if (/\.(ts|tsx|mts)$/.test(name) && !name.endsWith('.d.ts')) files.push(full)
  }
  return files
}

function edgesOf(files: readonly string[]): Edge[] {
  const edges: Edge[] = []
  for (const file of files) {
    for (const spec of importSpecs(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue
      const target = resolve(dirname(file), spec)
      edges.push({ file: toPosix(relative(PKG, file)), spec, from: moduleOf(file), to: moduleOf(target), target })
    }
  }
  return edges
}

describe('superagent dependency fence', () => {
  const saEdges = edgesOf(walk(SA))

  it('1. every import edge inside SA is in the allowed table', () => {
    expect(violations(saEdges)).toEqual([])
  })

  it('2. SA/kernel imports only protocol and kernel itself', () => {
    const bad = saEdges
      .filter((e) => e.from === 'kernel' && e.to !== 'kernel' && e.to !== 'protocol')
      .map((e) => `${e.file}: '${e.spec}' -> ${e.to}`)
    expect(bad).toEqual([])
  })

  it('3. files outside SA reach SA only through its index.ts', () => {
    const bad = edgesOf(walk(SRC, SA))
      .filter((e) => e.to !== 'outside' && e.to !== 'root')
      .map((e) => `${e.file}: '${e.spec}'`)
    expect(bad).toEqual([])
  })

  it('4. the checker reports a synthetic kernel -> desk edge', () => {
    const synthetic: Edge[] = [
      { file: 'synthetic/kernel/a.ts', spec: '../desk/x.ts', from: 'kernel', to: 'desk', target: join(SA, 'desk', 'x.ts') },
      { file: 'synthetic/kernel/b.ts', spec: '../protocol/objects.ts', from: 'kernel', to: 'protocol', target: join(SA, 'protocol', 'objects.ts') },
    ]
    const found = violations(synthetic)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('kernel -> desk')
  })
})
