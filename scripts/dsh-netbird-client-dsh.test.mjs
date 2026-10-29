/**
 * The DSH half of the desktop one-liner.
 *
 * `curl -fsSL https://anywhere.example.com/install.sh | sh` installs the
 * private-network client and then DSH itself, seeds the fleet's default model
 * provider (Kaon Router) and keeps `dsh web` resident. That second half is what
 * these tests hold: the service definition carries the canonical
 * `dsh.<machine>.netbird` authority and a PATH that reaches the dsh binary, the
 * provider seed matches the canonical preset instead of drifting from it, an
 * existing provider block or service unit is left alone, nothing is written in
 * a dry run, and the model API key is never written at all - the installer only
 * points at https://router-admin.example.com/.
 *
 * Nothing here touches the network, a real DSH home or a real service: every
 * command the installer shells out to is a recording shim, and the client
 * channel is a `file://` directory.
 *
 *   node --test scripts/dsh-netbird-client-dsh.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../tools/dsh-netbird/client/install.sh', import.meta.url))
const PRESET = fileURLToPath(new URL('../tools/dsh-netbird/llm-models.patch.yml', import.meta.url))
const KEY_URL = 'https://router-admin.example.com/'
const FQDN = 'laptop-b.netbird.cloud'
const TRUSTED_HOST = 'dsh.laptop-b.netbird'
const REAL_CURL = execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim()

const root = mkdtempSync(join(tmpdir(), 'aw-dsh-test-'))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

const NETBIRD = `#!/bin/sh
if [ -n "\${AW_FAKE_LOG:-}" ]; then printf '%s\\n' "$*" >> "$AW_FAKE_LOG"; fi
case "$1" in
  version) echo 0.78.1-fake ;;
  status)
    case "\${2:-}" in
      --ipv4) echo 100.64.0.12; exit 0 ;;
      --json) printf '%s\\n' '{"peers":{"total":1},"fqdn":"${FQDN}"}'; exit 0 ;;
    esac
    echo "Daemon status: Connected"
    echo "Management: Connected"
    echo "Signal: Connected"
    echo "FQDN: ${FQDN}"
    echo "Peers count: 1/1 Connected"
    ;;
  up|down|service) : ;;
esac
exit 0
`

const NODE_NEW = '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v22.22.0; fi\nexit 0\n'
const NODE_OLD = '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v18.20.0; fi\nexit 0\n'

/** A dsh that records what it was asked to do and answers the version probe. */
const DSH = `#!/bin/sh
if [ -n "\${DSH_LOG:-}" ]; then printf '%s\\n' "$*" >> "$DSH_LOG"; fi
case "$1" in
  -V|--version) echo 0.2.0-rc.2 ;;
esac
exit 0
`

const NPM = `#!/bin/sh
if [ -n "\${NPM_LOG:-}" ]; then printf '%s\\n' "$*" >> "$NPM_LOG"; fi
exit 0
`

/**
 * curl is needed for the client channel (`file://`, so the real one is used) and
 * for the DSH port checks. Nothing listens on 3080 in a test, so the answer is
 * derived from whether a service definition exists yet: "nothing there" before
 * the installer writes one, "it answers" (200) once it has - which is exactly
 * the sequence the installer reasons about, and it keeps the readiness wait from
 * sleeping for a server that never starts.
 */
const CURL = `#!/bin/sh
case "$*" in
  *127.0.0.1:3080*)
    if [ -e "\${HOME:-}/Library/LaunchAgents/org.dsh.web.plist" ] || [ -e "\${HOME:-}/.config/systemd/user/com.dsh.web.service" ]; then
      printf '%s' "\${FAKE_DSH_READY_CODE:-200}"
    else
      printf '%s' "\${FAKE_DSH_CODE:-000}"
    fi
    exit 0 ;;
esac
exec ${REAL_CURL} "$@"
`

/** launchctl / systemctl / loginctl: record the call, claim success. */
const SERVICE_TOOL = `#!/bin/sh
if [ -n "\${SERVICE_LOG:-}" ]; then printf '%s %s\\n' "$(basename "$0")" "$*" >> "$SERVICE_LOG"; fi
exit 0
`

