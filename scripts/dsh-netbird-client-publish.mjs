#!/usr/bin/env node
/**
 * Publish the desktop client channel.
 *
 * The channel is the one address an employee needs before joining the network:
 *
 *   curl -fsSL https://anywhere.example.com/install.sh | sh
 *
 * It carries the installer, the onboarding page and the mirrored NetBird client
 * archives, so a fresh machine never has to reach github.com (measured on the
 * edge host: the release download stalls there) and never has to trust a file
 * without a checksum. `checksums.txt` is copied from the upstream release file
 * and cross-checked against the local archives, so a mirrored archive that does
 * not match upstream refuses to publish.
 *
 * The channel lives in its own static root (`/www/wwwroot/client`) next to the
 * APK root, because `tools/netbird-client/scripts/publish.sh` replaces its root
 * atomically - sharing one directory would let an APK release delete the
 * installer.
 *
 * Run from the project root. Deploy action: it writes to the edge host and is
 * meant to be run deliberately.
 *
 *   node scripts/dsh-netbird-client-publish.mjs [--version 0.78.1]
 *        [--dist ~/.dsh/client-dist] [--dry-run] [--skip-verify]
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEFAULT_VERSION = '0.78.1'
export const DEFAULT_MANAGEMENT_URL = 'https://netbird.example.com:443'
export const PUBLIC_BASE = 'https://anywhere.example.com'
/** Client archives this channel mirrors; every one of them is required. */
export const TARGETS = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'amd64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'linux', arch: 'amd64' },
  // Windows installs the same archive shape as the other platforms: upstream ships
  // netbird_<version>_windows_amd64.tar.gz, and the PowerShell installer unpacks it
  // with the bsdtar Windows 10 1803 and later carry.
  { os: 'windows', arch: 'amd64' },
]
/** Files shipped verbatim from the repository, not from the dist cache. */
export const SOURCE_FILES = ['install.sh', 'install.ps1', 'index.html', 'qr-phone.svg']

export const CLIENT_DIR = fileURLToPath(new URL('../tools/dsh-netbird/client/', import.meta.url))
/** The canonical vhost for the name: the site at the root, the channel beside it. */
export const VHOST_SOURCE = fileURLToPath(new URL('../tools/dsh-netbird/nginx-anywhere.conf', import.meta.url))
export const DEFAULT_REMOTE_VHOST = '/www/server/panel/vhost/nginx/anywhere.conf'

/**
 * The remote steps that install the vhost. The order is the whole point: back
 * the file up first, validate with `nginx -t` before reloading, and put the
 * backup back when validation fails, so a bad edit can never be loaded into
 * memory. Backups are named without a `.conf` suffix because the include
 * directory is globbed with `*.conf` and a `*.conf` backup would be parsed as a
 * second vhost (see tools/dsh-netbird/README.zh.md, troubleshooting).
 */
export function vhostScript({ remote, bodyBase64, stamp }) {
  const backup = `${remote}.bak-site-${stamp}`
  return [
    'set -e',
    `VHOST='${remote}'`,
    `test -f "$VHOST" || { echo "vhost missing: $VHOST"; exit 1; }`,
    `cp "$VHOST" '${backup}'`,
    `echo ${bodyBase64} | base64 -d > /tmp/aw-anywhere.conf`,
    `if cmp -s /tmp/aw-anywhere.conf "$VHOST"; then rm -f '${backup}'; echo "vhost: already current"; exit 0; fi`,
    `cp /tmp/aw-anywhere.conf "$VHOST"`,
    'if ! nginx -t 2>/tmp/aw-nginx-test.log; then',
    '  echo "nginx -t rejected the new vhost, restoring the backup"',
    '  cat /tmp/aw-nginx-test.log',
    `  cp '${backup}' "$VHOST"`,
    '  exit 1',
    'fi',
    'nginx -s reload',
    `echo "vhost: installed (backup ${backup})"`,
  ].join('\n')
}

