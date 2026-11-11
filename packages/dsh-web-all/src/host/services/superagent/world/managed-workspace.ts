import { mkdirSync, realpathSync, readFileSync, writeFileSync, lstatSync } from 'node:fs'
import { join, dirname, isAbsolute, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import type { Workspace } from '../protocol/execution.ts'
import { resourceIds } from '../protocol/execution.ts'

/** Host-owned public input list. No hooks, inherited config, private files or model argv. */
export function createManagedWorkspace(sourceRoot: string, files: readonly string[], destination: string, role: Workspace['role'] = 'engineering') {
  const source = realpathSync(sourceRoot)
  if (!isAbsolute(destination) || !relative(source, destination).startsWith('..')) throw new Error('PRIVATE_WORKSPACE_REQUIRED')
  mkdirSync(destination, { mode: 0o700 })
  const root = realpathSync(destination), manifest: { path: string; digest: string }[] = []
  for (const path of files) {
    if (isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '..' || p.startsWith('.') || /^(auth|credentials)(\.|$)/i.test(p))) throw new Error('PUBLIC_SOURCE_LIST_REQUIRED')
    const from = join(source, path)
    if (realpathSync(from) !== from || !lstatSync(from).isFile()) throw new Error('SOURCE_LINK_DENIED')
    const bytes = readFileSync(from)
    if (bytes.length > 1048576) throw new Error('SOURCE_FILE_TOO_LARGE')
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), bytes, { flag: 'wx', mode: lstatSync(from).mode & 0o111 ? 0o700 : 0o600 })
    manifest.push({ path, digest: createHash('sha256').update(bytes).digest('hex') })
  }
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe', env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  git('init', '-b', 'codex/managed-' + randomUUID())
  git('-c', 'user.name=Managed source preparation', '-c', 'user.email=managed@localhost.invalid', 'add', '--', '.')
  git('-c', 'user.name=Managed source preparation', '-c', 'user.email=managed@localhost.invalid', 'commit', '--allow-empty', '-m', 'chore: seal explicit public source input')
  const repositoryId = 'file:' + root, branch = git('branch', '--show-current')
  const workspace: Workspace = { id: randomUUID(), root, source, repositoryId, baseline: git('rev-parse', 'HEAD'), branch, resources: resourceIds(repositoryId, branch), sourceStatus: 'explicit-public-input:' + createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), role }
  return { workspace, manifest }
}
