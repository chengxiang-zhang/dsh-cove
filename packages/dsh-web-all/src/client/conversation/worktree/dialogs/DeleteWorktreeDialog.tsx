/**
 * Delete dialog: one action replaced the two that users could not tell apart
 * ("clean up worktree" vs "remove worktree"). The choice they actually make is
 * whether the local branch goes too, so that is the checkbox:
 *
 *   - unchecked -> host `remove`: deletes the directory and its record, keeps
 *     the local branch, so a directory can be made for it again later;
 *   - checked   -> host `cleanup`: also deletes the local branch, which the
 *     host only allows once the branch is merged (or when forced).
 *
 * The force checkbox is not a mode the user has to understand up front: it
 * appears exactly when the host will demand it — uncommitted changes anywhere,
 * or deleting an unmerged branch — and says what it costs. A merged, clean
 * directory therefore deletes in one click with no choices at all.
 * @module @dsh-cove/dsh-client-ui-worktree/client/dialogs/delete
 */

import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { WorktreeApi } from '../api.ts'
import { worktreeErrorMessage } from '../lifecycle.ts'
import styles from '../worktree.module.css'

export function DeleteWorktreeDialog(props: {
  repoPath: string
  name: string
  /** Whether the branch is merged: decides the branch checkbox's default. */
  merged: boolean
  /** Uncommitted files in the directory: the host needs force to drop them. */
  dirty: number
  api: WorktreeApi
  /** The asking conversation, when this directory is its own: the host accepts
   *  that conversation's teardown instead of reporting it as a busy session
   *  (deleting archives a directory's conversation either way). */
  sessionId?: string
  onClose: () => void
  onRemoved: () => void
  t: PropsLocale<'worktree'>['t']
}): JSX.Element {
  const { repoPath, name, merged, dirty, api, sessionId, onClose, onRemoved, t } = props
  // Default to finishing the branch off when the host already calls it merged;
  // otherwise keep the branch, because deleting an unmerged branch needs force.
  const [deleteBranch, setDeleteBranch] = useState<boolean>(merged)
  const [force, setForce] = useState<boolean>(false)
  const [busy, setBusy] = useState<boolean>(false)
  const [error, setError] = useState<unknown>(null)

  /** The host refuses these cases without force; ask instead of failing. */
  const needsForce = dirty > 0 || (deleteBranch && !merged)
  const effectiveForce = needsForce && force

  /** Closing mid-flight would hide a delete that is already running. */
  const guardClose = (): void => { if (!busy) onClose() }

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const input = { repoPath, name, force: effectiveForce, ...(sessionId === undefined ? {} : { sessionId }) }
      if (deleteBranch) await api.cleanup(input)
      else await api.remove(input)
      onRemoved()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={guardClose}
      closeLabel={t('dialog.close')}
      title={t('worktree.deleteTitle', { name })}
      description={t('worktree.deleteDescription')}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={guardClose}>{t('dialog.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => { void submit() }}>
            {busy ? t('dialog.confirm') : t('worktree.deleteConfirm')}
          </Button>
        </>
      )}
    >
      <div className={styles.dialogBody}>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={deleteBranch}
            onChange={(event) => { setDeleteBranch(event.target.checked); setError(null) }}
            disabled={busy}
          />
          <span>{t('worktree.deleteBranch')}</span>
        </label>
        <div className={styles.dialogHint}>{t('worktree.deleteBranchHint')}</div>
        {needsForce && (
          <label className={styles.checkboxRow}>
            <input type="checkbox" checked={force} onChange={(event) => { setForce(event.target.checked) }} disabled={busy} />
            <span>{t('worktree.deleteForce')}</span>
          </label>
        )}
        {needsForce && force && (
          <div className={styles.dialogError} role="alert">{t('worktree.deleteForceWarning')}</div>
        )}
        {error !== null && <div className={styles.dialogError} role="alert">{worktreeErrorMessage(error, t)}</div>}
      </div>
    </Modal>
  )
}