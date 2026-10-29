/**
 * Tests for dsh-local-ops-audit.mjs and dsh-local-profile-migrate.mjs.
 *
 * Every test builds a throwaway DSH_HOME and HOME under a temp directory; the
 * real ~/.dsh is never read or written.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WEB_ALL,
  LEGACY_WEB_ALL,
  analyzeClientSource,
  analyzeDoctorPlistArgs,
  analyzeProfilePackage,
  analyzeRestartScript,
  analyzeStartScript,
  auditLocalOps,
  extractClientModuleId,
  hasFailure,
  parseProgramArguments,
} from './dsh-local-ops-audit.mjs'
import { applyPlan, planMigration, rewriteProfilePackage } from './dsh-local-profile-migrate.mjs'

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const clientSource = (id) => `window.__ModuleLoader__.load({\n\tid: "${id}",\n\tfactory: (require) => {}\n});\n`

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function makeWebAllPackage(dir, name, clientId) {
  write(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  write(join(dir, 'lib', 'client.js'), clientSource(clientId))
}

function link(target, path) {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(relative(dirname(path), target), path)
}

/** A clean profile whose web-all link points at a fixture package. */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-local-ops-'))
  const home = join(root, 'home')
  const dshHome = join(home, '.dsh')
  const webDir = join(dshHome, 'profiles', 'web')
  const repoPkg = join(root, 'repo', 'packages', 'dsh-web-all')
  makeWebAllPackage(repoPkg, WEB_ALL, WEB_ALL)
  write(join(webDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { '@deepseek-ai/dsh-mcp-client': '0.2.0', [WEB_ALL]: `link:${repoPkg}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', WEB_ALL, '@deepseek-ai/dsh-subagent-codex'] } },
  }, null, 2))
  link(repoPkg, join(webDir, 'node_modules', '@dsh-cove', 'dsh-web-all'))
  return { root, home, dshHome, webDir, repoPkg, repoRoot: join(root, 'repo'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const codes = (findings, level) => findings.filter((f) => f.level === level).map((f) => f.code)

test('clean profile passes', () => {
  const fx = makeFixture()
  try {
    const findings = auditLocalOps({ dshHome: fx.dshHome, home: fx.home })
    assert.equal(hasFailure(findings), false, JSON.stringify(findings))
  } finally { fx.cleanup() }
})

test('missing profile package.json fails', () => {
  const fx = makeFixture()
  try {
    rmSync(join(fx.webDir, 'package.json'))
    assert.ok(codes(auditLocalOps({ dshHome: fx.dshHome, home: fx.home }), 'fail').includes('profile-missing'))
  } finally { fx.cleanup() }
})

test('legacy name in bundles fails', () => {
  const fx = makeFixture()
  try {
    const path = join(fx.webDir, 'package.json')
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    pkg.dsh.profile.bundles.push(LEGACY_WEB_ALL)
    writeFileSync(path, JSON.stringify(pkg))
    assert.ok(codes(auditLocalOps({ dshHome: fx.dshHome, home: fx.home }), 'fail').includes('bundle-legacy'))
  } finally { fx.cleanup() }
})

test('object-form legacy bundle fails audit and migrate apply passes', () => {
  const fx = makeFixture()
  try {
    const path = join(fx.webDir, 'package.json')
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    pkg.dsh.profile.bundles = ['@deepseek-ai/dsh-base', { name: LEGACY_WEB_ALL }, '@deepseek-ai/dsh-subagent-codex']
    writeFileSync(path, JSON.stringify(pkg))
    assert.ok(codes(auditLocalOps({ dshHome: fx.dshHome, home: fx.home }), 'fail').includes('bundle-legacy'))
    const plan = planMigration({ dshHome: fx.dshHome, repoRoot: fx.repoRoot, stamp: '20260101-120000' })
    applyPlan(plan)
    const updated = JSON.parse(readFileSync(path, 'utf8'))
    assert.ok(updated.dsh.profile.bundles.includes(WEB_ALL))
    assert.ok(!updated.dsh.profile.bundles.some((e) => typeof e === 'object' && e?.name === LEGACY_WEB_ALL))
    assert.equal(hasFailure(auditLocalOps({ dshHome: fx.dshHome, home: fx.home })), false)
  } finally { fx.cleanup() }
})

test('legacy bundle subpath string fails audit like audit helpers', () => {
  const findings = analyzeProfilePackage({
    dsh: { profile: { bundles: [`${LEGACY_WEB_ALL}/extra`, WEB_ALL] } },
  })
  assert.ok(codes(findings, 'fail').includes('bundle-legacy'))
})

test('legacy name in dependencies fails', () => {
  const findings = analyzeProfilePackage({
    dependencies: { [LEGACY_WEB_ALL]: 'link:/x' },
    dsh: { profile: { bundles: [WEB_ALL] } },
  })
  assert.deepEqual(codes(findings, 'fail'), ['dependency-legacy'])
})

test('missing or duplicate current bundle fails', () => {
  assert.deepEqual(codes(analyzeProfilePackage({ dsh: { profile: { bundles: [] } } }), 'fail'), ['bundle-missing'])
  assert.deepEqual(codes(analyzeProfilePackage({ dsh: { profile: { bundles: [WEB_ALL, WEB_ALL] } } }), 'fail'), ['bundle-duplicate'])
})

test('dependency resolving to a differently named package fails', () => {
  const fx = makeFixture()
  try {
    const wrong = join(fx.root, 'wrong')
    makeWebAllPackage(wrong, LEGACY_WEB_ALL, WEB_ALL)
    const path = join(fx.webDir, 'package.json')
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    pkg.dependencies[WEB_ALL] = `link:${wrong}`
    writeFileSync(path, JSON.stringify(pkg))
    assert.ok(codes(auditLocalOps({ dshHome: fx.dshHome, home: fx.home }), 'fail').includes('dependency-name'))
  } finally { fx.cleanup() }
})

test('client id extraction reads double and single quotes within the head', () => {
  assert.equal(extractClientModuleId(clientSource(WEB_ALL)), WEB_ALL)
  assert.equal(extractClientModuleId(`load({ id: '${WEB_ALL}' })`), WEB_ALL)
  assert.equal(extractClientModuleId(`${' '.repeat(3000)}id: "${WEB_ALL}"`), null)
  assert.equal(extractClientModuleId('no id here'), null)
})

test('client id mismatch fails', () => {
  const fx = makeFixture()
  try {
    write(join(fx.repoPkg, 'lib', 'client.js'), clientSource(LEGACY_WEB_ALL))
    const findings = auditLocalOps({ dshHome: fx.dshHome, home: fx.home })
    assert.ok(codes(findings, 'fail').includes('client-id-legacy'))
    assert.deepEqual(codes(analyzeClientSource(clientSource('other')), 'fail'), ['client-id-mismatch'])
    assert.deepEqual(codes(analyzeClientSource('x'), 'fail'), ['client-id-missing'])
  } finally { fx.cleanup() }
})

test('client.js resolves from the global profiles node_modules', () => {
  const fx = makeFixture()
  try {
    rmSync(join(fx.webDir, 'node_modules', '@dsh-cove'), { recursive: true, force: true })
    assert.ok(codes(auditLocalOps({ dshHome: fx.dshHome, home: fx.home }), 'fail').includes('client-missing'))
    link(fx.repoPkg, join(fx.dshHome, 'profiles', 'node_modules', '@dsh-cove', 'dsh-web-all'))
    assert.equal(hasFailure(auditLocalOps({ dshHome: fx.dshHome, home: fx.home })), false)
  } finally { fx.cleanup() }
})

test('stale legacy package link fails, including a broken symlink', () => {
  const fx = makeFixture()
  try {
    symlinkSync(join(fx.root, 'gone'), (() => {
      mkdirSync(join(fx.webDir, 'node_modules', '@zcx'), { recursive: true })
      return join(fx.webDir, 'node_modules', '@zcx', 'dsh-web-all')
    })())
    assert.ok(codes(auditLocalOps({ dshHome: fx.dshHome, home: fx.home }), 'fail').includes('stale-legacy-package'))
  } finally { fx.cleanup() }
})

test('any leftover @zcx package fails audit even when profile is current', () => {
  const fx = makeFixture()
  try {
    const legacyDir = join(fx.root, 'legacy-pkg')
    write(join(legacyDir, 'package.json'), JSON.stringify({ name: '@zcx/dsh-community-plugins', version: '0.0.0' }))
    link(legacyDir, join(fx.webDir, 'node_modules', '@zcx', 'dsh-community-plugins'))
    const findings = auditLocalOps({ dshHome: fx.dshHome, home: fx.home })
    assert.equal(hasFailure(findings), true)
    assert.ok(codes(findings, 'fail').includes('stale-legacy-package'))
    assert.match(findings.find((f) => f.code === 'stale-legacy-package')?.message ?? '', /dsh-community-plugins/)
  } finally { fx.cleanup() }
})

test('doctor plist with a missing target fails, existing target passes', () => {
  const fx = makeFixture()
  try {
    const plist = join(fx.home, 'Library', 'LaunchAgents', 'com.dsh.doctor.plist')
    const missing = join(fx.root, 'removed', 'dsh-doctor.js')
    const body = (path) => `<?xml version="1.0"?><plist><dict><key>Label</key><string>com.dsh.doctor</string><key>ProgramArguments</key><array><string>/usr/bin/env</string><string>${path}</string></array></dict></plist>`
    write(plist, body(missing))
    assert.ok(codes(auditLocalOps({ dshHome: fx.dshHome, home: fx.home }), 'fail').includes('doctor-plist-missing-target'))
    write(plist, body(join(fx.repoPkg, 'lib', 'client.js')))
    assert.equal(hasFailure(auditLocalOps({ dshHome: fx.dshHome, home: fx.home })), false)
  } finally { fx.cleanup() }
})

test('plist helpers parse ProgramArguments and check paths', () => {
  const args = parseProgramArguments('<key>ProgramArguments</key><array><string>/bin/a</string><string>b &amp; c</string></array>')
  assert.deepEqual(args, ['/bin/a', 'b & c'])
  assert.deepEqual(codes(analyzeDoctorPlistArgs(['/bin/a', 'relative'], { exists: () => false }), 'fail'), ['doctor-plist-missing-target'])
  assert.deepEqual(codes(analyzeDoctorPlistArgs(['/bin/a'], { exists: () => true }), 'pass'), ['doctor-plist'])
})

test('restart script referencing the legacy scope fails', () => {
  const fx = makeFixture()
  try {
    write(join(fx.dshHome, 'bin', 'dsh-web-restart.sh'), `#!/bin/sh\npnpm --filter @zcx/dsh-web-all build\n`)
    assert.ok(codes(auditLocalOps({ dshHome: fx.dshHome, home: fx.home }), 'fail').includes('restart-script-legacy'))
    rmSync(join(fx.dshHome, 'bin', 'dsh-web-restart.sh'))
    write(join(fx.dshHome, 'logs', 'dsh-web-restart.sh'), `#!/bin/sh\nnode x @zcx/dsh-web-all\n`)
    assert.ok(codes(auditLocalOps({ dshHome: fx.dshHome, home: fx.home }), 'fail').includes('restart-script-legacy'))
    assert.deepEqual(codes(analyzeRestartScript('launchctl kickstart x'), 'pass'), ['restart-script'])
  } finally { fx.cleanup() }
})

