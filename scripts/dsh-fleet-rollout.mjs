#!/usr/bin/env node
/**
 * Fleet rollout: move the machines to one published `@dsh-cove/dsh-web-all`
 * version and prove it landed.
 *
 * This is the return leg of [fleet collection](../../docs/fleet-collection.md):
 * a merged improvement reaches a machine as a package version, never as a copied
 * directory. For each target profile the script asks the DSH CLI to install the
 * version (the same `dsh plugin add` path a user takes), restarts the machine's
 * own `dsh web` unit, and then verifies two independent facts: the installed
 * package version on disk, and the machine's browser entry answering.
 *
 * Restarting somebody else's `dsh web` interrupts live sessions, so the default
 * is a plan, not an action: `--apply` is required to touch a machine, and
 * `--only` narrows the blast radius to one machine at a time.
 *
 * Usage:
 *   node scripts/dsh-fleet-rollout.mjs --version 0.6.0                 # plan only
 *   node scripts/dsh-fleet-rollout.mjs --version 0.6.0 --apply --only pc-tower
 *   node scripts/dsh-fleet-rollout.mjs --version 0.6.0 --json          # machine-readable plan
 *
 * Exit: 0 every requested machine is at the version and answers, 1 at least one
 * machine failed, 2 usage or scope error.
 */
import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { loadScope, expandHome } from './dsh-fleet-collect.mjs'

const execFileAsync = promisify(execFile)

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Parses `--flag value` options; unknown flags are a usage error. */
export function parseArgs(argv) {
  const options = { version: null, apply: false, only: [], json: false, scope: null, skipRestart: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      if (argv[i + 1] === undefined) throw new Error(`missing value for ${arg}`)
      i += 1
      return argv[i]
    }
    switch (arg) {
      case '--version':
        options.version = next()
        break
      case '--scope':
        options.scope = next()
        break
      case '--only':
        options.only.push(next())
        break
      case '--apply':
        options.apply = true
        break
      case '--skip-restart':
        options.skipRestart = true
        break
      case '--json':
        options.json = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown option: ${arg}`)
    }
  }
  return options
}

/** `0.6.0` and `v0.6.0` name the same release; a range would install something else. */
export function normalizeVersion(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--version is required (an exact version such as 0.6.0)')
  }
  const trimmed = value.trim().replace(/^v/u, '')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(trimmed)) {
    throw new Error(`--version must be an exact version, got ${value}`)
  }
  return trimmed
}

/**
 * Restart target per OS. The service name is machine-local (systemd user units
 * are named by whoever installed them), so the plan says how it will be found
 * rather than guessing a unit that may not exist.
 */
export function restartCommand(machine) {
  const declared = machine.service
  if (declared && declared.kind === 'none') return { kind: 'none', detect: 'true', extract: () => null, restart: () => 'true' }
  if (declared && declared.target) {
    if (declared.kind === 'systemd-user') {
      return {
        kind: 'systemd-user',
        target: declared.target,
        detect: `printf '%s' ${declared.target}`,
        extract: (stdout) => stdout.trim() || null,
        restart: (unit) => `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart ${unit}`,
      }
    }
    if (declared.kind === 'systemd-system') {
      return {
        kind: 'systemd-system',
        target: declared.target,
        detect: `printf '%s' ${declared.target}`,
        extract: (stdout) => stdout.trim() || null,
        // `-n` fails fast instead of hanging on a password prompt.
        restart: (unit) => `sudo -n systemctl restart ${unit}`,
      }
    }
    if (declared.kind === 'launchd') {
      return {
        kind: 'launchd',
        target: declared.target,
        detect: `printf '%s' ${declared.target}`,
        extract: (stdout) => stdout.trim() || null,
        restart: (label) => `launchctl kickstart -k gui/$(id -u)/${label}`,
      }
    }
  }
  const os = (machine.os || '').toLowerCase()
  if (os === 'linux') {
    return {
      kind: 'systemd-user',
      detect: 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user list-unit-files --no-legend | grep -iE "dsh.*web|web.*dsh" | head -1',
      // `systemctl` prints `<unit> <state>`; the unit is the first column.
      extract: (stdout) => (stdout.trim().split(/\s+/u)[0] || null),
      restart: (unit) => `systemctl --user restart ${unit}`,
    }
  }
  if (os === 'darwin') {
    return {
      kind: 'launchd',
      detect: 'launchctl list | grep -i dsh | head -1',
      // `launchctl list` prints `<pid> <status> <label>`; the label is last.
      extract: (stdout) => (stdout.trim().split(/\s+/u).pop() || null),
      restart: (label) => `launchctl kickstart -k gui/$(id -u)/${label}`,
    }
  }
  return null
}

/** The browser entry that must answer after a rollout. */
export function entryUrl(machine) {
  if (!machine.netbirdName) return null
  return `http://dsh.${machine.netbirdName}.netbird/`
}

function runLocal(command, { timeout = 60_000 } = {}) {
  return execFileAsync('/bin/sh', ['-c', command], { timeout, maxBuffer: 4 * 1024 * 1024 })
    .then((result) => ({ ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() }))
    .catch((error) => ({
      ok: false,
      stdout: (error.stdout || '').trim(),
      stderr: (error.stderr || error.message || '').trim(),
    }))
}

function runRemote(machine, command, { timeout = 120_000 } = {}) {
  if (machine.local) return runLocal(command, { timeout })
  return execFileAsync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', machine.ssh, command],
    { timeout, maxBuffer: 4 * 1024 * 1024 },
  )
    .then((result) => ({ ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() }))
    .catch((error) => ({
      ok: false,
      stdout: (error.stdout || '').trim(),
      stderr: (error.stderr || error.message || '').trim(),
    }))
}

