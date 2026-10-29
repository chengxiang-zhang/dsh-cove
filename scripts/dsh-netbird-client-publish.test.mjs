/**
 * The desktop client channel is built from two sources that must not drift:
 * the upstream release checksums and the archives mirrored into the channel
 * cache. These tests pin the refusals (mirror drift, missing checksum, stale
 * published bytes) because each of them would otherwise reach an employee as a
 * working-looking installer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  artifactName,
  buildChecksums,
  channelText,
  CLIENT_DIR,
  DEFAULT_REMOTE_VHOST,
  parseArgs,
  renderChecksums,
  verify,
  VHOST_SOURCE,
  vhostScript,
} from './dsh-netbird-client-publish.mjs'

const VERSION = '0.78.1'
const NAMES = [
  artifactName(VERSION, 'darwin', 'arm64'),
  artifactName(VERSION, 'darwin', 'amd64'),
  artifactName(VERSION, 'linux', 'amd64'),
  artifactName(VERSION, 'windows', 'amd64'),
]
const DIGESTS = Object.fromEntries(NAMES.map((name, index) => [name, String(index + 1).repeat(64).slice(0, 64)]))
const UPSTREAM = `${NAMES.map((name) => `${DIGESTS[name]}  ${name}`).join('\n')}\nnetbird_${VERSION}.wasm  ${'a'.repeat(64)}\n`

test('artifact names follow the upstream release layout', () => {
  assert.equal(artifactName('1.2.3', 'darwin', 'arm64'), 'netbird_1.2.3_darwin_arm64.tar.gz')
})

test('builds checksums only for archives that match upstream', () => {
  const entries = buildChecksums({ names: NAMES, digests: DIGESTS, upstreamText: UPSTREAM })
  assert.deepEqual(entries, NAMES.map((name) => ({ name, sha256: DIGESTS[name] })))
  assert.equal(renderChecksums(entries), `${NAMES.map((name) => `${DIGESTS[name]}  ${name}`).join('\n')}\n`)
})

test('refuses a mirror that does not match the upstream checksums', () => {
  const digests = { ...DIGESTS, [NAMES[0]]: 'f'.repeat(64) }
  assert.throws(() => buildChecksums({ names: NAMES, digests, upstreamText: UPSTREAM }), /does not match upstream/)
})

test('refuses an archive upstream does not list', () => {
  assert.throws(
    () => buildChecksums({ names: [...NAMES, 'netbird_0.78.1_plan9_amd64.tar.gz'], digests: { ...DIGESTS, 'netbird_0.78.1_plan9_amd64.tar.gz': 'b'.repeat(64) }, upstreamText: UPSTREAM }),
    /not listed in the upstream checksum file/,
  )
})

test('refuses when an archive is missing from the cache', () => {
  assert.throws(() => buildChecksums({ names: NAMES, digests: { [NAMES[0]]: DIGESTS[NAMES[0]] }, upstreamText: UPSTREAM }), /missing local archive/)
})

test('channel text carries the version and the management endpoint', () => {
  const entries = buildChecksums({ names: NAMES, digests: DIGESTS, upstreamText: UPSTREAM })
  const text = channelText({ version: VERSION, managementUrl: 'https://mgmt.example.test:443', entries })
  assert.equal(text['latest.txt'], `${VERSION}\n`)
  assert.equal(text['management-url.txt'], 'https://mgmt.example.test:443\n')
  assert.equal(text['checksums.txt'].split('\n').filter(Boolean).length, NAMES.length)
})

test('parseArgs defaults to the edge channel and rejects unknown flags', () => {
  const args = parseArgs([])
  assert.equal(args.version, VERSION)
  assert.equal(args.remoteHost, 'nb-tx')
  assert.equal(args.remoteRoot, '/www/wwwroot/client')
  assert.equal(args.remoteVhost, DEFAULT_REMOTE_VHOST)
  assert.equal(args.skipVhost, false)
  assert.equal(parseArgs(['--skip-vhost']).skipVhost, true)
  assert.equal(parseArgs(['--remote-vhost', '/etc/nginx/x.conf']).remoteVhost, '/etc/nginx/x.conf')
  assert.equal(args.dryRun, false)
  assert.equal(parseArgs(['--version', '9.9.9', '--dry-run']).version, '9.9.9')
  assert.equal(parseArgs(['--dry-run']).dryRun, true)
  assert.throws(() => parseArgs(['--wat']), /unknown argument/)
})

/** A fake transport that serves exactly what was staged, plus the local archives. */
function fakeChannel({ version = VERSION, distDir, entries, text, mutate = {} }) {
  const bytes = {
    '/': readFileSync(join(CLIENT_DIR, 'index.html')),
    '/qr-phone.svg': readFileSync(join(CLIENT_DIR, 'qr-phone.svg')),
    '/install.sh': readFileSync(join(CLIENT_DIR, 'install.sh')),
    '/install.ps1': readFileSync(join(CLIENT_DIR, 'install.ps1')),
    '/client/checksums.txt': Buffer.from(text['checksums.txt']),
    '/client/management-url.txt': Buffer.from(text['management-url.txt']),
    '/client/latest.txt': Buffer.from(text['latest.txt']),
  }
  return {
    redirect: () => '301 https://anywhere.example.com/',
    bytes: (url) => {
      const path = new URL(url).pathname
      return mutate[path] ?? bytes[path]
    },
    head: (url) => {
      const name = new URL(url).pathname.split('/').pop()
      const size = mutate[name] ?? readFileSync(join(distDir, name)).length
      return { 'content-length': String(size) }
    },
    range: () => '206 1048576',
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'aw-channel-test-'))
  const distDir = join(dir, VERSION)
  mkdirSync(distDir, { recursive: true })
  for (const [index, name] of NAMES.entries()) writeFileSync(join(distDir, name), `archive-${index}`.repeat(32))
  const digests = Object.fromEntries(NAMES.map((name) => [name, 'x'.repeat(64)]))
  const entries = NAMES.map((name) => ({ name, sha256: digests[name] }))
  const upstream = `${NAMES.map((name) => `${digests[name]}  ${name}`).join('\n')}\n`
  const text = channelText({ version: VERSION, managementUrl: 'https://mgmt.example.test:443', entries })
  return { dir, distDir, entries, text, upstream }
}