test('start script without --trusted-host only warns', () => {
  const fx = makeFixture()
  try {
    write(join(fx.dshHome, 'bin', 'start-dsh-web.sh'), '#!/bin/sh\ndsh web\n')
    const findings = auditLocalOps({ dshHome: fx.dshHome, home: fx.home })
    assert.equal(hasFailure(findings), false)
    assert.deepEqual(codes(findings, 'warn'), ['start-script-trusted-host'])
    assert.deepEqual(codes(analyzeStartScript('dsh web --trusted-host dsh.x'), 'warn'), [])
  } finally { fx.cleanup() }
})

test('audit CLI exits non-zero on failure and zero when clean', () => {
  const fx = makeFixture()
  try {
    const env = { ...process.env, HOME: fx.home, DSH_HOME: fx.dshHome }
    const run = () => spawnSync(process.execPath, [join(SCRIPTS, 'dsh-local-ops-audit.mjs')], { env, encoding: 'utf8' })
    const ok = run()
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.match(ok.stdout, /\[dsh-local-ops\] OK/)
    write(join(fx.repoPkg, 'lib', 'client.js'), clientSource(LEGACY_WEB_ALL))
    const bad = run()
    assert.equal(bad.status, 1)
    assert.match(bad.stdout, /\[dsh-local-ops\] FAIL client-id-legacy/)
  } finally { fx.cleanup() }
})

