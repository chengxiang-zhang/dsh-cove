#!/usr/bin/env node
/**
 * Fleet collection: harvest the DSH upgrade surfaces that live outside the
 * repository (agent presets, profile patch layers, profile-local plugins and
 * machine checkouts), so machine-side improvements can be reviewed and merged
 * back into `packages/dsh-web-all` instead of being re-invented per machine.
 *
 * Read-only by contract: the remote side only runs `find`, `du`, `git` and
 * `tar -c`; nothing is written, moved or deleted on a collected machine. The
 * only child process that reads remote bytes is the local `tar -x`.
 *
 * Scope lives in `config/fleet-collect.local.json` (gitignored: machine names,
 * SSH aliases and home paths never reach the public repository). The committed
 * shape is `config/fleet-collect.example.json`. Products land in `.harvest/`,
 * also gitignored, because a harvested preset contains unpublished persona and
 * gate source.
 *
 * Usage:
 *   node scripts/dsh-fleet-collect.mjs                 # collect every machine
 *   node scripts/dsh-fleet-collect.mjs --only pc-tower --only zcx-t470p
 *   node scripts/dsh-fleet-collect.mjs --dry-run       # probe + list only
 *   node scripts/dsh-fleet-collect.mjs --json          # machine-readable summary
 *   node scripts/dsh-fleet-collect.mjs --install-schedule
 *   node scripts/dsh-fleet-collect.mjs --uninstall-schedule
 *
 * Exit codes: 0 when every requested machine was collected, 1 when at least one
 * machine failed (the report says which and why), 2 on a scope or usage error.
 */
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const SCOPE_PATHS = {
  local: join(repoRoot, 'config', 'fleet-collect.local.json'),
  template: join(repoRoot, 'config', 'fleet-collect.example.json'),
}

export const HARVEST_ROOT = join(repoRoot, '.harvest')

export const DEFAULT_LIMITS = {
  maxFiles: 20000,
  maxFileBytes: 2097152,
  maxTotalBytes: 67108864,
  maxTransferKilobytes: 262144,
  sshTimeoutSeconds: 120,
}

/**
 * Names pruned on the remote side before a single byte is transferred. Sessions,
 * storages, backups, credential files and caches are machine state, not upgrade
 * material, and two of them are secrets.
 */
export const PRUNE_NAMES = [
  'node_modules',
  '.git',
  '.cache',
  '__pycache__',
  'sessions',
  'storages',
  'backups',
  'results-*',
  '*.pyc',
  '*.log',
  '*.bak*',
  '.env*',
  '.credentials*',
  '*.pem',
  '*.key',
  '*.api-key',
  '*.sqlite',
  '*.sqlite3',
]

const SCHEDULE_LABEL = 'ai.deepseek.dsh.fleet-collect'

/** Relative paths inside a harvest directory that hold the raw tree. */
export const FILES_DIR = 'files'

