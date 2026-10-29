#!/usr/bin/env node
/**
 * TLS material for the overlay entry.
 *
 * The fleet's canonical entry is a plain-HTTP origin, and a browser fact follows:
 * plaintext HTTP is not a secure context. The plugin compensates for the two
 * capabilities that can be polyfilled (`crypto.randomUUID`, `navigator.clipboard`),
 * but a capability that needs a real permission - microphone capture for voice
 * input, for one - cannot be faked from the page: `navigator.mediaDevices` does
 * not exist outside a secure context, and the official voice-input plugin reports
 * "this browser cannot record" for exactly that missing object.
 *
 * The remedy is an HTTPS entry on the same canonical name, so this script owns the
 * certificate material it needs: one private CA for the fleet, plus one leaf per
 * machine whose SAN is `dsh.<machine>.<zone>`, both issued through the same
 * `domainPattern` the machine inventory declares.
 *
 * Everything private stays outside the repository. The default directory is
 * `~/.dsh/tls`, and a `--dir` inside this checkout is refused rather than trusted,
 * because a CA key committed once cannot be un-leaked.
 *
 * Usage:
 *   node scripts/dsh-netbird-tls.mjs init
 *   node scripts/dsh-netbird-tls.mjs issue studio-mac laptop-b
 *   node scripts/dsh-netbird-tls.mjs verify --host dsh.studio-mac.netbird --ip 100.64.0.11
 *   node scripts/dsh-netbird-tls.mjs trust
 */
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { MACHINES_PATH, parseInventory } from './dsh-netbird-mobile-registry.mjs'

/** Where the fleet's private material lives when no directory is given. */
export const DEFAULT_TLS_DIR = join(homedir(), '.dsh', 'tls')

/** The CA name that appears in every leaf's issuer, and in the trust store. */
export const CA_COMMON_NAME = 'dsh-cove fleet CA'

/** Long-lived, because a root is distributed by hand to every client. */
export const CA_DAYS = 3650

/** Inside the 398-day ceiling the public CAs converged on, with room to rotate. */
export const LEAF_DAYS = 825

/** A leaf this close to expiry is reissued instead of kept. */
export const RENEW_WITHIN_DAYS = 30

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Key and certificate file names for one canonical host. */
export function materialPaths(dir, host) {
  return {
    caKey: join(dir, 'ca.key'),
    caCert: join(dir, 'ca.crt'),
    caSerial: join(dir, 'ca.srl'),
    key: join(dir, `${host}.key`),
    csr: join(dir, `${host}.csr`),
    cert: join(dir, `${host}.crt`),
  }
}

/**
 * The canonical name of one machine, from the inventory's own pattern.
 *
 * @param {string} machine NetBird machine name
 * @param {string} pattern `dsh.<netbird-machine-name>.<zone>`
 * @returns {string} the canonical authority, and the leaf's only SAN
 */
export function entryHostFor(machine, pattern) {
  const name = String(machine ?? '').trim()
  if (name === '' || name.includes('.') || name.includes('/')) {
    throw new Error(`machine name must be a single label, got ${JSON.stringify(machine)}`)
  }
  return pattern.replace('<netbird-machine-name>', name)
}

/**
 * Refuses a directory inside this checkout.
 *
 * The point of the rule is not tidiness: a CA private key that reaches a commit
 * cannot be withdrawn, and every leaf it signed has to be reissued. Failing here
 * is the only cheap moment to stop that.
 *
 * @param {string} dir resolved directory
 * @returns {string} the resolved directory, when it is outside the repository
 */