/** Installed version of the package in one profile, or `none`. */
export function versionProbeCommand(profileDir) {
  const file = `${profileDir}/node_modules/@dsh-cove/dsh-web-all/package.json`
  // Double quotes so a remote `$HOME` expands on the machine, not on the operator.
  return `node -e "try{process.stdout.write(require(process.argv[1]).version)}catch(e){process.stdout.write('none')}" "${file}"`
}

/**
 * Builds the per-machine plan: which profiles move, which command installs, and
 * which unit the restart will target. Pure enough to test without SSH.
 */
export function buildPlan(machine, scope, version) {
  const dshHome = expandHome(scope.dshHome, { remote: true })
  const profiles = machine.rolloutProfiles && machine.rolloutProfiles.length > 0 ? machine.rolloutProfiles : null
  const restart = restartCommand(machine)
  return {
    name: machine.name,
    ssh: machine.ssh || null,
    local: machine.local === true,
    dshHome,
    version,
    profiles,
    install: profiles
      ? profiles.map(
          (profile) =>
            `${machine.pathPrefix ? `PATH=${machine.pathPrefix}:$PATH ` : ''}${machine.dshPath || 'dsh'} plugin --profile ${profile} add @dsh-cove/dsh-web-all@${version}`,
        )
      : ['(no rolloutProfiles declared for this machine; nothing to install)'],
    restart,
    entry: entryUrl(machine),
  }
}

function formatPlan(plan) {
  const lines = [`${plan.name} (${plan.ssh || 'local'}) -> ${plan.version}`]
  for (const command of plan.install) lines.push(`  install: ${command}`)
  if (plan.restart) lines.push(`  restart: ${plan.restart.kind} (${plan.restart.detect})`)
  else lines.push('  restart: none (unknown OS)')
  if (plan.entry) lines.push(`  verify: ${plan.entry}`)
  return lines.join('\n')
}

/** Polls one entry until it answers 200/302, or reports the last status it saw. */
export async function waitForEntry(url, { attempts = 20, intervalMs = 3000 } = {}) {
  let status = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = await runLocal(`curl -s -o /dev/null -w '%{http_code}' --max-time 8 ${url}`)
    status = probe.stdout || null
    if (/^(200|302)$/u.test(status || '')) return status
    await new Promise((done) => setTimeout(done, intervalMs))
  }
  return status
}

