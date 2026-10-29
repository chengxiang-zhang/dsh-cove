#!/usr/bin/env node
/**
 * Promote an already published and verified release to the `latest` dist-tag.
 *
 * The release workflow publishes the candidate, verifies the registry bytes, then promotes.
 * npm performs that promotion only when the trusted publisher carries the dist-tag
 * permission, so a deployment without it publishes and verifies fine but cannot move
 * `latest`. The workflow reports that case and stays green; this command is the one manual
 * step a maintainer then runs with their own npm credentials.
 *
 * Reads go straight to the registry over HTTP so the command never needs the npm CLI's
 * local state, and a version that already is `latest` needs no credentials at all.
 *
 * Usage: node scripts/promote-latest.mjs <vX.Y.Z|x.y.z>
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RELEASE_PACKAGE_NAMES, REGISTRY } from './release-candidate.mjs'

/** The plain version a tag names, with the leading `v` dropped. */
export function parseVersion(input) {
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(String(input ?? '').trim())
  if (match === null) throw new Error('usage: promote-latest.mjs <vX.Y.Z|x.y.z>')
  return match[1]
}

/** One `npm dist-tag add` per package the release publishes, in a fixed order. */
export function promoteCommands(version, packages = RELEASE_PACKAGE_NAMES) {
  return packages.map((name) => ({
    name,
    args: ['dist-tag', 'add', `${name}@${version}`, 'latest', '--registry=' + REGISTRY],
  }))
}

/** The registry's current `latest` for a package, read without the npm CLI. */
export async function registryLatest(name, fetchImpl = fetch) {
  const response = await fetchImpl(REGISTRY + encodeURIComponent(name).replace('%40', '@'))
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${name}: registry read failed with ${response.status}`)
  const body = await response.json()
  const latest = body?.['dist-tags']?.latest
  return typeof latest === 'string' ? latest : null
}

/**
 * Promote every release package and prove the read-back, so a promotion that npm accepted
 * but did not apply cannot be reported as done.
 */
export async function promote(version, options = {}) {
  const run = options.run ?? ((file, args, runOptions) => execFileSync(file, args, { encoding: 'utf8', ...runOptions }))
  const latestOf = options.registryLatest ?? registryLatest
  const resolved = parseVersion(version)
  const promoted = []
  for (const { name, args } of promoteCommands(resolved)) {
    if (await latestOf(name) === resolved) {
      console.log(`[promote-latest] ${name} already latest=${resolved}`)
      continue
    }
    console.log('[promote-latest] npm ' + args.join(' '))
    run('npm', args, { stdio: 'inherit' })
    const after = await latestOf(name)
    if (after !== resolved) throw new Error(`${name}: latest is ${String(after)}, expected ${resolved}`)
    console.log(`[promote-latest] ${name} latest=${resolved}`)
    promoted.push(name)
  }
  return { version: resolved, promoted }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  promote(process.argv[2]).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