const unameShim = (os) => `#!/bin/sh
if [ "$1" = "-m" ]; then echo arm64; else echo ${os}; fi
`

/** A channel with a version file only: the client is already on PATH here. */
function makeChannel() {
  const dir = mkdtempSync(join(root, 'channel-'))
  writeFileSync(join(dir, 'latest.txt'), '0.78.1\n')
  writeFileSync(join(dir, 'management-url.txt'), 'https://mgmt.example.test:443\n')
  return dir
}

/** A Node release directory: SHASUMS256.txt plus one archive this platform uses. */
function makeNodeChannel() {
  const dir = mkdtempSync(join(root, 'node-channel-'))
  const payload = mkdtempSync(join(root, 'node-payload-'))
  const nodeDir = 'node-v22.22.0-darwin-arm64'
  const bin = join(payload, nodeDir, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const [name, body] of [['node', NODE_NEW], ['npm', NPM], ['dsh', DSH]]) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  const archive = `${nodeDir}.tar.gz`
  execFileSync('tar', ['-czf', join(dir, archive), '-C', payload, nodeDir])
  const digest = createHash('sha256').update(readFileSync(join(dir, archive))).digest('hex')
  writeFileSync(join(dir, 'SHASUMS256.txt'), `${digest}  ${archive}\n`)
  return { dir, nodeDir }
}

/**
 * Run the installer with a private PATH: shims first, then the system
 * directories. The developer's own dsh, node and npm are deliberately out of
 * reach, so what the installer finds is only what a test put there.
 */
function run(args, { shims = {}, channel = null, extraEnv = {} } = {}) {
  const home = mkdtempSync(join(root, 'home-'))
  const shimDir = mkdtempSync(join(root, 'shim-'))
  const logDir = mkdtempSync(join(root, 'log-'))
  const binDir = join(logDir, 'bin')
  mkdirSync(binDir)
  const defaults = {
    netbird: NETBIRD,
    node: NODE_NEW,
    dsh: DSH,
    npm: NPM,
    pnpm: '#!/bin/sh\nexit 0\n',
    curl: CURL,
    sudo: '#!/bin/sh\nexec "$@"\n',
    uname: unameShim('Darwin'),
    launchctl: SERVICE_TOOL,
    systemctl: SERVICE_TOOL,
    loginctl: SERVICE_TOOL,
  }
  for (const [name, body] of Object.entries({ ...defaults, ...shims })) {
    if (body === null) continue
    writeFileSync(join(shimDir, name), body)
    chmodSync(join(shimDir, name), 0o755)
  }
  const env = {
    PATH: `${shimDir}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: root,
    DSH_LOG: join(logDir, 'dsh.log'),
    NPM_LOG: join(logDir, 'npm.log'),
    SERVICE_LOG: join(logDir, 'service.log'),
    AW_FAKE_LOG: join(logDir, 'netbird.log'),
    ...extraEnv,
  }
  const full = channel ? [...args, '--bin-dir', binDir, '--channel', `file://${channel}`] : [...args, '--bin-dir', binDir]
  try {
    const stdout = execFileSync('sh', [SCRIPT, ...full], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '', home, shimDir, logDir }
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout?.toString() ?? '', stderr: error.stderr?.toString() ?? '', home, shimDir, logDir }
  }
}

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
const profilePath = (home) => join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml')
const plistPath = (home) => join(home, 'Library', 'LaunchAgents', 'org.dsh.web.plist')
const unitPath = (home) => join(home, '.config', 'systemd', 'user', 'com.dsh.web.service')

