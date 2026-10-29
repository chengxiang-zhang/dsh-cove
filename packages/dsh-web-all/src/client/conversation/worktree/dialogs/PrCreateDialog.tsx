/**
 * Create-PR dialog: pick the PR target base branch (dropdown over the
 * repo's candidate branches, defaulted to the last status probe), push the
 * worktree branch, and obtain the PR page. Calls `api.prCreate` on confirm;
 * on success the dialog shows the resulting PR url with an open button
 * (window.open in a user gesture). The parent reloads the worktree index and
 * the PR status as soon as the push/PR landed (`onSettled`), so closing the
 * dialog with Escape while the request is in flight cannot lose the result;
 * closes are refused while the request is running.
 */

import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { WorktreeApi } from '../api.ts'
import type { PrCreateResult } from '../../../../core/worktree/types.ts'
import { worktreeErrorMessage } from '../lifecycle.ts'
import styles from '../worktree.module.css'

export function PrCreateDialog(props: {
  repoPath: string
  name: string
  /** Candidate base branches (local first, then origin/*). */
  branches: string[]
  /** Default PR target base branch (from the last status probe). */
  defaultBaseRef: string
  api: WorktreeApi
  onClose: () => void
  onCreated: () => void
  /** The host state changed: refresh the panel without closing this dialog. */
  onSettled: () => void
  t: PropsLocale<'worktree'>['t']
}): JSX.Element {
  const { repoPath, name, branches, defaultBaseRef, api, onClose, onCreated, onSettled, t } = props
  const [baseRef, setBaseRef] = useState<string>(() => (
    defaultBaseRef !== '' && (branches.length === 0 || branches.includes(defaultBaseRef))
      ? defaultBaseRef
      : (branches[0] ?? defaultBaseRef)
  ))
  const [busy, setBusy] = useState<boolean>(false)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<PrCreateResult | null>(null)

  /** Closing mid-flight would drop a PR that the host already created. */
  const guardClose = (): void => { if (!busy) onClose() }

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const created = await api.prCreate({
        repoPath,
        name,
        ...(baseRef.trim() !== '' ? { baseRef: baseRef.trim() } : {}),
      })
      setResult(created)
      // Refresh the panel now, not when the user dismisses the result view.
      onSettled()
      setBusy(false)
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
      title={t('worktree.prTitle', { name })}
      description={t('worktree.prDescription')}
      footer={result === null ? (
        <>
          <Button variant="outline" disabled={busy} onClick={guardClose}>{t('dialog.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => { void submit() }}>
            {busy ? t('dialog.confirm') : t('worktree.prConfirm')}
          </Button>
        </>
      ) : (
        <>
          <Button variant="outline" onClick={() => { onCreated(); onClose() }}>{t('dialog.confirm')}</Button>
          <Button variant="primary" onClick={() => { window.open(result.prUrl, '_blank', 'noopener,noreferrer'); onCreated(); onClose() }}>
            {t('worktree.prOpen')}
          </Button>
        </>
      )}
    >
      {result === null ? (
        <div className={styles.dialogBody}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('worktree.prBase')}</span>
            <select
              className={styles.fieldInput}
              value={baseRef}
              onChange={(event) => { setBaseRef(event.target.value); setError(null) }}
              disabled={busy}
            >
              {branches.length === 0 && <option value={baseRef}>{baseRef}</option>}
              {branches.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          {error !== null && <div className={styles.dialogError} role="alert">{worktreeErrorMessage(error, t)}</div>}
        </div>
      ) : (
        <div className={styles.dialogBody}>
          <div className={styles.successText} role="status">{t('worktree.prSuccess')}</div>
          <div className={styles.prUrl}>{result.prUrl}</div>
        </div>
      )}
    </Modal>
  )
}