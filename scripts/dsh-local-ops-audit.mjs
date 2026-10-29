#!/usr/bin/env node
/**
 * Local DSH operations audit: verifies that the machine-local DSH profile and
 * its launch helpers agree with the repository package identity.
 *
 *   1. `profiles/web/package.json` exists.
 *   2. `dsh.profile.bundles` lists `@dsh-cove/dsh-web-all` exactly once, and
 *      the legacy `@zcx/dsh-web-all` name appears in neither bundles nor
 *      dependencies.
 *   3. A web-all dependency entry resolves to a package.json whose name is
 *      `@dsh-cove/dsh-web-all`.
 *   4. The resolved `lib/client.js` registers `id: "@dsh-cove/dsh-web-all"`;
 *      a mismatching id makes the ModuleLoader report "already executed
 *      without registering".
 *   5. No `@zcx` scope directory with packages remains under profile
 *      `node_modules` (web or profiles level).
 *   6. A `com.dsh.doctor.plist` LaunchAgent must not point at removed paths.
 *   7. Ad-hoc restart scripts must not reference the legacy package name.
 *   8. (warning only) `bin/start-dsh-web.sh` should pass `--trusted-host`.
 *
 * Environment: DSH_HOME (default ~/.dsh), HOME (LaunchAgents lookup).
 * Exit code is non-zero when any check fails. Remediation lives in
 * docs/development.md (本地验证) and `scripts/dsh-local-profile-migrate.mjs`.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, openSync, readSync, closeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WEB_ALL = '@dsh-cove/dsh-web-all'
export const LEGACY_WEB_ALL = '@zcx/dsh-web-all'
const CLIENT_HEAD_BYTES = 2048
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']

/** @typedef {{ level: 'pass'|'warn'|'fail', code: string, message: string }} Finding */

const pass = (code, message) => ({ level: 'pass', code, message })
const warn = (code, message) => ({ level: 'warn', code, message })
const fail = (code, message) => ({ level: 'fail', code, message })

export function bundleName(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') return entry.name ?? entry.id ?? null
  return null
}

export function isPackage(entry, name) {
  const value = bundleName(entry)
  return value === name || (typeof value === 'string' && value.startsWith(`${name}/`))
}

/** Bundles listed in `dsh.profile.bundles`, or an empty list when absent. */
export function profileBundles(pkg) {
  const bundles = pkg?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles : []
}

/**
 * Pure analysis of a profile package.json object (checks 2).
 * @param {object} pkg parsed profiles/web/package.json
 * @returns {Finding[]}
 */
export function analyzeProfilePackage(pkg) {
  const findings = []
  const bundles = profileBundles(pkg)
  const current = bundles.filter((entry) => isPackage(entry, WEB_ALL)).length
  const legacyBundles = bundles.filter((entry) => isPackage(entry, LEGACY_WEB_ALL)).length

  if (current === 1) findings.push(pass('bundle-current', `bundles list ${WEB_ALL} once`))
  else if (current === 0) findings.push(fail('bundle-missing', `bundles do not list ${WEB_ALL}`))
  else findings.push(fail('bundle-duplicate', `bundles list ${WEB_ALL} ${current} times, expected exactly once`))

  if (legacyBundles > 0) {
    findings.push(fail('bundle-legacy', `bundles still list ${LEGACY_WEB_ALL}; run: node scripts/dsh-local-profile-migrate.mjs --apply`))
  }

  for (const field of DEP_FIELDS) {
    const deps = pkg?.[field]
    if (deps && typeof deps === 'object' && Object.hasOwn(deps, LEGACY_WEB_ALL)) {
      findings.push(fail('dependency-legacy', `${field} still contains ${LEGACY_WEB_ALL}; run: node scripts/dsh-local-profile-migrate.mjs --apply`))
    }
  }
  return findings
}

/**
 * Extract the first `id: "<name>"` literal from the head of a client bundle.
 * @param {string} sourceText client.js text (only the first ~2KB is inspected)
 * @returns {string|null}
 */