test('verify accepts a channel that serves exactly what was published', () => {
  const f = fixture()
  const logs = []
  const original = console.log
  console.log = (line) => logs.push(line)
  try {
    verify({ entries: f.entries, text: f.text, version: VERSION, distVersionDir: f.distDir, io: fakeChannel({ ...f }) })
  } finally {
    console.log = original
    rmSync(f.dir, { recursive: true, force: true })
  }
  assert.ok(logs.includes('==> channel verified'))
  assert.ok(logs.some((line) => line.includes('ok /install.sh (the one-liner)')))
})

test('verify refuses a published installer that differs from the repository copy', () => {
  const f = fixture()
  const io = fakeChannel({ ...f, mutate: { '/install.sh': Buffer.from('#!/bin/sh\necho stolen\n') } })
  assert.throws(
    () => verify({ entries: f.entries, text: f.text, version: VERSION, distVersionDir: f.distDir, io }),
    /\/install\.sh \(the one-liner\): served content differs/,
  )
  rmSync(f.dir, { recursive: true, force: true })
})

test('verify refuses a root page that differs from the repository copy', () => {
  const f = fixture()
  const io = fakeChannel({ ...f, mutate: { '/': Buffer.from('<!doctype html><p>some other site</p>') } })
  assert.throws(
    () => verify({ entries: f.entries, text: f.text, version: VERSION, distVersionDir: f.distDir, io }),
    /\/ \(the site\): served content differs/,
  )
  rmSync(f.dir, { recursive: true, force: true })
})

test('verify refuses a /client/ that stopped pointing at the root', () => {
  const f = fixture()
  const io = { ...fakeChannel({ ...f }), redirect: () => '200 ' }
  assert.throws(
    () => verify({ entries: f.entries, text: f.text, version: VERSION, distVersionDir: f.distDir, io }),
    /\/client\/ -> \/ \(old address\)/,
  )
  rmSync(f.dir, { recursive: true, force: true })
})

