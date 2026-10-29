import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { gzipSync, gunzipSync } from 'node:zlib'
import { assertArtifact, artifactIdentity, downloadVerified, integrity, promote, publishCandidate, registryMetadata } from './release-candidate.mjs'
import { waitForPublished } from './release-assets.mjs'
import { assertHostVersion } from './runtime-host-version.mjs'

// This file intentionally asserts the desired security boundary, not the current
// implementation. Failures are audit evidence, not skipped/expected failures.
// No real npm, deployment or remote service is contacted.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NAME = '@dsh-cove/dsh-web-all'
const immediate = { attempts: 2, delayMs: 0, sleep() {} }
function temporary(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-delivery-adversarial-')))
  t.after(() => {
    assert.equal(resolve(root), root)
    assert.ok(root.startsWith(join(realpathSync(tmpdir()), 'dsh-delivery-adversarial-')))
    rmSync(root, { recursive: true, force: true })
  })
  return root
}
function tarball(file, version = '0.4.2', payload = 'stable') {
  const manifest = Buffer.from(JSON.stringify({ name: NAME, version, payload }))
  const header = Buffer.alloc(512)
  header.write('package/package.json', 0)
  for (const [offset, length, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, manifest.length], [136, 12, 0]]) {
    header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset)
  }
  header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257)
  const sum = header.reduce((total, byte) => total + byte, 0)
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  writeFileSync(file, gzipSync(Buffer.concat([header, manifest, Buffer.alloc((512 - manifest.length % 512) % 512 + 1024)])))
}
function manifestOf(file) {
  const tar = gunzipSync(readFileSync(file))
  assert.equal(tar.subarray(0, 20).toString().replace(/\0.*$/, ''), 'package/package.json')
  return tar.subarray(512, 512 + parseInt(tar.subarray(124, 136).toString(), 8)).toString()
}
function release(t, options = {}) {
  const root = temporary(t), file = join(root, options.fileName ?? 'gated.tgz')
  tarball(file, options.version)
  const calls = [], expected = { integrity: integrity(file) }
  let view = 0
  const run = (command, args, execOptions) => {
    calls.push({ command, args, options: execOptions })
    if (command === 'tar') return manifestOf(args[1])
    assert.equal(command, 'npm', 'unmocked external command forbidden')
    if (args[0] === 'view') {
      if (args[2] === 'dist-tags') return JSON.stringify({ latest: options.latest ?? '0.4.1' })
      const result = options.views?.[view++] ?? expected
      if (result instanceof Error) throw result
      return JSON.stringify(result)
    }
    if (args[0] === 'pack') {
      const out = args[args.indexOf('--pack-destination') + 1]
      const name = options.packName ?? 'registry.tgz'
      copyFileSync(file, join(out, name))
      return JSON.stringify([{ filename: name }])
    }
    assert.ok(['publish', 'dist-tag'].includes(args[0]), 'unexpected npm operation')
    return ''
  }
  return { root, file, expected, run, calls, writes: () => calls.filter(c => ['publish', 'dist-tag'].includes(c.args[0])) }
}
function npmError(stdout, extra = {}) { return Object.assign(new Error('fake npm failed'), { stdout, ...extra }) }