async function verifyMachine(machine, scope, version) {
  // The probe runs on the machine, so a remote machine needs `$HOME` rather than
  // the operator's own absolute path.
  const dshHome = expandHome(scope.dshHome, { remote: !machine.local })
  const result = { installed: {}, entry: null, ok: false, notes: [] }
  for (const profile of machine.rolloutProfiles || []) {
    const probe = await runRemote(machine, versionProbeCommand(`${dshHome}/profiles/${profile}`), { timeout: 30_000 })
    result.installed[profile] = probe.ok ? probe.stdout : `probe-failed: ${probe.stderr}`
  }
  // The operator's own machine is reached over loopback: its nginx virtual host
  // is keyed by the canonical authority, so probing the overlay address from the
  // host itself can answer outside that host block.
  const url = machine.local ? 'http://127.0.0.1:3080/' : entryUrl(machine)
  if (url) {
    // A restarted service answers 502 until its own listen happens; the rollout is
    // only meaningful once the entry it broke has come back.
    const probe = await waitForEntry(url)
    result.entry = { url, status: probe }
    result.ok = Object.values(result.installed).every((value) => value === version) && /^(200|302)$/u.test(probe || '')
  } else {
    result.ok = Object.values(result.installed).every((value) => value === version)
    result.notes.push('no netbirdName: entry probe skipped')
  }
  return result
}

export async function main(argv = process.argv.slice(2), { env = process.env } = {}) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`fleet-rollout: ${error.message}`)
    return 2
  }
  if (options.help) {
    console.log('Usage: node scripts/dsh-fleet-rollout.mjs --version X.Y.Z [--apply] [--only NAME] [--json]')
    return 0
  }
  let version
  try {
    version = normalizeVersion(options.version)
  } catch (error) {
    console.error(`fleet-rollout: ${error.message}`)
    return 2
  }
  let loaded
  try {
    loaded = loadScope({ env, options })
  } catch (error) {
    console.error(`fleet-rollout: ${error.message}`)
    return 2
  }
  const { scope, source } = loaded
  if (source === 'template') {
    console.error('fleet-rollout: using the example scope; provide config/fleet-collect.local.json')
    return 2
  }
  const requested = options.only.length > 0 ? new Set(options.only) : null
  const machines = scope.machines.filter((machine) => !requested || requested.has(machine.name))
  if (machines.length === 0) {
    console.error(`fleet-rollout: no machine matched --only ${[...requested].join(',')}`)
    return 2
  }

  const report = { version, apply: options.apply, source, startedAt: new Date().toISOString(), machines: [] }
  for (const machine of machines) {
    const plan = buildPlan(machine, scope, version)
    const record = { plan, actions: [], verification: null, ok: false, error: null }
    if (!options.json) console.log(formatPlan(plan))
    if (options.apply) {
      if (!plan.profiles) {
        record.error = 'no rolloutProfiles declared'
      } else {
        for (const command of plan.install) {
          const result = await runRemote(machine, command)
          record.actions.push({ command, ok: result.ok, output: (result.stdout || result.stderr).slice(0, 2000) })
          if (!options.json) console.log(`  ${result.ok ? 'ok' : 'FAIL'}: ${command}`)
          if (!result.ok) break
        }
        const failedInstall = record.actions.some((action) => !action.ok)
        if (!failedInstall && plan.restart && !options.skipRestart) {
          const detect = await runRemote(machine, plan.restart.detect, { timeout: 30_000 })
          const target = plan.restart.extract(detect.stdout || '')
          if (!target) {
            record.error = 'could not detect the dsh web service unit'
          } else {
            const command = plan.restart.restart(target)
            const result = await runRemote(machine, command, { timeout: 60_000 })
            record.actions.push({ command, ok: result.ok, output: (result.stdout || result.stderr).slice(0, 2000) })
            if (!options.json) console.log(`  ${result.ok ? 'ok' : 'FAIL'}: ${command}`)
          }
        }
        record.verification = await verifyMachine(machine, scope, version)
        record.ok = !record.error && record.verification.ok && record.actions.every((action) => action.ok)
      }
    } else {
      record.verification = await verifyMachine(machine, scope, version)
      record.ok = record.verification.ok
    }
    report.machines.push(record)
  }
  report.finishedAt = new Date().toISOString()

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log('')
    for (const machine of report.machines) {
      const installed = Object.entries(machine.verification?.installed || {})
        .map(([profile, found]) => `${profile}=${found}`)
        .join(' ')
      console.log(
        `${machine.ok ? 'ok  ' : 'FAIL'} ${machine.plan.name}: installed ${installed || '-'} entry ${machine.verification?.entry?.status ?? '-'}${machine.error ? ` (${machine.error})` : ''}`,
      )
    }
  }
  return report.machines.every((machine) => machine.ok) ? 0 : 1
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exitCode = await main()
