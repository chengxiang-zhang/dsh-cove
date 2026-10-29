import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  REGISTRY, compareStableVersions, downloadVerified, integrity, promote, publishCandidate,
} from './release-candidate.mjs'

const NAME = '@dsh-cove/dsh-web-all'
const COMMUNITY = '@dsh-cove/dsh-client-ui-community-plugins'
const SPEC = `${NAME}@0.4.2`
function npmError(code) {
  return Object.assign(new Error(`fake npm ${code}`), { stdout: JSON.stringify({ error: { code } }) })
}

/** All npm/tar execution is injected. Fixture bytes, hashing and downloads use real files. */
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-candidate-'))
  t.after(() => {
    const target = resolve(root)
    assert.equal(target, root)
    assert.ok(target.startsWith(join(tmpdir(), 'dsh-release-candidate-')))
    rmSync(target, { recursive: true, force: true })
  })
  const file = join(root, 'gated.tgz')
  writeFileSync(file, JSON.stringify({ name: options.name ?? NAME, version: options.version ?? '0.4.2', payload: 'gated bytes' }))
  const expected = { integrity: integrity(file) }
  const calls = []
  let views = 0
  const run = (command, args, execOptions) => {
    calls.push({ command, args, options: execOptions })
    if (command === 'tar') {
      if (options.tarError) throw options.tarError
      assert.deepEqual(args, ['-xOzf', file, 'package/package.json'])
      return readFileSync(file, 'utf8')
    }
    assert.equal(command, 'npm', 'no unmocked external command is allowed')
    assert.ok(args.includes('--registry=' + REGISTRY))
    if (args[0] === 'view') {
      if (args[2] === 'dist-tags') {
        assert.equal(args[1], options.name ?? NAME)
        if (options.latestError) throw options.latestError
        return Object.hasOwn(options, 'tagsOutput') ? options.tagsOutput : JSON.stringify(options.tags ?? { latest: '0.4.1' })
      }
      assert.equal(args[1], `${options.name ?? NAME}@${options.version ?? '0.4.2'}`)
      assert.equal(args[2], 'dist')
      const next = options.metadata?.[Math.min(views++, options.metadata.length - 1)] ?? expected
      if (next instanceof Error) throw next
      return typeof next === 'string' ? next : JSON.stringify(next)
    }
    if (args[0] === 'pack') {
      if (options.packError) throw options.packError
      const out = args[args.indexOf('--pack-destination') + 1]
      mkdirSync(out, { recursive: true })
      const destination = join(out, 'registry.tgz')
      if (options.corruptDownload) writeFileSync(destination, 'different registry bytes')
      else copyFileSync(file, destination)
      return JSON.stringify([{ filename: 'registry.tgz' }])
    }
    if (args[0] === 'publish' || args[0] === 'dist-tag') {
      if (options.writeError) throw options.writeError
      return ''
    }
    assert.fail('unexpected fake npm operation: ' + args.join(' '))
  }
  return { root, file, expected, calls, run, writes: () => calls.filter(call => ['publish', 'dist-tag'].includes(call.args[0])) }
}

const immediate = { attempts: 3, delayMs: 0, sleep: () => {} }

test('publishCandidate verifies an existing immutable version without publishing', t => {
  const f = fixture(t)
  assert.deepEqual(publishCandidate(f.file, f.run), { spec: SPEC, published: false })
  assert.deepEqual(f.writes(), [])
})

test('both packages a release carries are release artifacts', t => {
  // The source/data package travels the same three stages as the runtime entity, so the
  // identity check has to accept it - and, as the invalid-manifest case below holds,
  // nothing else.
  const community = fixture(t, { name: COMMUNITY })
  assert.deepEqual(publishCandidate(community.file, community.run), {
    spec: `${COMMUNITY}@0.4.2`,
    published: false,
  })
  assert.deepEqual(community.writes(), [])
})

test('publishCandidate rejects an existing artifact mismatch', t => {
  const f = fixture(t, { metadata: [{ integrity: 'sha512-wrong' }] })
  assert.throws(() => publishCandidate(f.file, f.run), /differs from gated tarball/)
  assert.deepEqual(f.writes(), [])
})

