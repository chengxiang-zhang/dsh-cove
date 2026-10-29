import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVersion, promote, promoteCommands } from './promote-latest.mjs'

const latestIs = (version) => async () => version

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

test('promote runs the promote and proves the read-back', async () => {
  const calls = []
  const run = (file, args) => {
    calls.push(args[0])
    return ''
  }
  let reads = 0
  const registryLatest = async () => (reads++ === 0 ? '0.4.8' : '0.4.9')
  assert.deepEqual(await promote('v0.4.9', { run, registryLatest }), {
    version: '0.4.9',
    promoted: ['@dsh-cove/dsh-web-all'],
  })
  assert.deepEqual(calls, ['dist-tag'])
})

test('promote is a no-op when the version already is latest', async () => {
  const calls = []
  const run = (file, args) => { calls.push(args[0]); return '' }
  assert.deepEqual(await promote('0.4.9', { run, registryLatest: latestIs('0.4.9') }), {
    version: '0.4.9',
    promoted: [],
  })
  assert.deepEqual(calls, [])
})

test('promote fails when the registry latest is not the promoted version', async () => {
  const run = () => ''
  await assert.rejects(() => promote('0.4.9', { run, registryLatest: latestIs('0.4.8') }), /latest is 0\.4\.8, expected 0\.4\.9/)
})
