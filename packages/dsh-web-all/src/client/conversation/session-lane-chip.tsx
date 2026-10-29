/**
 * Conversation header chip: which branch this conversation runs on, rendered
 * immediately after the session title.
 *
 * Seat: `conversation.session.header.actions` (declared `kind: "list"`,
 * `scope: "session"`), i.e. the same header row as the title, to its right.
 * The chip owns four rules:
 *   1. it always answers "which branch is this conversation on": a lane shows
 *      its branch plus the lane's state, and a conversation on the repository's
 *      main checkout shows `Main checkout · <branch>`;
 *   2. for a lane it is also the worktree's whole lifecycle surface — clicking
 *      it opens {@link LaneMenu} (facts, submit PR, clean up, remove). There is
 *      no sidebar page for that anymore;
 *   3. it renders nothing when the session has no repository (or the host half
 *      predates the routes) — a header must never break because of a chip;
 *   4. it never changes the branch: selection stays in the composer picker, so
 *      exactly one control decides which branch a conversation starts on.
 *
 * Data: `POST /worktree/lane` resolves the lane from the session id alone, and
 * `POST /git/status` resolves the main-checkout branch for the session's cwd.
 * @module dsh-client-ui-worktree/client/session-lane-chip
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RepoStatus } from '../../core/git-graph/protocol.ts'
import type { LaneLookupInput, LaneView } from '../../core/worktree/types.ts'
import { IconBranchOutline16 } from '../ui-icons.ts'
import { WORKTREE_PART_LANE_CHIP, WORKTREE_PLUGIN } from './worktree/semantic.ts'
import { WorktreeApi } from './worktree/api.ts'
import { LaneMenu } from './worktree/lane-menu.tsx'
import { createLaneBinder, type LaneBinder } from './worktree/lane-binding.ts'
import { GitApi } from './git-graph/api.ts'
import { en, zh, type SessionLaneKey } from './session-lane-locales.ts'
import css from './conversation.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Conversation header lane chip copy. */
    'web-all-session-lane': SessionLaneKey
  }
}

/** The browser session summary the chip reads the cwd and run state from. */
interface SessionSummaryLike {
  byId?: Record<string, { cwd?: string; running?: boolean } | undefined>
}

/** The client service surface the chip uses to find the session's cwd. */
interface SessionsFace {
  list?: { getSnapshot?: () => SessionSummaryLike | undefined }
}

/** The injected face the position module hands the chip. */
export interface SessionLaneInjected {
  /** Lane lookup (session id only; the host resolves the cwd). */
  lane: Pick<WorktreeApi, 'lane'>['lane']
  /** Repository snapshot for the session's cwd; null when it is not a repo. */
  repoStatus: (sessionId: string) => Promise<RepoStatus | null>
  /** Whether the conversation is running a turn (teardown has to wait). */
  running: (sessionId: string) => boolean
  /** Worktree API for the lane menu's actions (it owns their dialogs). */
  api: WorktreeApi
  /** Namespace-bound translator for the lane menu and dialogs. */
  worktreeT: PropsLocale<'worktree'>['t']
  /** Namespace-bound translator for the chip itself. */
  t: Translate<SessionLaneKey>
}

/**
 * The status word for one lane. Precedence is deliberate: uncommitted work
 * is the most actionable fact, then merge state, then the PR, then whether
 * anything was pushed at all.
 */
export function laneStatusKey(
  lane: Pick<LaneView, 'dirty' | 'merged' | 'prNumber' | 'pushed'>,
): SessionLaneKey {
  if ((lane.dirty ?? 0) > 0) return 'lane.dirty'
  if (lane.merged) return 'lane.merged'
  if (lane.prNumber !== null) return 'lane.pr'
  if (lane.pushed) return 'lane.pushed'
  return 'lane.local'
}

/**
 * The header chip: the branch this conversation is on, and — on a lane — the
 * way to finish that branch off.
 * Renders nothing unless the conversation belongs to a git repository.
 */
