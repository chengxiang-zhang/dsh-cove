/**
 * The desktop client installer is the first thing an employee runs, so it is
 * tested without touching the network, the real channel or a real client: a
 * fake channel on disk (`file://`) serves fake archives, and a fake netbird
 * binary records what the installer asked it to do.
 *
 * What matters here is the contract, not the plumbing: the published installer
 * must refuse an archive that does not match the channel checksums, must not
 * install anything when it refuses, must leave an already-installed client
 * alone, and must not need a terminal (it runs under `curl | sh`, where stdin
 * is the script itself).
 *
 * The second half of the file covers the product command the installer adds
 * next to the client binary. The brand rule is that the vendor's name is not
 * what users operate, so `anywhere` is the command on the onboarding page; the
 * tests below hold the line that it is additive (the client binary keeps its
 * own name, contents and behavior), that its status and machine list are
 * derived from the client's own machine-readable output, that it forwards exit
 * codes unchanged, and that an absent client produces a clear message rather
 * than a shell error.
 *
 *   node --test scripts/dsh-netbird-client-install.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../tools/dsh-netbird/client/install.sh', import.meta.url))
const VERSION = '0.78.1'
const TARGETS = [
  ['darwin', 'arm64'], ['darwin', 'amd64'], ['linux', 'arm64'], ['linux', 'amd64'],
]
const ARTIFACTS = TARGETS.map(([os, arch]) => `netbird_${VERSION}_${os}_${arch}.tar.gz`)
const FLAGS = ['--dry-run', '--no-service', '--no-login', '--no-dsh', '--dsh-version', '--force', '--bin-dir', '--channel', '--management-url', '--profile', '--no-browser', '--qr', '--uninstall', '--help']

/**
 * What `status --json` prints: the shape netbird's own OutputOverview marshals,
 * compact and with management/signal as objects carrying a boolean. A peer's
 * fqdn sits next to this device's fqdn, which is exactly the ambiguity the
 * command has to resolve by position rather than by name.
 */
const STATUS_JSON = JSON.stringify({
  peers: {
    total: 2,
    connected: 2,
    details: [
      { fqdn: 'alpha.vpn', netbirdIp: '100.99.0.5', status: 'Connected', networks: ['10.0.0.0/24'] },
      { fqdn: 'beta.vpn', netbirdIp: '100.99.0.6', status: 'Connected' },
    ],
  },
  management: { connected: true, url: 'https://mgmt.example.test:443' },
  signal: { connected: true, url: 'https://signal.example.test:443' },
  fqdn: 'fake-machine.vpn',
  daemonStatus: 'Connected',
  daemonVersion: VERSION,
})

/** A client that answers the way the installer interrogates it. */
const FAKE_NETBIRD = `#!/bin/sh
if [ -n "\${AW_FAKE_LOG:-}" ]; then printf '%s\\n' "$*" >> "$AW_FAKE_LOG"; fi
case "$1" in
  version) echo ${VERSION}-fake ;;
  status)
    case "\${2:-}" in
      --ipv4) echo 100.99.0.7; exit 0 ;;
      --json) printf '%s\\n' '${STATUS_JSON}'; exit 0 ;;
    esac
    echo "Daemon status: Connected"
    echo "Management: Connected"
    echo "Signal: Connected"
    echo "FQDN: fake-machine.vpn"
    echo "NetBird IP: 100.99.0.7"
    echo "Peers count: 2/2 Connected"
    ;;
  down) : ;;
  up) exit "\${AW_FAKE_UP_CODE:-0}" ;;
  service) : ;;
esac
exit 0
`

/** A client too old to speak `status --json`; it must still be usable through the command. */
const FAKE_NETBIRD_NO_JSON = `#!/bin/sh
case "$1" in
  version) echo ${VERSION}-fake ;;
  status)
    case "\${2:-}" in
      --json) echo "unknown flag: --json" >&2; exit 1 ;;
      --detail) echo "Peers detail:"; echo " alpha.vpn:"; echo "  NetBird IP: 100.99.0.5" ;;
    esac
    echo "Daemon status: Connected"
    echo "Management: Connected"
    echo "Signal: Connected"
    echo "FQDN: fake-machine.vpn"
    echo "Peers count: 2/2 Connected"
    ;;
esac
exit 0
`