test('publishCandidate publishes only on confirmed E404, waits for propagation and checks bytes', t => {
  const f = fixture(t, { metadata: [npmError('E404'), npmError('E404')] })
  // Replace the final absent read with the correct post-publish metadata.
  let reads = 0
  const run = (command, args, options) => {
    if (command === 'npm' && args[0] === 'view' && args[2] === 'dist' && ++reads === 3) return JSON.stringify(f.expected)
    return f.run(command, args, options)
  }
  assert.deepEqual(publishCandidate(f.file, run, immediate), { spec: SPEC, published: true })
  assert.deepEqual(f.writes().map(call => call.args), [
    ['publish', f.file, '--access', 'public', '--tag', 'candidate', '--registry=' + REGISTRY],
  ])
  assert.equal(reads, 3)
})

for (const code of ['E401', 'E403', 'ENETUNREACH', 'ETIMEDOUT']) {
  test(`publishCandidate does not interpret ${code} as a missing version`, t => {
    const error = npmError(code)
    const f = fixture(t, { metadata: [error] })
    assert.throws(() => publishCandidate(f.file, f.run, immediate), actual => actual === error)
    assert.deepEqual(f.writes(), [])
  })
}

for (const code of ['E401', 'ENETUNREACH']) {
  test(`publishCandidate preserves post-publish ${code} instead of retrying it as 404`, t => {
    const error = npmError(code)
    const f = fixture(t, { metadata: [npmError('E404'), error] })
    assert.throws(() => publishCandidate(f.file, f.run, immediate), actual => actual === error)
    assert.equal(f.calls.filter(call => call.args[0] === 'view').length, 2)
    assert.equal(f.writes().length, 1)
  })
}

for (const output of ['null', 'not-json', '{}', '[]', '{"integrity":42}']) {
  test(`publishCandidate rejects malformed successful registry metadata ${output}`, t => {
    const f = fixture(t, { metadata: [output] })
    assert.throws(() => publishCandidate(f.file, f.run, immediate))
    assert.deepEqual(f.writes(), [])
  })
}

test('publishCandidate checks post-publish integrity and bounds genuine propagation absence', async t => {
  await t.test('mismatched bytes', t => {
    const f = fixture(t, { metadata: [npmError('E404'), { integrity: 'sha512-other' }] })
    assert.throws(() => publishCandidate(f.file, f.run, immediate), /differs from gated tarball/)
    assert.equal(f.writes().length, 1)
  })
  await t.test('persistent 404', t => {
    const f = fixture(t, { metadata: [npmError('E404')] })
    assert.throws(() => publishCandidate(f.file, f.run, immediate), /timed out waiting for candidate propagation/)
    assert.equal(f.calls.filter(call => call.args[0] === 'view').length, 4)
  })
})

for (const [latest, promoted] of [['0.4.3', false], ['0.4.2', false], ['0.4.1', true]]) {
  test(`promote preserves monotonic latest from ${latest}`, t => {
    const f = fixture(t, { tags: { latest } })
    assert.deepEqual(promote(f.file, f.run), { spec: SPEC, promoted, latest: promoted ? '0.4.2' : latest })
    assert.deepEqual(f.writes().map(call => call.args), promoted
      ? [['dist-tag', 'add', SPEC, 'latest', '--registry=' + REGISTRY]] : [])
  })
}

test('promote can initialize latest when the candidate-only package has no latest tag', t => {
  const f = fixture(t, { tags: { candidate: '0.4.2' } })
  assert.deepEqual(promote(f.file, f.run), { spec: SPEC, promoted: true, latest: '0.4.2' })
  assert.equal(f.writes().length, 1)
})

for (const latest of ['0.4.2', '0.4.3']) {
  test(`promote still verifies artifact integrity before skipping latest ${latest}`, t => {
    const f = fixture(t, { tags: { latest }, metadata: [{ integrity: 'sha512-wrong' }] })
    assert.throws(() => promote(f.file, f.run), /differs from gated tarball/)
    assert.deepEqual(f.writes(), [])
  })
}

for (const tagsOutput of ['not-json', 'null', '[]', '"0.4.1"', '{"latest":null}', '{"latest":"04.4.1"}', '{"latest":"0.4.3-beta.1"}', '{"latest":42}']) {
  test(`promote fails closed on malformed registry current state ${tagsOutput}`, t => {
    const f = fixture(t, { tagsOutput })
    assert.throws(() => promote(f.file, f.run))
    assert.deepEqual(f.writes(), [])
  })
}

