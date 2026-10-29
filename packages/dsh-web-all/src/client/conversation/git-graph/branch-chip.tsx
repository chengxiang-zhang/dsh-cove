/**
 * The git branch selector chip for blank sessions. It mounts in the selector
 * context hole (`conversation.input.selector.context`) beside the official
 * workspace selector. On shells that dropped the hole, it uses
 * `conversation.input.dock` only for the blank-session hero phase and lifts
 * itself into the official hero chip row. It is intentionally absent while a
 * session is running.
 * @module dsh-git-graph/client/chips/BranchChip
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconBranchOutline16 } from '../../ui-icons.ts'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// DSH 0.2 declares the seat's standard hooks by module augmentation
// (`GlobalStandardProps`, an empty merge target in ui-slots); the session one
// contributes `useSessions`. Type-only: the value comes from the seat props.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { BranchesView, GraphView, RepoStatus, SwitchResult } from '../../../core/git-graph/protocol.ts'
import type { GitGraphKey } from './locales.ts'
import { Chip, cx } from './chip.tsx'
import { heroPlacementIn, heroRowFor, shouldProbeInFlow } from './hero-seat.ts'
import { BranchPopover } from './branch-popover.tsx'
import { CreateBranchDialog } from './create-branch-dialog.tsx'
import { GraphDialog } from './graph-dialog.tsx'
import css from './git-graph.module.css'

/**
 * The verb face the conversation position module injects into the chip.
 *
 * Both branch verbs are the lane path: choosing an existing branch or naming a
 * new one creates/attaches its worktree and moves this conversation onto it.
 * That move rides the `uiWorkspace` client service, never a seat prop — the
 * `conversation.input.dock` seat is rendered with `{ session, input }` only.
 */
export interface GitGraphInjected {
  repoStatus: (sessionId: string | undefined) => Promise<RepoStatus | null>
  branches: (sessionId: string | undefined) => Promise<BranchesView | null>
  switchBranch: (sessionId: string | undefined, branch: string) => Promise<SwitchResult>
  createBranch: (sessionId: string | undefined, branch: string) => Promise<SwitchResult>
  graph: (sessionId: string | undefined, limit?: number) => Promise<GraphView | null>
  subscribeChanges: (sessionId: string | undefined, onChange: () => void) => () => void
}

/**
 * Full props of the branch chip: the official dock seat's runtime share + the
 * session identity injected by the seat (`inject(sessionId)`) + the git-graph
 * inject face + the locale seat. 0.2 has no selector-context seat, so the chip
 * lives in `conversation.input.dock` only.
 */
export type BranchChipProps =
  PropsRuntime<'conversation.input.dock'>
  & { sessionId?: string }
  & GitGraphInjected
  & { t: import('@deepseek-ai/dsh-client-ui-slots').Translate<GitGraphKey> }

/** Minimum gap between window-focus git refetches (ms). */
export const FOCUS_REFRESH_MIN_MS = 5_000

const SKIN_CENTER_BODY_ATTR = 'data-dsh-skin-center'
const DARK_THEME_BODY_ATTR = 'data-ds-dark-theme'
const DSH_BODY_ATTR_PREFIX = 'data-dsh-'

/** Whether a body attribute belongs to an applied skin rather than the skin center shell. */
function hasAppliedSkinBodyAttr(name: string): boolean {
  return name.startsWith(DSH_BODY_ATTR_PREFIX) && name !== SKIN_CENTER_BODY_ATTR
}

/** Whether the page is using the unskinned stock light theme. */
function readStockLightTheme(): boolean {
  if (typeof document === 'undefined') return false
  const body = document.body
  if (!body.hasAttribute(SKIN_CENTER_BODY_ATTR) || body.hasAttribute(DARK_THEME_BODY_ATTR)) return false
  return !body.getAttributeNames().some(hasAppliedSkinBodyAttr)
}

/** Track stock-light theme changes from body attributes. */
function useStockLightTheme(): boolean {
  const [stockLightTheme, setStockLightTheme] = useState(readStockLightTheme)

  useEffect(() => {
    const update = (): void => { setStockLightTheme(readStockLightTheme()) }
    update()
    if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return undefined
    const observer = new MutationObserver(update)
    observer.observe(document.body, { attributes: true })
    return () => { observer.disconnect() }
  }, [])

  return stockLightTheme
}

/**
 * The right edge of the rightmost painted descendant of `root`, excluding
 * `root` itself. The hero row's direct children can be display:contents
 * slot outlets, so the visible chip boundary must be found by walking.
 */
