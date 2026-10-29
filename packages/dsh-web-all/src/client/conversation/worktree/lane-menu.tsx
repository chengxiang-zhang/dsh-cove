/**
 * Lane popover: what the conversation's branch directory is, and the three
 * things a user can do about it.
 *
 * This is where the lifecycle lives now that there is no management panel: the
 * branch is chosen once, when the conversation starts (the composer picker), and
 * everything that happens *after* the branch exists — re-check, submit a PR,
 * delete the directory — hangs off the header chip that names that branch. One
 * control creates, one surface finishes.
 *
 * There used to be two teardown actions ("clean up worktree" / "remove
 * worktree"); users could not tell them apart, so they are one `Delete…` whose
 * dialog asks the only question that matters (does the local branch go too).
 *
 * Two safety rules are enforced here rather than discovered by failing:
 *   - a running conversation may not tear its own directory down (the directory
 *     would vanish under the running turn), so the action is disabled with the
 *     reason shown;
 *   - deleting the directory this conversation sits on archives the conversation
 *     (the host does that for every directory session), and the menu says so
 *     before the click instead of surprising the user afterwards.
 * @module @dsh-cove/dsh-client-ui-worktree/client/lane-menu
 */

import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { LaneView } from '../../../core/worktree/types.ts'
import { WorktreeApi } from './api.ts'
import { PrCreateDialog } from './dialogs/PrCreateDialog.tsx'
import { DeleteWorktreeDialog } from './dialogs/DeleteWorktreeDialog.tsx'
import { worktreeErrorMessage } from './lifecycle.ts'
import { WORKTREE_PART_LANE_MENU, WORKTREE_PLUGIN } from './semantic.ts'
import css from '../conversation.module.css'

/** Which dialog is open, if any. */
type LaneDialog = 'pr' | 'delete'

/** A base-branch choice set for the PR dialog, read from the repo status. */
interface PrChoices {
  branches: string[]
  baseBranch: string
}

export interface LaneMenuProps {
  /** The conversation the chip belongs to (the teardown caller identity). */
  sessionId: string
  /** The lane this conversation runs on. */
  lane: LaneView
  /** Worktree API surface (the menu owns its dialogs). */
  api: WorktreeApi
  /** Whether the conversation is running a turn right now. */
  running: boolean
  /**
   * Whether the lane records this conversation as its own session. Only then do
   * the teardown actions archive the conversation the user is looking at.
   */
  ownLane: boolean
  onClose: () => void
  /** The lane changed: the chip re-reads it. */
  onChanged: () => void
  t: PropsLocale<'worktree'>['t']
}

/**
 * The lane popover.
 * @param props - see {@link LaneMenuProps}.
 */