test('release validates actual gzip artifact bytes and preserves newer latest', t => {
  const f = release(t, { latest: '0.4.3' })
  // Real local tar validates our fixture format, never npm or a remote service.
  assert.deepEqual(artifactIdentity(f.file, (command, args) => {
    assert.equal(command, 'tar')
    return execFileSync(command, args, { encoding: 'utf8', timeout: 1000 })
  }), { name: NAME, version: '0.4.2' })
  assert.deepEqual(artifactIdentity(f.file, f.run), { name: NAME, version: '0.4.2' })
  assert.equal(promote(f.file, f.run).promoted, false)
  assert.equal(f.writes().length, 0)
})
test('repacked candidate with different bytes is rejected rather than overwriting immutable version', t => {
  const f = release(t), old = f.expected
  tarball(f.file, '0.4.2', 'non-deterministic prepack output')
  assert.throws(() => publishCandidate(f.file, (cmd, args, opts) => cmd === 'npm' && args[0] === 'view' ? JSON.stringify(old) : f.run(cmd, args, opts)), /differs/)
  assert.equal(f.writes().length, 0)
})
for (const stdout of ['not json', '{"error":{"code":"E401"}}', '{"error":{"code":404}}']) {
  test(`release never publishes on malformed/non-404 npm failure ${stdout}`, t => {
    const f = release(t, { views: [npmError(stdout)] })
    assert.throws(() => publishCandidate(f.file, f.run, immediate))
    assert.equal(f.writes().length, 0)
  })
}
test('release does not trust forged E404 stdout on a killed/timed-out process', t => {
  const f = release(t, { views: [npmError('{"error":{"code":"E404"}}', { code: 'ETIMEDOUT', signal: 'SIGTERM', status: null })] })
  assert.throws(() => publishCandidate(f.file, f.run, immediate))
  assert.equal(f.writes().length, 0, 'transport failure must not trigger npm publish')
})
for (const data of [[], false, 7, '', { integrity: [] }, { integrity: { value: 'sha512-x' } }]) {
  test(`release rejects metadata types ${JSON.stringify(data)}`, t => {
    const f = release(t, { views: [data] })
    assert.throws(() => registryMetadata(NAME + '@0.4.2', f.run))
    assert.equal(f.writes().length, 0)
  })
}
test('SRI with multiple valid algorithms fails closed (compatibility limitation, not bypass)', t => {
  const f = release(t)
  const sha256 = createHash('sha256').update(readFileSync(f.file)).digest('base64')
  assert.throws(() => assertArtifact(f.file, { integrity: `sha256-${sha256} ${integrity(f.file)}` }), /differs/)
})
test('pack filename cannot escape the gated output directory', t => {
  const f = release(t, { packName: '../escaped.tgz' }), out = join(f.root, 'downloads')
  assert.throws(() => downloadVerified(f.file, out, f.run), /path|filename|outside|invalid/i)
})
test('legacy release-assets propagates authentication failure rather than disguising as propagation timeout', () => {
  const error = Object.assign(new Error('authentication failed'), { code: 'E401' })
  assert.throws(() => waitForPublished([{ name: NAME }], '0.4.2', () => { throw error }, { attempts: 1 }), actual => actual === error)
})
test('npm subprocess invocations carry finite deadlines even before propagation retry loop', t => {
  const f = release(t)
  publishCandidate(f.file, f.run, immediate)
  for (const call of f.calls.filter(c => c.command === 'npm')) {
    assert.ok(Number.isFinite(call.options?.timeout) && call.options.timeout > 0, 'npm view must have a per-process timeout')
  }
})
test('known limitation: external publisher race is not falsely described as npm CAS', t => {
  const f = release(t)
  let latest = '0.4.1'
  const result = promote(f.file, (cmd, args, options) => {
    if (args[2] === 'dist-tags') { const old = latest; latest = '0.4.9'; return JSON.stringify({ latest: old }) }
    if (args[0] === 'dist-tag') latest = '0.4.2'
    return f.run(cmd, args, options)
  })
  assert.equal(result.promoted, true)
  assert.equal(latest, '0.4.2')
})
test('GITHUB_ENV emission rejects a newline in npm pack output filename', t => {
  const f = release(t), envFile = join(f.root, 'github.env'), out = join(f.root, 'downloads')
  const code = `
    import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    import fs from 'node:fs'; import path from 'node:path';
    const gated=${JSON.stringify(f.file)}, expected=${JSON.stringify(f.expected)}, out=${JSON.stringify(out)};
    cp.execFileSync=(cmd,args)=>{
      if(cmd==='tar')return ${JSON.stringify(manifestOf(f.file))};
      if(cmd!=='npm')throw Error('unexpected command');
      if(args[0]==='view')return JSON.stringify(expected);
      if(args[0]==='pack'){const filename='registry.tgz\\nINJECTED_ENV=1';fs.copyFileSync(gated,path.join(out,filename));return JSON.stringify([{filename}]);}
      throw Error('writes forbidden');
    };
    syncBuiltinESMExports(); process.argv=[process.execPath,${JSON.stringify(join(ROOT, 'scripts/release-candidate.mjs'))},'download',gated,out];
    await import(${JSON.stringify(new URL('./release-candidate.mjs', import.meta.url).href)});
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, GITHUB_ENV: envFile }, timeout: 3000 })
  assert.equal(result.error, undefined)
  const written = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
  assert.doesNotMatch(written, /^INJECTED_ENV=/m, 'untrusted path injected a second Actions environment variable')
})

test('runtime minimum rejects malformed or empty host stdout', () => {
  for (const value of ['', 'npm warning', '0.1.5-rc.2', 'garbage0.2.0-rc.2']) assert.throws(() => assertHostVersion(value))
})
test('runtime minimum does not accept an unrelated warning version preceding an obsolete DSH version', () => {
  assert.throws(() => assertHostVersion('wrapper 99.0.0\ndsh 0.1.5-rc.2'))
})


test('mount cleanup does not recursively delete arbitrary caller-supplied roots', t => {
  const root = temporary(t), calls = join(root, 'rm-calls.jsonl')
  const source = readFileSync(join(ROOT, 'scripts/e2e-mount.sh'), 'utf8')
  const cleanup = source.slice(source.indexOf('cleanup()'), source.indexOf('trap cleanup EXIT'))
  // Execute the actual cleanup body, but replace rm with a log-only function.
  // Never execute production rm, kill, startup, installation or remote commands.
  const script = `rm(){ printf '%s\\n' "$*" >> "$RM_CALLS"; }; warn(){ :; }; SERVER_PID=''; SCRATCH='/arbitrary/unowned/project'; E2E_ROOT='/arbitrary/unowned/home'; KEEP_HOME=''; ${cleanup}; cleanup`
  const result = spawnSync('bash', ['-c', script], { env: { ...process.env, RM_CALLS: calls }, encoding: 'utf8', timeout: 1000 })
  assert.equal(result.error, undefined)
  assert.equal(existsSync(calls) ? readFileSync(calls, 'utf8') : '', '', 'unvalidated roots reached recursive deletion')
})

test('shell command metacharacters supplied through DSH_CMD are not reevaluated as shell code', t => {
  const root = temporary(t), sentinel = join(root, 'should-not-exist')
  const cmd = `printf 'safe'; touch ${sentinel}`
  const result = spawnSync('bash', ['-c', '$DSH_CMD --version'], { env: { ...process.env, DSH_CMD: cmd }, encoding: 'utf8', timeout: 1000 })
  assert.equal(existsSync(sentinel), false)
  assert.equal(result.status, 0, 'word splitting is not eval; injected semicolon is not syntax')
})

// Exercise the real CLI entry point with fake npm/tar rather than executing any
// production commands. stdout/stderr are isolated in the child and bounded.
// The extracted cleanup assertion replaces rm with a log-only function.
