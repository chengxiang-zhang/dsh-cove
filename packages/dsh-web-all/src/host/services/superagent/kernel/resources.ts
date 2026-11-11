import type { ExpectedDevTransition } from '../protocol/delivery.ts'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import type { Workspace } from '../protocol/execution.ts'
import type { Ref } from '../protocol/managed-work.ts'
export interface ResourceLease { resourceId: string; target: Ref; actionRef: Ref; epoch: number; expiresAt: number; status: 'held' | 'released' }
export { resourceIds } from '../protocol/execution.ts'
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
export function verifyWorkspace(w: Workspace, transition?: ExpectedDevTransition): void {
 if (realpathSync(w.root) !== w.root || git(w.root, 'rev-parse','--show-toplevel') !== w.root || git(w.root, 'branch','--show-current') !== w.branch || (git(w.root,'rev-parse','HEAD') !== w.baseline && !(transition && w.branch === 'dev' && transition.before === w.baseline && realpathSync(git(w.root, 'rev-parse', '--absolute-git-dir')) === transition.realGitDir && git(w.root, 'rev-parse', 'HEAD') === transition.after && git(w.root, 'rev-list', '--parents', '-n', '1', transition.after) === transition.after + ' ' + transition.before))) throw new Error('WORKSPACE_IDENTITY_CHANGED')
}
