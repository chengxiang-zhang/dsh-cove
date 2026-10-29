/**
 * Tests for release-assets.mjs: the package walk mirrors verify-version.mjs
 * (the web-all runtime release package), and packOne downloads the exact
 * published version from the npm registry into the asset directory.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packageFiles, packOne, publishablePackages, waitForPublished } from './release-assets.mjs'

test('packageFiles: selects only the tagged web-all runtime release package', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-assets-'))
  try {
    for (const pkg of [
      'packages/dsh-web-all/package.json',
      'packages/dsh-community-plugins/package.json',
    ]) {
      mkdirSync(join(dir, pkg, '..'), { recursive: true })
      writeFileSync(join(dir, pkg), JSON.stringify({ name: 'x', version: '0.4.0' }))
    }
    const files = packageFiles(dir)
    assert.deepEqual(files, [join(dir, 'packages/dsh-web-all/package.json')])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('packOne: packs the exact published version and resolves the tarball path', () => {
  const calls = []
  const fakeRun = (file, args, options) => {
    calls.push({ file, args, options })
    return JSON.stringify([{ filename: 'dsh-cove-dsh-web-all-0.4.0.tgz' }])
  }
  const out = packOne('@dsh-cove/dsh-web-all', '0.4.0', '/tmp/assets', fakeRun)
  assert.deepEqual(calls[0].args, [
    'pack', '@dsh-cove/dsh-web-all@0.4.0', '--pack-destination', '/tmp/assets', '--json', '--registry=https://registry.npmjs.org/',
  ])
  assert.equal(out, join('/tmp/assets', 'dsh-cove-dsh-web-all-0.4.0.tgz'))
})

test('packOne: rejects when npm pack reports no filename', () => {
  const fakeRun = () => JSON.stringify([])
  assert.throws(() => packOne('@dsh-cove/dsh-web-all', '0.4.0', '/tmp/assets', fakeRun), /no filename/)
})

test('publishablePackages: drops private packages', () => {
  const out = publishablePackages([
    { name: '@dsh-cove/dsh-web-all', version: '0.4.0' },
    { name: '@dsh-cove/dsh-client-ui-community-plugins', version: '0.4.0', private: true },
  ])
  assert.deepEqual(out, [{ name: '@dsh-cove/dsh-web-all', version: '0.4.0' }])
})

test('waitForPublished: polls until every package version is readable', () => {
  const attempts = []
  const fakeView = (name) => {
    attempts.push(name)
    if (name.includes('community-plugins') && attempts.filter(n => n === name).length < 3) {
      throw Object.assign(new Error('not found'), { code: 'E404' })
    }
  }
  waitForPublished(
    [{ name: '@dsh-cove/dsh-web-all' }, { name: '@dsh-cove/dsh-client-ui-community-plugins' }],
    '0.4.0',
    fakeView,
    { attempts: 5, delayMs: 0 },
  )
  assert.equal(attempts.filter(n => n.includes('community-plugins')).length, 3)
})

test('waitForPublished: throws after the attempt budget', () => {
  const fakeView = () => { throw Object.assign(new Error('not found'), { code: 'E404' }) }
  assert.throws(
    () => waitForPublished([{ name: '@dsh-cove/dsh-web-all' }], '0.4.0', fakeView, { attempts: 2, delayMs: 0 }),
    /timed out waiting for npm propagation/,
  )
})
