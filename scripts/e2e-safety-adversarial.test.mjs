// Safety invariants execute the production preflight/cleanup and full runner
// against fake executables. No real DSH, package install, listener or rm runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'scripts/e2e-mount.sh'), 'utf8')
const boundary = source.indexOf('# 步骤 1：')
assert.ok(boundary > 0)
const bootstrap = `SCRIPT_DIR=${JSON.stringify(join(root, 'scripts'))}\nROOT=${JSON.stringify(root)}`
const relocate = text => text.replace(/SCRIPT_DIR=.*\nROOT=.*/, bootstrap)
const prefix = relocate(source.slice(0, boundary))

function inside(parent, path) {
  const r = relative(parent, path)
  return r !== '' && !isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)
}
function fixture(run) {
  const parent = realpathSync(tmpdir())
  const base = realpathSync(mkdtempSync(join(parent, 'dsh-e2e-invariant-')))
  const identity = lstatSync(base)
  try {
    const bin = join(base, 'bin'), home = join(base, 'home'), scratchParent = join(base, 'scratch-parent')
    for (const path of [bin, home, scratchParent]) mkdirSync(path)
    const log = join(base, 'calls.jsonl'), script = join(base, 'probe.sh'), tarball = join(base, 'registry candidate.tgz')
    writeFileSync(tarball, 'test fixture, never installed')
    const dispatch = join(base, 'fake-command.mjs')
    writeFileSync(dispatch, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const name=basename(process.argv[1]), args=process.argv.slice(2);
appendFileSync(process.env.PROBE_LOG,JSON.stringify({name,args,home:process.env.DSH_HOME})+'\\n');
if (args.includes('--version')) { console.log('0.2.0-rc.2'); process.exit(0); }
if (name==='dsh'||name==='npx'||name.includes('wrapper')) {
 if (args.includes('plugin')) {
  if(process.env.FAIL_INSTALL) process.exit(37);
  const file=join(process.env.DSH_HOME,'profiles/web/package.json');
  const json=JSON.parse(readFileSync(file,'utf8'));json.dsh.profile.bundles.push('@dsh-cove/dsh-web-all');writeFileSync(file,JSON.stringify(json));
 } else if(args.includes('web')) {
  console.log('dsh web: http://127.0.0.1:49123/?token=fake');
  process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);
 }
} else if(name==='pnpm'||name==='git') process.exit(0);
else throw Error('unexpected fake command '+name);
`)
    chmodSync(dispatch, 0o700)
    for (const name of ['dsh', 'pnpm', 'npx', 'git']) symlinkSync(dispatch, join(bin, name))
    // Only Node is real; never put a real dsh or package manager on this PATH.
    symlinkSync(process.execPath, join(bin, 'node'))
    for (const name of ['dirname', 'mkdir', 'cat', 'tail', 'head', 'awk', 'grep', 'sleep', 'seq']) {
      const located = spawnSync('/bin/bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
      symlinkSync(located, join(bin, name))
    }
    const invoke = (overrides = {}, tail = 'exit 79', full = false) => {
      writeFileSync(log, '')
      writeFileSync(script, full ? relocate(source) : prefix + '\n' + tail + '\n')
      const env = {
        PATH: bin, HOME: home, DSH_HOME_BASE: scratchParent,
        WEB_PLUGIN_DIR: join(root, 'packages/dsh-web-all'), WEB_ALL_TARBALL: tarball,
        PROBE_LOG: log, ...overrides,
      }
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
      const result = spawnSync('/bin/bash', [script], { cwd: root, encoding: 'utf8', timeout: 10000, env })
      assert.equal(result.error, undefined, result.error?.message)
      const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      return { ...result, calls }
    }
    return run({ base, bin, home, scratchParent, tarball, dispatch, invoke })
  } finally {
    assert.equal(dirname(base), parent)
    assert.ok(inside(parent, base) && base.startsWith(join(parent, 'dsh-e2e-invariant-')))
    const current = lstatSync(base)
    assert.equal(current.isSymbolicLink(), false)
    assert.equal(current.ino, identity.ino)
    assert.equal(current.dev, identity.dev)
    rmSync(base, { recursive: true, force: true })
  }
}

for (const [label, value] of [['root', '/'], ['home', f => f.home], ['workspace', root], ['relative', 'relative-scratch']]) {
  test(`rejects ${label} scratch parent before invoking DSH or allocating`, () => fixture(f => {
    const result = f.invoke({ DSH_HOME_BASE: typeof value === 'function' ? value(f) : value })
    assert.notEqual(result.status, 79, result.stderr)
    assert.deepEqual(result.calls, [])
    assert.deepEqual(readdirSync(f.scratchParent), [])
    assert.deepEqual(readdirSync(f.home), [])
  }))
}

test('existing scratch parent is preserved; cleanup removes only fresh private children', () => fixture(f => {
  writeFileSync(join(f.scratchParent, 'user-sentinel'), 'preserve')
  const result = f.invoke({}, `
"$NODE_BIN" -e 'const fs=require("fs");for(const x of process.argv.slice(1)){if((fs.statSync(x).mode&511)!==448)throw Error("not private");if(!fs.existsSync(x+"/.dsh-e2e-owner"))throw Error("not owned")}' "$SCRATCH" "$E2E_ROOT"
exit 79`)
  assert.equal(result.status, 79, result.stderr)
  assert.deepEqual(readdirSync(f.scratchParent), ['user-sentinel'])
  assert.equal(readFileSync(join(f.scratchParent, 'user-sentinel'), 'utf8'), 'preserve')
  assert.deepEqual(readdirSync(f.home), [])
}))

test('existing explicit fixture root is never reused, written or deleted', () => fixture(f => {
  const target = join(f.base, 'existing-fixture'); mkdirSync(target); writeFileSync(join(target, 'sentinel'), 'preserve')
  const result = f.invoke({ DSH_E2E_ROOT: target })
  assert.notEqual(result.status, 79)
  assert.deepEqual(result.calls, [])
  assert.deepEqual(readdirSync(target), ['sentinel'])
  assert.deepEqual(readdirSync(f.scratchParent), [])
}))

test('symlink scratch parent and symlink fixture ancestors are rejected', () => fixture(f => {
  const link = join(f.base, 'alias'); symlinkSync(f.scratchParent, link)
  for (const overrides of [{ DSH_HOME_BASE: link }, { DSH_E2E_ROOT: join(link, 'fixture') }]) {
    const result = f.invoke(overrides)
    assert.notEqual(result.status, 79)
    assert.deepEqual(result.calls, [])
  }
  assert.deepEqual(readdirSync(f.scratchParent), [])
}))

for (const [label, desired] of [['root', () => '/'], ['home', f => f.home], ['workspace', () => root], ['relative', () => 'fixture'], ['overlapping', f => join(f.scratchParent, 'fixture')]]) {
  test(`rejects ${label} fixture input before creating either root`, () => fixture(f => {
    const result = f.invoke({ DSH_E2E_ROOT: desired(f) })
    assert.notEqual(result.status, 79)
    assert.deepEqual(result.calls, [])
    assert.deepEqual(readdirSync(f.scratchParent), [])
  }))
}

test('explicit fresh fixture prefix allocates a private mkdtemp child, never the supplied path', () => fixture(f => {
  const desired = join(f.base, 'fresh-fixture')
  const result = f.invoke({ DSH_E2E_ROOT: desired }, '[[ "$E2E_ROOT" == "$DSH_E2E_ROOT".* ]] || exit 90\nexit 79')
  assert.equal(result.status, 79, result.stderr)
  assert.equal(existsSync(desired), false)
  assert.equal(readdirSync(f.base).some(name => name.startsWith('fresh-fixture.')), false)
}))

test('KEEP_HOME retains only freshly allocated owned roots, not unsafe paths', () => fixture(f => {
  const result = f.invoke({ KEEP_HOME: '1' })
  assert.equal(result.status, 79, result.stderr)
  const paths = [join(f.scratchParent, readdirSync(f.scratchParent)[0]), join(f.home, readdirSync(f.home)[0])]
  for (const path of paths) assert.ok(existsSync(join(path, '.dsh-e2e-owner')))
  const rejected = f.invoke({ KEEP_HOME: '1', DSH_HOME_BASE: root })
  assert.notEqual(rejected.status, 79)
  assert.deepEqual(rejected.calls, [])
}))

for (const port of ['3080', '3000', 'not-a-port', '-1', '00', '']) {
  test(`refuses PORT=${JSON.stringify(port)} before running any DSH command`, () => fixture(f => {
    const result = f.invoke({ PORT: port })
    assert.notEqual(result.status, 79)
    assert.deepEqual(result.calls, [])
  }))
}

test('explicit wrappers with spaces remain a single executable; missing/text wrappers never fallback', () => fixture(f => {
  const wrapper = join(f.bin, 'wrapper with spaces'); symlinkSync(f.dispatch, wrapper)
  const valid = f.invoke({ DSH_CMD: wrapper })
  assert.equal(valid.status, 79, valid.stderr)
  assert.equal(valid.calls[0].name, 'wrapper with spaces')
  assert.deepEqual(valid.calls[0].args, ['--version'])
  for (const value of ['missing-wrapper', 'dsh --profile production', '']) {
    const rejected = f.invoke({ DSH_CMD: value })
    assert.notEqual(rejected.status, 79)
    assert.deepEqual(rejected.calls, [])
  }
}))

for (const pathInput of [{ WEB_PLUGIN_DIR: 'relative-package' }, { WEB_ALL_TARBALL: 'relative.tgz' }, { WEB_ALL_TARBALL: '/nonexistent-e2e-fixture.tgz' }]) {
  test(`validates external inputs before CLI: ${JSON.stringify(pathInput)}`, () => fixture(f => {
    const result = f.invoke(pathInput)
    assert.notEqual(result.status, 79)
    assert.deepEqual(result.calls, [])
    assert.deepEqual(readdirSync(f.scratchParent), [])
  }))
}

test('cleanup refuses a replaced root even if its owner marker is copied', () => fixture(f => {
  const result = f.invoke({}, `
"$NODE_BIN" - "$SCRATCH" <<'NODE'
const fs=require('fs'),p=process.argv[2];
const st=fs.lstatSync(p);if(!require('path').isAbsolute(p)||st.isSymbolicLink()||JSON.parse(fs.readFileSync(p+'/.dsh-e2e-owner','utf8')).path!==p)throw Error('not test-owned');
fs.renameSync(p,p+'.retired');fs.mkdirSync(p,{mode:0o700});fs.copyFileSync(p+'.retired/.dsh-e2e-owner',p+'/.dsh-e2e-owner');fs.chmodSync(p+'/.dsh-e2e-owner',0o600);fs.writeFileSync(p+'/replacement-sentinel','preserve');
NODE
exit 79`)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /cleanup refused/)
  const replacement = readdirSync(f.scratchParent).find(name => !name.endsWith('.retired'))
  assert.equal(readFileSync(join(f.scratchParent, replacement, 'replacement-sentinel'), 'utf8'), 'preserve')
  assert.equal(readdirSync(f.home).length, 1, 'validate all roots before deleting any')
}))

test('cleanup rejects a changed sentinel and a symlink-swapped target', () => fixture(f => {
  for (const mutation of ['marker', 'symlink']) {
    const result = f.invoke({}, `
"$NODE_BIN" - "$SCRATCH" '${mutation}' <<'NODE'
const fs=require('fs'),p=process.argv[2];
if(process.argv[3]==='marker')fs.writeFileSync(p+'/.dsh-e2e-owner','forged');
else {const st=fs.lstatSync(p);if(!require('path').isAbsolute(p)||st.isSymbolicLink()||JSON.parse(fs.readFileSync(p+'/.dsh-e2e-owner','utf8')).path!==p)throw Error('not owned');fs.renameSync(p,p+'.retired');fs.mkdirSync(p+'.target',{mode:0o700});fs.writeFileSync(p+'.target/sentinel','preserve');fs.symlinkSync(p+'.target',p);}
NODE
exit 79`)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /cleanup refused/)
  }
}))

test('full fake consumer run keeps registry tarball, explicit web profile, loopback and ephemeral port', () => fixture(f => {
  const result = f.invoke({}, '', true)
  assert.equal(result.status, 0, result.stderr)
  const install = result.calls.find(row => row.args.includes('plugin'))
  const launch = result.calls.find(row => row.args.includes('web') && !row.args.includes('plugin'))
  assert.deepEqual(install.args, ['plugin', '--profile', 'web', 'add', 'file:' + f.tarball])
  assert.deepEqual(launch.args, ['--profile', 'web', '--host', '127.0.0.1', '--no-open', '--port', '0'])
  assert.equal(install.home, launch.home)
  assert.ok(inside(f.scratchParent, install.home))
  assert.deepEqual(readdirSync(f.scratchParent), [])
  assert.deepEqual(readdirSync(f.home), [])
}))

test('failed install cleans only owned children and never attempts web launch', () => fixture(f => {
  const result = f.invoke({ FAIL_INSTALL: '1' }, '', true)
  assert.equal(result.status, 37, result.stderr)
  assert.equal(result.calls.some(row => row.args[0] === 'web'), false)
  assert.deepEqual(readdirSync(f.scratchParent), [])
  assert.deepEqual(readdirSync(f.home), [])
}))

test('default missing dsh uses a quoted npx argument array; specified wrapper never does', () => fixture(f => {
  const path = join(f.bin, 'dsh')
  assert.ok(inside(f.base, path) && lstatSync(path).isSymbolicLink())
  unlinkSync(path)
  const result = f.invoke()
  assert.equal(result.status, 79, result.stderr)
  assert.deepEqual(result.calls[0].args, ['-y', '--package', '@deepseek-ai/dsh@0.2.0-rc.2', 'dsh', '--version'])
  assert.equal(result.calls[0].name, 'npx')
}))

test('signal trap stops only its recorded live child, not an arbitrary external PID', () => fixture(f => {
  const result = f.invoke({}, `
"$NODE_BIN" -e 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)' &
SERVER_PID=$!
kill -TERM "$$"
exit 79`)
  assert.equal(result.status, 143, result.stderr)
  assert.deepEqual(readdirSync(f.scratchParent), [])
  assert.deepEqual(readdirSync(f.home), [])
  // Even a known live PID cannot be killed unless it is our Bash job.
  const rejected = f.invoke({}, 'SERVER_PID=$PPID\nkill -TERM "$$"\nexit 79')
  assert.equal(rejected.status, 143, rejected.stderr)
}))

test('bash syntax remains valid', () => {
  const result = spawnSync('/bin/bash', ['-n', join(root, 'scripts/e2e-mount.sh')], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
