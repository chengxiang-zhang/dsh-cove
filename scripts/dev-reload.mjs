#!/usr/bin/env node
/**
 * dev-reload: apply a host or client build to a running DSH without a restart.
 *
 * Why this exists: `hmr.reconcileProfile()` is the only thing that swaps
 * already-loaded modules (it compares the loaded module files with disk, evicts
 * what changed and restarts the affected Loader entries), and in this deployment
 * nothing calls it on a schedule. Building alone changes files that no process
 * reads again; a restart is the expensive, session-breaking workaround.
 *
 * Measured on 2026-11-06 (0.2.1-rc.5 profile, `@dsh-cove/dsh-web-all` linked):
 *
 * | step                                   | observation                              |
 * | -------------------------------------- | ---------------------------------------- |
 * | `pnpm build`, nothing else             | no reload after 20 s (old string answers) |
 * | `pnpm build` + one valid patch save    | new string answers after 6 s, pid unchanged |
 * | profile save with invalid YAML         | nothing happens (no log line)             |
 *
 * So the trigger this script uses is: append one comment line to the profile
 * patch (a valid edit, atomically), then wait for the running host to log the
 * re-mount. It never writes outside the profile's `cordis.patch.yml`, never
 * signals a process and never restarts anything.
 *
 * Usage:
 *   node scripts/dev-reload.mjs [--profile web] [--home <DSH_HOME>]
 *                               [--probe <url> --expect <regex>]
 *                               [--log <file>] [--no-build]
 *                               [--timeout 30] [--dry-run]
 *
 * A recompose is silent in this deployment's log unless the domain itself says
 * something, so verification is a probe: give `--probe` a URL whose body changes
 * with the code (for client bundles `curl /` and look at the `&rev=` hash) and
 * `--expect` the new marker. The probe is any shell command whose stdout reflects
 * the deployed code (e.g. a curl of a route whose body the change alters). Without a probe the run reports "triggered" and does
 * not claim the reload landed.
 *
 * Exit codes: 0 triggered (and, with a probe, observed), 1 build failed,
 * 2 usage or IO error, 3 a requested probe/evidence did not arrive in time.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Prefix of the comment line every run appends; it is the edit, not evidence. */
export const MARKER_PREFIX = '# dev-reload:'

/** Lines a re-mounted runtime writes; the default evidence the reload landed. */
export const DEFAULT_EVIDENCE = /dsh-lark-inbox: 使用飞书应用|superagent: testHarness|测试台开启|reload plugin at/u

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

/** A stable, sortable stamp for the marker comment. */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/gu, '-')
}

/**
 * Append the marker comment to a patch document.
 * @param text - the current file contents.
 * @param at - the stamp to write.
 * @returns the new contents, with exactly one trailing newline per line.
 */
export function addMarker(text, at) {
  const marker = `${MARKER_PREFIX} ${at}`
  if (text.includes(marker)) return text
  const body = text.endsWith('\n') ? text : `${text}\n`
  return `${body}${marker}\n`
}

/**
 * Drop every marker comment; returns the original document.
 * @param text - the current file contents.
 * @returns the contents without dev-reload comment lines.
 */
export function stripMarkers(text) {
  return text.split('\n').filter(line => !line.startsWith(MARKER_PREFIX)).join('\n')
}

/** Parsed command line; every field has a documented default. */
export function parseArgs(argv, env = process.env) {
  const options = {
    profile: env.DSH_PROFILE ?? 'web',
    home: env.DSH_HOME ?? join(homedir(), '.dsh'),
    log: undefined,
    evidence: undefined,
    probe: undefined,
    expect: undefined,
    build: true,
    timeoutMs: 30_000,
    dryRun: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      index += 1
      return argv[index]
    }
    if (arg === '--profile') options.profile = value()
    else if (arg === '--home') options.home = value()
    else if (arg === '--log') options.log = value()
    else if (arg === '--probe') options.probe = value()
    else if (arg === '--expect') options.expect = value()
    else if (arg === '--evidence') options.evidence = value()
    else if (arg === '--no-build') options.build = false
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--timeout') {
      const seconds = Number(value())
      if (!Number.isFinite(seconds) || seconds <= 0) return { error: `--timeout 需要正数秒，收到 ${String(argv[index])}` }
      options.timeoutMs = Math.round(seconds * 1000)
    } else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `未知参数: ${String(arg)}` }
  }
  if (typeof options.profile !== 'string' || options.profile.trim() === '') return { error: '--profile 不能为空' }
  if (typeof options.home !== 'string' || options.home.trim() === '') return { error: '--home 不能为空' }
  if (options.profile.includes('/') || options.profile.includes('..')) return { error: `--profile 不合法: ${options.profile}` }
  if ((options.probe === undefined) !== (options.expect === undefined)) return { error: '--probe 与 --expect 必须成对出现' }
  if (options.expect !== undefined) {
    try { new RegExp(options.expect, 'u') } catch { return { error: `--expect 不是合法正则: ${options.expect}` } }
  }
  return { options }
}