/** Translates one glob into an anchored regular expression over `/`-joined paths. */
export function globToRegExp(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` spans zero or more directories; a trailing `**` spans everything.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/** True when `path` matches `pattern`. Patterns are matched against the whole path. */
export function matchesGlob(path, pattern) {
  return globToRegExp(pattern).test(path)
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => matchesGlob(path, pattern))
}

/**
 * Applies one surface's include/exclude lists to a candidate path. Exclusions win,
 * which is how `evals/results-*` stays out while the rest of `evals/` comes in.
 */
export function selectByGlobs(path, include, exclude = []) {
  if (!Array.isArray(include) || include.length === 0) return false
  if (matchesAny(path, exclude)) return false
  return matchesAny(path, include)
}

/** Reads `--flag` style options; unknown flags are a usage error. */
export function parseArgs(argv) {
  const options = {
    scope: null,
    out: null,
    only: [],
    stamp: null,
    dryRun: false,
    json: false,
    installSchedule: false,
    uninstallSchedule: false,
    printSchedule: false,
    quiet: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`missing value for ${arg}`)
      i += 1
      return value
    }
    switch (arg) {
      case '--scope':
        options.scope = next()
        break
      case '--out':
        options.out = next()
        break
      case '--only':
        options.only.push(next())
        break
      case '--stamp':
        options.stamp = next()
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--json':
        options.json = true
        break
      case '--quiet':
        options.quiet = true
        break
      case '--install-schedule':
        options.installSchedule = true
        break
      case '--uninstall-schedule':
        options.uninstallSchedule = true
        break
      case '--print-schedule':
        options.printSchedule = true
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

/** Resolves the scope document: explicit flag, then environment, then local, then example. */
export function resolveScopePath({ root = repoRoot, options = {}, env = process.env } = {}) {
  if (options.scope) return { path: resolve(options.scope), source: 'flag' }
  if (env.DSH_COVE_FLEET_SCOPE) return { path: resolve(env.DSH_COVE_FLEET_SCOPE), source: 'env' }
  const local = join(root, 'config', 'fleet-collect.local.json')
  if (existsSync(local)) return { path: local, source: 'local' }
  return { path: join(root, 'config', 'fleet-collect.example.json'), source: 'template' }
}

const SERVICE_KINDS = new Set(['systemd-user', 'systemd-system', 'launchd', 'none'])

/** Validates one declared service handle; `null` means "detect it at rollout time". */
function normalizeService(value, where) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') throw new Error(`fleet scope: ${where} must be an object`)
  const kind = requireString(value.kind, `${where}.kind`)
  if (!SERVICE_KINDS.has(kind)) {
    throw new Error(`fleet scope: ${where}.kind must be one of ${[...SERVICE_KINDS].join(', ')}`)
  }
  return {
    kind,
    target: value.target ? requireString(value.target, `${where}.target`) : null,
  }
}

function requireString(value, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`fleet scope: ${where} must be a non-empty string`)
  }
  return value
}

function requireStringArray(value, where) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`fleet scope: ${where} must be an array of strings`)
  }
  return value
}

/**
 * Validates and normalizes a scope document. Every error names the JSON path so a
 * broken local scope reports which line to fix instead of failing mid-collection.
 */
export function validateScope(raw, source = 'scope') {
  if (!raw || typeof raw !== 'object') throw new Error(`fleet scope (${source}): not an object`)
  if (raw.version !== 1) throw new Error(`fleet scope (${source}): unsupported version ${raw.version}`)

  const surfaces = raw.surfaces
  if (!surfaces || typeof surfaces !== 'object') {
    throw new Error(`fleet scope (${source}): surfaces is required`)
  }
  const normalizedSurfaces = {}
  for (const [name, surface] of Object.entries(surfaces)) {
    const where = `surfaces.${name}`
    if (!surface || typeof surface !== 'object') throw new Error(`fleet scope: ${where} not an object`)
    const roots = Array.isArray(surface.roots) ? surface.roots : []
    if (roots.length === 0) throw new Error(`fleet scope: ${where}.roots must not be empty`)
    normalizedSurfaces[name] = {
      roots: roots.map((root, index) => {
        const path = requireString(root && root.path, `${where}.roots[${index}].path`)
        const maxdepth =
          root.maxdepth === undefined ? null : Number.isInteger(root.maxdepth) ? root.maxdepth : null
        return { path, maxdepth }
      }),
      include: requireStringArray(surface.include, `${where}.include`),
      exclude: surface.exclude === undefined ? [] : requireStringArray(surface.exclude, `${where}.exclude`),
    }
  }

  const machines = Array.isArray(raw.machines) ? raw.machines : []
  if (machines.length === 0) throw new Error(`fleet scope (${source}): machines must not be empty`)
  const names = new Set()
  const normalizedMachines = machines.map((machine, index) => {
    const where = `machines[${index}]`
    const name = requireString(machine && machine.name, `${where}.name`)
    if (names.has(name)) throw new Error(`fleet scope: duplicate machine name ${name}`)
    names.add(name)
    const isLocal = machine.local === true
    const ssh = isLocal ? null : requireString(machine.ssh, `${where}.ssh`)
    const surfaceNames = machine.surfaces === undefined ? ['profiles'] : requireStringArray(machine.surfaces, `${where}.surfaces`)
    for (const surface of surfaceNames) {
      // `checkouts` is a surface name without a directory of its own: its roots and
      // origin matcher live in the top-level `checkouts` block.
      if (surface === 'checkouts' && raw.checkouts) continue
      if (!normalizedSurfaces[surface]) {
        throw new Error(`fleet scope: ${where}.surfaces names unknown surface ${surface}`)
      }
    }
    // `netbirdName` and `rolloutProfiles` are the distribution facts: the
    // canonical browser entry the rollout verifies, and the profiles that carry
    // this package. Both stay optional because not every machine runs the plugin.
    const rolloutProfiles = machine.rolloutProfiles === undefined
      ? null
      : requireStringArray(machine.rolloutProfiles, `${where}.rolloutProfiles`)
    return {
      name,
      local: isLocal,
      ssh,
      os: machine.os || null,
      surfaces: surfaceNames,
      baselinePreset: machine.baselinePreset || null,
      netbirdName: machine.netbirdName ? requireString(machine.netbirdName, `${where}.netbirdName`) : null,
      rolloutProfiles,
      // How a rollout reaches this machine's `dsh` CLI and how its web service
      // restarts. Both are machine-local facts (nvm paths, unit scope, label),
      // so they are declared here rather than guessed at rollout time.
      dshPath: machine.dshPath ? requireString(machine.dshPath, `${where}.dshPath`) : null,
      // `dsh plugin add` shells out to pnpm, which a non-interactive SSH session
      // does not always find; the prefix names the directory that carries it.
      pathPrefix: machine.pathPrefix ? requireString(machine.pathPrefix, `${where}.pathPrefix`) : null,
      service: normalizeService(machine.service, `${where}.service`),
      notes: machine.notes || null,
    }
  })

  const checkouts = raw.checkouts
    ? {
        roots: requireStringArray(raw.checkouts.roots || [], 'checkouts.roots'),
        maxdepth: Number.isInteger(raw.checkouts.maxdepth) ? raw.checkouts.maxdepth : 3,
        originMatch: requireStringArray(raw.checkouts.originMatch || [], 'checkouts.originMatch'),
        diffMaxBytes: Number.isInteger(raw.checkouts.diffMaxBytes)
          ? raw.checkouts.diffMaxBytes
          : 262144,
      }
    : null

  const limits = { ...DEFAULT_LIMITS, ...(raw.limits || {}) }
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isInteger(limits[key]) || limits[key] <= 0) {
      throw new Error(`fleet scope: limits.${key} must be a positive integer`)
    }
  }

  const baseline = raw.baseline
    ? {
        preset: raw.baseline.preset || 'code-vibe',
        presetDir: requireString(raw.baseline.presetDir, 'baseline.presetDir'),
        patchFile: raw.baseline.patchFile || null,
      }
    : null

  return {
    source,
    dshHome: raw.dshHome || '~/.dsh',
    surfaces: normalizedSurfaces,
    machines: normalizedMachines,
    checkouts,
    limits,
    baseline,
  }
}

/** Reads and validates a scope document from disk. */
export function loadScope({ root = repoRoot, options = {}, env = process.env } = {}) {
  const { path, source } = resolveScopePath({ root, options, env })
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`fleet scope: cannot read ${path}: ${error.message}`)
  }
  return { scope: validateScope(raw, source), path, source }
}

/** `~/.dsh` becomes `$HOME/.dsh` on the remote side and an absolute path locally. */
export function expandHome(path, { home = homedir(), remote = false } = {}) {
  if (path === '~') return remote ? '$HOME' : home
  if (path.startsWith('~/')) {
    const rest = path.slice(2)
    return remote ? `$HOME/${rest}` : join(home, rest)
  }
  return path
}

/**
 * Remote probe: machine identity, DSH home presence, the size of the collected
 * roots, and the installed `@dsh-cove/dsh-web-all` version per profile. Kept in
 * one round trip because every extra SSH call is a chance for the overlay to fail
 * mid-collection.
 */
export function buildProbeScript(scope, machine) {
  const dshHome = expandHome(scope.dshHome, { remote: true })
  const roots = []
  for (const surfaceName of directorySurfaces(machine, scope)) {
    for (const root of scope.surfaces[surfaceName].roots) {
      const path = `${dshHome}/${root.path}`
      if (!roots.includes(path)) roots.push(path)
    }
  }
  const prune = PRUNE_NAMES.map((name) => (name.includes('*') ? `-name '${name}'` : `-name '${name}'`)).join(' -o ')
  const surfaceSections = directorySurfaces(machine, scope)
    .map((surfaceName) => {
      const surface = scope.surfaces[surfaceName]
      const lines = [`echo "SECTION surface.${surfaceName}"`]
      for (const root of surface.roots) {
        const depth = root.maxdepth === null ? '' : ` -maxdepth ${root.maxdepth}`
        lines.push(
          `find "${root.path}"${depth} \\( ${prune} \\) -prune -o -type f -print 2>/dev/null`,
        )
      }
      return lines.join('\n')
    })
    .join('\n')

  return [
    'set -u',
    `DSH="${dshHome}"`,
    // Listing paths stay relative to the DSH home so the tar member list and the
    // glob selection speak the same language.
    'cd "$DSH" || exit 3',
    'echo "SECTION host"; hostname 2>/dev/null || uname -n',
    'echo "SECTION user"; id -un 2>/dev/null || echo unknown',
    'echo "SECTION os"; uname -s 2>/dev/null || echo unknown',
    `echo "SECTION date"; date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || echo unknown`,
    'echo "SECTION dshHome"; printf "%s\\n" "$DSH"',
    'echo "SECTION dshHomeExists"; if [ -d "$DSH" ]; then echo yes; else echo no; fi',
    'echo "SECTION profiles"; for d in "$DSH"/profiles/*/; do ' +
      '[ -f "$d/package.json" ] || continue; n=$(basename "$d"); ' +
      `v=$(node -e "try{process.stdout.write(require(process.argv[1]).version)}catch(e){process.stdout.write('none')}" "$d/node_modules/@dsh-cove/dsh-web-all/package.json" 2>/dev/null || echo none); ` +
      `printf '%s\\t%s\\n' "$n" "$v"; done`,
    surfaceSections,
    'echo "SECTION end"',
  ].join('\n')
}

/** Splits the probe output into its `SECTION` blocks. */
export function parseProbeOutput(stdout) {
  const sections = {}
  let current = null
  for (const line of String(stdout).split('\n')) {
    const header = /^SECTION (.+)$/.exec(line.trimEnd())
    if (header) {
      current = header[1]
      sections[current] = []
      continue
    }
    if (current === null) continue
    sections[current].push(line)
  }
  return sections
}

/** Interprets probe sections into the machine facts the report prints. */
export function summarizeProbe(sections, { exists = true } = {}) {
  const first = (name) => (sections[name] || []).map((line) => line.trim()).find(Boolean) || null
  const profiles = {}
  for (const line of sections.profiles || []) {
    const [name, version] = line.split('\t')
    if (name) profiles[name.trim()] = (version || 'none').trim()
  }
  const listings = {}
  for (const [name, lines] of Object.entries(sections)) {
    if (!name.startsWith('surface.')) continue
    listings[name.slice('surface.'.length)] = lines.map((line) => line.trim()).filter(Boolean)
  }
  return {
    exists,
    host: first('host'),
    user: first('user'),
    os: first('os'),
    remoteDate: first('date'),
    dshHome: first('dshHome'),
    dshHomeExists: first('dshHomeExists') === 'yes',
    profiles,
    listings,
  }
}

/** Normalizes a listing: strips leading `./`, drops absolute and empty entries. */
export function normalizeListing(lines) {
  const seen = new Set()
  const out = []
  for (const raw of lines) {
    const path = raw.replace(/^\.\//, '').trim()
    if (!path || path.startsWith('/') || path.startsWith('..')) continue
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  out.sort()
  return out
}

/**
 * Selects the files one machine contributes, applying each surface's globs and the
 * file-count cap. The result records why files were dropped, so a cap that bites
 * is visible in the report instead of being silently lossy.
 */
export function surfaceRelativePath(path, surface) {
  for (const root of surface.roots) {
    const prefix = root.path.replace(/\/$/, '') + '/'
    if (path === prefix.slice(0, -1)) return ''
    if (path.startsWith(prefix)) return path.slice(prefix.length)
  }
  return null
}

export function selectMachineFiles(probe, machine, scope) {
  const selected = []
  const dropped = []
  const perSurface = {}
  for (const surfaceName of directorySurfaces(machine, scope)) {
    const surface = scope.surfaces[surfaceName]
    const listing = normalizeListing(probe.listings[surfaceName] || [])
    let kept = 0
    for (const path of listing) {
      const rel = surfaceRelativePath(path, surface)
      if (rel !== null && selectByGlobs(rel, surface.include, surface.exclude)) {
        selected.push(path)
        kept += 1
      } else {
        dropped.push({ path, reason: 'not-in-surface' })
      }
    }
    perSurface[surfaceName] = { listed: listing.length, kept }
  }
  const unique = [...new Set(selected)].sort()
  if (unique.length > scope.limits.maxFiles) {
    const cut = unique.slice(scope.limits.maxFiles)
    for (const path of cut) dropped.push({ path, reason: 'file-count-cap' })
    return { files: unique.slice(0, scope.limits.maxFiles), dropped, perSurface }
  }
  return { files: unique, dropped, perSurface }
}

/** Exact transfer size of the selected files, asked before a byte is moved. */
export function buildSizeScript(scope) {
  const dshHome = expandHome(scope.dshHome, { remote: true })
  // LC_ALL=C: a localized `du` prints its total line as e.g. `总计`, and the awk
  // below matches the word `total`. Without this the estimate silently reads 0 on
  // machines whose locale is not English.
  return `set -u; cd "${dshHome}" || exit 3; tr '\\n' '\\0' | LC_ALL=C xargs -0 du -ck 2>/dev/null | awk '$2 == "total" { s += $1 } END { print s + 0 }'`
}

export async function estimateSize(machine, scope, files) {
  if (files.length === 0) return 0
  const result = await runOnMachine(machine, scope, buildSizeScript(scope), {
    input: files.join('\n') + '\n',
  })
  const kilobytes = Number(String(result.stdout).trim().split('\n').pop() || 0)
  return Number.isFinite(kilobytes) ? kilobytes : 0
}

/**
 * The transfer command: one tar stream whose member list arrives on stdin. The
 * caller passes it as the single SSH command argument, so stdin stays free for
 * the file list (a script on stdin and a member list on stdin would collide).
 */
export function buildTarScript(scope) {
  const dshHome = expandHome(scope.dshHome, { remote: true })
  return `set -u; cd "${dshHome}" || exit 3; exec tar -czf - -T - 2>/dev/null`
}

/** Surface names that own a directory tree; `checkouts` is handled separately. */
export function directorySurfaces(machine, scope) {
  return machine.surfaces.filter((name) => scope.surfaces[name] !== undefined)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function walk(dir, base = dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push(relative(base, full))
  }
  return out
}

/** File map (`relpath` -> sha256) for a tree, used by the drift comparison. */
export function hashTree(dir) {
  const map = new Map()
  if (!existsSync(dir)) return map
  for (const rel of walk(dir)) {
    map.set(rel.split(sep).join('/'), sha256(readFileSync(join(dir, rel))))
  }
  return map
}

/**
 * Compares a harvested preset against the repository baseline. `baselineMissing`
 * is the expected first state: the machine is ahead because the repository has
 * no such file yet, which is exactly what the merge has to fix.
 */
export function computeTreeDrift({ harvestedDir, baselineDir }) {
  const harvested = hashTree(harvestedDir)
  const baseline = hashTree(baselineDir)
  const added = []
  const removed = []
  const modified = []
  for (const [path, digest] of harvested) {
    if (!baseline.has(path)) added.push(path)
    else if (baseline.get(path) !== digest) modified.push(path)
  }
  for (const path of baseline.keys()) {
    if (!harvested.has(path)) removed.push(path)
  }
  return {
    harvestedFiles: harvested.size,
    baselineFiles: baseline.size,
    baselineMissing: baseline.size === 0,
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
  }
}

/** Row ids a profile patch mounts, so two machines can be compared at a glance. */
export function patchRowIds(text, limit = 200) {
  const ids = []
  for (const line of String(text).split('\n')) {
    const match = /^\s*-\s+id:\s*(\S+)/.exec(line)
    if (match) ids.push(match[1])
    if (ids.length >= limit) break
  }
  return ids
}

function runLocal(script, { cwd, timeout, input } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn('/bin/sh', ['-c', script], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = timeout
      ? setTimeout(() => child.kill('SIGKILL'), timeout)
      : null
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      resolveRun({ code: -1, stdout, stderr: `${stderr}${error.message}` })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolveRun({ code, stdout, stderr })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

function runSsh(alias, script, { timeout, input } = {}) {
  return new Promise((resolveRun) => {
    // Two transports on purpose: a probe arrives as a script on stdin (no quoting
    // risk for large bodies), while a script that must read stdin itself is passed
    // as the single SSH command argument instead.
    const args =
      input === undefined
        ? ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', alias, 'sh -s']
        : ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', alias, script]
    const child = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = timeout
      ? setTimeout(() => child.kill('SIGKILL'), timeout)
      : null
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      resolveRun({ code: -1, stdout, stderr: `${stderr}${error.message}` })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolveRun({ code, stdout, stderr })
    })
    child.stdin.end(input === undefined ? script : input)
  })
}

/** Runs one remote/local script for a machine, dispatching on `machine.local`. */
function runOnMachine(machine, scope, script, options = {}) {
  const timeout = scope.limits.sshTimeoutSeconds * 1000
  if (machine.local) {
    return runLocal(script, { cwd: expandHome(scope.dshHome), timeout, ...options })
  }
  return runSsh(machine.ssh, script, { timeout, ...options })
}

/**
 * Pipes a remote tar stream into a local extractor. The member list goes to the
 * remote `tar -T -` on stdin, so a path with spaces never reaches a shell.
 */
function extractTar({ machine, scope, files, destDir }) {
  return new Promise((resolveExtract) => {
    const script = buildTarScript(scope)
    const timeout = scope.limits.sshTimeoutSeconds * 1000
    const producer = machine.local
      ? spawn('/bin/sh', ['-c', script], { cwd: expandHome(scope.dshHome) })
      : spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', machine.ssh, script])
    const consumer = spawn('tar', ['-xzf', '-', '-C', destDir], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    producer.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    consumer.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      producer.kill('SIGKILL')
      consumer.kill('SIGKILL')
    }, timeout * 4)
    producer.stdout.pipe(consumer.stdin)
    producer.stdin.end(files.join('\n') + '\n')
    let pending = 2
    const finish = (result) => {
      pending -= 1
      if (pending > 0) return
      clearTimeout(timer)
      resolveExtract({ ...result, stderr })
    }
    producer.on('error', (error) => finish({ code: -1, stderr: stderr + error.message }))
    consumer.on('error', (error) => finish({ code: -1, stderr: stderr + error.message }))
    producer.on('close', (code) => finish({ code }))
    consumer.on('close', (code) => finish({ code }))
  })
}

function removeIfOversize(dir, files, limits) {
  const kept = []
  const dropped = []
  let total = 0
  for (const rel of files) {
    const full = join(dir, rel)
    let size = 0
    try {
      size = statSync(full).size
    } catch {
      dropped.push({ path: rel, reason: 'missing-after-extract' })
      continue
    }
    if (size > limits.maxFileBytes) {
      dropped.push({ path: rel, reason: 'file-size-cap', bytes: size })
      safeUnlink(full)
      continue
    }
    if (total + size > limits.maxTotalBytes) {
      dropped.push({ path: rel, reason: 'total-size-cap', bytes: size })
      safeUnlink(full)
      continue
    }
    total += size
    kept.push({ path: rel, bytes: size, sha256: sha256(readFileSync(full)) })
  }
  return { kept, dropped, total }
}

function safeUnlink(path) {
  try {
    unlinkSync(path)
  } catch {
    // A file that is already gone needs no cleanup; the report already records why.
  }
}

function pruneEmptyDirs(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    pruneEmptyDirs(full)
    try {
      if (readdirSync(full).length === 0) rmdirSync(full)
    } catch {
      // Racing directories are not worth failing a collection over.
    }
  }
}

/** Parses `REPO` lines the checkout probe emits. */
export function buildCheckoutDetailScript(repos, scope) {
  const cap = scope.checkouts ? scope.checkouts.diffMaxBytes : 262144
  const blocks = repos.map((repo) => {
    const quoted = `'${repo.replace(/'/g, `'\\''`)}'`
    return [
      `echo "SECTION status ${repo}"`,
      `git -C ${quoted} rev-parse --abbrev-ref HEAD 2>/dev/null; git -C ${quoted} rev-parse --short HEAD 2>/dev/null; git -C ${quoted} status --porcelain 2>/dev/null | wc -l`,
      `echo "SECTION stat ${repo}"`,
      `git -C ${quoted} diff --stat --no-color 2>/dev/null | tail -5`,
      `echo "SECTION patch ${repo}"`,
      `git -C ${quoted} diff --no-color 2>/dev/null | head -c ${cap}`,
    ].join('\n')
  })
  return ['set -u', ...blocks, 'echo "SECTION end"'].join('\n')
}