export function artifactName(version, os, arch) {
  return `netbird_${version}_${os}_${arch}.tar.gz`
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Read the upstream checksum file (`<sha256>  <file>`, the release format) and
 * return the entries for `names`, refusing anything that does not match the
 * local archives byte for byte.
 */
export function buildChecksums({ names, digests, upstreamText }) {
  const upstream = new Map()
  for (const line of upstreamText.split('\n')) {
    const [digest, name] = line.trim().split(/\s+/)
    if (digest && name) upstream.set(name, digest)
  }
  const entries = []
  for (const name of names) {
    const local = digests[name]
    if (!local) throw new Error(`missing local archive for ${name}`)
    const expected = upstream.get(name)
    if (!expected) throw new Error(`${name} is not listed in the upstream checksum file`)
    if (expected !== local) throw new Error(`${name} does not match upstream: upstream=${expected} local=${local}`)
    entries.push({ name, sha256: local })
  }
  return entries
}

export function renderChecksums(entries) {
  return `${entries.map((entry) => `${entry.sha256}  ${entry.name}`).join('\n')}\n`
}

/** The text files the channel serves; each one is generated, never hand-edited. */
export function channelText({ version, managementUrl, entries }) {
  return {
    'latest.txt': `${version}\n`,
    'management-url.txt': `${managementUrl}\n`,
    'checksums.txt': renderChecksums(entries),
  }
}

export function parseArgs(argv) {
  const args = {
    version: DEFAULT_VERSION,
    dist: join(homedir(), '.dsh', 'client-dist'),
    managementUrl: DEFAULT_MANAGEMENT_URL,
    remoteHost: 'nb-tx',
    remoteRoot: '/www/wwwroot/client',
    remoteVhost: DEFAULT_REMOTE_VHOST,
    dryRun: false,
    skipVerify: false,
    skipVhost: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    switch (flag) {
      case '--version': args.version = value; i += 1; break
      case '--dist': args.dist = value; i += 1; break
      case '--management-url': args.managementUrl = value; i += 1; break
      case '--remote-host': args.remoteHost = value; i += 1; break
      case '--remote-root': args.remoteRoot = value; i += 1; break
      case '--remote-vhost': args.remoteVhost = value; i += 1; break
      case '--dry-run': args.dryRun = true; break
      case '--skip-verify': args.skipVerify = true; break
      case '--skip-vhost': args.skipVhost = true; break
      case '--help': args.help = true; break
      default: throw new Error(`unknown argument: ${flag}`)
    }
  }
  return args
}

export const HELP = `netbird desktop client channel

  node scripts/dsh-netbird-client-publish.mjs [options]

  --version <v>            client version to mirror (default ${DEFAULT_VERSION})
  --dist <dir>             cache holding the downloaded archives
  --management-url <url>   value served as management-url.txt
  --remote-host <host>     ssh host of the channel (default nb-tx)
  --remote-root <path>     static root on that host
  --remote-vhost <path>    canonical vhost on that host (${DEFAULT_REMOTE_VHOST})
  --dry-run                stage and report, upload nothing, touch nothing
  --skip-verify            skip the HTTPS checks after uploading
  --skip-vhost             publish the files only, leave the vhost alone
  --help
`

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  const distVersionDir = join(args.dist, args.version)
  const names = TARGETS.map((target) => artifactName(args.version, target.os, target.arch))

  const digests = {}
  for (const name of names) {
    const path = join(distVersionDir, name)
    digests[name] = sha256(readFileSync(path))
    console.log(`==> ${name} ${statSync(path).size} bytes sha256=${digests[name]}`)
  }
  const upstreamPath = join(distVersionDir, `netbird_${args.version}_checksums.txt`)
  const entries = buildChecksums({ names, digests, upstreamText: readFileSync(upstreamPath, 'utf8') })
  console.log(`==> all ${entries.length} archives match the upstream ${args.version} checksums`)

  const text = channelText({ version: args.version, managementUrl: args.managementUrl, entries })
  const stage = mkdtempSync(join(tmpdir(), 'aw-channel-'))
  for (const file of SOURCE_FILES) {
    // Preserve the source mtime: rsync then skips unchanged files, so a page
    // edit does not re-upload 57 MB of archives.
    cpSync(join(CLIENT_DIR, file), join(stage, file), { preserveTimestamps: true })
    chmodSync(join(stage, file), 0o644)
  }
  for (const [name, body] of Object.entries(text)) writeFileSync(join(stage, name), body)
  for (const name of names) cpSync(join(distVersionDir, name), join(stage, name), { preserveTimestamps: true })
  console.log(`==> staged ${SOURCE_FILES.length + names.length + Object.keys(text).length} files in ${stage}`)

  if (args.dryRun) {
    console.log(`==> dry run: vhost ${args.remoteVhost} left as it is, nothing uploaded`)
    for (const file of [...SOURCE_FILES, ...Object.keys(text), ...names]) console.log(`    ${file}`)
    rmSync(stage, { recursive: true, force: true })
    return
  }

  if (args.skipVhost) {
    console.log('==> vhost: skipped (--skip-vhost)')
  } else {
    console.log(`==> vhost: ${args.remoteHost}:${args.remoteVhost}`)
    const body = readFileSync(VHOST_SOURCE)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const output = execFileSync('ssh', [
      args.remoteHost,
      vhostScript({ remote: args.remoteVhost, bodyBase64: body.toString('base64'), stamp }),
    ], { encoding: 'utf8' })
    for (const line of output.trim().split('\n')) console.log(`    ${line}`)
  }

  const staging = `${args.remoteRoot}.staging`
  const previous = `${args.remoteRoot}.previous`
  const ssh = (command) => execFileSync('ssh', [args.remoteHost, command], { stdio: 'inherit' })
  console.log(`==> upload to ${args.remoteHost}:${args.remoteRoot}`)
  ssh(`rm -rf '${staging}' && mkdir -p '${staging}'`)
  execFileSync('rsync', ['-a', '--partial', '--inplace', `${stage}/`, `${args.remoteHost}:${staging}/`], { stdio: 'inherit' })
  ssh([
    'set -e',
    `test -s '${staging}/install.sh'`,
    `test -s '${staging}/index.html'`,
    `test -s '${staging}/checksums.txt'`,
    `rm -rf '${previous}'`,
    `if [ -d '${args.remoteRoot}' ]; then mv '${args.remoteRoot}' '${previous}'; fi`,
    `mv '${staging}' '${args.remoteRoot}'`,
    `rm -rf '${previous}'`,
    `chown -R www:www '${args.remoteRoot}'`,
    `chmod 0755 '${args.remoteRoot}'`,
    `find '${args.remoteRoot}' -type d -exec chmod 0755 {} +`,
    `find '${args.remoteRoot}' -type f -exec chmod 0644 {} +`,
  ].join(' && '))
  rmSync(stage, { recursive: true, force: true })
  console.log('==> uploaded')

  if (args.skipVerify) return
  verify({ entries, text, version: args.version, distVersionDir })
  console.log('\n==> employees install with:')
  console.log(`    curl -fsSL ${PUBLIC_BASE}/install.sh | sh`)
  console.log(`    phones: ${PUBLIC_BASE}/`)
}

