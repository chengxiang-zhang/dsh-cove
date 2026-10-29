/**
 * The create-branch dialog: name input with the pure validation mirror for
 * instant feedback, the host `check-ref-format` gate as the authority, and
 * readable rejection copy.
 *
 * On success it does not just vanish. Creating the branch also creates its
 * worktree, and whether this conversation now runs in it depends on the shell
 * (see the branch picker's `switchBranch`): the result view states which of the
 * two happened, because a dialog that closes silently would leave the user
 * believing they are on the new branch while they are still in the old
 * checkout.
 * @module dsh-git-graph/client/chips/CreateBranchDialog
 */

import { useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { validateBranchName } from '../../../core/git-graph/commands.ts'
import type { SwitchResult } from '../../../core/git-graph/protocol.ts'
import type { GitGraphKey } from './locales.ts'
import { errorMessage } from './error-copy.ts'
import { Backdrop } from './chip.tsx'
import css from './git-graph.module.css'

/** Props of the create-branch dialog. */
export interface CreateBranchDialogProps {
  /** The host create verb (`git switch --no-guess -c <name>` from HEAD). */
  onCreate: (name: string) => Promise<SwitchResult>
  /** Close the dialog (cancel or after a successful create). */
  onClose: () => void
  t: Translate<GitGraphKey>
}

/**
 * The create-and-switch dialog.
 * @param props - see {@link CreateBranchDialogProps}.
 */
export function CreateBranchDialog({ onCreate, onClose, t }: CreateBranchDialogProps) {
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The created branch and whether this conversation moved onto its worktree. */
  const [created, setCreated] = useState<{ branch: string; opened: boolean } | null>(null)

  const submit = (): void => {
    if (pending) return
    const trimmed = name.trim()
    if (validateBranchName(trimmed) !== null) {
      setError(t('error.invalidBranchName'))
      return
    }
    setPending(true)
    setError(null)
    void onCreate(trimmed).then((result) => {
      if (result.ok) {
        setCreated({ branch: result.branch, opened: result.opened })
        return
      }
      setError(errorMessage(result.error, t))
    }).finally(() => { setPending(false) })
  }

  return (
    <>
      <Backdrop onClose={onClose} />
      <div className={css.dialog} role="dialog" aria-label={t('branch.createDialog.title')} data-gitgraph-dialog data-dsh-plugin="git-graph">
        <h3 className={css.dialogTitle}>{t('branch.createDialog.title')}</h3>
        <p className={css.dialogDescription}>{t('branch.createDialog.description')}</p>
        {created !== null && (
          <div className={css.dialogNotice} role="status">
            {created.opened
              ? t('toast.switchSuccess', { branchName: created.branch })
              : t('toast.worktreeReady', { branchName: created.branch })}
          </div>
        )}
        {created === null && <div className={css.dialogField}>
          <label className={css.dialogLabel} htmlFor="git-graph-branch-name">
            {t('branch.createDialog.nameLabel')}
          </label>
          <input
            id="git-graph-branch-name"
            className={css.dialogInput}
            value={name}
            onChange={(event) => { setName(event.target.value) }}
            placeholder={t('branch.createDialog.placeholder')}
            onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
            autoFocus
          />
        </div>}
        {error !== null && <div className={css.dialogError}>{error}</div>}
        <div className={css.dialogActions}>
          <button type="button" className={css.dialogButton} onClick={onClose}>
            {created === null ? t('branch.createDialog.cancel') : t('branch.createDialog.done')}
          </button>
          {created === null && (
            <button
              type="button"
              className={css.dialogButtonPrimary}
              onClick={submit}
              disabled={pending || name.trim() === ''}
            >
              {t('branch.createDialog.confirm')}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