test('--help documents the DSH flags and where the model key comes from', () => {
  const result = run(['--help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--no-dsh/)
  assert.match(result.stdout, /--dsh-version/)
  assert.match(result.stdout, new RegExp(KEY_URL.replace(/[/.]/g, '\\$&')))
})

test('installs a resident DSH service, seeds Kaon Router and prints the key steps', () => {
  const result = run(['--no-login'], { channel: makeChannel() })
  assert.equal(result.status, 0, result.stderr)

  const plist = read(plistPath(result.home))
  assert.ok(plist, 'the LaunchAgent was not written')
  assert.match(plist, /<string>org\.dsh\.web<\/string>/)
  assert.match(plist, /<string>--trusted-host<\/string>/)
  assert.match(plist, new RegExp(`<string>${TRUSTED_HOST.replace(/\./g, '\\.')}</string>`))
  assert.match(plist, /<key>DSH_HOME<\/key>/)
  assert.match(plist, new RegExp(join(result.home, '.dsh').replace(/[/.]/g, '\\$&')))
  // The service PATH must reach the dsh this installer used; launchd starts with
  // a minimal PATH, so a missing entry here means a service that never boots.
  assert.match(plist, new RegExp(`${result.shimDir.replace(/[/.]/g, '\\$&')}:/`))

  const service = read(join(result.logDir, 'service.log'))
  assert.match(service, /launchctl bootout gui\/\d+\/org\.dsh\.web/)
  assert.match(service, /launchctl bootstrap gui\/\d+ .*org\.dsh\.web\.plist/)

  assert.match(read(join(result.logDir, 'dsh.log')), /^plugin --profile web add @dsh-cove\/dsh-web-all@latest$/m)

  const profile = read(profilePath(result.home))
  assert.match(profile, /^- id: llm-pi-ai$/m)
  assert.match(profile, /baseURL: https:\/\/router\.example\.com\/v1/)
  assert.match(profile, /apiKeyEnv: KAON_ROUTER_API_KEY/)
  assert.match(profile, /provider: router/)
  assert.match(profile, /model: kaon\/deepseek-v4\.1-flash/)
  assert.match(profile, /reasoningEffort: high/)

  // The key is the user's to paste: the installer prints the address and never
  // stores a secret.
  assert.match(result.stdout, new RegExp(KEY_URL.replace(/[/.]/g, '\\$&')))
  assert.match(result.stdout, /KAON_ROUTER_API_KEY/)
  assert.equal(existsSync(join(result.home, '.dsh', '.credentials.yaml')), false, 'the installer wrote a credentials file')
  assert.match(result.stdout, /DSH answers on http:\/\/127\.0\.0\.1:3080\/ \(HTTP 200\)/)
  assert.match(result.stdout, /DSH is installed and resident on this machine/)
})

test('--no-service installs DSH without a resident service and the summary says so', () => {
  const result = run(['--no-login', '--no-service'], { channel: makeChannel() })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /not keeping DSH resident \(--no-service\)/)
  assert.match(result.stdout, /DSH is installed but not kept resident/)
  assert.equal(existsSync(plistPath(result.home)), false)
  assert.ok(existsSync(profilePath(result.home)), 'the provider seed was skipped')
})

test('--no-dsh installs the network client only', () => {
  const result = run(['--no-login', '--no-dsh'], { channel: makeChannel() })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /skipping DSH \(--no-dsh\)/)
  assert.doesNotMatch(result.stdout, /DSH is installed/)
  assert.match(result.stdout, /  3\. Phones: open https:\/\/anywhere\.example\.com\//)
  assert.equal(existsSync(plistPath(result.home)), false)
  assert.equal(existsSync(profilePath(result.home)), false)
})

test('a dry run prints the DSH plan and writes nothing', () => {
  const result = run(['--dry-run', '--no-login'], { channel: makeChannel() })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /install -m 0644 <generated> .*org\.dsh\.web\.plist/)
  assert.match(result.stdout, new RegExp(TRUSTED_HOST.replace(/\./g, '\\.')))
  assert.match(result.stdout, /plugin --profile web add @dsh-cove\/dsh-web-all@latest/)
  assert.match(result.stdout, /append the Kaon Router provider/)
  assert.match(result.stdout, /dry run: nothing was downloaded, installed or changed/)
  assert.equal(existsSync(plistPath(result.home)), false, 'the dry run wrote a service definition')
  assert.equal(existsSync(profilePath(result.home)), false, 'the dry run wrote a profile')
})

