/**
 * The rollout plan is the only thing standing between a merge and a fleet of
 * machines: it decides what gets installed, where, and how the machine is
 * restarted. These tests pin the decisions that must not drift silently —
 * especially that the plan is inert without `--apply`, that a version must be
 * exact (a range would install whatever is newest), and that the restart target
 * is discovered instead of guessed.
 *
 *   node --test scripts/dsh-fleet-rollout.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPlan,
  entryUrl,
  normalizeVersion,
  parseArgs,
  restartCommand,
  versionProbeCommand,
} from './dsh-fleet-rollout.mjs'

const SCOPE = {
  dshHome: '~/.dsh',
  surfaces: {},
  machines: [],
  checkouts: null,
  limits: {},
  baseline: null,
}

test('parses the documented flags and defaults to a plan', () => {
  const options = parseArgs(['--version', '0.6.0', '--only', 'pc-tower'])
  assert.equal(options.version, '0.6.0')
  assert.deepEqual(options.only, ['pc-tower'])
  assert.equal(options.apply, false)
})

test('rejects an unknown flag instead of ignoring it', () => {
  assert.throws(() => parseArgs(['--versoin', '0.6.0']), /unknown option/u)
  assert.throws(() => parseArgs(['--version']), /missing value/u)
})

test('accepts only an exact version', () => {
  assert.equal(normalizeVersion('0.6.0'), '0.6.0')
  assert.equal(normalizeVersion('v0.6.0'), '0.6.0')
  assert.equal(normalizeVersion('0.6.0-rc.1'), '0.6.0-rc.1')
  for (const bad of ['', 'latest', '^0.6', '0.6', '~0.6.0', 'file:../pkg']) {
    assert.throws(() => normalizeVersion(bad), /exact version|required/u)
  }
})

test('discovers the restart target instead of hard-coding a unit name', () => {
  const linux = restartCommand({ os: 'linux' })
  assert.equal(linux.kind, 'systemd-user')
  assert.match(linux.detect, /systemctl --user list-unit-files/u)
  assert.match(linux.restart('dsh-web.service'), /systemctl --user restart dsh-web\.service/u)

  const mac = restartCommand({ os: 'darwin' })
  assert.equal(mac.kind, 'launchd')
  assert.match(mac.restart('ai.deepseek.dsh.web'), /launchctl kickstart -k gui\//u)

  assert.equal(restartCommand({ os: 'windows' }), null)
})

test('builds the canonical browser entry from the netbird name', () => {
  assert.equal(entryUrl({ netbirdName: 'pc-tower' }), 'http://dsh.pc-tower.netbird/')
  assert.equal(entryUrl({}), null)
})

test('plans one install per declared profile and nothing else', () => {
  const plan = buildPlan({ name: 'pc-tower', ssh: 'nb-pc-tower', os: 'linux', rolloutProfiles: ['web'] }, SCOPE, '0.6.0')
  assert.deepEqual(plan.install, ['dsh plugin --profile web add @dsh-cove/dsh-web-all@0.6.0'])
  assert.equal(plan.version, '0.6.0')
  assert.equal(plan.local, false)
  assert.equal(plan.entry, null, 'no netbird name means no entry probe')
})

test('keeps a machine without declared profiles inert', () => {
  const plan = buildPlan({ name: 'zcx-mbp', ssh: 'nb-zcx-mbp', os: 'darwin' }, SCOPE, '0.6.0')
  assert.deepEqual(plan.install, ['(no rolloutProfiles declared for this machine; nothing to install)'])
})

test('expands the dsh home remotely so the probe runs on the machine', () => {
  const plan = buildPlan({ name: 'wq-imac', ssh: 'nb-wq-imac', os: 'darwin', rolloutProfiles: ['web'] }, SCOPE, '0.6.0')
  assert.equal(plan.dshHome, '$HOME/.dsh')
})

test('the version probe reads the installed manifest and falls back to none', () => {
  const command = versionProbeCommand('$HOME/.dsh/profiles/web')
  assert.ok(command.includes('$HOME/.dsh/profiles/web/node_modules/@dsh-cove/dsh-web-all/package.json'))
  assert.ok(command.includes("'none'"))
  assert.ok(!command.includes('\n'), 'one line, so the remote shell cannot split it')
})
