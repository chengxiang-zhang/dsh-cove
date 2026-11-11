import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { inspectProjectKeeper, type ProjectKeeperRef } from '../executors/project-keeper.ts'

// Fixed host helper: the private token is read here, never passed in argv or returned.
try {
  const refs = JSON.parse(readFileSync(0, 'utf8')) as Omit<ProjectKeeperRef, 'version' | 'managementToken'>[]
  if (!Array.isArray(refs) || !refs.length || refs.length > 7) throw Error('KEEPER_REFS_INVALID')
  for (const ref of refs) {
    const root = lstatSync(ref.root), path = join(ref.root, 'owner-ref.json'), info = lstatSync(path)
    if (!root.isDirectory() || root.mode & 0o077 || !info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.() || realpathSync(ref.root) !== ref.root) throw Error('KEEPER_OWNER_NOT_PRIVATE')
    const owner = JSON.parse(readFileSync(path, 'utf8')) as ProjectKeeperRef
    if (owner.version !== 1 || ['instance','root','pid','artifactDigest'].some(key => owner[key as keyof ProjectKeeperRef] !== ref[key as keyof typeof ref])) throw Error('KEEPER_OWNER_CHANGED')
    const result = await inspectProjectKeeper(owner)
    if (!result.current || !['active','quarantine'].includes(result.status.phase)) throw Error('KEEPER_NOT_CURRENT')
  }
  process.stdout.write('current')
} catch { process.stdout.write('unavailable'); process.exitCode = 1 }
