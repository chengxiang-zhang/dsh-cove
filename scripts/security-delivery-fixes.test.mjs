import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packOne, waitForPublished, isRegistryNotFound } from './release-assets.mjs'
import { assertHostVersion } from './runtime-host-version.mjs'

for (const filename of ['../escape.tgz', '/escape.tgz', 'a\\escape.tgz', 'a.tgz\nINJECTED=1', 'a.tgz\rINJECTED=1', 'a\0.tgz', '..tgz']) {
  test('pack rejects unsafe filename ' + JSON.stringify(filename), () => {
    assert.throws(() => packOne('test', '1.0.0', '/tmp/output', () => JSON.stringify([{ filename }])), /filename|path/)
  })
}
test('pack rejects newline output root before subprocess', () => {
  assert.throws(() => packOne('test', '1.0.0', '/tmp/output\nINJECTED=1', () => assert.fail('subprocess forbidden')), /path/)
})
test('only confirmed npm 404 is retryable, never contradictory process failure', () => {
  for (const extra of [{ code: 'ETIMEDOUT' }, { signal: 'SIGTERM' }, { status: null }, { status: 0 }, { status: 2 }]) {
    assert.equal(isRegistryNotFound({ stdout: '{"error":{"code":"E404"}}', ...extra }), false)
  }
  assert.equal(isRegistryNotFound({ stdout: '{"error":{"code":"E404"}}', status: 1 }), true)
})
test('legacy propagation retries explicit 404 but propagates auth and transport immediately', () => {
  let calls = 0
  waitForPublished([{ name: 'test' }], '1.0.0', () => { if (++calls === 1) throw Object.assign(new Error('missing'), { code: 'E404' }) }, { attempts: 2, delayMs: 0 })
  assert.equal(calls, 2)
  for (const code of ['E401', 'ETIMEDOUT', undefined]) {
    const error = Object.assign(new Error('not a proven 404'), { code })
    assert.throws(() => waitForPublished([{ name: 'test' }], '1.0.0', () => { throw error }, { attempts: 2, delayMs: 0 }), e => e === error)
  }
})
test('version parse only accepts a single official-shaped version line', () => {
  assert.equal(assertHostVersion('0.2.0-rc.2\n'), '0.2.0-rc.2')
  for (const output of ['wrapper 99.0.0\ndsh 0.1.5-rc.2', '99.0.0\n0.1.5-rc.2', 'warning 99.0.0', '0.2.0-rc.2 extra']) assert.throws(() => assertHostVersion(output))
})

test('pack output path is exactly one safe basename under its output directory', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'security-delivery-fixes-')))
  t.after(() => {
    assert.ok(root.startsWith(join(realpathSync(tmpdir()), 'security-delivery-fixes-')))
    rmSync(root, { recursive: true, force: true })
  })
  const path = packOne('test', '1.0.0', root, (_cmd, _args, options) => {
    assert.ok(Number.isFinite(options.timeout) && options.timeout > 0)
    return '[{"filename":"test-1.0.0.tgz"}]'
  })
  assert.equal(path, join(root, 'test-1.0.0.tgz'))
})
