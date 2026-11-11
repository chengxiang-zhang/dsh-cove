import { createHash } from 'node:crypto'
import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
export interface ManagedMaterial { id: string; path: string; sha256: string; source: string }
/** Paths come only from the owner-controlled project bootstrap, never intake JSON. */
export function loadManagedMaterials(entries: readonly ManagedMaterial[] = []) {
  let size = 0
  const ids = new Set<string>()
  const materials = entries.map(entry => {
    if (!entry.id || ids.has(entry.id) || !entry.source || !isAbsolute(entry.path) || realpathSync(entry.path) !== entry.path || !lstatSync(entry.path).isFile()) throw Error('MANAGED_MATERIAL_INVALID')
    ids.add(entry.id)
    const bytes = readFileSync(entry.path); size += bytes.length
    if (size > 524288 || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw Error('MANAGED_MATERIAL_CHANGED')
    return { id: entry.id, source: entry.source, sha256: entry.sha256, text: bytes.toString('utf8') }
  })
  return { digest: createHash('sha256').update(JSON.stringify(materials)).digest('hex'), materials }
}