test('a machine already serving DSH on the port keeps its own service', () => {
  const result = run(['--no-login'], {
    channel: makeChannel(),
    extraEnv: { FAKE_DSH_CODE: '200' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /a DSH service is already answering on this port/)
  assert.match(result.stdout, /answered HTTP 200 before anything was installed/)
  assert.equal(existsSync(plistPath(result.home)), false, 'a second service definition was written for a port that already answers')
  assert.doesNotMatch(read(join(result.logDir, 'service.log')), /bootstrap/, 'the existing service was disturbed')
  // The provider seed is still applied: the machine becomes usable without
  // touching whatever already serves it.
  assert.ok(existsSync(profilePath(result.home)), 'the provider seed was skipped')
})

test('Linux gets a systemd user unit, lingering and the same authority', () => {
  const result = run(['--no-login'], {
    channel: makeChannel(),
    shims: { uname: unameShim('Linux') },
  })
  assert.equal(result.status, 0, result.stderr)
  const unit = read(unitPath(result.home))
  assert.ok(unit, 'the systemd user unit was not written')
  assert.match(unit, /^\[Service\]$/m)
  assert.match(unit, new RegExp(`^ExecStart=.* web --host 127\\.0\\.0\\.1 --port 3080 --no-open --trusted-host ${TRUSTED_HOST.replace(/\./g, '\\.')}$`, 'm'))
  assert.match(unit, /^WantedBy=default\.target$/m)
  assert.match(unit, /^Environment=DSH_HOME=/m)
  const service = read(join(result.logDir, 'service.log'))
  assert.match(service, /^systemctl --user daemon-reload$/m)
  assert.match(service, /^systemctl --user enable --now com\.dsh\.web\.service$/m)
  assert.match(service, /^loginctl enable-linger \S+$/m)
  assert.equal(existsSync(plistPath(result.home)), false, 'a LaunchAgent was written on Linux')
})

test('an existing provider block and an existing service unit are left alone', () => {
  const home = mkdtempSync(join(root, 'keep-home-'))
  const profile = profilePath(home)
  mkdirSync(join(home, '.dsh', 'profiles', 'web'), { recursive: true })
  const existing = '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      router:\n        baseURL: https://example.test/v1\n'
  writeFileSync(profile, existing)
  const plist = plistPath(home)
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  writeFileSync(plist, '<!-- an operator-owned definition -->\n')

  const result = run(['--no-login'], { channel: makeChannel(), extraEnv: { HOME: home } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(read(profile), existing, 'the machine-local provider block was rewritten')
  assert.equal(read(plist), '<!-- an operator-owned definition -->\n', 'the existing service definition was rewritten')
  assert.match(result.stdout, /already configures a model provider/)
  assert.match(result.stdout, /already installed/)
})

test('a freshly initialized profile (comment header plus `[]`) is seeded as one document', () => {
  const home = mkdtempSync(join(root, 'init-home-'))
  const profile = profilePath(home)
  mkdirSync(join(home, '.dsh', 'profiles', 'web'), { recursive: true })
  // Exactly what `dsh plugin --profile web add` leaves behind on a fresh home.
  const initialized = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries.\n[]\n'
  writeFileSync(profile, initialized)

  const result = run(['--no-login'], { channel: makeChannel(), extraEnv: { HOME: home } })
  assert.equal(result.status, 0, result.stderr)
  const seeded = read(profile)
  assert.ok(seeded.startsWith(initialized.split('\n').slice(0, 2).join('\n')), 'the profile comment header was lost')
  assert.equal(/^\[\]$/m.test(seeded), false, 'the empty-sequence marker survived: the file now holds two YAML documents')
  assert.match(seeded, /^- id: llm-pi-ai$/m)
  assert.match(seeded, /^- id: agent-default-model$/m)
})

test('a machine with an old Node gets a private one, verified against its release list', () => {
  const node = makeNodeChannel()
  const result = run(['--no-login', '--dsh-version', '0.2.0-rc.2'], {
    channel: makeChannel(),
    shims: { node: NODE_OLD, npm: null, dsh: null },
    extraEnv: { AW_NODE_CHANNEL: `file://${node.dir}` },
  })
  assert.equal(result.status, 0, result.stderr)
  const privateBin = join(result.home, '.dsh', 'node', node.nodeDir, 'bin')
  assert.ok(existsSync(join(privateBin, 'node')), 'the private Node was not installed')
  assert.match(result.stdout, /is older than 22/)
  assert.match(result.stdout, /matches the Node release list/)
  assert.match(read(join(result.logDir, 'npm.log')), /^install -g @deepseek-ai\/dsh@0\.2\.0-rc\.2$/m)
  assert.match(read(plistPath(result.home)), new RegExp(`${privateBin.replace(/[/.]/g, '\\$&')}:/`))
})

test('--uninstall removes the resident service and keeps DSH itself', () => {
  const result = run(['--no-login'], { channel: makeChannel() })
  const home = result.home
  assert.ok(existsSync(plistPath(home)))
  const uninstall = run(['--uninstall'], { channel: makeChannel(), extraEnv: { HOME: home } })
  assert.equal(uninstall.status, 0, uninstall.stderr)
  assert.match(uninstall.stdout, /rm -f .*org\.dsh\.web\.plist/)
  assert.match(uninstall.stdout, /DSH itself stays installed/)
  assert.equal(existsSync(plistPath(home)), false, 'the service definition survived --uninstall')
  assert.ok(existsSync(profilePath(home)), 'the profile was deleted by --uninstall')
  assert.match(read(join(uninstall.logDir, 'service.log')), /launchctl bootout gui\/\d+\/org\.dsh\.web/)
})

/** The seeded provider block, exactly as the installer appends it. */
function seedBlock() {
  const text = readFileSync(SCRIPT, 'utf8')
  const marker = text.indexOf("<<'DSH_LLM_SEED_EOF'")
  assert.ok(marker > 0, 'the provider seed heredoc is missing')
  const body = text.indexOf('\n', marker) + 1
  const end = text.indexOf('\nDSH_LLM_SEED_EOF', body)
  assert.ok(end > body, 'the provider seed heredoc is unterminated')
  return text.slice(body, end)
}

/** One `- id: <model>` block, from its id line to the next model id. */
function modelBlock(text, id) {
  const start = text.indexOf(`- id: ${id}`)
  assert.ok(start >= 0, `${id} is missing`)
  const rest = text.slice(start)
  const next = rest.indexOf('\n          - id: ', 1)
  return next < 0 ? rest : rest.slice(0, next)
}

const value = (block, key) => {
  const match = new RegExp(`^\\s*${key}: (.+)$`, 'm').exec(block)
  return match ? match[1].trim() : undefined
}
const inputs = (block) => (block.match(/^\s+- (text|image)$/gm) ?? []).map((line) => line.trim())

test('the seeded provider matches the canonical fleet preset instead of drifting', () => {
  const seed = seedBlock()
  const preset = readFileSync(PRESET, 'utf8')

  // The four facts an operator can verify by eye: which provider is default,
  // where it points, which key reference it reads, and the default model.
  assert.match(seed, /^        baseURL: https:\/\/router\.example\.com\/v1$/m)
  assert.match(seed, /^        apiKeyEnv: KAON_ROUTER_API_KEY$/m)
  assert.match(seed, /^    provider: router$/m)
  assert.match(seed, /^    model: kaon\/deepseek-v4\.1-flash$/m)
  assert.match(seed, /^    reasoningEffort: high$/m)
  assert.match(preset, /^        baseURL: https:\/\/router\.example\.com\/v1$/m)
  assert.match(preset, /^        apiKeyEnv: KAON_ROUTER_API_KEY$/m)
  assert.match(preset, /^    provider: router$/m)
  assert.match(preset, /^    model: kaon\/deepseek-v4\.1-flash$/m)

  const ids = [...seed.matchAll(/^          - id: (kaon\/\S+)$/gm)].map((match) => match[1])
  assert.ok(ids.length >= 4, `the seed carries too few models: ${ids.join(', ')}`)
  for (const id of ids) {
    const seeded = modelBlock(seed, id)
    const canonical = modelBlock(preset, id)
    for (const key of ['contextWindow', 'maxTokens']) {
      assert.equal(value(seeded, key), value(canonical, key), `${id} ${key} drifted from llm-models.patch.yml`)
    }
    assert.deepEqual(inputs(seeded), inputs(canonical), `${id} input modalities drifted from llm-models.patch.yml`)
    assert.match(seeded, /^            reasoningEfforts:$/m, `${id} lost its reasoning efforts`)
  }
})