/**
 * An older layout: flat management/signal strings, the device name under
 * localPeerState and the peers as a bare array. The command reads it too, so a
 * machine holding an older client still gets a branded status view.
 */
const LEGACY_STATUS_JSON = JSON.stringify({
  management_state: 'Connected',
  signal_state: 'Connecting',
  localPeerState: { IP: '100.2.2.1/16', fqdn: 'legacy-machine.vpn' },
  peers: [{ fqdn: 'old.vpn', netbirdIp: '100.2.2.2' }],
})

const FAKE_NETBIRD_LEGACY = `#!/bin/sh
case "$1" in
  version) echo ${VERSION}-fake ;;
  status)
    if [ "\${2:-}" = "--json" ]; then
      printf '%s\\n' '${LEGACY_STATUS_JSON}'
      exit 0
    fi
    echo "Management: Connected"
    echo "Signal: Connecting"
    echo "FQDN: legacy-machine.vpn"
    ;;
esac
exit 0
`

const root = mkdtempSync(join(tmpdir(), 'aw-install-test-'))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Build a channel directory of fake archives plus its checksums file. */
function makeChannel(name, { checksums = 'real', archives = true, latest = VERSION, vendor = FAKE_NETBIRD } = {}) {
  const dir = mkdtempSync(join(root, `${name}-`))
  writeFileSync(join(dir, 'latest.txt'), `${latest}\n`)
  writeFileSync(join(dir, 'management-url.txt'), 'https://mgmt.example.test:443\n')
  const digests = {}
  if (archives) {
    const payload = mkdtempSync(join(root, `${name}-payload-`))
    writeFileSync(join(payload, 'netbird'), vendor)
    chmodSync(join(payload, 'netbird'), 0o755)
    for (const artifact of ARTIFACTS) {
      execFileSync('tar', ['-czf', join(dir, artifact), '-C', payload, 'netbird'])
      digests[artifact] = sha256(join(dir, artifact))
    }
  }
  if (checksums === 'real') {
    const lines = ARTIFACTS.filter((artifact) => digests[artifact]).map((artifact) => `${digests[artifact]}  ${artifact}`)
    writeFileSync(join(dir, 'checksums.txt'), `${lines.join('\n')}\n`)
  } else if (checksums === 'wrong') {
    writeFileSync(join(dir, 'checksums.txt'), `${ARTIFACTS.map((artifact) => `${'0'.repeat(64)}  ${artifact}`).join('\n')}\n`)
  }
  return dir
}

/** Run the installer with only the shims the case needs on PATH. */
function run(args, { shims = [], channel = null, extraEnv = {} } = {}) {
  const shimDir = mkdtempSync(join(root, 'shim-'))
  for (const [name, body] of Object.entries(shims)) {
    writeFileSync(join(shimDir, name), body)
    chmodSync(join(shimDir, name), 0o755)
  }
  // This file covers the private-network client; the DSH phase that rides along
  // on the same one-liner is exercised in dsh-netbird-client-dsh.test.mjs.
  const full = channel ? [...args, '--no-dsh', '--channel', `file://${channel}`] : [...args, '--no-dsh']
  const { PATH: extraPath, ...rest } = extraEnv
  const basePath = extraPath ? `${extraPath}:${process.env.PATH}` : process.env.PATH
  const env = { ...rest, PATH: `${shimDir}:${basePath}`, HOME: root, TMPDIR: root }
  try {
    const stdout = execFileSync('sh', [SCRIPT, ...full], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout?.toString() ?? '', stderr: error.stderr?.toString() ?? '' }
  }
}

const SUDO_SHIM = `#!/bin/sh\nexec "$@"\n`

/** Install the client into a fresh bin directory and hand both back. */
function installClient(name, { vendor = FAKE_NETBIRD } = {}) {
  const channel = makeChannel(name, { vendor })
  const bin = mkdtempSync(join(root, `${name}-bin-`))
  const result = run(['--no-service', '--no-login', '--bin-dir', bin], { channel, shims: { sudo: SUDO_SHIM } })
  assert.equal(result.status, 0, result.stderr)
  return { bin, channel, result }
}

