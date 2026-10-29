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

/**
 * Promote every release package and prove the read-back, so a promotion that npm accepted
 * but did not apply cannot be reported as done.
 */
export function promote(version, run = (file, args, options) => execFileSync(file, args, { encoding: 'utf8', ...options })) {
  const resolved = parseVersion(version)
  for (const { name, args } of promoteCommands(resolved)) {
    console.log('[promote-latest] npm ' + args.join(' '))
    run('npm', args, { stdio: 'inherit' })
    const tags = JSON.parse(run('npm', ['view', name, 'dist-tags', '--json', '--registry=' + REGISTRY], { encoding: 'utf8' }))
    if (tags?.latest !== resolved) throw new Error(`${name}: latest is ${String(tags?.latest)}, expected ${resolved}`)
    console.log(`[promote-latest] ${name} latest=${resolved}`)
  }
  return { version: resolved }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    promote(process.argv[2])
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
