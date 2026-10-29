/**
 * Host git subprocess plumbing for the worktree manager. We reuse the
 * shared runner seam (`@deepseek-ai/dsh-subprocess`) the family already
 * uses for git operations; this file only owns the worktree-specific git
 * argv builders so the service layer stays declarative.
 * @module dsh-client-ui-worktree/host/git
 */

import type { GitRunner } from './git-runner.ts'

/** win32 ships git as git.exe (git for Windows); the .cmd/.bat shim in
 *  PATH would otherwise be the resolution target and Node's spawn cannot
 *  launch a .cmd file directly. Naming git.exe bypasses any shim and
 *  always hits the native executable. cmd.exe routing is deliberately
 *  NOT used: several git args carry %-format specs (--format on
 *  for-each-ref / log) that cmd would expand and corrupt. */
export function gitSpawnArgv(platform: NodeJS.Platform, argv: readonly string[]): readonly string[] {
  return platform === 'win32' ? ['git.exe', ...argv] : ['git', ...argv]
}

/** `git worktree list --porcelain` — the canonical list of linked worktrees
 *  with their branch, HEAD, and on-disk path. */
export const WORKTREE_LIST_ARGV = ['worktree', 'list', '--porcelain'] as const

/**
 * `git worktree add [-b <branch>] [--detach] <path> [<commit-ish>]` — the
 * create argv. `branch` cuts a new branch at `commitIsh` and checks it out
 * in the linked worktree; without it git checks out `commitIsh` itself, and
 * a commit-ish that is not a branch name leaves a DETACHED HEAD. A detached
 * worktree cannot be pushed (`git push -u origin <branch>` needs a local
 * branch) or matched by `git worktree list --porcelain`, so every
 * session-bound lane must pass `branch`.
 *
 * `-b` and `--detach` are mutually exclusive in git; passing both is a
 * programmer error and throws rather than silently dropping one.
 */
export function worktreeAddArgv(
  path: string,
  commitIsh: string,
  detach: boolean,
  branch?: string,
): readonly string[] {
  if (detach && branch !== undefined) {
    throw new Error('worktreeAddArgv: --detach and -b are mutually exclusive')
  }
  const argv = ['worktree', 'add']
  if (detach) argv.push('--detach')
  if (branch !== undefined) argv.push('-b', branch)
  argv.push(path, commitIsh)
  return argv
}

/**
 * `git check-ignore -q <path>` — exit 0 when the path is ignored by the
 * repository's ignore rules. Used to refuse creating a lane before the
 * lane root is ignored, so an unignored `<repo>/.dsh/workspaces/` can never
 * be swept into the main checkout by a `git add -A`.
 */
export function checkIgnoreArgv(path: string): readonly string[] {
  return ['check-ignore', '-q', path]
}

/** `git worktree remove [--force] <path>` — the remove argv. */
export function worktreeRemoveArgv(path: string, force: boolean): readonly string[] {
  const argv = ['worktree', 'remove']
  if (force) argv.push('--force')
  argv.push(path)
  return argv
}

/** `git worktree prune` — drop stale administrative records. */
export const WORKTREE_PRUNE_ARGV = ['worktree', 'prune'] as const

/** `git worktree list --porcelain` invocation helper. */
export function worktreeListPorcelain(): readonly string[] {
  return WORKTREE_LIST_ARGV
}

/** `git rev-parse --verify --quiet refs/heads/<branch>` — branch exists check. */
export function verifyRefArgv(branch: string): readonly string[] {
  return ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]
}

/** `git branch <name> [<start>]` — create branch from start point. */
export function createBranchArgv(name: string, start?: string): readonly string[] {
  const argv = ['branch', name]
  if (start !== undefined) argv.push(start)
  return argv
}

/** `git remote` — list configured remotes (we look for `origin`). */
export const REMOTE_LIST_ARGV = ['remote'] as const

/** `git remote get-url <name>` — the remote URL for compare-URL / API derivation. */
export function remoteGetUrlArgv(name: string): readonly string[] {
  return ['remote', 'get-url', name]
}

/** `git push -u origin <branch>` — push and set upstream. */
export function pushUpstreamArgv(branch: string): readonly string[] {
  return ['push', '-u', 'origin', branch]
}

/** `git ls-remote --exit-code origin refs/heads/<branch>` — remote branch existence probe. */
export function lsRemoteBranchArgv(branch: string): readonly string[] {
  return ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`]
}

/** `git fetch origin --prune` — sync remote-tracking refs and drop deleted ones. */
export const FETCH_PRUNE_ARGV = ['fetch', 'origin', '--prune'] as const

/** `git merge-base --is-ancestor <candidate> <base>` — merge detection (exit 0 = ancestor). */
export function mergeBaseIsAncestorArgv(candidate: string, base: string): readonly string[] {
  return ['merge-base', '--is-ancestor', candidate, base]
}

/** `git rev-parse --verify --quiet refs/remotes/origin/<branch>` — pushed probe. */
export function verifyRemoteRefArgv(branch: string): readonly string[] {
  return ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]
}

/** `git symbolic-ref refs/remotes/origin/HEAD` — remote default branch probe (fails when unset). */
export const REMOTE_HEAD_REF = 'refs/remotes/origin/HEAD' as const
export const REMOTE_HEAD_ARGV = ['symbolic-ref', REMOTE_HEAD_REF] as const

/** `git branch -d|-D <branch>` — delete the local branch (refuses unmerged without -D). */
export function branchDeleteArgv(branch: string, force: boolean): readonly string[] {
  return ['branch', force ? '-D' : '-d', branch]
}

/** `git for-each-ref refs/heads refs/remotes/origin --format=%(refname:short)` —
 *  candidate branches for the create/PR dialog dropdowns. Local branches
 *  come first, then remote-tracking `origin/*` names (prefix stripped). */
export const BRANCH_LIST_ARGV = [
  'for-each-ref', 'refs/heads', 'refs/remotes/origin',
  '--format=%(refname:short)',
] as const

/**
 * Parse `git for-each-ref` output into a deduplicated short-name list:
 * local branches in listing order first, then `origin/*` remote-tracking
 * names with the `origin/` prefix stripped (skipping duplicates already
 * seen locally, so `dev` + `origin/dev` collapse to one entry).
 */
export function parseBranchList(stdout: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '').trim()
    if (line === '' || line === 'origin/HEAD') continue
    const name = stripOriginPrefix(line)
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** Strip a leading `origin/` from a remote-tracking short ref. */
export function stripOriginPrefix(ref: string): string {
  return ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref
}

/** Re-export the shared runner type for callers. */
export type { GitRunner }
