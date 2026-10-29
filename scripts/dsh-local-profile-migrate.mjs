#!/usr/bin/env node
/**
 * Migrate a machine-local DSH profile from the legacy `@zcx/dsh-web-all`
 * identity to `@dsh-cove/dsh-web-all` with surgical file and symlink edits.
 *
 * Actions, only when stale legacy state exists:
 *   - back up profiles/web/package.json to package.json.bak-<YYYYMMDD-HHMMSS>
 *   - rewrite dependencies and dsh.profile.bundles to the new name
 *   - move the entire stale `node_modules/@zcx` scope to
 *     `node_modules/@zcx.retired-<stamp>` when it still contains packages
 *   - ensure profiles/web/node_modules/@dsh-cove/dsh-web-all links to the
 *     repository package
 *   - refresh family links via scripts/link-profile.mjs
 *
 * `dsh plugin add` is deliberately not used (optional-dependency installs can
 * hang on mirrors), and the running DSH service is never restarted; the user
 * restarts it after --apply.
 *
 * Usage:
 *   node scripts/dsh-local-profile-migrate.mjs                 # dry run
 *   node scripts/dsh-local-profile-migrate.mjs --apply         # write
 *   node scripts/dsh-local-profile-migrate.mjs --apply --no-link-profile
 *
 * Environment: DSH_HOME (default ~/.dsh), HOME.
 */
import {
  constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LEGACY_WEB_ALL, WEB_ALL, isPackage } from './dsh-local-ops-audit.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = resolvePath(SCRIPT_DIR, '..')
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']

function report(msg) {
  console.log(`[dsh-local-migrate] ${msg}`)
}

/** `YYYYMMDD-HHMMSS` in local time. */
export function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

function entryAt(path) {
  try { return lstatSync(path) } catch { return null }
}

/** Absolute directory of a `link:`/`file:` spec, or null for other specs. */
function linkSpecDir(spec, webDir) {
  if (typeof spec !== 'string') return null
  const match = /^(?:link|file):(.*)$/.exec(spec)
  if (!match) return null
  return isAbsolute(match[1]) ? match[1] : resolvePath(webDir, match[1])
}

function packageNameAt(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name } catch { return null }
}

/**
 * Whether the profile package.json still carries legacy identity.
 * @param {object} pkg
 */
export function hasLegacyPackageState(pkg) {
  const bundles = pkg?.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.some((e) => isPackage(e, LEGACY_WEB_ALL))) return true
  return DEP_FIELDS.some((f) => pkg?.[f] && Object.hasOwn(pkg[f], LEGACY_WEB_ALL))
}

/**
 * Pure rewrite of a profile package.json object. Does not touch the input.
 * @param {object} pkg parsed profiles/web/package.json
 * @param {{ repoRoot?: string, webDir?: string }} [options]
 * @returns {{ pkg: object, changed: boolean, linkDir: string, notes: string[] }}
 *   linkDir is the directory the @dsh-cove dependency links to.
 */
