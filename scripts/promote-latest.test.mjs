import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVersion, promote, promoteCommands } from './promote-latest.mjs'

test('parseVersion accepts a tag or a plain version and rejects anything else', () => {
  assert.equal(parseVersion('v0.4.9'), '0.4.9')
  assert.equal(parseVersion(' 0.4.9 '), '0.4.9')
  for (const bad of ['', 'v0.4', 'latest', '0.4.9-rc.1', undefined]) {
    assert.throws(() => parseVersion(bad), /usage: promote-latest\.mjs/)
  }
})

test('promoteCommands targets the public registry for every release package', () => {
  assert.deepEqual(promoteCommands('0.4.9', ['@dsh-cove/dsh-web-all']), [{
    name: '@dsh-cove/dsh-web-all',
    args: ['dist-tag', 'add', '@dsh-cove/dsh-web-all@0.4.9', 'latest', '--registry=https://registry.npmjs.org/'],
  }])
})

test('promote runs the promote and proves the read-back', () => {
  const calls = []
  const run = (file, args, options) => {
    calls.push({ file, args, options })
    if (args[0] === 'view') return JSON.stringify({ latest: '0.4.9', candidate: '0.4.9' })
    return ''
  }
  assert.deepEqual(promote('v0.4.9', run).version, '0.4.9')
  assert.deepEqual(calls.map((call) => call.args[0]), ['dist-tag', 'view'])
})

test('promote fails when the registry latest is not the promoted version', () => {
  const run = (file, args) => (args[0] === 'view' ? JSON.stringify({ latest: '0.4.8' }) : '')
  assert.throws(() => promote('0.4.9', run), /latest is 0\.4\.8, expected 0\.4\.9/)
})
