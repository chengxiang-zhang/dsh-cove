import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releasePackageFiles } from './verify-version.mjs'

test('releasePackageFiles selects every published package, and no private one', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-verify-version-'))
  try {
    for (const [path, manifest] of [
      ['packages/dsh-web-all/package.json', { version: '0.4.0' }],
      ['packages/dsh-community-plugins/package.json', { version: '0.4.0' }],
      // Published beside the runtime in the same release: one version names them all.
      ['packages/not-published/package.json', { version: '0.0.0', private: true }],
    ]) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), JSON.stringify(manifest))
    }
    assert.deepEqual(releasePackageFiles(root), [
      join(root, 'packages/dsh-community-plugins/package.json'),
      join(root, 'packages/dsh-web-all/package.json'),
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the release tree itself carries one version', () => {
  // The real tree, not a fixture: a tag publishes these together, so a mismatch here is a
  // release that would ship two numbers.
  const versions = releasePackageFiles().map((file) => JSON.parse(readFileSync(file, 'utf8')).version)
  assert.ok(versions.length >= 2, 'the runtime entity and the source/data package are both published')
  assert.equal(new Set(versions).size, 1, `every published package declares one version: ${versions.join(', ')}`)
})