export function LaneMenu(props: LaneMenuProps): JSX.Element {
  const { sessionId, lane, api, running, ownLane, onClose, onChanged, t } = props
  const [busy, setBusy] = useState<'refresh' | 'pr' | 'delete' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [dialog, setDialog] = useState<LaneDialog | null>(null)
  const [prChoices, setPrChoices] = useState<PrChoices | null>(null)
  /** Directory facts re-read for the delete dialog; see openDelete. */
  const [deleteFacts, setDeleteFacts] = useState<{ merged: boolean; dirty: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // While one of the dialogs is showing, the menu must not dismiss itself on
    // the next click: the dialog is portaled to the body (so every click in it
    // is "outside" this popover) and it owns its own dismissal. Without this the
    // dialog unmounted mid-flight and a PR or teardown the host had already
    // started vanished from the screen.
    if (dialog !== null) return undefined
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [dialog, onClose])

  /** Probe the lane again, remote included; the chip re-reads the answer. */
  const refresh = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('refresh')
    setError(null)
    try {
      await api.status({ repoPath: lane.repoPath, name: lane.name, force: true })
      onChanged()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  /**
   * The PR dialog needs the repository's candidate branches, which only the
   * status probe knows. Fetching them here keeps the dialog's contract (a base
   * dropdown over real branches) instead of opening it with a guessed base.
   */
  const openPrDialog = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('pr')
    setError(null)
    try {
      const status = await api.status({ repoPath: lane.repoPath })
      setPrChoices({ branches: status.branches, baseBranch: status.baseBranch })
      setDialog('pr')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  /**
   * The delete dialog owns the branch-checkbox decision; the guard is here.
   *
   * The facts are re-read first. `dirty` is a local git call the host makes on
   * every lane read, and the chip's snapshot can predate work the user has just
   * left in the directory — which is exactly what decides whether the host will
   * demand the force choice. Reading that decision from the snapshot hid the
   * force row the host needs, so the dialog lied about being one click.
   */
  const openDelete = async (): Promise<void> => {
    if (running || busy !== null) return
    setBusy('delete')
    setError(null)
    try {
      const fresh = await api.lane({ path: lane.path })
      setDeleteFacts({ merged: fresh?.merged ?? lane.merged, dirty: fresh?.dirty ?? lane.dirty ?? 0 })
      setDialog('delete')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  /** The lane is gone (or changed) after a teardown: leave and re-read. */
  const afterTeardown = (): void => {
    setDialog(null)
    setDeleteFacts(null)
    onChanged()
    onClose()
  }

  return (
    <div
      ref={rootRef}
      className={css.laneMenu}
      role="menu"
      aria-label={t('menu.aria', { branch: lane.branch ?? lane.name })}
      data-dsh-plugin={WORKTREE_PLUGIN}
      data-dsh-part={WORKTREE_PART_LANE_MENU}
    >
      <div className={css.laneMenuFacts}>
        <span className={css.laneMenuPathLabel}>{t('menu.path')}</span>
        <span className={css.laneMenuPath} title={lane.path}>{lane.path}</span>
      </div>
      {/* The PR link is provenance, not an action: it only exists when this
          plugin created one, and it stays reachable after the merge. */}
      {lane.prUrl !== null && (
        <a className={css.laneMenuLink} href={lane.prUrl} target="_blank" rel="noopener noreferrer">
          {t('worktree.prOpen')}
        </a>
      )}
      {error !== null && <div className={css.laneMenuError} role="alert">{worktreeErrorMessage(error, t)}</div>}
      <div className={css.laneMenuActions}>
        <button
          type="button"
          role="menuitem"
          className={css.laneMenuItem}
          disabled={busy !== null || lane.merged}
          onClick={() => { void openPrDialog() }}
        >
          {t('menu.pr')}
        </button>
        <button
          type="button"
          role="menuitem"
          className={css.laneMenuItem}
          disabled={running || busy !== null}
          onClick={() => { void openDelete() }}
        >
          {t('menu.delete')}
        </button>
        <button
          type="button"
          role="menuitem"
          className={css.laneMenuItem}
          disabled={busy !== null}
          onClick={() => { void refresh() }}
        >
          {t('menu.refresh')}
        </button>
      </div>
      {running && <div className={css.laneMenuHint}>{t('menu.running')}</div>}
      {ownLane && <div className={css.laneMenuHint}>{t('menu.selfTeardown')}</div>}

      {dialog === 'pr' && prChoices !== null && (
        <PrCreateDialog
          repoPath={lane.repoPath}
          name={lane.name}
          branches={prChoices.branches}
          defaultBaseRef={prChoices.baseBranch}
          api={api}
          onClose={() => { setDialog(null) }}
          onCreated={afterTeardown}
          onSettled={onChanged}
          t={t}
        />
      )}
      {dialog === 'delete' && deleteFacts !== null && (
        <DeleteWorktreeDialog
          repoPath={lane.repoPath}
          name={lane.name}
          merged={deleteFacts.merged}
          dirty={deleteFacts.dirty}
          api={api}
          sessionId={ownLane ? sessionId : undefined}
          onClose={() => { setDialog(null) }}
          onRemoved={afterTeardown}
          t={t}
        />
      )}
    </div>
  )
}