export function extractClientModuleId(sourceText) {
  const head = String(sourceText).slice(0, CLIENT_HEAD_BYTES)
  const match = /\bid:\s*(["'])((?:(?!\1).)+)\1/.exec(head)
  return match ? match[2] : null
}

/**
 * Pure analysis of the client bundle head (check 4).
 * @param {string} sourceText
 * @returns {Finding[]}
 */
export function analyzeClientSource(sourceText) {
  const id = extractClientModuleId(sourceText)
  if (id === WEB_ALL) return [pass('client-id', `client.js registers ${WEB_ALL}`)]
  if (id === LEGACY_WEB_ALL) {
    return [fail('client-id-legacy', `client.js registers ${LEGACY_WEB_ALL}; relink the profile to this repository (node scripts/dsh-local-profile-migrate.mjs --apply)`)]
  }
  if (id === null) return [fail('client-id-missing', `client.js has no module id in its first ${CLIENT_HEAD_BYTES} bytes, expected id: "${WEB_ALL}"`)]
  return [fail('client-id-mismatch', `client.js registers "${id}", expected "${WEB_ALL}"`)]
}

/** Decode the XML entities a LaunchAgent plist string can contain. */
function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Extract ProgramArguments from an XML plist.
 * @param {string} plistText XML plist content
 * @returns {string[]}
 */
export function parseProgramArguments(plistText) {
  const array = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plistText)
  if (!array) return []
  return [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => decodeXml(m[1]))
}

/**
 * Check 6 on parsed ProgramArguments: any absolute path argument that no longer
 * exists is a failure.
 * @param {string[]} args
 * @param {{ exists?: (p: string) => boolean, home?: string }} [options]
 * @returns {Finding[]}
 */
export function analyzeDoctorPlistArgs(args, { exists = existsSync, home = homedir() } = {}) {
  const missing = []
  for (const arg of args) {
    if (typeof arg !== 'string') continue
    const path = arg.startsWith('~/') ? join(home, arg.slice(2)) : arg
    if (!path.startsWith('/')) continue
    if (!exists(path)) missing.push(arg)
  }
  if (missing.length === 0) return [pass('doctor-plist', 'com.dsh.doctor.plist targets exist')]
  return [fail(
    'doctor-plist-missing-target',
    `com.dsh.doctor.plist points at missing path(s): ${missing.join(', ')}; the doctor CLI package was removed and its capability lives in web-all. Run: launchctl bootout gui/$(id -u)/com.dsh.doctor && mv ~/Library/LaunchAgents/com.dsh.doctor.plist ~/Library/LaunchAgents/com.dsh.doctor.plist.retired`,
  )]
}

/**
 * Check 7: an ad-hoc restart script that names the legacy scope.
 * @param {string} scriptText
 * @param {string} [path] script path used in the message
 * @returns {Finding[]}
 */
export function analyzeRestartScript(scriptText, path = 'dsh-web-restart.sh') {
  if (/@zcx\/dsh-web-all/.test(scriptText) || /pnpm\s+--filter\s+@zcx/.test(scriptText)) {
    return [fail(
      'restart-script-legacy',
      `${path} references the legacy @zcx scope; retire it (mv ${path} ${path}.retired) and use tools/dsh-launchd or the documented restart`,
    )]
  }
  return [pass('restart-script', `${path} has no legacy references`)]
}

/**
 * Check 8: the start script should declare a trusted host.
 * @param {string} scriptText
 * @param {string} [path]
 * @returns {Finding[]}
 */
export function analyzeStartScript(scriptText, path = 'start-dsh-web.sh') {
  if (/--trusted-host\b/.test(scriptText)) return [pass('start-script', `${path} passes --trusted-host`)]
  return [warn('start-script-trusted-host', `${path} does not pass --trusted-host (see docs/remote-access.md)`)]
}

function readHead(path, bytes) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** lstat that also reports broken symlinks; null when nothing is at the path. */
function entryAt(path) {
  try { return lstatSync(path) } catch { return null }
}

const LEGACY_SCOPE = '@zcx'
const STALE_LEGACY_SCOPE_MSG = `retire or move the whole ${LEGACY_SCOPE} scope under profile node_modules; family packages live under @dsh-cove via link-profile (node scripts/dsh-local-profile-migrate.mjs --apply)`

/**
 * Check 5: any leftover package under node_modules/@zcx.
 * @param {string} scopePath absolute path to .../node_modules/@zcx
 * @returns {Finding[]}
 */
export function analyzeLegacyScopeDir(scopePath) {
  const st = entryAt(scopePath)
  if (!st?.isDirectory()) return []
  let entries
  try { entries = readdirSync(scopePath) } catch { return [] }
  if (entries.length === 0) return []
  return [fail('stale-legacy-package', `${scopePath} still has @zcx packages (${entries.join(', ')}); ${STALE_LEGACY_SCOPE_MSG}`)]
}

/** Locate the dsh-web-all client bundle: profile node_modules first, then ancestors up to DSH_HOME. */
export function resolveClientJs(webDir, dshHome) {
  const rel = join('node_modules', ...WEB_ALL.split('/'), 'lib', 'client.js')
  let dir = webDir
  const stop = resolvePath(dshHome)
  for (let i = 0; i < 16; i++) {
    const candidate = join(dir, rel)
    if (existsSync(candidate)) return candidate
    if (resolvePath(dir) === stop) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Check 3: the web-all dependency (when declared) must resolve to the @dsh-cove package. */
function analyzeDependencyResolution(pkg, webDir) {
  const spec = pkg?.dependencies?.[WEB_ALL]
  if (spec === undefined) return []
  let manifest
  if (typeof spec === 'string' && /^(link|file):/.test(spec)) {
    manifest = join(resolvePath(webDir, spec.replace(/^(link|file):/, '')), 'package.json')
  } else {
    manifest = join(webDir, 'node_modules', ...WEB_ALL.split('/'), 'package.json')
    if (!existsSync(manifest)) {
      return [fail('dependency-unresolved', `dependency ${WEB_ALL}@${spec} is not installed under profiles/web/node_modules`)]
    }
  }
  if (!existsSync(manifest)) return [fail('dependency-unresolved', `dependency ${WEB_ALL}=${spec} resolves to ${manifest}, which does not exist`)]
  let name
  try { name = readJson(manifest).name } catch (error) {
    return [fail('dependency-unreadable', `cannot read ${manifest}: ${error.message}`)]
  }
  if (name !== WEB_ALL) return [fail('dependency-name', `dependency ${WEB_ALL} resolves to a package named "${name}" at ${manifest}`)]
  return [pass('dependency', `dependency ${WEB_ALL} resolves to ${manifest}`)]
}

function readProgramArguments(plistPath) {
  let text = readFileSync(plistPath, 'utf8')
  if (text.startsWith('bplist')) {
    text = execFileSync('plutil', ['-convert', 'xml1', '-o', '-', plistPath], { encoding: 'utf8' })
  }
  return parseProgramArguments(text)
}

/**
 * Run every check against a DSH home.
 * @param {{ dshHome?: string, home?: string }} [options]
 * @returns {Finding[]}
 */
export function auditLocalOps({ dshHome, home } = {}) {
  const userHome = home ?? process.env.HOME ?? homedir()
  const dsh = dshHome ?? process.env.DSH_HOME ?? join(userHome, '.dsh')
  const profilesDir = join(dsh, 'profiles')
  const webDir = join(profilesDir, 'web')
  const findings = []

  // 1. profile package.json
  const pkgPath = join(webDir, 'package.json')
  let pkg = null
  if (!existsSync(pkgPath)) {
    findings.push(fail('profile-missing', `${pkgPath} does not exist`))
  } else {
    try {
      pkg = readJson(pkgPath)
      findings.push(pass('profile', `${pkgPath} exists`))
    } catch (error) {
      findings.push(fail('profile-unreadable', `cannot parse ${pkgPath}: ${error.message}`))
    }
  }

  // 2 and 3. bundles, dependencies
  if (pkg) {
    findings.push(...analyzeProfilePackage(pkg))
    findings.push(...analyzeDependencyResolution(pkg, webDir))
  }

  // 4. client bundle id
  const clientPath = resolveClientJs(webDir, dsh)
  if (!clientPath) {
    findings.push(fail('client-missing', `cannot resolve ${WEB_ALL}/lib/client.js from ${webDir} or its ancestors up to ${dsh}`))
  } else {
    findings.push(...analyzeClientSource(readHead(clientPath, CLIENT_HEAD_BYTES)).map((f) => ({ ...f, message: `${f.message} (${clientPath})` })))
  }

  // 5. stale @zcx scope under profile node_modules
  const scopeFindings = []
  for (const base of [webDir, profilesDir]) {
    scopeFindings.push(...analyzeLegacyScopeDir(join(base, 'node_modules', LEGACY_SCOPE)))
  }
  if (scopeFindings.length === 0) {
    findings.push(pass('stale-legacy-package', `no ${LEGACY_SCOPE} scope with packages under profile node_modules`))
  } else {
    findings.push(...scopeFindings)
  }

  // 6. doctor LaunchAgent
  const doctorPlist = join(userHome, 'Library', 'LaunchAgents', 'com.dsh.doctor.plist')
  if (existsSync(doctorPlist)) {
    try {
      findings.push(...analyzeDoctorPlistArgs(readProgramArguments(doctorPlist), { home: userHome }))
    } catch (error) {
      findings.push(warn('doctor-plist-unreadable', `cannot parse ${doctorPlist}: ${error.message}`))
    }
  }

  // 7. ad-hoc restart scripts
  for (const script of [join(dsh, 'logs', 'dsh-web-restart.sh'), join(dsh, 'bin', 'dsh-web-restart.sh')]) {
    if (existsSync(script)) findings.push(...analyzeRestartScript(readFileSync(script, 'utf8'), script))
  }

  // 8. start script posture
  const startScript = join(dsh, 'bin', 'start-dsh-web.sh')
  if (existsSync(startScript)) findings.push(...analyzeStartScript(readFileSync(startScript, 'utf8'), startScript))

  return findings
}

/** True when any finding is a hard failure. */
export function hasFailure(findings) {
  return findings.some((f) => f.level === 'fail')
}

function main() {
  const findings = auditLocalOps()
  for (const f of findings) console.log(`[dsh-local-ops] ${f.level.toUpperCase()} ${f.code}: ${f.message}`)
  const failures = findings.filter((f) => f.level === 'fail').length
  const warnings = findings.filter((f) => f.level === 'warn').length
  console.log(`[dsh-local-ops] ${failures === 0 ? 'OK' : 'FAILED'}: ${failures} failure(s), ${warnings} warning(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

// Run only as the entry script so tests can import the helpers.
if (resolvePath(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main()
}
