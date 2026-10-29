import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CA_COMMON_NAME,
  DEFAULT_TLS_DIR,
  assertOutsideRepo,
  ensureCa,
  entryHostFor,
  hostFromInventory,
  issueLeaf,
  materialPaths,
  trustCommands,
  verifyEntry,
} from './dsh-netbird-tls.mjs'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-netbird-tls-test-'))
  test.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the canonical name comes from the inventory pattern, not from a second rule', () => {
  assert.equal(entryHostFor('studio-mac', 'dsh.<netbird-machine-name>.netbird'), 'dsh.studio-mac.netbird')
  assert.throws(() => entryHostFor('', 'dsh.<netbird-machine-name>.netbird'), /single label/)
  assert.throws(() => entryHostFor('a.b', 'dsh.<netbird-machine-name>.netbird'), /single label/)
  assert.equal(hostFromInventory(REPO_ROOT, 'studio-mac'), 'dsh.studio-mac.netbird')
  assert.throws(() => hostFromInventory(REPO_ROOT, 'no-such-machine'), /declares no machine/)
})

test('private material is refused inside the checkout and accepted outside it', () => {
  assert.throws(() => assertOutsideRepo(REPO_ROOT), /inside the repository/)
  assert.throws(() => assertOutsideRepo(join(REPO_ROOT, 'scripts')), /inside the repository/)
  const dir = tempDir()
  assert.equal(assertOutsideRepo(dir), resolve(dir))
  assert.equal(DEFAULT_TLS_DIR.startsWith(REPO_ROOT), false)
})

test('one CA serves the fleet, and its private key is not world readable', () => {
  const dir = tempDir()
  const ca = ensureCa(dir)
  assert.equal(ca.created, true)
  const certificate = new X509Certificate(readFileSync(ca.cert))
  assert.equal(certificate.ca, true, 'the root must be usable as a CA')
  assert.match(certificate.subject, new RegExp(CA_COMMON_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(statSync(materialPaths(dir, 'ca').caKey).mode & 0o777, 0o600)
  assert.equal(statSync(ca.cert).mode & 0o777, 0o644)

  const again = ensureCa(dir)
  assert.equal(again.created, false, 'a second init keeps the root, so leaves stay valid')
  assert.equal(readFileSync(again.cert, 'utf8'), readFileSync(ca.cert, 'utf8'))
})

test('a leaf carries exactly the canonical name and chains to the fleet CA', () => {
  const dir = tempDir()
  const caCert = new X509Certificate(readFileSync(ensureCa(dir).cert))
  const host = 'dsh.studio-mac.netbird'
  const leaf = issueLeaf(dir, host, { caCert })
  assert.equal(leaf.issued, true)

  const certificate = new X509Certificate(readFileSync(leaf.cert))
  assert.equal(certificate.subjectAltName, `DNS:${host}`)
  assert.equal(certificate.checkIssued(caCert), true)
  assert.equal(statSync(leaf.key).mode & 0o777, 0o600)

  // Independent of Node's own verifier: openssl is what a reviewer will run.
  const output = execFileSync('openssl', ['verify', '-CAfile', materialPaths(dir, 'ca').caCert, leaf.cert], {
    encoding: 'utf8',
  })
  assert.match(output, /: OK/)
})

test('re-issuing keeps a valid leaf, and --rotate replaces it', () => {
  const dir = tempDir()
  const caCert = new X509Certificate(readFileSync(ensureCa(dir).cert))
  const host = 'dsh.studio-mac.netbird'
  const first = issueLeaf(dir, host, { caCert })
  // Read the bytes now: `first.cert` and `rotated.cert` are one path, so comparing the
  // paths after a rotation would compare the rotated file with itself.
  const firstBytes = readFileSync(first.cert, 'utf8')
  const second = issueLeaf(dir, host, { caCert })
  assert.equal(second.issued, false, 'a live fleet is not re-identified on every run')
  assert.equal(readFileSync(second.cert, 'utf8'), firstBytes)

  const rotated = issueLeaf(dir, host, { caCert, rotate: true })
  assert.equal(rotated.issued, true)
  assert.notEqual(readFileSync(rotated.cert, 'utf8'), firstBytes)
})

test('a leaf from a superseded root is re-issued instead of kept', () => {
  const dir = tempDir()
  const host = 'dsh.studio-mac.netbird'
  const oldCa = new X509Certificate(readFileSync(ensureCa(dir).cert))
  issueLeaf(dir, host, { caCert: oldCa })

  // A root is rotated by replacing it, which is the only moment every leaf becomes
  // a leaf of nothing. A kept leaf here would serve a chain no client trusts.
  rmSync(materialPaths(dir, 'ca').caKey)
  rmSync(materialPaths(dir, 'ca').caCert)
  const newCa = new X509Certificate(readFileSync(ensureCa(dir).cert))
  assert.notEqual(newCa.fingerprint, oldCa.fingerprint, 'the rotated root is a different root')

  const reissued = issueLeaf(dir, host, { caCert: newCa })
  assert.equal(reissued.issued, true)
  const certificate = new X509Certificate(readFileSync(reissued.cert))
  assert.equal(certificate.verify(newCa.publicKey), true)
  // Same issuer name, different key: the signature is the only thing that distinguishes
  // a leaf of the new root from a leaf of the old one.
  assert.equal(certificate.verify(oldCa.publicKey), false)
})

/**
 * Serves one leaf on a loopback port, the way a machine's nginx will.
 *
 * @param {object} leaf
 * @returns {Promise<{ port: number, close: () => void }>}
 */
function serveLeaf(leaf) {
  const server = https.createServer(
    { key: readFileSync(leaf.key), cert: readFileSync(leaf.cert) },
    (_request, response) => response.end('ok'),
  )
  return new Promise((resolvePromise, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({ port: server.address().port, close: () => server.close() })
    })
  })
}

test('verification is a real handshake: chain plus host name', async () => {
  const dir = tempDir()
  const caCert = new X509Certificate(readFileSync(ensureCa(dir).cert))
  const host = 'dsh.studio-mac.netbird'
  const leaf = issueLeaf(dir, host, { caCert })
  const served = await serveLeaf(leaf)
  try {
    const ok = await verifyEntry({ host, ip: '127.0.0.1', port: served.port, caPath: materialPaths(dir, 'ca').caCert })
    assert.equal(ok.ok, true, JSON.stringify(ok))
    assert.equal(ok.san, `DNS:${host}`)

    const wrongName = await verifyEntry({
      host: 'dsh.other-mac.netbird',
      ip: '127.0.0.1',
      port: served.port,
      caPath: materialPaths(dir, 'ca').caCert,
    })
    assert.equal(wrongName.ok, false, 'a name the leaf does not carry must not verify')

    const foreign = tempDir()
    ensureCa(foreign)
    const wrongCa = await verifyEntry({
      host,
      ip: '127.0.0.1',
      port: served.port,
      caPath: materialPaths(foreign, 'ca').caCert,
    })
    assert.equal(wrongCa.ok, false, 'an untrusted chain must not verify')
  } finally {
    served.close()
  }
})

test('trust commands name the system stores the browsers actually read', () => {
  const commands = trustCommands('/tmp/ca.crt')
  const platforms = commands.map(entry => entry.platform).join('\n')
  assert.match(platforms, /macOS/)
  assert.match(commands[0].command, /security add-trusted-cert/)
  assert.match(commands.map(entry => entry.command).join('\n'), /update-ca-certificates/)
})