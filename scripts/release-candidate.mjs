#!/usr/bin/env node
// Publish only a candidate. Existing immutable versions must match the gated
// tarball; authentication/network failures are never treated as "not found".
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packOne, isRegistryNotFound, NPM_TIMEOUT_MS } from './release-assets.mjs'

export const REGISTRY = 'https://registry.npmjs.org/'
/**
 * The packages a release publishes, at the one version its tag names.
 *
 * The runtime entity and the source/data package beside it travel together, so both go
 * through the same three stages: the candidate tag first, the immutable registry bytes
 * verified afterwards, and `latest` only once that verification passed. Restricting this
 * list is what stops a stray tarball from being published by a release run.
 */
export const RELEASE_PACKAGE_NAMES = [
  '@dsh-cove/dsh-web-all',
  '@dsh-cove/dsh-client-ui-community-plugins',
]
const runDefault = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', ...options })
export function integrity(file) {
  return 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64')
}
function stableVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('invalid stable release version: ' + String(version))
  }
  return version.split('.').map(part => BigInt(part))
}

/** Compare stable versions numerically, without lexicographic or precision loss. */
export function compareStableVersions(left, right) {
  const a = stableVersion(left)
  const b = stableVersion(right)
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

export function artifactIdentity(file, run = runDefault) {
  const manifest = JSON.parse(run('tar', ['-xOzf', file, 'package/package.json'], { timeout: NPM_TIMEOUT_MS }))
  if (!RELEASE_PACKAGE_NAMES.includes(manifest?.name)) {
    throw new Error('not a release artifact for this repository: ' + String(manifest?.name))
  }
  stableVersion(manifest.version)
  return { name: manifest.name, version: manifest.version }
}
function registryView(spec, field, run) {
  let stdout
  try {
    stdout = run('npm', ['view', spec, field, '--json', '--registry=' + REGISTRY], { timeout: NPM_TIMEOUT_MS })
  } catch (error) {
    if (isRegistryNotFound(error)) return null
    throw error
  }
  // Malformed success output is not an absent package/version.
  const value = JSON.parse(stdout)
  if (value === null) throw new Error('registry returned null metadata for ' + spec)
  return value
}

export function registryMetadata(spec, run = runDefault) {
  const metadata = registryView(spec, 'dist', run)
  if (metadata === null) return null
  if (typeof metadata?.integrity !== 'string' || metadata.integrity === '') {
    throw new Error('registry metadata has no integrity for ' + spec)
  }
  return metadata
}

/** Missing latest is valid on a first candidate-only release; malformed tags fail closed. */
export function registryLatest(name, run = runDefault) {
  const tags = registryView(name, 'dist-tags', run)
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) {
    throw new Error('registry dist-tags unavailable or malformed for ' + name)
  }
  if (!Object.hasOwn(tags, 'latest')) return null
  stableVersion(tags.latest)
  return tags.latest
}
export function assertArtifact(file, metadata) {
  if (!metadata || metadata.integrity !== integrity(file)) throw new Error('immutable registry artifact differs from gated tarball')
}
export function publishCandidate(file, run = runDefault, {
  attempts = 30,
  delayMs = 10000,
  sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  const { name, version } = artifactIdentity(file, run)
  const spec = `${name}@${version}`
  let metadata = registryMetadata(spec, run)
  if (metadata) {
    assertArtifact(file, metadata)
    return { spec, published: false }
  }
  // npm never replaces an existing version. A concurrent publication/failure
  // remains a failure, rather than silently claiming our candidate was shipped.
  run('npm', ['publish', file, '--access', 'public', '--tag', 'candidate', '--registry=' + REGISTRY], { stdio: 'inherit', timeout: NPM_TIMEOUT_MS })
  // Retry only confirmed registry 404s. Auth, network, malformed metadata and
  // immutable-byte mismatches must remain their original errors, not propagation.
  for (let attempt = 1; attempt <= attempts; attempt++) {
    metadata = registryMetadata(spec, run)
    if (metadata) break
    if (attempt < attempts) sleep(delayMs)
  }
  if (!metadata) throw new Error('timed out waiting for candidate propagation: ' + spec)
  assertArtifact(file, metadata)
  return { spec, published: true }
}
export function downloadVerified(file, outDir, run = runDefault) {
  if (typeof outDir !== 'string' || /[\x00-\x1f\x7f]/.test(outDir)) throw new Error('invalid artifact output path')
  const { name, version } = artifactIdentity(file, run)
  const metadata = registryMetadata(`${name}@${version}`, run)
  assertArtifact(file, metadata)
  mkdirSync(outDir, { recursive: true })
  const downloaded = packOne(name, version, outDir, run)
  assertArtifact(downloaded, metadata)
  return downloaded
}
export function promote(file, run = runDefault) {
  const { name, version } = artifactIdentity(file, run)
  const spec = `${name}@${version}`
  // Even an equal/older rerun must prove the immutable version is our gated artifact.
  assertArtifact(file, registryMetadata(spec, run))
  const current = registryLatest(name, run)
  if (current !== null && compareStableVersions(version, current) <= 0) {
    console.log(`[release-candidate] preserving latest ${current}; verified ${spec}`)
    return { spec, promoted: false, latest: current }
  }
  // Repository-wide workflow concurrency serializes this read/write with other
  // releases here. npm has no CAS: publishers outside this workflow can still race.
  run('npm', ['dist-tag', 'add', spec, 'latest', '--registry=' + REGISTRY], { stdio: 'inherit', timeout: NPM_TIMEOUT_MS })
  return { spec, promoted: true, latest: version }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [mode, input, output] = process.argv.slice(2)
    if (!input) throw new Error('usage: release-candidate.mjs publish|download|promote <gated.tgz> [outDir]')
    const file = resolve(input)
    if (mode === 'publish') publishCandidate(file)
    else if (mode === 'download' && output) {
      // The verified path is the command's output, so a caller that verifies two packages
      // in one job cannot have the second overwrite the first's identity.
      console.log(downloadVerified(file, resolve(output)))
    } else if (mode === 'promote') promote(file)
    else throw new Error('invalid release-candidate mode')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