export function assertOutsideRepo(dir) {
  const resolved = resolve(dir)
  const inside = resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}${sep}`)
  if (inside) {
    throw new Error(
      `refusing to keep private CA material inside the repository (${relative(REPO_ROOT, resolved) || '.'}); ` +
        `use ${DEFAULT_TLS_DIR} or another --dir outside the checkout`,
    )
  }
  return resolved
}

/** The openssl configuration that carries the extensions, portable across LibreSSL and OpenSSL. */
function opensslConfig() {
  return [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    '',
    '[dn]',
    `CN = ${CA_COMMON_NAME}`,
    '',
    '[v3_ca]',
    'basicConstraints = critical,CA:TRUE',
    'keyUsage = critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier = hash',
    '',
  ].join('\n')
}

/** One leaf's extensions: server authentication, and exactly the canonical name. */
function leafExtensions(host) {
  return [
    '[v3_leaf]',
    'basicConstraints = critical,CA:FALSE',
    'keyUsage = critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectKeyIdentifier = hash',
    `subjectAltName = DNS:${host}`,
    '',
  ].join('\n')
}

function openssl(args, options = {}) {
  try {
    return execFileSync('openssl', args, { encoding: 'utf8', stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = String(error?.stderr ?? '').trim() || String(error?.message ?? error)
    if (error?.code === 'ENOENT') {
      throw new Error('openssl is not on PATH; install it (macOS: brew install openssl@3) and retry')
    }
    throw new Error(`openssl ${args[0]} failed: ${detail}`)
  }
}

function withTempConfig(contents, run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tls-'))
  const path = join(dir, 'openssl.cnf')
  writeFileSync(path, contents)
  try {
    return run(path)
  } finally {
    execFileSync('rm', ['-rf', dir], { stdio: 'ignore' })
  }
}

/** Days until `notAfter`, negative when already expired. */
export function daysUntil(notAfter) {
  const at = Date.parse(notAfter)
  if (Number.isNaN(at)) {
    return Number.NEGATIVE_INFINITY
  }
  return Math.floor((at - Date.now()) / 86_400_000)
}

/**
 * Whether an existing leaf still answers for this host under this CA.
 *
 * A kept leaf is the same bytes on reload, which is what makes `issue` safe to run
 * over a live fleet: nginx reloads read the file, they do not expect a new identity
 * every time the script runs.
 *
 * @param {string} keyPath
 * @param {string} certPath
 * @param {string} host
 * @param {X509Certificate} caCert
 * @returns {boolean}
 */
export function leafStillValid(certPath, host, caCert) {
  if (!existsSync(certPath)) {
    return false
  }
  let leaf
  try {
    leaf = new X509Certificate(readFileSync(certPath))
  } catch {
    return false
  }
  if (!leaf.checkIssued(caCert)) {
    return false
  }
  // `checkIssued` compares the issuer name and key usage, and every root this script
  // mints carries the same common name: a leaf of a *rotated* root would pass that
  // check and be kept, serving a chain no client can build. The signature is what
  // actually ties the leaf to this root.
  if (!leaf.verify(caCert.publicKey)) {
    return false
  }
  const names = String(leaf.subjectAltName ?? '')
    .split(',')
    .map(part => part.trim().replace(/^DNS:/, ''))
  if (!names.includes(host)) {
    return false
  }
  return daysUntil(leaf.validTo) > RENEW_WITHIN_DAYS
}

/**
 * Creates the fleet CA when it is missing.
 *
 * @param {string} dir
 * @returns {{ created: boolean, cert: string }}
 */
export function ensureCa(dir) {
  const paths = materialPaths(dir, 'ca')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (existsSync(paths.caKey) && existsSync(paths.caCert)) {
    return { created: false, cert: paths.caCert }
  }
  if (existsSync(paths.caKey) !== existsSync(paths.caCert)) {
    throw new Error(`${dir} holds half a CA (one of ca.key and ca.crt); remove the orphan before re-running`)
  }
  withTempConfig(opensslConfig(), config => {
    openssl([
      'req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes',
      '-days', String(CA_DAYS), '-config', config, '-extensions', 'v3_ca',
      '-keyout', paths.caKey, '-out', paths.caCert,
    ])
  })
  chmodSync(paths.caKey, 0o600)
  chmodSync(paths.caCert, 0o644)
  return { created: true, cert: paths.caCert }
}

/**
 * Issues (or keeps) one machine's leaf certificate.
 *
 * @param {string} dir
 * @param {string} host canonical authority
 * @param {{ rotate?: boolean, caCert?: X509Certificate }} [options]
 * @returns {{ host: string, cert: string, key: string, issued: boolean }}
 */
export function issueLeaf(dir, host, options = {}) {
  const paths = materialPaths(dir, host)
  const caCert = options.caCert ?? new X509Certificate(readFileSync(paths.caCert))
  if (!options.rotate && leafStillValid(paths.cert, host, caCert)) {
    return { host, cert: paths.cert, key: paths.key, issued: false }
  }
  withTempConfig(leafExtensions(host), config => {
    openssl([
      'req', '-new', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-subj', `/CN=${host}`, '-keyout', paths.key, '-out', paths.csr,
    ])
    openssl([
      'x509', '-req', '-in', paths.csr, '-sha256', '-days', String(LEAF_DAYS),
      '-CA', paths.caCert, '-CAkey', paths.caKey, '-CAcreateserial', '-CAserial', paths.caSerial,
      '-extfile', config, '-extensions', 'v3_leaf', '-out', paths.cert,
    ])
  })
  chmodSync(paths.key, 0o600)
  chmodSync(paths.cert, 0o644)
  execFileSync('rm', ['-f', paths.csr], { stdio: 'ignore' })
  return { host, cert: paths.cert, key: paths.key, issued: true }
}

/**
 * Reads a machine's canonical name from the inventory, so a host is never typed twice.
 *
 * @param {string} repoRoot
 * @param {string} machine
 * @returns {string}
 */
export function hostFromInventory(repoRoot, machine) {
  const inventory = parseInventory(readFileSync(join(repoRoot, MACHINES_PATH), 'utf8'))
  const domain = inventory.machines.get(machine)
  if (!domain) {
    throw new Error(`${MACHINES_PATH} declares no machine named ${machine}`)
  }
  return domain
}

/**
 * Handshakes the live entry the way a browser will: chain through the fleet CA,
 * and the host name checked against the leaf.
 *
 * @param {{ host: string, ip?: string, port?: number, caPath: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, reason?: string, subject?: string, validTo?: string, san?: string }>}
 */
export function verifyEntry(options) {
  const { host, ip, port = 443, caPath, timeoutMs = 10_000 } = options
  const ca = readFileSync(caPath)
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (!settled) {
        settled = true
        socket.destroy()
        resolve(value)
      }
    }
    const socket = tls.connect(
      { host: ip ?? host, port, servername: host, ca, rejectUnauthorized: true },
      () => {
        const peer = socket.getPeerX509Certificate()
        finish({
          ok: true,
          subject: peer?.subject ?? '',
          validTo: peer?.validTo ?? '',
          san: String(peer?.subjectAltName ?? ''),
        })
      },
    )
    socket.setTimeout(timeoutMs, () => finish({ ok: false, reason: `timeout after ${timeoutMs}ms` }))
    socket.on('error', error => finish({ ok: false, reason: String(error?.code ?? error?.message ?? error) }))
  })
}

/**
 * How a client machine starts trusting the fleet CA.
 *
 * Android is deliberately absent: GeckoView keeps its own root store and does not
 * read the platform's user certificates, so the mobile client stays on the
 * plaintext entry - which is why the HTTP vhost keeps serving.
 *
 * @param {string} caPath
 * @returns {Array<{ platform: string, command: string }>}
 */
export function trustCommands(caPath) {
  return [
    {
      platform: 'macOS (Chrome and the desktop app read the system keychain)',
      command:
        `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${caPath}`,
    },
    {
      platform: 'Debian/Ubuntu',
      command:
        `sudo cp ${caPath} /usr/local/share/ca-certificates/dsh-netbird-ca.crt && sudo update-ca-certificates`,
    },
    {
      platform: 'RHEL/Fedora',
      command: `sudo cp ${caPath} /etc/pki/ca-trust/source/anchors/dsh-netbird-ca.crt && sudo update-ca-trust`,
    },
  ]
}

function usage() {
  return [
    'usage:',
    '  dsh-netbird-tls.mjs init [--dir DIR]',
    '  dsh-netbird-tls.mjs issue <machine...> [--dir DIR] [--rotate] [--host <name>]',
    '  dsh-netbird-tls.mjs verify --host <name> [--ip <addr>] [--port 443] [--dir DIR]',
    '  dsh-netbird-tls.mjs trust [--dir DIR]',
    '',
    `  --dir defaults to ${DEFAULT_TLS_DIR} and must stay outside the repository`,
  ].join('\n')
}

function parseArgs(argv) {
  const args = { command: argv[0] ?? '', machines: [], dir: DEFAULT_TLS_DIR, host: '', ip: '', port: 443, rotate: false }
  const takesValue = { '--dir': 'dir', '--host': 'host', '--ip': 'ip' }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--rotate') {
      args.rotate = true
      continue
    }
    if (token === '--port') {
      args.port = Number(argv[index + 1])
      index += 1
      continue
    }
    if (takesValue[token]) {
      args[takesValue[token]] = argv[index + 1] ?? ''
      index += 1
      continue
    }
    if (token.startsWith('--')) {
      throw new Error(`unknown option ${token}`)
    }
    args.machines.push(token)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === '' || args.command === '--help' || args.command === '-h') {
    console.log(usage())
    return
  }
  const dir = assertOutsideRepo(isAbsolute(args.dir) ? args.dir : resolve(process.cwd(), args.dir))

  if (args.command === 'init') {
    const ca = ensureCa(dir)
    console.log(`${ca.created ? 'created' : 'kept'} CA ${ca.cert}`)
    console.log('next: distribute ca.crt to every client machine, then `issue <machine...>` per machine')
    return
  }

  if (args.command === 'issue') {
    const ca = ensureCa(dir)
    if (args.machines.length === 0 && args.host === '') {
      throw new Error('issue needs at least one machine name (or --host for a name outside the inventory)')
    }
    const caCert = new X509Certificate(readFileSync(ca.cert))
    const hosts = args.host !== ''
      ? [args.host]
      : args.machines.map(machine => hostFromInventory(REPO_ROOT, machine))
    for (const host of hosts) {
      const result = issueLeaf(dir, host, { rotate: args.rotate, caCert })
      console.log(`${result.issued ? 'issued' : 'kept'} ${host}: ${result.cert} + ${result.key}`)
    }
    return
  }

  if (args.command === 'verify') {
    if (args.host === '') {
      throw new Error('verify needs --host <canonical name>')
    }
    const result = await verifyEntry({ host: args.host, ip: args.ip || undefined, port: args.port, caPath: materialPaths(dir, 'ca').caCert })
    if (!result.ok) {
      throw new Error(`${args.host}:${args.port} did not verify against ${dir}/ca.crt (${result.reason})`)
    }
    console.log(`ok ${args.host}:${args.port} subject=${result.subject} notAfter=${result.validTo} san=${result.san}`)
    return
  }

  if (args.command === 'trust') {
    for (const entry of trustCommands(materialPaths(dir, 'ca').caCert)) {
      console.log(`# ${entry.platform}\n${entry.command}`)
    }
    return
  }

  throw new Error(`unknown command ${args.command}\n${usage()}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`dsh-netbird-tls: ${String(error?.message ?? error)}`)
    process.exit(1)
  })
}