/** Run the installed command the way a user does: `sh <bin>/anywhere <args>`. */
function runAnywhere(bin, args = [], { env = {} } = {}) {
  const wrapper = join(bin, 'anywhere')
  try {
    const stdout = execFileSync('sh', [wrapper, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout?.toString() ?? '', stderr: error.stderr?.toString() ?? '' }
  }
}

test('--help documents every flag the parser accepts', () => {
  const result = run(['--help'])
  assert.equal(result.status, 0)
  for (const flag of FLAGS) assert.match(result.stdout, new RegExp(flag.replace(/-/g, '\\-')), `${flag} missing from --help`)
  assert.match(result.stdout, /curl -fsSL https:\/\/anywhere\.example\.com\/install\.sh \| sh/)
})

test('the default channel is the directory that holds the archives', () => {
  // The one-liner is served from /install.sh while the archives, latest.txt and
  // checksums.txt live under /client/; a mismatch here breaks every install.
  const script = readFileSync(SCRIPT, 'utf8')
  assert.match(script, /AW_CHANNEL:-https:\/\/anywhere\.example\.com\/client/)
})

test('no user-facing installer output names the vendor product', () => {
  // The brand decision is that users operate the product name, not the vendor
  // name. Comments, paths and archive filenames may keep the vendor name; what
  // the installer prints may not, and neither may the vendor's own command
  // names, which is why the closing guidance points at `anywhere`.
  const lines = readFileSync(SCRIPT, 'utf8').split('\n')
  const printed = lines.filter((line) => /^\s*(say|note|die|warn|step)\b/.test(line))
  assert.ok(printed.length > 0)
  for (const line of printed) {
    assert.doesNotMatch(line, /NetBird/, `vendor product name printed: ${line.trim()}`)
    assert.doesNotMatch(line, /\bnetbird (status|up|down|version|service|machines)\b/, `vendor command printed: ${line.trim()}`)
  }
  const help = run(['--help']).stdout
  assert.doesNotMatch(help, /NetBird/)
  assert.match(help, /Anywhere Work private-network client installer/)
})

test('an unknown flag fails loudly instead of guessing', () => {
  const result = run(['--nope'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unknown argument: --nope/)
})

test('dry run reports the plan and installs nothing', () => {
  const channel = makeChannel('dry')
  const bin = mkdtempSync(join(root, 'dry-bin-'))
  const result = run(['--dry-run', '--bin-dir', bin], { channel })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /dry run: nothing was downloaded, installed or changed/)
  assert.match(result.stdout, new RegExp(`file://${channel.replace(/[/.]/g, '\\$&')}`))
  assert.match(result.stdout, /anywhere up --management-url/)
  assert.match(result.stdout, /install -m 0755 <generated> .*\/anywhere/)
  assert.equal(existsSync(join(bin, 'netbird')), false)
  assert.equal(existsSync(join(bin, 'anywhere')), false, 'the dry run created the command')
})

test('installs, starts a session daemon and reports the machine', () => {
  const channel = makeChannel('install')
  const bin = mkdtempSync(join(root, 'install-bin-'))
  const result = run(['--no-service', '--bin-dir', bin], { channel, shims: { sudo: SUDO_SHIM } })
  assert.equal(result.status, 0, result.stderr)
  const installed = join(bin, 'netbird')
  assert.ok(existsSync(installed), 'binary was not installed')
  assert.match(readFileSync(installed, 'utf8'), /Management: Connected/, 'the installed binary is not the one the channel served')
  assert.match(result.stdout, /matches the channel/)
  assert.match(result.stdout, /daemon up/)
  assert.match(result.stdout, /machine {3}fake-machine/)
  assert.match(result.stdout, /address {3}100\.99\.0\.7/)
  assert.match(result.stdout, /What happens next/)
  assert.match(result.stdout, /anywhere status/)
  assert.match(result.stdout, /anywhere machines/)
})

test('a normal install adds the anywhere command beside the client binary, mode 0755', () => {
  const { bin } = installClient('add-command')
  const client = join(bin, 'netbird')
  const wrapper = join(bin, 'anywhere')
  assert.ok(existsSync(client), 'the client binary is missing')
  assert.ok(existsSync(wrapper), 'the anywhere command was not installed next to the client')
  assert.equal(statSync(wrapper).mode & 0o777, 0o755, 'the anywhere command is not executable')
  assert.equal(statSync(client).mode & 0o777, 0o755, 'the client binary lost its mode')
  const body = readFileSync(wrapper, 'utf8')
  assert.match(body, /^#!\/bin\/sh\n/, 'the command does not start with a POSIX sh shebang')
  assert.ok(body.includes(`VENDOR_DEFAULT='${client}'`), 'the command does not record the absolute client path')
  assert.equal(body.includes('__ANYWHERE_VENDOR__'), false, 'the generated command still holds its placeholder')
  // Additive: the client binary keeps its name, its bytes and its own behavior.
  assert.equal(sha256(client), createHash('sha256').update(FAKE_NETBIRD).digest('hex'), 'the client binary was replaced')
})

test('anywhere with no arguments reports a status summary and lists the commands', () => {
  const { bin } = installClient('no-args')
  const result = runAnywhere(bin)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Anywhere Work private network/)
  assert.match(result.stdout, /^Management: Connected$/m)
  assert.match(result.stdout, /^Signal: {5}Connected$/m)
  assert.match(result.stdout, /^Your machines: 2$/m)
  assert.match(result.stdout, /^This device: fake-machine\.vpn$/m)
  assert.match(result.stdout, /^Commands$/m)
  for (const subcommand of ['status', 'machines', 'up', 'down', 'version', 'help']) {
    assert.match(result.stdout, new RegExp(`anywhere ${subcommand}\\b`), `${subcommand} is not offered`)
  }
})

test('anywhere status reports the parsed connections, the count and this device', () => {
  const { bin } = installClient('status')
  const result = runAnywhere(bin, ['status'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout,
    'Management: Connected\nSignal:     Connected\nYour machines: 2\nThis device: fake-machine.vpn\n',
  )
})

test('anywhere machines lists the machines this identity can see and nothing else', () => {
  const { bin } = installClient('machines')
  const result = runAnywhere(bin, ['machines'])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'alpha.vpn  100.99.0.5',
    'beta.vpn  100.99.0.6',
  ])
})