test('verify refuses an archive whose served size differs from the local one', () => {
  const f = fixture()
  const io = fakeChannel({ ...f, mutate: { [NAMES[0]]: 17 } })
  assert.throws(
    () => verify({ entries: f.entries, text: f.text, version: VERSION, distVersionDir: f.distDir, io }),
    /content-length: served content differs/,
  )
  rmSync(f.dir, { recursive: true, force: true })
})
test('the vhost install backs up first, validates before reloading and restores on failure', () => {
  const remote = '/www/server/panel/vhost/nginx/anywhere.conf'
  const script = vhostScript({ remote, bodyBase64: 'AAAA', stamp: '20261016T011900' })

  // Backup happens before anything is written over the live file.
  const backup = script.indexOf(`${remote}.bak-site-20261016T011900`)
  const write = script.indexOf(`cp /tmp/aw-anywhere.conf "$VHOST"`)
  assert.ok(backup !== -1 && write !== -1 && backup < write, 'the live vhost is overwritten before it is backed up')

  // `nginx -t` runs before the reload, and a rejected config puts the backup back.
  const test = script.indexOf('nginx -t')
  const reload = script.indexOf('nginx -s reload')
  assert.ok(test !== -1 && reload !== -1 && test < reload, 'the config is reloaded before it is validated')
  assert.match(script, /cp '\/www\/server\/panel\/vhost\/nginx\/anywhere\.conf\.bak-site-20261016T011900' "\$VHOST"/)

  // The include directory is globbed with *.conf, so a backup that ended in
  // `.conf` would be parsed as a second vhost and break `nginx -t`.
  assert.doesNotMatch(script, /bak-site-20261016T011900\.conf\b/)
})

test('the vhost install is a no-op when the served config already matches', () => {
  const script = vhostScript({ remote: '/etc/nginx/sites/aw.conf', bodyBase64: 'AAAA', stamp: 'S' })
  assert.match(script, /cmp -s \/tmp\/aw-anywhere\.conf "\$VHOST"/)
  assert.match(script, /vhost: already current/)
})

test('the published vhost serves the site at the root and keeps every channel endpoint', () => {
  const vhost = readFileSync(VHOST_SOURCE, 'utf8')

  // The site is the root's document, served out of the published channel root,
  // with its relative asset reachable at the root for the same reason.
  assert.match(vhost, /location = \/ \{\n\s+root \/www\/wwwroot\/client;/)
  assert.match(vhost, /try_files \/index\.html =404;/)
  assert.match(vhost, /location = \/qr-phone\.svg \{/)

  // The old address is a redirect to the root, so a shared link or a compiled
  // address still lands on the page - and does not serve a second copy of it.
  assert.match(vhost, /location = \/client\/ \{\n\s+return 301 https:\/\/\$host\/;/)

  // Every endpoint the app and the installer have compiled in.
  for (const endpoint of ['/health', '/version.json', '/fleet.json', '/install.sh', '/install.ps1']) {
    assert.ok(vhost.includes(`location = ${endpoint} {`), `${endpoint} lost its location block`)
  }
  assert.match(vhost, /location \/client\/ \{/)
  assert.match(vhost, /location ~ \^\/client\/netbird_/)
})

test('the vhost carries exactly one of each location, so nginx -t cannot see a duplicate', () => {
  const vhost = readFileSync(VHOST_SOURCE, 'utf8')
  for (const needle of [
    'location = / {',
    'location = /client/ {',
    'location ^~ /deck/ {',
    'location = /install.sh {',
    'location = /install.ps1 {',
  ]) {
    const count = vhost.split(needle).length - 1
    assert.equal(count, 1, `${needle} appears ${count} times; a duplicate location fails nginx -t`)
  }
})

test('the deck region in the vhost is byte-identical to the region the deck patches', () => {
  // the deck deploy script replaces exactly the marked region with its own
  // snippet. If the two drift, the deck's patcher either reports the region as
  // present-without-markers (and silently stops maintaining it) or inserts a
  // second /deck/ location, which is an nginx -t failure.
  const vhost = readFileSync(VHOST_SOURCE, 'utf8')
  const snippet = readFileSync(new URL('../tools/dsh-netbird/nginx-deck.conf.snippet', import.meta.url), 'utf8')
  const lines = vhost.split('\n')
  const begin = lines.findIndex(line => line.includes('deck (anywhere work roadshow) begin'))
  const end = lines.findIndex(line => line.includes('deck (anywhere work roadshow) end'))
  assert.ok(begin !== -1 && end > begin, 'the deck region markers are missing from the vhost')
  assert.equal(lines.slice(begin, end + 1).join('\n').trim(), snippet.trim(),
    'the vhost deck region differs from tools/dsh-netbird/nginx-deck.conf.snippet')
})
