import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hostVersion, compareVersions, assertHostVersion } from './runtime-host-version.mjs'

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8')

test('host pin comes from runtime floor and satisfies 0.2.0-rc.2', () => {
  const pkg = JSON.parse(read('packages/dsh-web-all/package.json'))
  assert.equal(pkg.dsh.engines.dsh, '>=' + hostVersion())
  assert.ok(compareVersions(hostVersion(), '0.2.0-rc.2') >= 0)
  assert.equal(hostVersion({ dsh: { engines: { dsh: '>=0.3.0-rc.4' } } }), '0.3.0-rc.4')
  assert.throws(() => hostVersion({ dsh: { engines: { dsh: '^0.2.0' } } }), /explicit/)
})
test('host check rejects older prerelease/stable hosts and accepts newer versions', () => {
  for (const old of ['0.1.5-rc.2', '0.1.9', '0.2.0-rc.1', 'unknown']) {
    assert.throws(() => assertHostVersion(old, '0.2.0-rc.2'), /does not satisfy/)
  }
  for (const current of ['0.2.0-rc.2', 'dsh v0.2.0-rc.10', '0.2.0', '0.3.0']) {
    assertHostVersion(current, '0.2.0-rc.2')
  }
})
test('CI, release and local mount consume the same host source instead of hardcoded pins', () => {
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const source = read(file)
    const installs = source.split('\n').filter((line) => line.includes('npm install -g') && line.includes('@deepseek-ai/dsh@'))
    assert.ok(installs.length)
    for (const line of installs) assert.ok(line.includes('$(node scripts/runtime-host-version.mjs)'))
    assert.doesNotMatch(source, /@deepseek-ai\/dsh@\d/)
  }
  const mount = read('scripts/e2e-mount.sh')
  assert.ok(mount.includes('HOST_VERSION="$("$NODE_BIN" "$ROOT/scripts/runtime-host-version.mjs")"'))
  assert.ok(mount.includes('@deepseek-ai/dsh@$("$NODE_BIN" "$ROOT/scripts/runtime-host-version.mjs")'))
  assert.ok(mount.includes('runtime-host-version.mjs" --check "$("${DSH_RUN[@]}" --version)"'))
})

test('release graph gates candidate, exact registry smoke, then latest promotion', () => {
  const workflow = read('.github/workflows/release.yml')
  const pre = workflow.slice(workflow.indexOf('  prepublish-smoke:'), workflow.indexOf('  candidate:'))
  for (const gate of ['pnpm typecheck', 'pnpm build', 'pnpm test', 'pnpm test:scripts', 'pnpm runtime-deps:check', 'verify-version.mjs']) assert.ok(pre.includes(gate))
  assert.match(pre, /pack --out "\$RUNNER_TEMP\/runtime.tgz"/)
  assert.match(pre, /WEB_ALL_TARBALL: \$\{\{ runner.temp \}\}\/runtime.tgz/)
  // Anchored on the invocation, not on the YAML shape: the step may be a multi-line block
  // (it tees its output so the gate can be reported), and what this test is about is that
  // the prerelease job really runs the packed-artifact mount smoke.
  assert.match(pre, /bash scripts\/e2e-mount\.sh/)
  assert.match(workflow, /candidate:[\s\S]*needs: prepublish-smoke/)
  assert.match(workflow, /verify-release:[\s\S]*needs: candidate/)
  const download = workflow.indexOf('release-candidate.mjs download')
  const smoke = workflow.indexOf('bash scripts/e2e-mount.sh', download)
  const promote = workflow.indexOf('release-candidate.mjs promote')
  assert.ok(download > 0 && smoke > download && promote > smoke)
  assert.doesNotMatch(workflow, /publish[^\n]*--tag latest/)
})