export function rewriteProfilePackage(pkg, { repoRoot = DEFAULT_REPO_ROOT, webDir = '.' } = {}) {
  const next = structuredClone(pkg)
  const notes = []
  const repoPackageDir = join(repoRoot, 'packages', 'dsh-web-all')
  let linkDir = repoPackageDir

  if (!hasLegacyPackageState(pkg)) {
    const existing = linkSpecDir(pkg?.dependencies?.[WEB_ALL], webDir)
    return { pkg: next, changed: false, linkDir: existing ?? repoPackageDir, notes }
  }

  const deps = next.dependencies ?? {}
  const hadLegacyDep = Object.hasOwn(deps, LEGACY_WEB_ALL)
  const hadCurrentDep = Object.hasOwn(deps, WEB_ALL)

  // Prefer an existing link target only when it really is the @dsh-cove package;
  // an old checkout still named @zcx would reproduce the failure.
  let spec = null
  for (const candidate of [deps[WEB_ALL], deps[LEGACY_WEB_ALL]]) {
    const dir = linkSpecDir(candidate, webDir)
    if (dir && packageNameAt(dir) === WEB_ALL) {
      spec = candidate
      linkDir = dir
      break
    }
  }
  if (spec === null) spec = `link:${repoPackageDir}`

  if (hadLegacyDep || !hadCurrentDep) {
    const rebuilt = {}
    let placed = false
    for (const [key, value] of Object.entries(deps)) {
      if (key === LEGACY_WEB_ALL) {
        if (!placed) { rebuilt[WEB_ALL] = spec; placed = true }
        continue
      }
      if (key === WEB_ALL) {
        if (!placed) { rebuilt[WEB_ALL] = spec; placed = true }
        continue
      }
      rebuilt[key] = value
    }
    if (!placed) rebuilt[WEB_ALL] = spec
    next.dependencies = rebuilt
    notes.push(`dependencies: ${hadLegacyDep ? `remove ${LEGACY_WEB_ALL}, ` : ''}set ${WEB_ALL} = ${spec}`)
  }

  for (const field of ['devDependencies', 'optionalDependencies']) {
    if (next[field] && Object.hasOwn(next[field], LEGACY_WEB_ALL)) {
      delete next[field][LEGACY_WEB_ALL]
      notes.push(`${field}: remove ${LEGACY_WEB_ALL}`)
    }
  }

  const bundles = next.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.some((e) => isPackage(e, LEGACY_WEB_ALL))) {
    const rebuilt = []
    let seen = false
    for (const entry of bundles) {
      if (isPackage(entry, LEGACY_WEB_ALL) || isPackage(entry, WEB_ALL)) {
        if (!seen) { rebuilt.push(WEB_ALL); seen = true }
        continue
      }
      rebuilt.push(entry)
    }
    next.dsh.profile.bundles = rebuilt
    notes.push(`bundles: replace ${LEGACY_WEB_ALL} with ${WEB_ALL}`)
  }

  return { pkg: next, changed: true, linkDir, notes }
}

/**
 * Build the ordered action list for a DSH home. No writes.
 * @param {{ dshHome: string, repoRoot?: string, stamp?: string }} options
 */
export function planMigration({ dshHome, repoRoot = DEFAULT_REPO_ROOT, stamp = timestamp() }) {
  const profilesDir = join(dshHome, 'profiles')
  const webDir = join(profilesDir, 'web')
  const pkgPath = join(webDir, 'package.json')
  const actions = []
  if (!existsSync(pkgPath)) return { error: `${pkgPath} does not exist`, actions, stale: false, linkDir: null }

  let pkg
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch (error) {
    return { error: `cannot parse ${pkgPath}: ${error.message}`, actions, stale: false, linkDir: null }
  }

  const rewrite = rewriteProfilePackage(pkg, { repoRoot, webDir })
  const staleScopes = [webDir, profilesDir]
    .map((base) => join(base, 'node_modules', '@zcx'))
    .filter((scopePath) => {
      const st = entryAt(scopePath)
      if (!st?.isDirectory()) return false
      try { return readdirSync(scopePath).length > 0 } catch { return false }
    })
  const stale = rewrite.changed || staleScopes.length > 0
  if (!stale) return { actions, stale: false, linkDir: rewrite.linkDir }

  if (rewrite.changed) {
    const backup = `${pkgPath}.bak-${stamp}`
    actions.push({ type: 'backup', from: pkgPath, to: backup, describe: `back up package.json -> ${backup}` })
    actions.push({ type: 'write-package', path: pkgPath, pkg: rewrite.pkg, describe: `rewrite ${pkgPath}: ${rewrite.notes.join('; ')}` })
  }

  for (const scopePath of staleScopes) {
    const retired = join(dirname(scopePath), `@zcx.retired-${stamp}`)
    actions.push({ type: 'retire', from: scopePath, to: retired, describe: `move legacy scope ${scopePath} -> ${retired}` })
  }

  const linkParent = join(webDir, 'node_modules', '@dsh-cove')
  const linkPath = join(linkParent, 'dsh-web-all')
  const target = relative(linkParent, rewrite.linkDir)
  const existing = entryAt(linkPath)
  if (!existing) {
    actions.push({ type: 'symlink', path: linkPath, target, describe: `link ${linkPath} -> ${target}` })
  } else if (existing.isSymbolicLink()) {
    let current = null
    try { current = realpathSync(linkPath) } catch {}
    if (current !== safeRealpath(rewrite.linkDir)) {
      actions.push({ type: 'symlink', path: linkPath, target, replace: true, describe: `relink ${linkPath} -> ${target}` })
    }
  } else {
    actions.push({ type: 'note', describe: `${linkPath} is a real directory; left untouched` })
  }

  return { actions, stale: true, linkDir: rewrite.linkDir }
}

