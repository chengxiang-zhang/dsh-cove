#!/usr/bin/env node
/**
 * Multi-user isolation test on real, independent machines.
 *
 * The account is single-tenant, so "each user only reaches their own machines"
 * is expressed as one private group per user plus one self-referencing policy
 * (`scripts/dsh-netbird-user-namespace.mjs`). That model is easy to state and
 * hard to believe, so this harness proves it with actual machines: four
 * containers, two per user, each container its own network namespace with its
 * own WireGuard interface.
 *
 * It asserts both halves of the promise:
 *
 *   1. visibility - each container's peer set holds exactly its own user's
 *      other machine, and never a fleet machine nor the other user's machines
 *      (this is what the app's DSH catalogue filters on);
 *   2. reachability - a TCP port opened by each container is reachable by the
 *      same user's other container and refused/dropped from the other user's.
 *
 * Mint one setup key per user first, each carrying that user's group:
 *
 *   curl -fsS -X POST -H "Authorization: Bearer $NETBIRD_MGMT_TOKEN" \
 *     -H 'Content-Type: application/json' \
 *     -d '{"name":"iso-a","type":"reusable","expires_in":7200,"usage_limit":4,
 *          "auto_groups":["<u-... group id>"]}' \
 *     https://netbird.example.com/api/setup-keys
 *
 * Then:
 *
 *   node scripts/dsh-netbird-isolation-docker.mjs --key-a <key> --key-b <key>
 *
 * Requires a Linux VM (on macOS: `brew install colima docker && colima start`).
 * The containers need NET_ADMIN and /dev/net/tun; `--network host` from the
 * upstream docs cannot be used because the four clients would share one network
 * namespace. Pass --keep to leave the containers for inspection.
 *
 * Measured 2026-10-15 on a colima VM (netbird 0.80.0 client, management 0.78.1):
 * 12/12 - four in-group directions reachable, eight cross-user directions
 * blocked, no container seeing any of the seven fleet machines.
 */
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)

const IMAGE = arg('image', 'netbirdio/netbird:latest')
const MGMT = arg('management-url', 'https://netbird.example.com:443')
const PORT = Number(arg('port', '8080'))
const KEEP = flag('keep')
const FLEET_IPS = (arg('fleet-ips') ?? [
  '100.64.0.11', '100.64.0.12', '100.64.0.13',
  '100.64.0.14', '100.64.0.15', '100.64.0.16', '100.64.0.20',
].join(',')).split(',').map((value) => value.trim()).filter(Boolean)

const keyA = arg('key-a')
const keyB = arg('key-b')
if (!keyA || !keyB) {
  console.error('usage: dsh-netbird-isolation-docker.mjs --key-a <setup key> --key-b <setup key>')
  process.exit(2)
}

const USERS = { a: { key: keyA, machines: ['iso-a1', 'iso-a2'] }, b: { key: keyB, machines: ['iso-b1', 'iso-b2'] } }
const ALL = [...USERS.a.machines, ...USERS.b.machines]

const docker = (args, { quiet = false } = {}) => {
  try {
    const out = execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return quiet ? '' : out.trim()
  } catch (error) {
    if (quiet) return null
    throw new Error(`docker ${args.join(' ')} failed: ${error.stderr?.toString().trim() || error.message}`)
  }
}
const inMachine = (name, command) => docker(['exec', name, 'sh', '-c', command])

function cleanup() {
  for (const name of ALL) docker(['rm', '-f', name], { quiet: true })
}
if (!KEEP) process.on('exit', cleanup)

console.log(`image=${IMAGE} management=${MGMT} port=${PORT}`)
cleanup()
for (const [user, spec] of Object.entries(USERS)) {
  for (const name of spec.machines) {
    docker([
      'run', '-d', '--name', name,
      '--cap-add=NET_ADMIN', '--device', '/dev/net/tun',
      '-e', `NB_SETUP_KEY=${spec.key}`,
      '-e', `NB_MANAGEMENT_URL=${MGMT}`,
      IMAGE,
    ])
    console.log(`started ${name} (user ${user})`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitForPeers(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const states = ALL.map((name) => {
      const raw = docker(['exec', name, 'netbird', 'status', '--json'], { quiet: true })
      try { return JSON.parse(raw) } catch { return null }
    })
    if (states.every((state) => state?.peers && state.peers.total > 0)) return
    await sleep(3000)
  }
  throw new Error('timed out waiting for the peers to appear')
}

await waitForPeers()

const ips = {}
const peers = {}
for (const name of ALL) {
  const state = JSON.parse(inMachine(name, 'netbird status --json') || '{}')
  ips[name] = String(state.netbirdIp ?? '').split('/')[0]
  peers[name] = (state.peers?.details ?? []).map((peer) => peer.netbirdIp).sort()
  console.log(`${name.padEnd(8)} self=${ips[name].padEnd(16)} sees=[${peers[name].join(', ')}]`)
}

const results = []
const check = (label, ok) => { results.push([label, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }

console.log('\n-- visibility --')
const other = { a: USERS.b.machines, b: USERS.a.machines }
for (const [user, spec] of Object.entries(USERS)) {
  const [first, second] = spec.machines
  check(`${first} sees exactly ${second}`, JSON.stringify(peers[first]) === JSON.stringify([ips[second]]))
  check(`${second} sees exactly ${first}`, JSON.stringify(peers[second]) === JSON.stringify([ips[first]]))
  for (const name of spec.machines) {
    check(`${name} sees no fleet machine`, !peers[name].some((ip) => FLEET_IPS.includes(ip)))
    check(`${name} sees no machine of the other user`, !peers[name].some((ip) => other[user].map((m) => ips[m]).includes(ip)))
  }
}

console.log('\n-- reachability --')
for (const name of ALL) {
  docker(['exec', '-d', name, 'sh', '-c', `while true; do nc -l -p ${PORT} -e /bin/echo; done`])
}
await sleep(2000)
const reachable = (from, to) => docker(['exec', from, 'nc', '-z', '-w', '4', ips[to], String(PORT)], { quiet: true }) !== null
for (const [user, spec] of Object.entries(USERS)) {
  const [first, second] = spec.machines
  for (const [from, to] of [[first, second], [second, first]]) {
    check(`${from} -> ${to} (same user) reachable`, reachable(from, to))
  }
  for (const from of spec.machines) {
    for (const to of other[user]) check(`${from} -> ${to} (other user) blocked`, !reachable(from, to))
  }
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\nRESULT: ${failed.length === 0 ? `ALL PASS (${results.length}/${results.length})` : `${failed.length} FAILED of ${results.length}`}`)
if (KEEP) console.log(`containers kept: ${ALL.join(' ')}`)
process.exit(failed.length === 0 ? 0 : 1)