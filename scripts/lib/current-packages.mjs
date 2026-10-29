/**
 * Discover the repository's current publishable package roots:
 * packages/*, non-recursively and deterministically.
 * Shared by release, documentation, and profile-link maintenance scripts.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * @param {string} root repository root to walk.
 * @returns {{ dir: string, pkgPath: string }[]} absolute package directories
 *   and package.json paths, sorted per root.
 */
export function walkCurrentPackages(root) {
  const out = []
  const absBase = resolve(root, 'packages')
  if (existsSync(absBase)) {
    for (const entry of readdirSync(absBase).sort()) {
      const dir = resolve(absBase, entry)
      const pkgPath = join(dir, 'package.json')
      if (!existsSync(pkgPath)) continue
      out.push({ dir, pkgPath })
    }
  }
  return out
}