test('anywhere reads an older client status layout as well', () => {
  const { bin } = installClient('legacy', { vendor: FAKE_NETBIRD_LEGACY })
  const status = runAnywhere(bin, ['status'])
  assert.equal(status.status, 0, status.stderr)
  assert.equal(
    status.stdout,
    'Management: Connected\nSignal:     Connecting\nYour machines: 1\nThis device: legacy-machine.vpn\n',
  )
  const machines = runAnywhere(bin, ['machines'])
  assert.equal(machines.status, 0, machines.stderr)
  assert.deepEqual(machines.stdout.trim().split('\n'), ['old.vpn  100.2.2.2'])
})

test('an unknown subcommand prints usage to stderr and exits non-zero', () => {
  const { bin } = installClient('unknown')
  const result = runAnywhere(bin, ['scp'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /^Usage:$/m)
  assert.equal(result.stdout, '')
  const help = runAnywhere(bin, ['help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /^Usage:$/m)
})

test('anywhere up forwards to the client and propagates its exit code', () => {
  const { bin } = installClient('forward')
  const log = join(root, 'forward-invocations.log')
  const result = runAnywhere(bin, ['up', '--management-url', 'https://mgmt.example.test:443'], {
    env: { AW_FAKE_LOG: log, AW_FAKE_UP_CODE: '37' },
  })
  // 37 is the fake client's own choice; a wrapper that swallowed it would
  // break every `if anywhere up; then ...` script.
  assert.equal(result.status, 37)
  assert.ok(existsSync(log), 'the client was never invoked')
  assert.equal(readFileSync(log, 'utf8').trim(), 'up --management-url https://mgmt.example.test:443')

  const version = runAnywhere(bin, ['version'], { env: { AW_FAKE_LOG: log } })
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout.trim(), `${VERSION}-fake`)
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').at(-1), 'version')

  const down = runAnywhere(bin, ['down'], { env: { AW_FAKE_LOG: log } })
  assert.equal(down.status, 0, down.stderr)
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').at(-1), 'down')
})

test("anywhere status falls back to the client's own plain output when JSON fails", () => {
  const { bin } = installClient('fallback', { vendor: FAKE_NETBIRD_NO_JSON })
  const result = runAnywhere(bin, ['status'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Peers count: 2\/2 Connected/, 'the client plain output was not passed through')
  assert.doesNotMatch(result.stdout, /Your machines:/, 'a failed parse still produced the branded view')
})

test('anywhere fails with a clear message, not a shell error, when the client is gone', () => {
  const { bin } = installClient('missing')
  rmSync(join(bin, 'netbird'))
  const result = runAnywhere(bin, ['status'])
  assert.equal(result.status, 127)
  assert.match(result.stderr, /client binary is missing/)
  assert.match(result.stderr, /reinstall it with the Anywhere Work installer/)
  assert.doesNotMatch(result.stderr, /command not found|No such file or directory|not found/)
})

test('refuses an archive that does not match the channel checksums', () => {
  const channel = makeChannel('mismatch', { checksums: 'wrong' })
  const bin = mkdtempSync(join(root, 'mismatch-bin-'))
  const result = run(['--no-service', '--bin-dir', bin], { channel })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /checksum mismatch/)
  assert.equal(existsSync(join(bin, 'netbird')), false)
})

test('refuses to install when the channel publishes no checksums', () => {
  const channel = makeChannel('nochecksums', { checksums: 'missing' })
  const bin = mkdtempSync(join(root, 'nochecksums-bin-'))
  const result = run(['--no-service', '--bin-dir', bin], { channel })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /refusing to install unverified bits/)
  assert.equal(existsSync(join(bin, 'netbird')), false)
})

test('uses a client that is already installed instead of downloading one', () => {
  const channel = makeChannel('existing', { archives: false })
  const bin = mkdtempSync(join(root, 'existing-bin-'))
  writeFileSync(join(bin, 'netbird'), FAKE_NETBIRD)
  chmodSync(join(bin, 'netbird'), 0o755)
  const result = run(['--no-service', '--bin-dir', bin], { channel, shims: { sudo: SUDO_SHIM }, extraEnv: { PATH: bin } })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /using the client already on this machine/)
  assert.match(result.stdout, /re-run with --force/)
  assert.equal(sha256(join(bin, 'netbird')), createHash('sha256').update(FAKE_NETBIRD).digest('hex'), 'the existing client was overwritten')
  // The product command is still added, and it points at the client that was found.
  assert.ok(existsSync(join(bin, 'anywhere')), 'the anywhere command was not added next to the existing client')
  assert.ok(readFileSync(join(bin, 'anywhere'), 'utf8').includes(`VENDOR_DEFAULT='${join(bin, 'netbird')}'`))
})

