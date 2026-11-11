import { execFileSync } from 'node:child_process'
import { realpathSync, existsSync, lstatSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resourceIds } from '../protocol/execution.ts'
export type { Workspace } from '../protocol/execution.ts'
import type { Workspace } from '../protocol/execution.ts'
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
/** Trusted host provisioning only. Never copies or resets the caller's dirty checkout. */
export function prepareWorkspace(input: { source: string; baseline: string; destination: string; provisioningRoot: string; role?: Workspace['role']; environment?: string }): Workspace {
 const source = realpathSync(input.source), parent = realpathSync(dirname(input.destination)), provision = realpathSync(input.provisioningRoot)
 if (!isAbsolute(input.destination) || parent !== provision || existsSync(input.destination) || !/^[a-f0-9]{40}$/.test(input.baseline)) throw new Error('WORKSPACE_BOUNDARY')
 if (git(source, 'rev-parse', '--show-toplevel') !== source || git(source, 'rev-parse', `${input.baseline}^{commit}`) !== input.baseline) throw new Error('REPOSITORY_BASELINE_MISMATCH')
 const sourceStatus = git(source, 'status', '--porcelain=v1'), commonPath = git(source, 'rev-parse', '--git-common-dir'), common = realpathSync(isAbsolute(commonPath) ? commonPath : join(source,commonPath))
 let origin = ''; try { origin = git(source, 'remote', 'get-url', 'origin') } catch { /* A local repository has an explicit file identity. */ }
 const repositoryId = origin || `file:${common}`, branch = `p2/${randomUUID()}`
 execFileSync('/usr/bin/git', ['clone','--no-local','--no-hardlinks','--no-checkout','--',source,input.destination], { stdio: 'pipe', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
 git(input.destination, 'checkout', '-b', branch, input.baseline)
 const root = realpathSync(input.destination)
 if (lstatSync(root).isSymbolicLink() || git(root, 'rev-parse','HEAD') !== input.baseline || git(root,'status','--porcelain=v1')) throw new Error('WORKSPACE_NOT_READY')
 return { id: randomUUID(), root, source, repositoryId, baseline: input.baseline, branch, resources: resourceIds(repositoryId, branch, input.environment), sourceStatus, role: input.role ?? 'engineering' }
}