/** A profile still carrying the legacy identity, with a legacy checkout and link. */
function makeLegacyFixture() {
  const fx = makeFixture()
  const oldPkg = join(fx.root, 'old', 'dsh-web-all')
  makeWebAllPackage(oldPkg, LEGACY_WEB_ALL, LEGACY_WEB_ALL)
  const path = join(fx.webDir, 'package.json')
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  pkg.dependencies = { first: '1.0.0', [LEGACY_WEB_ALL]: `link:${oldPkg}`, last: '2.0.0' }
  pkg.dsh.profile.bundles = ['@deepseek-ai/dsh-base', LEGACY_WEB_ALL, '@deepseek-ai/dsh-subagent-codex']
  writeFileSync(path, JSON.stringify(pkg, null, 2))
  rmSync(join(fx.webDir, 'node_modules', '@dsh-cove'), { recursive: true, force: true })
  link(oldPkg, join(fx.webDir, 'node_modules', '@zcx', 'dsh-web-all'))
  return { ...fx, oldPkg, pkgPath: path }
}

test('rewriteProfilePackage swaps the name in place and prefers the repo link over a legacy checkout', () => {
  const fx = makeLegacyFixture()
  try {
    const pkg = JSON.parse(readFileSync(fx.pkgPath, 'utf8'))
    const result = rewriteProfilePackage(pkg, { repoRoot: fx.repoRoot, webDir: fx.webDir })
    assert.equal(result.changed, true)
    assert.deepEqual(Object.keys(result.pkg.dependencies), ['first', WEB_ALL, 'last'])
    assert.equal(result.pkg.dependencies[WEB_ALL], `link:${fx.repoPkg}`)
    assert.deepEqual(result.pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', WEB_ALL, '@deepseek-ai/dsh-subagent-codex'])
    assert.ok(pkg.dependencies[LEGACY_WEB_ALL], 'input is not mutated')
  } finally { fx.cleanup() }
})

test('rewriteProfilePackage keeps an existing link when it targets the new package and dedupes bundles', () => {
  const fx = makeLegacyFixture()
  try {
    const alt = join(fx.root, 'alt', 'dsh-web-all')
    makeWebAllPackage(alt, WEB_ALL, WEB_ALL)
    const pkg = {
      dependencies: { [LEGACY_WEB_ALL]: `link:${alt}` },
      dsh: { profile: { bundles: [WEB_ALL, LEGACY_WEB_ALL] } },
    }
    const result = rewriteProfilePackage(pkg, { repoRoot: fx.repoRoot, webDir: fx.webDir })
    assert.equal(result.pkg.dependencies[WEB_ALL], `link:${alt}`)
    assert.deepEqual(result.pkg.dsh.profile.bundles, [WEB_ALL])
    assert.equal(result.linkDir, alt)
  } finally { fx.cleanup() }
})

test('rewriteProfilePackage leaves a clean profile unchanged', () => {
  const fx = makeFixture()
  try {
    const pkg = JSON.parse(readFileSync(join(fx.webDir, 'package.json'), 'utf8'))
    const result = rewriteProfilePackage(pkg, { repoRoot: fx.repoRoot, webDir: fx.webDir })
    assert.equal(result.changed, false)
    assert.deepEqual(planMigration({ dshHome: fx.dshHome, repoRoot: fx.repoRoot }).actions, [])
  } finally { fx.cleanup() }
})

test('migrate plan is read-only and apply repairs the profile so the audit passes', () => {
  const fx = makeLegacyFixture()
  try {
    assert.equal(hasFailure(auditLocalOps({ dshHome: fx.dshHome, home: fx.home })), true)
    const before = readFileSync(fx.pkgPath, 'utf8')
    const plan = planMigration({ dshHome: fx.dshHome, repoRoot: fx.repoRoot, stamp: '20260101-000000' })
    assert.equal(plan.stale, true)
    assert.equal(readFileSync(fx.pkgPath, 'utf8'), before, 'planning writes nothing')
    assert.ok(plan.actions.some((a) => a.type === 'backup' && a.to.endsWith('package.json.bak-20260101-000000')))

    applyPlan(plan)
    assert.equal(readFileSync(`${fx.pkgPath}.bak-20260101-000000`, 'utf8'), before)
    assert.equal(existsSync(join(fx.webDir, 'node_modules', '@zcx')), false)
    assert.equal(lstatSync(join(fx.webDir, 'node_modules', '@dsh-cove', 'dsh-web-all')).isSymbolicLink(), true)
    const findings = auditLocalOps({ dshHome: fx.dshHome, home: fx.home })
    assert.equal(hasFailure(findings), false, JSON.stringify(findings))
    assert.equal(planMigration({ dshHome: fx.dshHome, repoRoot: fx.repoRoot }).stale, false, 'idempotent')
  } finally { fx.cleanup() }
})

test('apply retires the whole @zcx scope with contents intact', () => {
  const fx = makeFixture()
  try {
    const legacyDir = join(fx.webDir, 'node_modules', '@zcx', 'dsh-web-all')
    mkdirSync(legacyDir, { recursive: true })
    const marker = join(legacyDir, 'keep-me.txt')
    writeFileSync(marker, 'payload')
    const plan = planMigration({ dshHome: fx.dshHome, repoRoot: fx.repoRoot, stamp: '20260202-030405' })
    assert.ok(plan.actions.some((a) => a.type === 'retire' && a.to.endsWith('@zcx.retired-20260202-030405')))
    applyPlan(plan)
    assert.equal(existsSync(join(fx.webDir, 'node_modules', '@zcx')), false)
    const retired = join(fx.webDir, 'node_modules', '@zcx.retired-20260202-030405', 'dsh-web-all')
    assert.equal(readFileSync(join(retired, 'keep-me.txt'), 'utf8'), 'payload')
  } finally { fx.cleanup() }
})

test('apply leaves a real @dsh-cove directory untouched', () => {
  const fx = makeLegacyFixture()
  try {
    const linkPath = join(fx.webDir, 'node_modules', '@dsh-cove', 'dsh-web-all')
    rmSync(linkPath, { force: true })
    mkdirSync(linkPath, { recursive: true })
    writeFileSync(join(linkPath, 'manual-install.txt'), 'stay')
    const plan = planMigration({ dshHome: fx.dshHome, repoRoot: fx.repoRoot, stamp: '20260303-000000' })
    assert.ok(plan.actions.some((a) => a.type === 'note' && a.describe.includes('left untouched')))
    applyPlan(plan)
    assert.equal(readFileSync(join(linkPath, 'manual-install.txt'), 'utf8'), 'stay')
  } finally { fx.cleanup() }
})

test('apply relink replaces a wrong @dsh-cove symlink', () => {
  const fx = makeLegacyFixture()
  try {
    const linkPath = join(fx.webDir, 'node_modules', '@dsh-cove', 'dsh-web-all')
    const wrong = join(fx.root, 'wrong-target')
    makeWebAllPackage(wrong, WEB_ALL, WEB_ALL)
    rmSync(linkPath, { force: true })
    link(wrong, linkPath)
    const plan = planMigration({ dshHome: fx.dshHome, repoRoot: fx.repoRoot, stamp: '20260404-000000' })
    assert.ok(plan.actions.some((a) => a.type === 'symlink' && a.replace === true))
    applyPlan(plan)
    assert.equal(realpathSync(linkPath), realpathSync(fx.repoPkg))
  } finally { fx.cleanup() }
})

test('apply retires the whole @zcx scope when sibling legacy packages remain', () => {
  const fx = makeLegacyFixture()
  try {
    const scopeDir = join(fx.webDir, 'node_modules', '@zcx')
    write(join(scopeDir, 'other-package', 'package.json'), JSON.stringify({ name: '@zcx/other' }))
    const plan = planMigration({ dshHome: fx.dshHome, repoRoot: fx.repoRoot, stamp: '20260505-000000' })
    applyPlan(plan)
    assert.equal(existsSync(scopeDir), false)
    const retired = join(fx.webDir, 'node_modules', '@zcx.retired-20260505-000000')
    assert.equal(existsSync(join(retired, 'dsh-web-all')), true)
    assert.equal(existsSync(join(retired, 'other-package')), true)
    assert.equal(hasFailure(auditLocalOps({ dshHome: fx.dshHome, home: fx.home })), false)
  } finally { fx.cleanup() }
})

test('migrate CLI dry-run changes nothing and --apply rewrites the profile', () => {
  const fx = makeLegacyFixture()
  try {
    const env = { ...process.env, HOME: fx.home, DSH_HOME: fx.dshHome }
    const script = join(SCRIPTS, 'dsh-local-profile-migrate.mjs')
    const before = readFileSync(fx.pkgPath, 'utf8')
    const dry = spawnSync(process.execPath, [script], { env, encoding: 'utf8' })
    assert.equal(dry.status, 0, dry.stdout + dry.stderr)
    assert.match(dry.stdout, /dry run complete/)
    assert.equal(readFileSync(fx.pkgPath, 'utf8'), before)
    assert.equal(readdirSync(dirname(fx.pkgPath)).some((f) => f.includes('.bak-')), false)

    const applied = spawnSync(process.execPath, [script, '--apply', '--no-link-profile'], { env, encoding: 'utf8' })
    assert.equal(applied.status, 0, applied.stdout + applied.stderr)
    assert.match(applied.stdout, /restarted by the user/)
    const pkg = JSON.parse(readFileSync(fx.pkgPath, 'utf8'))
    assert.equal(pkg.dependencies[LEGACY_WEB_ALL], undefined)
    assert.ok(pkg.dependencies[WEB_ALL])
    assert.equal(readdirSync(dirname(fx.pkgPath)).some((f) => /^package\.json\.bak-\d{8}-\d{6}$/.test(f)), true)
  } finally { fx.cleanup() }
})