function safeRealpath(path) {
  try { return realpathSync(path) } catch { return path }
}

/** Copy a backup; if the target already exists, append a short random suffix. */
function backupExclusive(from, to) {
  try {
    copyFileSync(from, to, constants.COPYFILE_EXCL)
    return to
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const alt = `${to}-${randomBytes(4).toString('hex')}`
    copyFileSync(from, alt, constants.COPYFILE_EXCL)
    return alt
  }
}

/** Execute planned actions. Returns the number of actions applied. */
export function applyPlan(plan) {
  let applied = 0
  for (const action of plan.actions) {
    switch (action.type) {
      case 'backup':
        backupExclusive(action.from, action.to)
        break
      case 'write-package':
        writeFileSync(action.path, `${JSON.stringify(action.pkg, null, 2)}\n`)
        break
      case 'remove-link':
        unlinkSync(action.path)
        break
      case 'retire':
        renameSync(action.from, action.to)
        break
      case 'rmdir-if-empty':
        try {
          if (existsSync(action.path) && readdirSync(action.path).length === 0) rmdirSync(action.path)
        } catch {}
        break
      case 'symlink':
        mkdirSync(dirname(action.path), { recursive: true })
        if (action.replace) unlinkSync(action.path)
        symlinkSync(action.target, action.path)
        break
      default:
        continue
    }
    applied++
  }
  return applied
}

function runLinkProfile(repoRoot, home) {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'link-profile.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, HOME: home },
  })
  if (result.status !== 0) report(`link-profile exited with status ${result.status}`)
  return result.status === 0
}

function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const skipLinkProfile = argv.includes('--no-link-profile')
  const home = process.env.HOME || homedir()
  const dshHome = process.env.DSH_HOME || join(home, '.dsh')

  report(`DSH_HOME=${dshHome} (${apply ? 'apply' : 'dry run; pass --apply to write'})`)
  const plan = planMigration({ dshHome })
  if (plan.error) {
    report(plan.error)
    process.exit(1)
  }
  if (!plan.stale) {
    report(`no legacy ${LEGACY_WEB_ALL} or @zcx scope state found; nothing to migrate`)
    process.exit(0)
  }

  for (const action of plan.actions) report(`${apply ? 'apply' : 'would'}: ${action.describe}`)
  if (!apply) {
    report('dry run complete; no files were changed')
    process.exit(0)
  }

  const applied = applyPlan(plan)
  report(`${applied} action(s) applied`)

  const defaultHome = join(home, '.dsh')
  if (skipLinkProfile) {
    report('link-profile skipped (--no-link-profile)')
  } else if (resolvePath(dshHome) !== resolvePath(defaultHome)) {
    report(`link-profile skipped: it targets ${defaultHome}, DSH_HOME is ${dshHome}`)
  } else {
    runLinkProfile(DEFAULT_REPO_ROOT, home)
  }

  report('done. The managed DSH service must be restarted by the user for the change to take effect; this script does not restart it.')
  report('next: node scripts/dsh-local-ops-audit.mjs')
}

if (resolvePath(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main()
}
