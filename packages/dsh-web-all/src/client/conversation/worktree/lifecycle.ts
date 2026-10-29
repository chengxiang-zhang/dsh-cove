/**
 * Worktree lifecycle stage derivation (pure, shared with tests): given the
 * disk truth and the latest status probe, classify a linked worktree into
 * one of the four panel stages that drive its primary action.
 *
 * Also the single place that turns a client/host failure into localized copy:
 * the panel and the dialogs must never print the host's English `message`
 * verbatim in a Chinese UI, and a fence refusal must not read like a git bug.
 * @module @dsh-cove/dsh-client-ui-worktree/client/lifecycle
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorktreeStatusView, WorktreeView } from '../../../core/worktree/types.ts'
import type { WorktreeErrorCode } from '../../../core/worktree/invariant.ts'
import { WorktreeApiError } from './api.ts'
import type { WorktreeKey } from './locales.ts'

/** Lifecycle stage of one linked worktree — drives the row's primary action. */
export type WorktreeStage = 'missing' | 'developing' | 'in-review' | 'merged'

export function stageOfWorktree(
  worktree: Pick<WorktreeView, 'exists' | 'branch'>,
  status: WorktreeStatusView | undefined,
): WorktreeStage {
  if (!worktree.exists) return 'missing'
  if (status?.merged === true) return 'merged'
  // A pushed branch with a recorded PR url is under review; anything else
  // is still developing (submit-PR is the next step).
  if (status?.prUrl != null && status.prUrl !== '') return 'in-review'
  return 'developing'
}

/** The localized key for one domain error code. */
function codeKeyOf(code: WorktreeErrorCode | undefined): WorktreeKey {
  switch (code) {
    case 'worktree-exists': return 'error.worktreeExists'
    case 'worktree-not-found': return 'error.worktreeNotFound'
    case 'not-a-repository': return 'error.notARepository'
    case 'workspace-unknown': return 'error.workspaceUnknown'
    case 'invalid-branch': return 'error.invalidBranch'
    case 'worktree-busy': return 'error.worktreeBusy'
    case 'not-merged': return 'error.notMerged'
    case 'session-create-failed':
    case 'session-unknown': return 'error.laneSession'
    case 'lane-mismatch': return 'error.laneMismatch'
    default: return 'error.gitFailed'
  }
}

/**
 * The localized key explaining one failure, or null when the error carries no
 * known shape (the caller then shows its own message).
 */
export function worktreeErrorKeyOf(error: unknown): WorktreeKey | null {
  if (error instanceof WorktreeApiError) {
    if (error.kind === 'permission') return 'error.permissionDenied'
    if (error.kind === 'malformed' || error.kind === 'transport') return 'error.unreachable'
    return codeKeyOf(error.code)
  }
  return null
}

/**
 * Render one failure as user-facing copy.
 * @param error - any thrown value from the worktree API.
 * @param t - the `worktree` namespace translator.
 * @returns localized text, with the raw detail attached for the git/unreachable cases.
 */
export function worktreeErrorMessage(error: unknown, t: Translate<WorktreeKey>): string {
  const detail = error instanceof Error ? error.message : String(error)
  const key = worktreeErrorKeyOf(error)
  if (key === null) return detail
  if (key === 'error.gitFailed' || key === 'error.unreachable') return t(key, { error: detail })
  return t(key)
}