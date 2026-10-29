#!/usr/bin/env node
/**
 * The TLS entry, served for real and read by the app's own runtime.
 *
 * `scripts/dsh-netbird-tls.mjs` issues the certificate material and
 * `tools/dsh-netbird/nginx.conf.template` declares the entries; this run proves the
 * two together end to end: it issues a CA and a leaf for this machine's canonical
 * name, renders the template into a private nginx prefix on loopback ports, starts
 * nginx with that leaf in front of the running DSH, verifies the handshake the way a
 * client does, and loads both entries in Electron to read what the page is given.
 *
 * The point of the run is one capability: plaintext HTTP is not a secure context, so
 * `navigator.mediaDevices` - what the official voice-input plugin checks before it
 * can record - does not exist on the plaintext entry, and does exist on the TLS one.
 *
 *   node poc/tls-entry.mjs [--electron <path>] [--nginx <path>] [--machine <name>] [--out <dir>]
 */
import { spawn, spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

import { machineLabel } from '../agent/kernel.mjs'
import { ensureCa, issueLeaf, materialPaths, verifyEntry } from '../../../scripts/dsh-netbird-tls.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const TEMPLATE = join(REPO_ROOT, 'tools', 'dsh-netbird', 'nginx.conf.template')

function parseArgs(argv) {
  const args = {
    electron: process.env.AW_ELECTRON ?? '',
    nginx: '/opt/homebrew/opt/nginx/bin/nginx',
    machine: declaredMachine() || machineLabel(hostname()),
    out: join(HERE, 'evidence'),
  }
  const values = { '--electron': 'electron', '--nginx': 'nginx', '--machine': 'machine', '--out': 'out' }
  for (let index = 0; index < argv.length; index += 1) {
    const key = values[argv[index]]
    if (key === undefined) continue
    args[key] = argv[index + 1]
    index += 1
  }
  return args
}

/**
 * The canonical machine name this host's own launcher declares.
 *
 * `dsh.<machine>.netbird` is not the operating system's host name - the fleet names
 * machines in NetBird - and the host-access fence admits only the authority the
 * launcher was started with, so a run that wants the fence to answer has to use the
 * name the machine actually declares rather than a derived guess.
 *
 * @returns {string} the machine name, or '' when there is no launcher to read
 */
function declaredMachine(home = homedir()) {
  try {
    const launcher = readFileSync(join(home, '.dsh', 'bin', 'start-dsh-web.sh'), 'utf8')
    const authority = launcher.match(/--trusted-host\s+(\S+)/)?.[1] ?? ''
    const machine = authority.replace(/^dsh\./, '').replace(/\.netbird$/, '')
    return machine === authority ? '' : machine
  } catch {
    return ''
  }
}

const args = parseArgs(process.argv.slice(2))
const stateDir = join(args.out, 'tls-entry')
rmSync(stateDir, { recursive: true, force: true })
mkdirSync(stateDir, { recursive: true })

let failures = 0
function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (!ok) failures += 1
  process.stdout.write(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}\n`,
  )
}

/** A free loopback port, so the run never fights the machine's real entries. */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** Waits until the entry answers a TLS handshake, or gives up. */
async function waitForTls(host, port, caPath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await verifyEntry({ host, ip: '127.0.0.1', port, caPath, timeoutMs: 2_000 })
    if (result.ok) return result
    if (Date.now() > deadline) return result
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** One GET over TLS with the name in SNI and in Host, the way a browser sends it. */
function readPosture({ host, port, caPath }) {
  const ca = readFileSync(caPath)
  return new Promise((resolve) => {
    const request = https.request(
      { host: '127.0.0.1', port, servername: host, ca, headers: { Host: host }, path: '/api/dsh-access/session' },
      (response) => {
        let body = ''
        response.on('data', (chunk) => {
          body += chunk.toString()
        })
        response.on('end', () => resolve({ status: response.statusCode, body }))
      },
    )
    request.on('error', (error) => resolve({ status: null, body: String(error?.message ?? error) }))
    request.end()
  })
}

/** One Electron reading of one URL, through the harness window. */
function readInApp(url, caPath, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(args.electron, [
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${join(stateDir, 'electron')}`,
      `--host-resolver-rules=MAP ${new URL(url).hostname} 127.0.0.1`,
      join(HERE, 'tls-entry-app.mjs'),
      '--ca',
      caPath,
      '--url',
      url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ facts: null, error: `no reading within ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
      const line = out.split('\n').find((candidate) => candidate.startsWith('FACTS ') || candidate.startsWith('FACTS_ERROR '))
      if (line === undefined) return
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(line.startsWith('FACTS_ERROR ')
        ? { facts: null, error: line.slice('FACTS_ERROR '.length) }
        : { facts: JSON.parse(line.slice('FACTS '.length)) })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ facts: null, error: String(error?.message ?? error) })
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve({ facts: null, error: 'the harness exited without a reading' })
    })
  })
}

if (!existsSync(TEMPLATE)) {
  throw new Error(`missing ${TEMPLATE}`)
}
if (!existsSync(args.electron)) {
  throw new Error(`no Electron runtime at ${args.electron}; pass --electron <path>`)
}
if (!existsSync(args.nginx)) {
  throw new Error(`no nginx at ${args.nginx}; pass --nginx <path>`)
}

const host = `dsh.${args.machine}.netbird`
const materialDir = join(stateDir, 'tls')
const ca = ensureCa(materialDir)
const caCert = new X509Certificate(readFileSync(ca.cert))
process.stdout.write(`issued material for ${host} in ${materialDir}\n`)

const leaf = issueLeaf(materialDir, host, { caCert })

const httpPort = await freePort()
const tlsPort = await freePort()
const prefix = join(stateDir, 'nginx')
mkdirSync(join(prefix, 'tmp'), { recursive: true })

// One rendering of the canonical template for this run: the machines' real ports
// belong to the machine (80 and 443), which a poc must not take, and the worker
// temp paths belong under the run's own prefix.
const rendered = readFileSync(TEMPLATE, 'utf8')
  .replaceAll('__MACHINE__', args.machine)
  .replaceAll('__NETBIRD_IP__', '127.0.0.1')
  .replaceAll('__TLS_DIR__', materialDir)
  .replaceAll('/var/tmp/dsh-nginx', join(prefix, 'tmp'))
  .replace('listen 127.0.0.1:80;', `listen 127.0.0.1:${httpPort};`)
  .replace('listen 127.0.0.1:443 ssl;', `listen 127.0.0.1:${tlsPort} ssl;`)
writeFileSync(join(prefix, 'dsh.conf'), rendered)
writeFileSync(join(prefix, 'nginx.conf'), [
  'worker_processes 1;',
  `error_log ${join(prefix, 'error.log')} info;`,
  `pid ${join(prefix, 'nginx.pid')};`,
  'events { worker_connections 64; }',
  'http {',
  `    access_log ${join(prefix, 'access.log')};`,
  `    client_body_temp_path ${join(prefix, 'tmp', 'client_body')};`,
  `    proxy_temp_path ${join(prefix, 'tmp', 'proxy')};`,
  `    include ${join(prefix, 'dsh.conf')};`,
  '}',
  '',
].join('\n'))

// `-e` pins the early error log: nginx opens the compiled-in default before it reads
// the configuration, and on this host that default is not where a run may write.
const test = spawnSync(args.nginx, ['-t', '-e', join(prefix, 'error.log'), '-p', prefix, '-c', join(prefix, 'nginx.conf')], { encoding: 'utf8' })
if (test.status !== 0) {
  process.stdout.write(`${test.stdout ?? ''}${test.stderr ?? ''}`)
  throw new Error('the rendered template does not load; see the nginx output above')
}
process.stdout.write('rendered template loads in nginx\n')

const nginx = spawn(args.nginx, ['-e', join(prefix, 'error.log'), '-p', prefix, '-c', join(prefix, 'nginx.conf'), '-g', 'daemon off;'], {
  stdio: ['ignore', 'ignore', 'pipe'],
})
let nginxErrors = ''
nginx.stderr.on('data', (chunk) => {
  nginxErrors += chunk.toString()
})

try {
  const handshake = await waitForTls(host, tlsPort, materialPaths(materialDir, 'ca').caCert)
  check('the TLS entry answers a chain a client can build', handshake.ok, true)
  if (handshake.ok) {
    process.stdout.write(`      leaf subject=${handshake.subject} notAfter=${handshake.validTo} san=${handshake.san}\n`)
  }

  const posture = await readPosture({ host, port: tlsPort, caPath: materialPaths(materialDir, 'ca').caCert })
  let declared = false
  try {
    declared = JSON.parse(posture.body)?.authority?.declared === true
  } catch {
    declared = false
  }
  check('the fence still admits the canonical authority over TLS', declared, true)
  if (!declared) {
    process.stdout.write(`      posture reading: HTTP ${posture.status} ${posture.body.slice(0, 200)}\n`)
  }

  const secure = await readInApp(`https://${host}:${tlsPort}/`, materialPaths(materialDir, 'ca').caCert)
  if (secure.facts === null) {
    check('the app loads the TLS entry', secure.error, null)
  } else {
    check('the TLS entry is a secure context', secure.facts.isSecureContext, true)
    check('the microphone API exists there', secure.facts.mediaDevices, 'object')
    check('so the recorder can start', secure.facts.MediaRecorder, 'function')
  }

  const plain = await readInApp(`http://${host}:${httpPort}/`, materialPaths(materialDir, 'ca').caCert)
  if (plain.facts === null) {
    check('the app loads the plaintext entry', plain.error, null)
  } else {
    check('the plaintext entry is not a secure context', plain.facts.isSecureContext, false)
    check('and has no microphone API', plain.facts.mediaDevices, 'undefined')
  }

  writeFileSync(join(stateDir, 'evidence.json'), `${JSON.stringify({
    host,
    httpPort,
    tlsPort,
    handshake,
    posture: { status: posture.status, declared },
    secure: secure.facts,
    plaintext: plain.facts,
    leaf,
  }, null, 2)}\n`)
} finally {
  nginx.kill('SIGTERM')
  if (nginxErrors.trim() !== '') {
    process.stdout.write(`nginx said:\n${nginxErrors}`)
  }
}

process.stdout.write(failures === 0
  ? `tls entry holds: plaintext has no microphone API, the TLS entry does (evidence in ${join(stateDir, 'evidence.json')})\n`
  : `${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)