test('--uninstall stops the service and removes the command and the client', () => {
  const channel = makeChannel('uninstall')
  const bin = mkdtempSync(join(root, 'uninstall-bin-'))
  const shims = { sudo: SUDO_SHIM }
  assert.equal(run(['--no-service', '--bin-dir', bin], { channel, shims }).status, 0)
  assert.ok(existsSync(join(bin, 'netbird')))
  assert.ok(existsSync(join(bin, 'anywhere')))
  const result = run(['--uninstall', '--bin-dir', bin], { channel, shims })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /netbird down$/m)
  assert.match(result.stdout, /netbird service uninstall$/m)
  assert.match(result.stdout, new RegExp(`rm -f ${bin.replace(/[/.]/g, '\\$&')}/anywhere$`, 'm'))
  assert.equal(existsSync(join(bin, 'netbird')), false, 'the client is still installed')
  assert.equal(existsSync(join(bin, 'anywhere')), false, 'the anywhere command is still installed')
})

test('refuses a platform it cannot install on', () => {
  const channel = makeChannel('platform')
  const result = run(['--dry-run'], {
    channel,
    shims: { uname: '#!/bin/sh\n[ "$1" = "-m" ] && echo x86_64 || echo FreeBSD\n' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /supports macOS and Linux/)
})