#!/usr/bin/env node
/**
 * Verify that every package a release publishes declares the version the tag names.
 *
 * The repository has one version number. A tag names it and the runtime entity carries
 * it: one release, one version, whether the thing a person holds is the runtime or the
 * installer built from the same tag. Private workspace packages are not published, so
 * they are not this gate's business - the repository-wide invariant that they too
 * declare the released version lives in `scripts/version-doctrine.test.mjs`.
 *
 * Prints GitHub error annotations (::error file=...) on mismatch and exits
 * non-zero; the release workflow runs this right before publishing.
 *
 * Usage: node scripts/verify-version.mjs <x.y.z|vX.Y.Z>
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkCurrentPackages } from './lib/current-packages.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')

/** Whether a manifest is published, which is what makes its version this gate's business. */
function isPublished(pkgPath) {
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).private !== true
  } catch {
    // An unreadable manifest is reported by the mismatch pass rather than silently skipped.
    return true
  }
}

/** Package manifests published by a repository vX.Y.Z release. */
export function releasePackageFiles(root = REPO_ROOT) {
  return walkCurrentPackages(root)
    .filter(({ pkgPath }) => isPublished(pkgPath))
    .map(({ pkgPath }) => pkgPath)
}

function main() {
  const tag = process.argv[2] ?? ''
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(tag)
  if (match === null) {
    console.error('usage: node scripts/verify-version.mjs <x.y.z | vX.Y.Z>')
    process.exit(2)
  }
  const version = match[1]
  const files = releasePackageFiles()
  if (files.length === 0) {
    console.error('no published package was found under packages/; this is not a release tree')
    process.exit(1)
  }

  let mismatch = 0
  for (const file of files) {
    let pkgVersion
    try {
      pkgVersion = JSON.parse(readFileSync(file, 'utf8')).version
    } catch (error) {
      console.error(`::error file=${file}::unreadable package.json (${error instanceof Error ? error.message : String(error)})`)
      mismatch = 1
      continue
    }
    if (pkgVersion !== version) {
      console.error(`::error file=${file}::version ${pkgVersion} does not match tag v${version}`)
      mismatch = 1
    }
  }

  if (mismatch) process.exit(1)
  console.log(`[verify-version] all ${files.length} published packages match v${version}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