/** The profile patch this script edits, and the log it reads by default. */
export function pathsFor(options) {
  const home = resolve(options.home)
  return {
    patch: join(home, 'profiles', options.profile, 'cordis.patch.yml'),
    log: options.log === undefined ? join(home, 'logs', 'web.launchd.log') : resolve(options.log),
  }
}

/** How many bytes the log currently holds (0 when it does not exist yet). */
export function logSize(path) {
  try { return statSync(path).size } catch { return 0 }
}

/**
 * Read the log from `offset` and return the first line matching `pattern`.
 * @returns the matching line, or undefined while nothing matched.
 */
export function matchAfter(path, offset, pattern) {
  if (!existsSync(path)) return undefined
  const size = statSync(path).size
  if (size <= offset) return undefined
  const length = size - offset
  const buffer = Buffer.alloc(length)
  const handle = openSync(path, 'r')
  try { readSync(handle, buffer, 0, length, offset) } finally { closeSync(handle) }
  for (const line of buffer.toString('utf8').split('\n')) if (pattern.test(line)) return line
  return undefined
}

/** Atomically replace a file, so a reader never sees a half-written patch. */
function writeAtomic(path, text) {
  const temp = `${path}.dev-reload-${String(process.pid)}`
  writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
}

function usage() {
  return [
    'usage: node scripts/dev-reload.mjs [--profile web] [--home <DSH_HOME>]',
    '                                   [--probe <url> --expect <regex>] [--log <file>]',
    '                                   [--no-build] [--timeout 30] [--dry-run]',
    '',
    'Applies a build to a running DSH by triggering one profile recompose; never restarts.',
  ].join('\n')
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help === true) { console.log(usage()); return 0 }
  if (parsed.error !== undefined) { console.error(parsed.error); console.error(usage()); return 2 }
  const { options } = parsed
  const { patch, log } = pathsFor(options)
  if (!existsSync(patch)) { console.error(`profile patch 不存在: ${patch}`); return 2 }

  if (options.build) {
    console.log('build: pnpm --filter @dsh-cove/dsh-web-all build')
    if (!options.dryRun) {
      const built = spawnSync('pnpm', ['--filter', '@dsh-cove/dsh-web-all', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' })
      if (built.status !== 0) { console.error(`build 失败，退出码 ${String(built.status ?? 'null')}`); return 1 }
    }
  } else {
    console.log('build: skipped (--no-build)')
  }

  const offset = logSize(log)
  const before = readFileSync(patch, 'utf8')
  const after = addMarker(before, stamp())
  console.log(`patch: ${patch}`)
  if (options.probe !== undefined) console.log(`probe: ${options.probe}  expect: ${options.expect}`)
  if (options.dryRun) {
    console.log('dry-run: would append the marker and then wait for the evidence')
    return 0
  }
  writeAtomic(patch, after)
  console.log(`marker appended; waiting up to ${String(Math.round(options.timeoutMs / 1000))}s`)

  const deadline = Date.now() + options.timeoutMs
  let matchedLog
  let matchedProbe
  while (Date.now() < deadline) {
    if (options.probe !== undefined) {
      matchedProbe = probeOnce(options.probe, new RegExp(options.expect, 'u'))
      if (matchedProbe !== undefined) break
    }
    const evidence = options.evidence === undefined ? DEFAULT_EVIDENCE : new RegExp(options.evidence, 'u')
    matchedLog = matchAfter(log, offset, evidence)
    if (matchedLog !== undefined) break
    await new Promise(done => setTimeout(done, 400))
  }
  if (matchedProbe !== undefined) { console.log(`reloaded: probe matched /${String(options.expect)}/`); return 0 }
  if (matchedLog !== undefined) { console.log(`reloaded: ${matchedLog.trim()}`); return 0 }
  if (options.probe === undefined && options.evidence === undefined) {
    // A silent recompose is the normal case for host code here: the trigger landed,
    // but nothing in this deployment logs it. Report the fact, not a verdict.
    console.log('triggered; no probe given, so this run does not claim the new code is loaded')
    return 0
  }
  console.error('没有观测到证据；常见原因：probe 的 URL 不反映新代码、profile 名或 --log 指错、或改动落在进程静态图里（需重启）。')
  if (existsSync(log)) console.error(`日志尾部：\n${readFileSync(log, 'utf8').slice(-1_500)}`)
  return 3
}

/**
 * One probe attempt: run the caller's command and test its output.
 *
 * The probe is a shell command rather than a URL because the thing that changes
 * with host code is often a POST body or a CLI output; a URL-only probe would be
 * limited to whatever a GET happens to render.
 * @param command - shell command whose stdout reflects the deployed code.
 * @param pattern - what the new code prints.
 * @returns the matched output while the new code answers, undefined while the old does.
 */
function probeOnce(command, pattern) {
  const run = spawnSync('bash', ['-lc', command], { encoding: 'utf8', timeout: 10_000 })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  return pattern.test(output) ? output.slice(0, 200) : undefined
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().then(code => { process.exitCode = code }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  })
}