/**
 * Every current published package declares the minimum DSH runtime metadata
 * consumed by the plugin-manager update guard.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkCurrentPackages } from './lib/current-packages.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SUPPORTED_MINIMUM = /^>=\s*v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

test('every current package declares a supported DSH runtime floor', () => {
  const packages = walkCurrentPackages(ROOT)
  assert.ok(packages.length > 0, 'package walker found no packages')
  for (const { pkgPath } of packages) {
    const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const minimum = manifest?.dsh?.engines?.dsh
    const hasRuntimeEntry = manifest?.dsh?.bundle !== undefined || manifest?.dsh?.client !== undefined || pkgPath.endsWith('/dsh-web-all/package.json')
    if (!hasRuntimeEntry) {
      assert.equal(minimum, undefined, `${relative(ROOT, pkgPath)} is data-only and must not declare a DSH runtime floor`)
      continue
    }
    assert.equal(typeof minimum, 'string', `${relative(ROOT, pkgPath)} must declare dsh.engines.dsh`)
    assert.match(minimum, SUPPORTED_MINIMUM, `${relative(ROOT, pkgPath)} must use the supported >=<semver> form`)
  }
})