function paintedRight(root: Element): number | null {
  let right: number | null = null
  const visit = (node: Element): void => {
    if (node !== root) {
      const rect = node.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        right = right === null ? rect.right : Math.max(right, rect.right)
      }
    }
    for (const child of Array.from(node.children)) visit(child)
  }
  visit(root)
  return right
}

/**
 * Coalesce repeated placement updates into one animation-frame callback so
 * observer bursts in the same frame measure only once. When the environment
 * provides no requestAnimationFrame, updates run synchronously instead.
 */
function frameScheduler(update: () => void): { schedule: () => void, cancel: () => void } {
  let pending = false
  let frame: number | null = null
  const flush = (): void => {
    pending = false
    frame = null
    update()
  }
  return {
    schedule: () => {
      if (pending) return
      pending = true
      if (typeof requestAnimationFrame === 'function') {
        frame = requestAnimationFrame(flush)
      } else {
        flush()
      }
    },
    cancel: () => {
      pending = false
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
    },
  }
}

/**
 * The git branch selector chip for blank sessions.
 * @param props - the composed entry props of whichever seat it mounted in.
 */
export function BranchChip(props: BranchChipProps) {
  const sessionId = props.sessionId
  // Blank-session flag from the standard session list. The selector never
  // throws for a missing session id / row, so the hook can stay mounted
  // while the session baseline is still loading.
  const blankSession = props.useSessions((state): boolean => {
    if (sessionId === undefined) return false
    const sessions = state as { byId?: Record<string, { blank?: boolean }> }
    return sessions.byId?.[sessionId]?.blank === true
  })
  // The dock seat carries the composer snapshot. It exposes the selector
  // only in the blank hero phase; the session-maybe context seat uses the
  // session baseline's blank flag instead.
  const dockSeat = 'session' in props && 'input' in props
  const sessionSnapshot = dockSeat ? props.session as unknown as { composerPhase?: string; shellPhase?: string; openState?: string } : undefined
  const phaseBlank = sessionSnapshot?.shellPhase === 'blank' || sessionSnapshot?.composerPhase === 'blank'
  // The 0.2 dock hands the seat only { session, input }: the hero phase is
  // computed on the official side and never reaches the seat, so the session
  // list's blank flag is the reliable show/hide signal. Placement is decided
  // from the DOM instead — when the dock row sits directly under the official
  // hero chip row, the chip is lifted into that row (see the layout effect
  // below); otherwise it stays in flow inside the dock row.
  const phaseHero = phaseBlank && (sessionSnapshot?.openState === 'open' || blankSession === true)
  const showBranchSelector = blankSession === true || phaseHero
  const stockLightTheme = useStockLightTheme()

  /** Repository state: undefined = loading, null = not a repository, else the snapshot. */
  const [repo, setRepo] = useState<RepoStatus | null | undefined>(undefined)
  /** Fresh branch list, fetched when the branch popover opens. */
  const [branchesView, setBranchesView] = useState<BranchesView | null>(null)
  const [branchOpen, setBranchOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  /** Measured hero-row placement against the anchor's containing block; null while the chip stays in flow. */
  const [heroPlacement, setHeroPlacement] = useState<{ left: number, top: number } | null>(null)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  /** Hero seat: a measured placement means the chip is lifted into the official hero chip row. */
  const heroLift = heroPlacement !== null

  // Hero placement: the shell renders the dock as its own row between the
  // official hero chip row and the composer card. The chip belongs *in* that
  // row, immediately after its rightmost painted chip (the agent-preset seat),
  // on the official 28px transparent pill recipe. The row is found
  // structurally and measured after a synchronous probe that takes the anchor
  // out of flow: dropping the dock row resizes the vertically centred composer
  // stack, so only the settled layout is the one to match. Offsets are taken
  // against the anchor's own containing block — the composer stack is static,
  // so stack-relative numbers land hundreds of pixels away from the row.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const heroRow = showBranchSelector && anchor !== null ? heroRowFor(anchor) : null
    const outlet = anchor?.parentElement ?? null
    const stack = outlet?.parentElement ?? null
    if (anchor === null || outlet === null || stack === null || heroRow === null) {
      setHeroPlacement(null)
      return
    }
    const measure = (): void => {
      const block = anchor.offsetParent ?? document.documentElement
      const blockRect = block.getBoundingClientRect()
      const rowRect = heroRow.getBoundingClientRect()
      if (blockRect.width <= 0 || rowRect.width <= 0 || rowRect.height <= 0) return
      const right = paintedRight(heroRow)
      if (right === null) return
      const { left, top } = heroPlacementIn(
        { left: blockRect.left, top: blockRect.top, clientLeft: block.clientLeft, clientTop: block.clientTop },
        { top: rowRect.top, height: rowRect.height },
        right,
      )
      setHeroPlacement(previous => {
        if (previous !== null && Math.abs(previous.left - left) < 0.5 && Math.abs(previous.top - top) < 0.5) return previous
        return { left, top }
      })
    }
    const probe = shouldProbeInFlow(anchor)
    if (probe) {
      anchor.style.position = 'absolute'
      anchor.style.visibility = 'hidden'
    }
    measure()
    if (probe) {
      anchor.style.position = ''
      anchor.style.visibility = ''
    }
    const scheduler = frameScheduler(measure)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduler.schedule)
    for (const target of [anchor, outlet, stack, heroRow]) observer?.observe(target)
    window.addEventListener('resize', scheduler.schedule)
    return () => {
      scheduler.cancel()
      observer?.disconnect()
      window.removeEventListener('resize', scheduler.schedule)
    }
  }, [showBranchSelector, sessionId, repo !== undefined && repo !== null])

  const refetch = useCallback(() => {
    let live = true
    props.repoStatus(sessionId)
      .then((status) => { if (live) setRepo(status) })
      .catch(() => { if (live) setRepo(null) })
    return () => { live = false }
  }, [props.repoStatus, sessionId])

  // Blank-session data stays fresh through the initial load, host-pushed
  // changes, and a throttled focus refresh. Active sessions never subscribe
  // or start a Git status round trip.
  const lastFocusRefetch = useRef(0)
  useEffect(() => {
    if (!showBranchSelector) return undefined
    return refetch()
  }, [showBranchSelector, refetch])
  useEffect(() => {
    if (!showBranchSelector) return undefined
    const unsubscribe = props.subscribeChanges(sessionId, () => { refetch() })
    const onFocus = (): void => {
      const now = Date.now()
      if (now - lastFocusRefetch.current < FOCUS_REFRESH_MIN_MS) return
      lastFocusRefetch.current = now
      refetch()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [showBranchSelector, props.subscribeChanges, sessionId, refetch])

  const closeCreate = (): void => {
    setCreateOpen(false)
    refetch()
  }

  // Fetch the fresh branch list each time the popover opens. All hooks stay
  // above the data-gated returns so the hook order is stable while `repo`
  // settles from undefined (loading) to a snapshot.
  useEffect(() => {
    if (!showBranchSelector || !branchOpen) return undefined
    let live = true
    setBranchesView(null)
    props.branches(sessionId).then((view) => { if (live) setBranchesView(view) })
    return () => { live = false }
  }, [showBranchSelector, branchOpen, props.branches, sessionId])

  // Active sessions intentionally expose no branch-selection control. Loading
  // and non-repository workspaces likewise render no dead control.
  if (!showBranchSelector || repo === undefined || repo === null) return null

  const openBranchPopover = (): void => {
    setBranchOpen(open => !open)
  }

  return (
    <div
      ref={anchorRef}
      data-gitgraph-chip-anchor
      data-dsh-plugin="git-graph"
      data-dsh-part="chip"
      data-gitgraph-stock-light={stockLightTheme || undefined}
      className={cx(css.anchor, heroLift && css.anchorHero)}
      style={heroLift && heroPlacement !== null
        ? { left: `${heroPlacement.left}px`, top: `${heroPlacement.top}px`, paddingLeft: 0 }
        : undefined}
    >
      <div className={css.chipWrap}>
        <Chip
          hero={heroLift}
          icon={<IconBranchOutline16 size={heroLift ? 16 : 14} />}
          label={repo.branch === '' ? props.t('branch.detached') : repo.branch}
          ariaLabel={props.t('chip.aria.branch')}
          open={branchOpen}
          onClick={openBranchPopover}
        />
        {branchOpen && branchesView !== null && (
          <BranchPopover
            hero={heroLift}
            view={branchesView}
            onSwitch={(branch) => props.switchBranch(sessionId, branch)}
            onSwitched={refetch}
            onCreate={() => {
              setBranchOpen(false)
              setCreateOpen(true)
            }}
            onGraph={() => {
              setBranchOpen(false)
              setGraphOpen(true)
            }}
            onClose={() => { setBranchOpen(false) }}
            t={props.t}
          />
        )}
      </div>
      {createOpen && (
        <CreateBranchDialog
          onCreate={(name) => props.createBranch(sessionId, name)}
          onClose={closeCreate}
          t={props.t}
        />
      )}
      {graphOpen && (
        <GraphDialog
          graph={(limit) => props.graph(sessionId, limit)}
          onClose={() => { setGraphOpen(false) }}
          t={props.t}
        />
      )}
    </div>
  )
}