export function SessionLaneChip(
  props: PropsRuntime<'conversation.session.header.actions'> & { sessionId?: string } & SessionLaneInjected,
) {
  const { sessionId, lane: lookup, repoStatus, running, api, worktreeT, t } = props
  const [lane, setLane] = useState<LaneView | null>(null)
  const [repo, setRepo] = useState<RepoStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [bindFailed, setBindFailed] = useState(false)
  // One binder per mounted chip: it holds the per-session "already attempted"
  // set, so a refused binding is reported instead of retried forever.
  const binderRef = useRef<LaneBinder | null>(null)
  // The binder resolves through the same lookup the chip already receives, so
  // the two never disagree about which lane this conversation is on.
  binderRef.current ??= createLaneBinder({ lane: lookup, bindLane: (input) => api.bindLane(input) })
  const binder = binderRef.current

  useEffect(() => {
    if (sessionId === undefined) {
      setLane(null)
      setRepo(null)
      return
    }
    let live = true
    const refresh = (): void => {
      // `binder.bind` resolves the lane AND records the pairing when the host
      // does not have it yet (see the module doc).
      void Promise.all([binder.bind(sessionId), repoStatus(sessionId)]).then(
        ([binding, repoValue]) => {
          if (!live) return
          setBindFailed(binding.bindFailed)
          setLane(binding.lane)
          setRepo(repoValue)
        },
        () => { if (live) { setLane(null); setRepo(null) } },
      )
    }
    refresh()
    // The branch can change while the session id stays the same (a
    // mid-conversation branch switch, or a cleanup that archived the lane) and
    // there is no push channel, so revalidate whenever the tab is looked at.
    const revalidate = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', revalidate)
    window.addEventListener('focus', revalidate)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', revalidate)
      window.removeEventListener('focus', revalidate)
    }
  }, [sessionId, lookup, repoStatus, binder])

  /** Re-read the lane after the menu changed it (PR, refresh, teardown). */
  const reload = useCallback((): void => {
    if (sessionId === undefined) return
    void lookup({ sessionId }).then((value) => { setLane(value) }, () => { /* keep the last answer */ })
  }, [lookup, sessionId])

  if (lane !== null && lane.branch !== null && sessionId !== undefined) {
    const status = t(laneStatusKey(lane), { number: lane.prNumber ?? 0 })
    return (
      <span className={css.laneChipWrap}>
        <button
          type="button"
          className={css.laneChip}
          data-dsh-plugin={WORKTREE_PLUGIN}
          data-dsh-part={WORKTREE_PART_LANE_CHIP}
          title={t('lane.aria', { branch: lane.branch })}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen((value) => !value) }}
        >
          <IconBranchOutline16 size={14} />
          <span className={css.laneBranch}>{lane.branch}</span>
          <span className={css.laneStatus}>{status}</span>
          {(lane.permissionPresetApplied === false || bindFailed) && (
            <span className={css.laneWarning}>{t('lane.presetMissing')}</span>
          )}
        </button>
        {open && (
          <LaneMenu
            sessionId={sessionId}
            lane={lane}
            api={api}
            running={running(sessionId)}
            ownLane
            onClose={() => { setOpen(false) }}
            onChanged={reload}
            t={worktreeT}
          />
        )}
      </span>
    )
  }

  // No lane: the conversation works on the repository's main checkout. The
  // branch is still the answer to "which branch am I on", so say it — but there
  // is no lane to finish off, so this one stays read-only.
  if (repo === null || repo.branch === '') return null

  return (
    <span
      className={css.laneChip}
      data-dsh-plugin={WORKTREE_PLUGIN}
      data-dsh-part={WORKTREE_PART_LANE_CHIP}
      data-dsh-kind="main"
      title={t('lane.mainCheckoutAria', { branch: repo.branch })}
    >
      <IconBranchOutline16 size={14} />
      <span className={css.laneStatus}>{t('lane.mainCheckout')}</span>
      <span className={css.laneBranch}>{repo.branch}</span>
    </span>
  )
}

export { en as sessionLaneEn, zh as sessionLaneZh }
export type { SessionLaneKey }

/** Optional service lookup that survives a missing or reshaped service. */
function optionalService<T>(ctx: ClientContext, name: string): T | undefined {
  try {
    return (ctx.get as unknown as (id: string, strict?: boolean) => unknown)(name, false) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * Mount the lane chip on the session-header actions seat. The seat is
 * `scope: "session"`, so the runtime injects the session id and the chip
 * needs no other identity.
 */
export function mountSessionLaneChip(ctx: ClientContext): () => void {
  const api = new WorktreeApi()
  const git = new GitApi()
  const translate = ctx.locale.bind('web-all-session-lane')
  const t: Translate<SessionLaneKey> = (key, params) => translate(key, params)
  const worktreeTranslate = ctx.locale.bind('worktree')
  const worktreeT: PropsLocale<'worktree'>['t'] = (key, params) => worktreeTranslate(key, params)
  const sessions = (): SessionsFace | undefined => optionalService<SessionsFace>(ctx, 'sessions')
  // Identity matters: the chip's effect lists these as dependencies, so a
  // per-render closure would refetch on every render. Create them once for the
  // lifetime of the mount.
  const lane = (input: LaneLookupInput) => api.lane(input)
  const repoStatus = async (sessionId: string): Promise<RepoStatus | null> => {
    const cwd = sessions()?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd
    if (typeof cwd !== 'string' || cwd === '') return null
    const result = await git.status(cwd)
    return result.ok ? result.value : null
  }
  const running = (sessionId: string): boolean =>
    sessions()?.list?.getSnapshot?.()?.byId?.[sessionId]?.running === true
  const face = (props: PropsRuntime<'conversation.session.header.actions'>) => (
    <SessionLaneChip
      {...props}
      lane={lane}
      repoStatus={repoStatus}
      running={running}
      api={api}
      worktreeT={worktreeT}
      t={t}
    />
  )
  return ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'web-all-session-lane-chip',
    order: 100,
    inject: (sessionId: string) => ({ sessionId }),
  }, face))
}