test('promote fails closed on a missing registry package or auth/network failure', async t => {
  for (const code of ['E404', 'E401', 'ENETUNREACH']) {
    await t.test(code, t => {
      const f = fixture(t, { latestError: npmError(code) })
      assert.throws(() => promote(f.file, f.run))
      assert.deepEqual(f.writes(), [])
    })
  }
})

test('stable semver comparison is numeric and rejects nonstable or noncanonical values', () => {
  assert.equal(compareStableVersions('0.10.0', '0.9.99'), 1)
  assert.equal(compareStableVersions('1.0.0', '0.999.999'), 1)
  assert.equal(compareStableVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1)
  assert.equal(compareStableVersions('0.4.2', '0.4.2'), 0)
  for (const invalid of ['01.2.3', '1.2', 'v1.2.3', '1.2.3-beta', '1.2.3+build', '', null]) {
    assert.throws(() => compareStableVersions(invalid, '1.2.3'), /invalid stable/)
  }
})

test('downloadVerified validates registry bytes after packing into a real fixture directory', t => {
  const f = fixture(t)
  const out = downloadVerified(f.file, join(f.root, 'download'), f.run)
  assert.equal(out, join(f.root, 'download', 'registry.tgz'))
  assert.equal(integrity(out), integrity(f.file))
  assert.deepEqual(f.writes(), [])
})

test('downloadVerified refuses mismatching local or downloaded artifacts', async t => {
  await t.test('gated artifact differs from registry metadata: no download', t => {
    const f = fixture(t, { metadata: [{ integrity: 'sha512-wrong' }] })
    assert.throws(() => downloadVerified(f.file, join(f.root, 'download'), f.run), /differs/)
    assert.equal(f.calls.some(call => call.args[0] === 'pack'), false)
  })
  await t.test('downloaded artifact differs: no path returned', t => {
    const f = fixture(t, { corruptDownload: true })
    assert.throws(() => downloadVerified(f.file, join(f.root, 'download'), f.run), /differs/)
    assert.deepEqual(f.writes(), [])
  })
})

test('tarball parsing failures never become npm publication or promotion', async t => {
  for (const operation of [publishCandidate, promote, downloadVerified]) {
    await t.test(operation.name, t => {
      const error = new Error('fake tar: truncated archive')
      const f = fixture(t, { tarError: error })
      assert.throws(() => operation === downloadVerified
        ? operation(f.file, join(f.root, 'download'), f.run)
        : operation(f.file, f.run), actual => actual === error)
      assert.equal(f.calls.some(call => call.command === 'npm'), false)
    })
  }
})

test('invalid tarball manifests never reach registry commands', async t => {
  for (const value of ['not-json', 'null', JSON.stringify({ name: 'unrelated', version: '0.4.2' }), JSON.stringify({ name: NAME, version: '0.4.2-beta.1' })]) {
    await t.test(value, t => {
      const f = fixture(t)
      writeFileSync(f.file, value)
      assert.throws(() => promote(f.file, f.run))
      assert.equal(f.calls.some(call => call.command === 'npm'), false)
    })
  }
})

test('pack and publish subprocess errors are propagated without successful promotion', async t => {
  await t.test('download fails', t => {
    const error = new Error('fake npm pack failed')
    const f = fixture(t, { packError: error })
    const outDir = join(f.root, 'download')
    assert.throws(() => downloadVerified(f.file, outDir, f.run), actual => actual === error)
    assert.equal(existsSync(join(outDir, 'registry.tgz')), false)
    assert.deepEqual(f.writes(), [])
  })
  await t.test('publish fails', t => {
    const error = npmError('E403')
    const f = fixture(t, { metadata: [npmError('E404')], writeError: error })
    assert.throws(() => publishCandidate(f.file, f.run, immediate), actual => actual === error)
    assert.equal(f.calls.filter(call => call.args[0] === 'view').length, 1)
    assert.equal(f.calls.some(call => call.args[0] === 'dist-tag'), false)
  })
})

test('release workflow serializes tags under one repository-wide concurrency group', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.match(workflow, /concurrency:\s*\n\s+group: release-\$\{\{ github\.repository \}\}\s*\n\s+cancel-in-progress: false/)
  assert.match(workflow, /needs: prepublish-smoke/)
  assert.match(workflow, /needs: candidate/)
})
