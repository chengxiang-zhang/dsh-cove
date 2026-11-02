/**
 * The collector decides what leaves a machine. Two properties matter more than
 * any other: secret and machine-state files never enter the transfer set, and a
 * scope typo fails loudly instead of producing an empty harvest that looks like
 * "nothing to merge".
 *
 *   node --test scripts/dsh-fleet-collect.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildProbeScript,
  computeTreeDrift,
  expandHome,
  globToRegExp,
  normalizeListing,
  parseArgs,
  parseProbeOutput,
  selectByGlobs,
  selectMachineFiles,
  summarizeProbe,
  surfaceRelativePath,
  validateScope,
} from './dsh-fleet-collect.mjs'

const SCOPE = {
  version: 1,
  dshHome: '~/.dsh',
  surfaces: {
    presets: {
      roots: [{ path: '.agent-presets' }],
      include: ['*/agent.cordis.yml', '*/skills/**'],
      exclude: ['**/evals/results-*/**'],
    },
    profiles: {
      roots: [{ path: 'profiles', maxdepth: 2 }],
      include: ['*/cordis.patch.yml', '*/*.js'],
      exclude: [],
    },
  },
  checkouts: { roots: ['~/code'], maxdepth: 3, originMatch: ['dsh-cove'], diffMaxBytes: 1024 },
  limits: { maxFiles: 10 },
  machines: [
    { name: 'pc-tower', ssh: 'nb-pc-tower', os: 'linux', surfaces: ['presets', 'profiles', 'checkouts'] },
  ],
  baseline: { preset: 'code-vibe', presetDir: 'packages/dsh-web-all/presets/code-vibe' },
}

test('glob matching keeps single-star inside one segment and double-star across segments', () => {
  assert.equal(globToRegExp('*/agent.cordis.yml').test('code-vibe/agent.cordis.yml'), true)
  assert.equal(globToRegExp('*/agent.cordis.yml').test('a/code-vibe/agent.cordis.yml'), false)
  assert.equal(globToRegExp('*/skills/**').test('code-vibe/skills/task-router/SKILL.md'), true)
  assert.equal(globToRegExp('**/evals/results-*/**').test('code-vibe/evals/results-20261029/a.json'), true)
  assert.equal(globToRegExp('**/evals/results-*/**').test('code-vibe/evals/tier-cases.md'), false)
})

test('a file is selected only by the surface that claims it', () => {
  assert.equal(selectByGlobs('code-vibe/agent.cordis.yml', SCOPE.surfaces.presets.include, SCOPE.surfaces.presets.exclude), true)
  assert.equal(selectByGlobs('web/cordis.patch.yml', SCOPE.surfaces.presets.include), false)
  assert.equal(selectByGlobs('web/wish-gate.js', SCOPE.surfaces.profiles.include), true)
})

test('paths are matched relative to their surface root', () => {
  assert.equal(surfaceRelativePath('.agent-presets/code-vibe/skills/a/SKILL.md', SCOPE.surfaces.presets), 'code-vibe/skills/a/SKILL.md')
  assert.equal(surfaceRelativePath('profiles/web/cordis.patch.yml', SCOPE.surfaces.profiles), 'web/cordis.patch.yml')
  assert.equal(surfaceRelativePath('elsewhere/x', SCOPE.surfaces.profiles), null)
})

test('selection reports what the file cap dropped instead of silently truncating', () => {
  const probe = {
    listings: {
      profiles: Array.from({ length: 12 }, (_, index) => `profiles/p${index}/cordis.patch.yml`),
    },
  }
  const machine = { name: 'pc-tower', surfaces: ['profiles'] }
  const scope = { ...SCOPE, surfaces: { profiles: SCOPE.surfaces.profiles }, limits: { maxFiles: 10 } }
  const selection = selectMachineFiles(probe, machine, scope)
  assert.equal(selection.files.length, 10)
  assert.deepEqual(
    selection.dropped.filter((item) => item.reason === 'file-count-cap').length,
    2,
  )
})

test('listing normalization drops absolute and parent paths', () => {
  assert.deepEqual(normalizeListing(['./b', 'a', '/etc/passwd', '../x', '', 'a']), ['a', 'b'])
})

