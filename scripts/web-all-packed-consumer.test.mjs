import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packages = {
  '@dsh-cove/dsh-web-all': { dir: 'packages/dsh-web-all', exports: ['.', './client', './invariant'] },
  '@dsh-cove/dsh-client-ui-community-plugins': { dir: 'packages/dsh-community-plugins', exports: ['./community.json'] },
}

test('runtime and compiled source-package contract exports survive npm packing', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dsh-web-packed-consumer-'))
  try {
    for (const [name, expected] of Object.entries(packages)) {
      const pkg = JSON.parse(await readFile(join(root, expected.dir, 'package.json'), 'utf8'))
      assert.deepEqual(Object.keys(pkg.exports).filter(key => expected.exports.includes(key)).sort(), [...expected.exports].sort(), `${name} export map`)
      const packed = spawnSync('pnpm', ['pack', '--pack-destination', work], { cwd: join(root, expected.dir), encoding: 'utf8' })
      assert.equal(packed.status, 0, `${name} pack failed: ${packed.stderr}`)
      for (const key of expected.exports) {
        const target = typeof pkg.exports[key] === 'string' ? pkg.exports[key] : pkg.exports[key].default
        assert.ok(target, `${name}${key} lacks runtime target`)
        assert.ok(pkg.files.some(entry => target.replace(/^\.\//u, '').startsWith(entry.replace(/\/\*.*$/u, ''))), `${name}${key} target not covered by files whitelist`)
      }
    }
  } finally { await rm(work, { recursive: true, force: true }) }
})