function readRepoListing(machine, scope) {
  const checkouts = scope.checkouts
  if (!checkouts || !machine.surfaces.includes('checkouts')) {
    return Promise.resolve({ repos: [], stderr: '', code: 0 })
  }
  const roots = checkouts.roots.map((root) => expandHome(root, { remote: true }))
  const script = [
    'set -u',
    `find ${roots.map((root) => `"${root}"`).join(' ')} -maxdepth ${checkouts.maxdepth} -name .git -type d -prune 2>/dev/null`,
    'echo "SECTION end"',
  ].join('\n')
  const emit = [
    'set -u',
    'while IFS= read -r g; do',
    '  repo=${g%/.git}',
    '  origin=$(git -C "$repo" config --get remote.origin.url 2>/dev/null || true)',
    '  [ -n "$origin" ] || continue',
    '  branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")',
    '  head=$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo "?")',
    '  dirty=$(git -C "$repo" status --porcelain 2>/dev/null | wc -l | tr -d " ")',
    '  printf "REPO\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$repo" "$origin" "$branch" "$head" "$dirty"',
    'done',
    'echo "SECTION end"',
  ].join('\n')
  return runOnMachine(machine, scope, script).then((listing) =>
    runOnMachine(machine, scope, emit, { input: listing.stdout }).then((result) => {
      const repos = []
      for (const line of result.stdout.split('\n')) {
        if (!line.startsWith('REPO\t')) continue
        const [, repo, origin, branch, head, dirty] = line.split('\t')
        repos.push({ repo, origin, branch, head, dirty: Number(dirty || 0) })
      }
      return { repos, stderr: result.stderr, code: result.code }
    }),
  )
}