test('the probe script prunes secrets and machine state before listing', () => {
  const script = buildProbeScript(SCOPE, SCOPE.machines[0])
  for (const name of ['.credentials*', '*.pem', '*.key', '.env*', 'sessions', 'storages', 'node_modules']) {
    assert.ok(script.includes(name), `${name} must be pruned`)
  }
  assert.ok(script.includes('cd "$DSH"'), 'listing paths stay relative to the DSH home')
  assert.ok(!script.includes('/home/'), 'no absolute path leaks into the script')
})

test('probe output is split into its sections and interpreted', () => {
  const sections = parseProbeOutput(
    ['SECTION host', 'box', 'SECTION profiles', 'web\t0.5.0', 'SECTION surface.profiles', 'profiles/web/cordis.patch.yml', 'SECTION end'].join('\n'),
  )
  const probe = summarizeProbe(sections)
  assert.equal(probe.host, 'box')
  assert.deepEqual(probe.profiles, { web: '0.5.0' })
  assert.deepEqual(probe.listings.profiles, ['profiles/web/cordis.patch.yml'])
})

test('home expansion differs between the operator and the machine', () => {
  assert.equal(expandHome('~/.dsh', { home: '/Users/op', remote: false }), '/Users/op/.dsh')
  assert.equal(expandHome('~/.dsh', { remote: true }), '$HOME/.dsh')
})

test('scope validation names the broken field', () => {
  assert.throws(() => validateScope({ ...SCOPE, version: 2 }), /unsupported version/u)
  assert.throws(() => validateScope({ ...SCOPE, machines: [] }), /machines must not be empty/u)
  assert.throws(
    () => validateScope({ ...SCOPE, machines: [{ name: 'a', ssh: 'x', surfaces: ['nope'] }] }),
    /unknown surface nope/u,
  )
  assert.throws(() => validateScope({ ...SCOPE, limits: { maxFiles: 0 } }), /limits\.maxFiles/u)
  assert.throws(
    () => validateScope({ ...SCOPE, machines: [{ name: 'a', ssh: 'x' }, { name: 'a', ssh: 'y' }] }),
    /duplicate machine name/u,
  )
})

test('scope validation keeps the distribution facts and rejects a broken profile list', () => {
  const scope = validateScope({
    ...SCOPE,
    machines: [{ name: 'a', ssh: 'x', netbirdName: 'a-host', rolloutProfiles: ['web'] }],
  })
  assert.equal(scope.machines[0].netbirdName, 'a-host')
  assert.deepEqual(scope.machines[0].rolloutProfiles, ['web'])
  assert.throws(
    () => validateScope({ ...SCOPE, machines: [{ name: 'a', ssh: 'x', rolloutProfiles: 'web' }] }),
    /rolloutProfiles/u,
  )
})

test('drift reports added, modified, removed and the empty baseline case', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-drift-'))
  try {
    const harvested = join(root, 'harvested')
    const baseline = join(root, 'baseline')
    mkdirSync(join(harvested, 'skills/a'), { recursive: true })
    mkdirSync(join(baseline, 'skills/a'), { recursive: true })
    writeFileSync(join(harvested, 'skills/a/SKILL.md'), 'new\n')
    writeFileSync(join(baseline, 'skills/a/SKILL.md'), 'old\n')
    mkdirSync(join(harvested, 'skills/b'), { recursive: true })
    writeFileSync(join(harvested, 'skills/b/SKILL.md'), 'only here\n')
    const drift = computeTreeDrift({ harvestedDir: harvested, baselineDir: baseline })
    assert.deepEqual(drift.modified, ['skills/a/SKILL.md'])
    assert.deepEqual(drift.added, ['skills/b/SKILL.md'])
    assert.deepEqual(drift.removed, [])
    assert.equal(drift.baselineMissing, false)

    const empty = computeTreeDrift({ harvestedDir: harvested, baselineDir: join(root, 'missing') })
    assert.equal(empty.baselineMissing, true)
    assert.equal(empty.harvestedFiles, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collector flags are parsed and unknown flags rejected', () => {
  const options = parseArgs(['--only', 'pc-tower', '--dry-run', '--json'])
  assert.deepEqual(options.only, ['pc-tower'])
  assert.equal(options.dryRun, true)
  assert.equal(options.json, true)
  assert.throws(() => parseArgs(['--nope']), /unknown option/u)
})
