/**
 * Path and naming helpers shared between the host manager and the browser
 * side (browser side uses these for display only — it never writes to the
 * filesystem). All paths are POSIX; the host normalizes the separators at
 * the git boundary.
 * @module @dsh-cove/dsh-client-ui-worktree/core
 */

import { isValidBranchName } from './invariant.ts'

/** The directory inside each repo that owns linked worktrees. */
export const WORKSPACE_DIR = '.dsh/workspaces'

/** The manifest filename inside `WORKSPACE_DIR`. */
export const MANIFEST_FILENAME = 'manifest.json'

/** Compose `<repo>/.dsh/workspaces` for a given repo path. */
export function worktreeRoot(repoPath: string): string {
  if (typeof repoPath !== 'string' || repoPath.length === 0) {
    throw new TypeError('repoPath must be a non-empty string')
  }
  const trimmed = stripTrailingSeparator(repoPath)
  return `${trimmed}/${WORKSPACE_DIR}`
}

/** Compose `<repo>/.dsh/workspaces/<branch>` for a given repo + branch. */
export function worktreeDir(repoPath: string, branch: string): string {
  if (!isValidBranchName(branch)) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`)
  }
  return `${worktreeRoot(repoPath)}/${branch}`
}

/**
 * Whether a path is one of this plugin's lane directories
 * (`<repo>/.dsh/workspaces/<branch>`).
 *
 * Used to keep the lane lifecycle's bookkeeping — retiring a lane's workspace
 * registration once its conversations are archived — away from workspaces the
 * user registered themselves. Workspace ids are opaque, so the path is the only
 * thing that identifies a lane in a workspace list.
 */
export function isLaneDirectory(path: string): boolean {
  if (typeof path !== 'string' || path === '') return false
  return path.replace(/\\/g, '/').includes(`/${WORKSPACE_DIR}/`)
}

/** Strip a single trailing `/` (defensive only — POSIX paths usually lack it). */
function stripTrailingSeparator(path: string): string {
  return path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path
}

/** Short sha (first 7 chars) — same display rule as `git rev-parse --short`. */
export function shortSha(sha: string | null | undefined): string | null {
  if (typeof sha !== 'string' || sha.length === 0) return null
  return sha.length > 7 ? sha.slice(0, 7) : sha
}

/**
 * Truncate a path for the sidebar row (replace the leading `<repo>/.dsh/`
 * with a visual marker so the full path is still in the title attr).
 */
export function displayPath(absolute: string): string {
  const marker = `/${WORKSPACE_DIR}/`
  const idx = absolute.indexOf(marker)
  if (idx < 0) return absolute
  return `.dsh/workspaces/${absolute.slice(idx + marker.length)}`
}

/**
 * Whether `target` is `root` itself or lies beneath it (POSIX, segment-aware).
 *
 * Applied to keep mutations inside the workspaces the host has registered: a
 * plain string prefix would let `/repo-other` read as "inside `/repo`".
 */
export function isInsidePath(root: string, target: string): boolean {
  const posix = (value: string): string => value.replace(/\\/g, '/')
  const base = posix(root)
  const candidate = posix(target)
  const trimmedBase = base.length > 1 && base.endsWith('/') ? base.slice(0, -1) : base
  const trimmed = candidate.length > 1 && candidate.endsWith('/') ? candidate.slice(0, -1) : candidate
  if (trimmedBase === '/' || trimmedBase === '') return trimmed.startsWith('/')
  return trimmed === trimmedBase || trimmed.startsWith(`${trimmedBase}/`)
}

/** Compare two paths for equality after normalization (POSIX separators). */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true
  const na = a.replace(/\\/g, '/')
  const nb = b.replace(/\\/g, '/')
  if (na === nb) return true
  const sa = na.endsWith('/') && na.length > 1 ? na.slice(0, -1) : na
  const sb = nb.endsWith('/') && nb.length > 1 ? nb.slice(0, -1) : nb
  return sa === sb
}

/**
 * Parse a GitHub remote URL into `{ owner, repo }`. Accepts the https
 * (`https://github.com/owner/repo[.git]`), ssh scp-like
 * (`git@github.com:owner/repo.git`), and ssh URL (`ssh://git@github.com/owner/repo`)
 * spellings. Returns null for non-GitHub remotes so the caller can fall
 * back to the compare-URL path.
 */
export function githubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const match = remoteUrl.trim().match(/(?:github\.com[/:])([^/]+)\/([^/.]+?)(?:\.git)?$/)
  if (match === null) return null
  const [, owner, repo] = match
  if (owner === undefined || repo === undefined || owner === '' || repo === '') return null
  return { owner, repo }
}

/**
 * GitHub compare URL for one PR candidate: base...head with the editor
 * expanded. Returns null when the remote is not a GitHub URL.
 */
export function githubCompareUrl(remoteUrl: string, base: string, branch: string): string | null {
  const parsed = githubOwnerRepo(remoteUrl)
  if (parsed === null) return null
  return `https://github.com/${parsed.owner}/${parsed.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`
}
