import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, isAbsolute, normalize } from 'node:path'
import type { GitEntry, DeliveryStep } from '../../protocol/delivery.ts'
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function git(root: string, args: string[], input?: Buffer | string, index?: string): string {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
    encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', ...(index ? { GIT_INDEX_FILE: index } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trimEnd()
}
export function safePath(path: string): void {
  if (!path || isAbsolute(path) || normalize(path) !== path || /[\\\x00-\x1f]/.test(path) || path.split('/').some(p => p === '..' || p.toLowerCase() === '.git')) throw new Error('DELIVERY_PATH')
}
export function file(root: string, path: string): { bytes: Buffer; mode: GitEntry['mode']; blob: string } | null {
  safePath(path)
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('DELIVERY_SYMLINK') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  const stat = lstatSync(current)
  if (!stat.isFile()) throw new Error('DELIVERY_FILE_TYPE')
  const bytes = readFileSync(current)
  return { bytes, mode: stat.mode & 0o111 ? '100755' : '100644', blob: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }
}
export const manifestDigest = (s: DeliveryStep) => digest({ manifest: s.manifest, deletions: s.deletions })
export function identity(s: DeliveryStep): void {
  if (!/^[a-f0-9]{40}$/.test(s.expectedParent) || realpathSync(s.candidateRoot) !== s.candidateRoot || s.branch !== 'dev' || realpathSync(s.targetRoot) !== s.targetRoot || git(s.targetRoot, ['rev-parse', '--show-toplevel']) !== s.targetRoot || realpathSync(git(s.targetRoot, ['rev-parse', '--absolute-git-dir'])) !== s.realGitDir || git(s.targetRoot, ['symbolic-ref', 'HEAD']) !== 'refs/heads/dev' || git(s.targetRoot, ['rev-parse', '--show-object-format']) !== 'sha1') throw new Error('DELIVERY_TARGET_CHANGED')
}
export function validateManifest(s: DeliveryStep): void {
  if (!s.manifest.length && !s.deletions.length) throw new Error('DELIVERY_EMPTY')
  const paths = [...s.manifest.map(e => e.path), ...s.deletions]
  if (new Set(paths).size !== paths.length) throw new Error('DELIVERY_DUPLICATE_PATH')
  for (const path of paths) safePath(path)
  for (const entry of s.manifest) {
    if (!['100644', '100755'].includes(entry.mode) || !/^[a-f0-9]{40}$/.test(entry.blob)) throw new Error('DELIVERY_MODE_REQUIRED')
    const actual = file(s.candidateRoot, entry.path)
    if (!actual || actual.blob !== entry.blob || actual.mode !== entry.mode) throw new Error('DELIVERY_CANDIDATE_CHANGED')
  }
  for (const path of s.deletions) if (file(s.candidateRoot, path)) throw new Error('DELIVERY_CANDIDATE_CHANGED')
}
export function treeEntries(root: string, revision: string): Map<string, GitEntry> {
  return new Map(git(root, ['ls-tree', '-rz', revision]).split('\0').filter(Boolean).map(row => {
    const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row)
    if (!match) throw new Error('DELIVERY_UNSUPPORTED_TREE')
    return [match[3]!, { path: match[3]!, mode: match[1] as GitEntry['mode'], blob: match[2]! }]
  }))
}
export function commitBytes(s: Pick<DeliveryStep, 'finalTree' | 'expectedParent' | 'message' | 'authoredAt'>): string {
  if (!Number.isSafeInteger(s.authoredAt) || s.authoredAt <= 0 || !s.message.trim() || s.message.includes('\0')) throw new Error('DELIVERY_COMMIT_METADATA')
  return `tree ${s.finalTree}\nparent ${s.expectedParent}\nauthor DSH Delivery <delivery@localhost> ${s.authoredAt} +0000\ncommitter DSH Delivery <delivery@localhost> ${s.authoredAt} +0000\n\n${s.message.trim()}\n`
}

export function gitBytes(root: string, args: string[]): Buffer { return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { maxBuffer: 256 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }) }