/**
 * Fetch the published channel over HTTPS and compare every byte with what we
 * staged. The transport is injectable so the comparison logic itself is tested
 * without a network.
 */
export function verify({ entries, text, version, distVersionDir, base = PUBLIC_BASE, io = channelIO }) {
  const local = (name) => readFileSync(join(CLIENT_DIR, name))
  const expect = (label, actual, wanted) => {
    if (actual !== wanted) throw new Error(`${label}: served content differs from what was published`)
    console.log(`    ok ${label}`)
  }

  console.log(`==> verify ${base}`)
  // The site owns the root; /client/ is only the archives' address now and
  // points back at the page, so a stale link cannot land on a second copy.
  expect('/ (the site)', sha256(io.bytes(`${base}/`)), sha256(local('index.html')))
  expect('/qr-phone.svg (phone handoff code)', sha256(io.bytes(`${base}/qr-phone.svg`)), sha256(local('qr-phone.svg')))
  expect('/client/ -> / (old address)', io.redirect(`${base}/client/`), `301 ${base}/`)
  expect('/install.sh (the one-liner)', sha256(io.bytes(`${base}/install.sh`)), sha256(local('install.sh')))
  expect('/client/checksums.txt', sha256(io.bytes(`${base}/client/checksums.txt`)), sha256(Buffer.from(text['checksums.txt'])))
  expect('/client/management-url.txt', io.bytes(`${base}/client/management-url.txt`).toString(), text['management-url.txt'])
  expect('/client/latest.txt', io.bytes(`${base}/client/latest.txt`).toString(), `${version}\n`)
  for (const entry of entries) {
    const url = `${base}/client/${entry.name}`
    expect(`${entry.name} content-length`, io.head(url)['content-length'], String(statSync(join(distVersionDir, entry.name)).size))
    expect(`${entry.name} resumable 1 MiB range`, io.range(url), '206 1048576')
  }
  console.log('==> channel verified')
}

/** The real channel is HTTPS on the edge host; curl is the transport we ship. */
export const channelIO = {
  bytes: (url) => execFileSync('curl', ['-fsS', '-m', '30', url], { encoding: 'buffer' }),
  head: (url) => execFileSync('curl', ['-fsSI', '-m', '30', url], { encoding: 'utf8' })
    .trim().split('\n').reduce((acc, line) => {
      const index = line.indexOf(':')
      if (index > 0) acc[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
      return acc
    }, {}),
  redirect: (url) => execFileSync('curl', ['-fsS', '-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', '-m', '20', url], { encoding: 'utf8' }),
  range: (url) => execFileSync('curl', ['-fsS', '-r', '0-1048575', '-o', '/dev/null', '-w', '%{http_code} %{size_download}', '-m', '60', url], { encoding: 'utf8' }),
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`error: ${error.message}`)
    process.exit(1)
  }
}