function collectCheckouts(machine, scope) {
  const checkouts = scope.checkouts
  if (!checkouts || !machine.surfaces.includes('checkouts')) return Promise.resolve(null)
  return readRepoListing(machine, scope).then(async (listing) => {
    const matched = listing.repos.filter((repo) =>
      checkouts.originMatch.some((needle) => (repo.origin || '').includes(needle)),
    )
    if (matched.length === 0) return { repos: [], matched: [], details: {} }
    const detailScript = buildCheckoutDetailScript(
      matched.map((repo) => repo.repo),
      scope,
    )
    const result = await runOnMachine(machine, scope, detailScript)
    const sections = parseProbeOutput(result.stdout)
    const details = {}
    for (const repo of matched) {
      const status = (sections[`status ${repo.repo}`] || []).map((line) => line.trim())
      details[repo.repo] = {
        branch: status[0] || repo.branch,
        head: status[1] || repo.head,
        dirty: Number(status[2] || repo.dirty),
        stat: (sections[`stat ${repo.repo}`] || []).filter((line) => line.trim()).join('\n'),
        patch: (sections[`patch ${repo.repo}`] || []).join('\n'),
      }
    }
    return { repos: listing.repos, matched, details }
  })
}

function stampNow(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

function isoNow() {
  return new Date().toISOString()
}

/**
 * Collects one machine: probe, select, transfer, prune, hash. Never throws for a
 * machine-level failure; the error is recorded so the report can name it.
 */
export async function collectMachine(machine, scope, { outDir, dryRun = false } = {}) {
  const record = {
    name: machine.name,
    ssh: machine.ssh,
    local: machine.local === true,
    surfaces: machine.surfaces,
    ok: false,
    error: null,
    probe: null,
    perSurface: {},
    files: [],
    dropped: [],
    checkouts: null,
    drift: null,
    bytes: 0,
    startedAt: isoNow(),
    finishedAt: null,
  }
  try {
    const probeScript = buildProbeScript(scope, machine)
    const probeResult = await runOnMachine(machine, scope, probeScript)
    if (probeResult.code !== 0 && !probeResult.stdout.includes('SECTION')) {
      throw new Error(`probe failed (exit ${probeResult.code}): ${probeResult.stderr.trim().slice(0, 300)}`)
    }
    const sections = parseProbeOutput(probeResult.stdout)
    const probe = summarizeProbe(sections)
    record.probe = probe
    if (!probe.dshHomeExists) throw new Error(`no DSH home at ${probe.dshHome || scope.dshHome}`)
    const selection = selectMachineFiles(probe, machine, scope)
    record.perSurface = selection.perSurface
    record.dropped = selection.dropped
    const estimateKilobytes = await estimateSize(machine, scope, selection.files)
    record.estimatedKilobytes = estimateKilobytes
    if (estimateKilobytes > scope.limits.maxTransferKilobytes) {
      throw new Error(
        `selected files are ${estimateKilobytes} KiB, above the ${scope.limits.maxTransferKilobytes} KiB transfer cap`,
      )
    }
    if (dryRun) {
      record.files = selection.files.map((path) => ({ path }))
      record.ok = true
      record.finishedAt = isoNow()
      return record
    }
    const machineDir = join(outDir, machine.name)
    const filesDir = join(machineDir, FILES_DIR)
    mkdirSync(filesDir, { recursive: true })
    const extract = await extractTar({ machine, scope, files: selection.files, destDir: filesDir })
    const present = walk(filesDir).map((rel) => rel.split(sep).join('/'))
    const pruned = removeIfOversize(filesDir, present, scope.limits)
    record.files = pruned.kept
    record.dropped = record.dropped.concat(pruned.dropped)
    record.bytes = pruned.total
    pruneEmptyDirs(filesDir)
    if (extract.stderr.trim()) record.transferStderr = extract.stderr.trim().slice(0, 2000)
    record.checkouts = await collectCheckouts(machine, scope)
    if (record.checkouts) writeJson(join(machineDir, 'checkouts.json'), record.checkouts)
    record.ok = record.files.length > 0
    if (!record.ok) record.error = 'no file selected for this machine'
  } catch (error) {
    record.error = error.message
    record.ok = false
  }
  record.finishedAt = isoNow()
  return record
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Computes the drift record from already-collected files on disk. */
export function computeMachineDrift(machineDir, machine, scope, { root = repoRoot } = {}) {
  if (!scope.baseline || !machine.baselinePreset) return null
  const filesDir = join(machineDir, FILES_DIR)
  const harvestedPreset = join(filesDir, '.agent-presets', machine.baselinePreset)
  if (!existsSync(harvestedPreset)) return null
  const baselineDir = join(root, scope.baseline.presetDir)
  const tree = computeTreeDrift({ harvestedDir: harvestedPreset, baselineDir })
  const patchPath = join(filesDir, 'profiles')
  return {
    preset: machine.baselinePreset,
    ...tree,
    profiles: readProfileFacts(patchPath),
  }
}

/** Profile patch facts from the harvested tree: rows, line count, digest. */
export function readProfileFacts(profilesDir) {
  const facts = {}
  if (!existsSync(profilesDir)) return facts
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const patchPath = join(profilesDir, entry.name, 'cordis.patch.yml')
    if (!existsSync(patchPath)) continue
    const text = readFileSync(patchPath, 'utf8')
    facts[entry.name] = {
      lines: text.split('\n').length,
      rows: patchRowIds(text),
      sha256: sha256(Buffer.from(text)),
    }
  }
  return facts
}

function formatBytes(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${bytes} B`
}

/** Markdown report for one harvest run. */
export function renderHarvestReport(manifest) {
  const lines = []
  lines.push('# Fleet harvest')
  lines.push('')
  lines.push(`- stamp: \`${manifest.stamp}\``)
  lines.push(`- scope: \`${manifest.scopePath}\` (${manifest.scopeSource})`)
  lines.push(`- repository version: \`${manifest.repoVersion}\``)
  lines.push(`- started: ${manifest.startedAt}`)
  lines.push(`- finished: ${manifest.finishedAt}`)
  lines.push(`- machines: ${manifest.machines.length} (ok ${manifest.machines.filter((m) => m.ok).length})`)
  lines.push('')
  lines.push('## Machines')
  lines.push('')
  lines.push('| machine | web-all | preset files | transfer | checkouts | status |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const machine of manifest.machines) {
    const versions = Object.entries(machine.probe?.profiles || {})
      .map(([name, version]) => `${name}=${version}`)
      .join(' ')
    const presetFiles = machine.perSurface?.presets?.kept ?? 0
    const checkouts = machine.checkouts?.matched?.length
      ? machine.checkouts.matched.map((repo) => `${repo.repo.split('/').pop()}@${repo.branch}`).join(' ')
      : '-'
    const status = machine.ok ? (machine.dryRun ? 'listed' : 'collected') : `failed: ${machine.error}`
    lines.push(
      `| ${machine.name} | ${versions || '-'} | ${presetFiles} | ${formatBytes((machine.estimatedKilobytes || 0) * 1024)} | ${checkouts} | ${status} |`,
    )
  }
  lines.push('')
  const drifted = manifest.machines.filter((machine) => machine.drift && !machine.drift.baselineMissing)
  const ahead = manifest.machines.filter((machine) => machine.drift && machine.drift.baselineMissing)
  if (ahead.length > 0 || drifted.length > 0) {
    lines.push('## Preset drift against the repository baseline')
    lines.push('')
    for (const machine of [...ahead, ...drifted]) {
      const drift = machine.drift
      lines.push(`### ${machine.name} (preset \`${drift.preset}\`)`)
      lines.push('')
      if (drift.baselineMissing) {
        lines.push(
          `Repository baseline \`${manifest.baseline?.presetDir}\` is empty or missing: all ${drift.harvestedFiles} harvested files are ahead of the repository.`,
        )
      } else {
        lines.push(
          `harvested ${drift.harvestedFiles} files, baseline ${drift.baselineFiles}: +${drift.added.length} added, ~${drift.modified.length} modified, -${drift.removed.length} removed`,
        )
        for (const path of drift.added.slice(0, 25)) lines.push(`- added: \`${path}\``)
        if (drift.added.length > 25) lines.push(`- ... ${drift.added.length - 25} more added`)
        for (const path of drift.modified.slice(0, 25)) lines.push(`- modified: \`${path}\``)
        if (drift.modified.length > 25) lines.push(`- ... ${drift.modified.length - 25} more modified`)
      }
      lines.push('')
      const profiles = Object.entries(drift.profiles || {})
      if (profiles.length > 0) {
        lines.push('| profile | patch lines | mounted rows |')
        lines.push('| --- | --- | --- |')
        for (const [name, fact] of profiles.slice(0, 12)) {
          lines.push(`| ${name} | ${fact.lines} | ${fact.rows.length} |`)
        }
        lines.push('')
      }
    }
  }
  const withDropped = manifest.machines.filter((machine) => (machine.dropped || []).length > 0)
  if (withDropped.length > 0) {
    lines.push('## Files left behind')
    lines.push('')
    for (const machine of withDropped) {
      const byReason = new Map()
      for (const item of machine.dropped) {
        byReason.set(item.reason, (byReason.get(item.reason) || 0) + 1)
      }
      lines.push(
        `- ${machine.name}: ${[...byReason.entries()].map(([reason, count]) => `${reason}=${count}`).join(', ')}`,
      )
    }
    lines.push('')
  }
  const failures = manifest.machines.filter((machine) => !machine.ok)
  if (failures.length > 0) {
    lines.push('## Failures')
    lines.push('')
    for (const machine of failures) lines.push(`- ${machine.name}: ${machine.error}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

function repoVersion(root = repoRoot) {
  try {
    return JSON.parse(readFileSync(join(root, 'packages', 'dsh-web-all', 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

function updateLatestLink(harvestRoot, stamp) {
  const link = join(harvestRoot, 'latest')
  try {
    if (lstatSync(link)) unlinkSync(link)
  } catch {
    // No previous link is the normal first-run state.
  }
  try {
    symlinkSync(stamp, link, 'dir')
  } catch {
    // A filesystem without symlinks still has the timestamped directory.
  }
}

/** Launchd plist for the daily collection, kept inside the repository. */
export function renderSchedulePlist({ root = repoRoot, hour = 9, minute = 15 } = {}) {
  const scriptPath = join(root, 'scripts', 'dsh-fleet-collect.mjs')
  const logDir = join(root, '.harvest')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SCHEDULE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${scriptPath}</string>
    <string>--quiet</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${root}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${join(logDir, 'collect.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(logDir, 'collect.err.log')}</string>
</dict>
</plist>
`
}

/** The exact commands that install or remove the daily run, for an unsandboxed shell. */
export function renderScheduleInstructions({ root = repoRoot, hour = 9, minute = 15 } = {}) {
  const node = process.execPath
  const script = join(root, 'scripts', 'dsh-fleet-collect.mjs')
  const log = join(root, '.harvest', 'collect.log')
  return [
    'Install the daily collection from a shell outside the DSH file sandbox:',
    '',
    `  ${node} ${script} --install-schedule`,
    '',
    'Equivalent without launchd (cron, any OS):',
    '',
    `  (crontab -l 2>/dev/null; echo "${minute} ${hour} * * * cd ${root} && ${node} ${script} --quiet >> ${log} 2>&1") | crontab -`,
    '',
    `Remove it again with: ${node} ${script} --uninstall-schedule  (or crontab -e)`,
  ].join('\n')
}

export const SCHEDULE_PLIST_PATH = '.harvest/fleet-collect.launchd.plist'

async function installSchedule({ root = repoRoot } = {}) {
  const plistPath = join(root, SCHEDULE_PLIST_PATH)
  mkdirSync(dirname(plistPath), { recursive: true })
  writeFileSync(plistPath, renderSchedulePlist({ root }))
  const domain = `gui/${process.getuid ? process.getuid() : 501}`
  await execFileAsync('launchctl', ['bootout', domain, SCHEDULE_LABEL]).catch(() => {})
  await execFileAsync('launchctl', ['bootstrap', domain, plistPath])
  return { plistPath, domain }
}

async function uninstallSchedule() {
  const domain = `gui/${process.getuid ? process.getuid() : 501}`
  await execFileAsync('launchctl', ['bootout', domain, SCHEDULE_LABEL])
}

function formatTable(manifest) {
  const rows = manifest.machines.map((machine) => {
    const versions = Object.entries(machine.probe?.profiles || {})
      .map(([name, version]) => `${name}=${version}`)
      .join(',')
    const drift = machine.drift
      ? machine.drift.baselineMissing
        ? `ahead(${machine.drift.harvestedFiles})`
        : `+${machine.drift.added.length}/~${machine.drift.modified.length}/-${machine.drift.removed.length}`
      : '-'
    return [
      machine.name,
      versions || '-',
      String(machine.perSurface?.presets?.kept ?? 0),
      drift,
      machine.ok ? 'ok' : `FAIL ${machine.error}`,
    ].join('\t')
  })
  return ['machine\tweb-all\tpreset-files\tdrift\tstatus', ...rows].join('\n')
}

export async function main(argv = process.argv.slice(2), { env = process.env } = {}) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`fleet-collect: ${error.message}`)
    return 2
  }
  if (options.help) {
    console.log('Usage: node scripts/dsh-fleet-collect.mjs [--scope PATH] [--only NAME] [--dry-run] [--json] [--install-schedule|--uninstall-schedule|--print-schedule]')
    return 0
  }
  if (options.printSchedule) {
    console.log(renderScheduleInstructions())
    return 0
  }
  if (options.installSchedule || options.uninstallSchedule) {
    try {
      if (options.uninstallSchedule) {
        await uninstallSchedule()
        console.log(`fleet-collect: removed launchd job ${SCHEDULE_LABEL}`)
      } else {
        const { plistPath, domain } = await installSchedule()
        console.log(`fleet-collect: installed ${SCHEDULE_LABEL} in ${domain} from ${relative(repoRoot, plistPath)}`)
      }
      return 0
    } catch (error) {
      // Installing a login item or a crontab needs a shell outside the DSH file
      // sandbox; the command itself is printed so the operator can run it.
      console.error(`fleet-collect: schedule change failed: ${error.message}`)
      console.error('')
      console.error(renderScheduleInstructions())
      return 1
    }
  }

  let loaded
  try {
    loaded = loadScope({ env, options })
  } catch (error) {
    console.error(`fleet-collect: ${error.message}`)
    return 2
  }
  const { scope, path, source } = loaded
  if (source === 'template') {
    console.error(
      'fleet-collect: using the example scope; copy config/fleet-collect.example.json to config/fleet-collect.local.json and fill in the real machines',
    )
  }
  const requested = options.only.length > 0 ? new Set(options.only) : null
  const machines = scope.machines.filter((machine) => !requested || requested.has(machine.name))
  if (machines.length === 0) {
    console.error(`fleet-collect: no machine matched --only ${[...requested].join(',')}`)
    return 2
  }

  // Human progress goes to stderr in JSON mode so stdout stays one parseable document.
  const log = options.json ? (line) => console.error(line) : (line) => console.log(line)

  const stamp = options.stamp || stampNow()
  const harvestRoot = options.out ? resolve(options.out) : HARVEST_ROOT
  const outDir = join(harvestRoot, stamp)
  mkdirSync(outDir, { recursive: true })

  const manifest = {
    stamp,
    scopePath: path,
    scopeSource: source,
    repoVersion: repoVersion(),
    startedAt: isoNow(),
    finishedAt: null,
    baseline: scope.baseline,
    dryRun: options.dryRun,
    machines: [],
  }

  for (const machine of machines) {
    if (!options.quiet) log(`fleet-collect: ${machine.name} (${machine.ssh || 'local'})`)
    const record = await collectMachine(machine, scope, { outDir, dryRun: options.dryRun })
    record.dryRun = options.dryRun
    record.stamp = stamp
    if (!options.dryRun && record.ok) {
      record.drift = computeMachineDrift(join(outDir, machine.name), machine, scope)
      if (record.drift) writeJson(join(outDir, machine.name, 'drift.json'), record.drift)
    }
    if (!options.quiet) {
      const driftLabel = record.drift
        ? record.drift.baselineMissing
          ? ` ahead of baseline (${record.drift.harvestedFiles} files)`
          : ` +${record.drift.added.length}/~${record.drift.modified.length}/-${record.drift.removed.length}`
        : ''
      const shownBytes = record.bytes > 0 ? record.bytes : (record.estimatedKilobytes || 0) * 1024
      log(
        `  ${record.ok ? 'ok' : 'FAIL'}${record.ok ? ` files=${record.files.length} ${formatBytes(shownBytes)}${record.dryRun ? ' (estimated)' : ''}` : `: ${record.error}`}${driftLabel}`,
      )
    }
    manifest.machines.push(record)
  }

  manifest.finishedAt = isoNow()
  const report = renderHarvestReport(manifest)
  writeJson(join(outDir, 'manifest.json'), manifest)
  writeFileSync(join(outDir, 'HARVEST.md'), report)
  updateLatestLink(harvestRoot, stamp)

  if (options.json) {
    console.log(JSON.stringify(manifest, null, 2))
  } else if (!options.quiet) {
    console.log('')
    console.log(formatTable(manifest))
    console.log('')
    console.log(`fleet-collect: report ${relative(repoRoot, join(outDir, 'HARVEST.md'))}`)
  }
  return manifest.machines.every((machine) => machine.ok) ? 0 : 1
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code
  })
}
