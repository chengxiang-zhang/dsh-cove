/**
 * Public error type thrown by the host worktree manager. Errors are domain
 * shaped (no leaking of git exit codes as raw integers) so the HTTP layer
 * can map them to stable status codes without parsing message strings.
 *
 * The browser half imports this through the same `./invariant` export as
 * the host half: both halves agree on the error vocabulary over the wire.
 * @module @dsh-cove/dsh-client-ui-worktree/invariant
 */

export type WorktreeErrorCode =
  /** The session cwd is not inside a git repository. */
  | 'not-a-repository'
  /** The session cwd does not match any registered workspace. */
  | 'workspace-unknown'
  /** The named worktree does not exist for the repository. */
  | 'worktree-not-found'
  /** A worktree with the same name already exists. */
  | 'worktree-exists'
  /** A running session would be broken by removing this worktree. */
  | 'worktree-busy'
  /** The branch name is invalid (empty, contains spaces, has a `..`, etc.). */
  | 'invalid-branch'
  /** A git subprocess returned a non-zero exit code. */
  | 'git-failed'
  /** The git push to the remote failed. */
  | 'push-failed'
  /** The repository has no `origin` remote to push to. */
  | 'no-remote'
  /** Cleanup refused because the branch is not merged into its base. */
  | 'not-merged'
  /** The remote host is not GitHub, so no compare URL or PR API applies. */
  | 'unsupported-remote'
  /** The manifest file is missing required fields or is corrupted. */
  | 'manifest-corrupt'
  /** The repo does not ignore `<repo>/.dsh/workspaces/`, so a lane directory
   *  would show up as untracked in the main checkout. */
  | 'worktree-not-ignored'
  /** The host could not create the session bound to a new lane. */
  | 'session-create-failed'
  /** The session a lane would bind to is not live on the host. */
  | 'session-unknown'
  /** A bind named a lane the asking conversation is not running in. */
  | 'lane-mismatch'

/**
 * Thrown by the worktree host service when a domain precondition fails.
 * The message is human-readable English; the code is the stable contract.
 */
export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: WorktreeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'WorktreeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/**
 * Stable, language-neutral branch-name predicate. Accepts the git ref
 * subset that does not surprise users: letters, digits, dot, underscore,
 * slash, dash; must not be empty, must not start with a dot or dash, must
 * not contain `..`, must not end with `.lock`, and must be <= 100 chars.
 */
export function isValidBranchName(name: string): boolean {
  if (typeof name !== 'string') return false
  if (name.length === 0 || name.length > 100) return false
  if (name === 'HEAD' || name === '@') return false
  if (name.startsWith('.') || name.startsWith('-')) return false
  if (name.endsWith('.lock') || name.endsWith('/') || name.endsWith('.')) return false
  if (name.includes('..')) return false
  if (name.includes('~') || name.includes('^') || name.includes(':')) return false
  if (name.includes('\\') || name.includes(' ')) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false
  return true
}

/** Default error message for a code (browser copy mirrors these). */
export function defaultMessage(code: WorktreeErrorCode): string {
  switch (code) {
    case 'not-a-repository': return 'The directory is not a git repository.'
    case 'workspace-unknown': return 'The directory is not a registered workspace.'
    case 'worktree-not-found': return 'No such worktree.'
    case 'worktree-exists': return 'A worktree with that name already exists.'
    case 'worktree-busy': return 'A running session is bound to that worktree; stop it first or use force.'
    case 'invalid-branch': return 'That branch name is not valid for a git ref.'
    case 'git-failed': return 'git exited with a non-zero status; see the server log for details.'
    case 'push-failed': return 'The push to the remote failed; see the server log for details.'
    case 'no-remote': return 'The repository has no "origin" remote; add one before creating a pull request.'
    case 'not-merged': return 'The branch is not merged into its base; merge the pull request first or force the cleanup.'
    case 'unsupported-remote': return 'The remote host is not GitHub; PR creation is only supported for GitHub remotes.'
    case 'manifest-corrupt': return 'The worktree manifest is corrupted; remove it and reinitialize.'
    case 'worktree-not-ignored': return 'The repository does not ignore the worktree root; add it to .gitignore before creating a lane.'
    case 'session-create-failed': return 'The host could not start a session on the new lane; the lane was rolled back.'
    case 'session-unknown': return 'The session does not exist on the host, so it cannot be bound to a lane.'
    case 'lane-mismatch': return 'The session is not running in that lane directory, so it cannot be bound to it.'
  }
}
