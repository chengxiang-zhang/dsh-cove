/** The source-control panel: staged vs unstaged sections with per-file
 *  stage/unstage and discard actions, a branch switcher with create-branch,
 *  a commit box (Ctrl/Cmd+Enter, gated on staged changes), and a
 *  VSCode-like history — rows carry ref badges, author and relative time.
 *  Right-click a file or history row for the advanced operations menu
 *  (open in editor, discard, revert, cherry-pick, copy paths/hashes);
 *  destructive actions land in a confirm modal first. Refresh is manual +
 *  on mount + SSE/poll (KISS, no file watcher). */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { IconBranchOutline16, IconCloseOutline16, IconCodeOutline16, IconCopyOutline16, IconPlusOutline16, IconRefreshOutline16, IconTrashOutline16 } from '../ui-icons.ts'
import { Button, Input, Menu, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitStatusEntry } from '../../core/right-pane/protocol.ts'
import type {
  BranchesView, CommitDiffView, GitEnvelope, GitError, GitMutationResult, GraphCommit, GraphView, RepoStatus,
} from '../../core/git-graph/protocol.ts'
import { DiffView } from './diff-view.tsx'
import { rightPaneEn, type RightPaneLocaleKey } from './right-pane-i18n.ts'
import css from './sidebar.module.css'

export interface GitScope { sessionId?: string; cwd?: string }
export type GitT = (key: RightPaneLocaleKey, params?: Record<string, string | number>) => string

/** Resolve one copy key with interpolation, falling back to the en dictionary. */
function dict(t: GitT | undefined, key: RightPaneLocaleKey, params?: Record<string, string | number>): string {
  const text = t?.(key, params) ?? rightPaneEn[key] ?? key
  if (params === undefined) return text
  return text.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}

/** One /git/* call. A denied request (403 from the host access fence) or any
 *  pre-flight failure answers without the envelope, so the HTTP status becomes
 *  the message instead of an empty string. */
async function git<T>(route: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/git/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const envelope = await response.json().catch(() => null) as GitEnvelope<T> | null
  const ok = (envelope as { ok?: unknown } | null)?.ok
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope) || typeof ok !== 'boolean') {
    const message = `${response.status} ${response.statusText}`.trim()
    throw Object.assign(new Error(message), { gitError: { code: 'internal', message } })
  }
  if (!envelope.ok) throw Object.assign(new Error(gitErrorMessage(envelope.error)), { gitError: envelope.error })
  return envelope.value
}

/** Localized operation-failure copy, one label per GitError code. Accepts any
 *  shape because a proxy or a non-envelope answer can produce one, and never
 *  yields an empty message. */
export function gitErrorMessage(error: unknown, t?: GitT): string {
  const s = (key: RightPaneLocaleKey, params?: Record<string, string | number>): string => dict(t, key, params)
  const record = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown }
  const code = typeof record.code === 'string' ? record.code : undefined
  const message = typeof record.message === 'string' && record.message.trim() !== '' ? record.message.trim() : undefined
  const labels: Partial<Record<GitError['code'], string>> = {
    'conflicts-present': s('git.error.conflictsPresent'),
    'operation-in-progress': s('git.error.operationInProgress'),
    'dirty-worktree': s('git.error.dirtyWorktree'),
    'apply-conflict': s('git.error.applyConflict'),
    'nothing-to-apply': s('git.error.nothingToApply'),
    'commit-not-found': s('git.error.commitNotFound'),
    'file-not-tracked': s('git.error.fileNotTracked'),
    'invalid-file-path': s('git.error.invalidFilePath'),
    'workspace-unknown': s('git.error.workspaceUnknown'),
  }
  const label = code === undefined ? undefined : labels[code as GitError['code']]
  if (label !== undefined) return label
  return s('git.error.internal', { message: message ?? s('git.error.unknown') })
}

/** Localized text for a rejection thrown by `git()`: the structured /git error
 *  when the response carried one, else the plain message. */
export function gitFailureText(reason: unknown, t?: GitT): string {
  const gitError = (reason as { gitError?: unknown } | null | undefined)?.gitError
  if (typeof gitError === 'object' && gitError !== null) return gitErrorMessage(gitError, t)
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.trim() !== '' ? message : dict(t, 'git.error.unknown')
}

/** The XY status letters a row badge shows (X = index, Y = worktree). */
export function badgeOf(entry: GitStatusEntry): string {
  const index = entry.xy[0]
  const worktree = entry.xy[1]
  if (index !== undefined && index !== ' ' && index !== '?') return index
  if (worktree !== undefined && worktree !== ' ' && worktree !== '?') return worktree
  return '?'
}

/** Whether the entry carries STAGED (index) changes — the X letter is set. */
export function isStagedEntry(entry: GitStatusEntry): boolean {
  const index = entry.xy[0]
  return index !== undefined && index !== ' ' && index !== '?'
}

/** Whether the entry carries UNSTAGED (worktree) changes — the Y letter is set
 *  (untracked `??` counts as unstaged: it is a worktree-only change). A file
 *  with both letters set ('MM') lands in BOTH sections. */
export function isUnstagedEntry(entry: GitStatusEntry): boolean {
  if (entry.xy === '??') return true
  const worktree = entry.xy[1]
  return worktree !== undefined && worktree !== ' ' && worktree !== '?'
}

/** Whether the entry is untracked (`??`): git diff never includes it. */
export function isUntracked(entry: GitStatusEntry): boolean {
  return badgeOf(entry) === '?'
}

/** Split the porcelain entries into the two VSCode-style sections. */
export function splitEntries(entries: GitStatusEntry[]): { staged: GitStatusEntry[]; unstaged: GitStatusEntry[] } {
  return { staged: entries.filter(isStagedEntry), unstaged: entries.filter(isUnstagedEntry) }
}

export function shortOid(oid: string): string { return oid.slice(0, 8) }

/** The last path segment (diff title for a file). */
function baseName(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/** Compact relative history time ("now" / "5m ago" / "3h ago" / "2d ago"…). */
export function relativeText(epochMs: number, now: number, t?: GitT): string {
  const s = (key: RightPaneLocaleKey, params?: Record<string, string | number>): string => dict(t, key, params)
  const diff = Math.max(0, now - epochMs)
  const MIN = 6e4
  const HOUR = 36e5
  const DAY = 864e5
  if (diff < MIN) return s('git.ago.now')
  if (diff < HOUR) return s('git.ago.minutes', { n: Math.floor(diff / MIN) })
  if (diff < DAY) return s('git.ago.hours', { n: Math.floor(diff / HOUR) })
  if (diff < 30 * DAY) return s('git.ago.days', { n: Math.floor(diff / DAY) })
  if (diff < 365 * DAY) return s('git.ago.months', { n: Math.floor(diff / (30 * DAY)) })
  return s('git.ago.years', { n: Math.floor(diff / (365 * DAY)) })
}

function commitLabel(commit: GraphCommit): string { return `${shortOid(commit.oid)} ${commit.subject}` }

/** The pending destructive action (discard / revert / cherry-pick), gated by a confirm modal. */
interface ConfirmState {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => Promise<unknown>
}

/** History batch size: the log loads lazily in pages so a long history never
 *  floods the panel at once (the end of the log is reached by paging). */
const LOG_BATCH = 30

export function GitWorkbench(props: {
  scope: GitScope
  t?: GitT
  /** Open a workspace file in the native file viewer (untracked files). */
  onOpenFile: (path: string) => void
  /**
   * Whether this page's tab is the one on screen.
   *
   * A right-side tab stays mounted while another tab is shown, so without this the poll
   * would keep running for a page nobody is looking at, and opening the tab again would
   * show whatever the last tick read - up to fifteen seconds of git history that is not
   * the repository's.
   */
  visible?: boolean
}) {
  const { scope, t, onOpenFile, visible = true } = props
  /** Translate through a ref: the panel receives a fresh `t` on every parent
   *  render, and an unstable translator would change `reload`'s identity and
   *  re-fire its mount effect (an endless refresh loop). */
  const tRef = useRef(t)
  tRef.current = t
  const s = useCallback(
    (key: RightPaneLocaleKey, params?: Record<string, string | number>): string => dict(tRef.current, key, params),
    [],
  )
  const cwd = scope.cwd
  const [status, setStatus] = useState<RepoStatus | null>()
  const [entries, setEntries] = useState<GitStatusEntry[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [commits, setCommits] = useState<GraphCommit[]>([])
  const [cursor, setCursor] = useState<string>()
  const [hasMore, setHasMore] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** The inline diff shown below the sections (VSCode-style, no page swap);
   *  null = nothing open. The body is loaded lazily on first open. */
  const [inlineDiff, setInlineDiff] = useState<{ text: string; title: string } | null>(null)

  /** The open file-row context menu (cursor position for the portaled Menu). */
  const [fileMenu, setFileMenu] = useState<{ entry: GitStatusEntry; staged: boolean; x: number; y: number } | null>(null)
  /** The open history-row context menu. */
  const [historyMenu, setHistoryMenu] = useState<{ entry: GraphCommit; x: number; y: number } | null>(null)
  /** The pending destructive action awaiting confirmation. */
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  /** Create-branch modal state. */
  const [createOpen, setCreateOpen] = useState(false)
  const [branchName, setBranchName] = useState('')

  const reload = useCallback(async (): Promise<void> => {
    if (!cwd) return
    try {
      const [value, graph, branchView, raw] = await Promise.all([
        git<RepoStatus | null>('status', { path: cwd }),
        git<GraphView | null>('graph', { path: cwd, limit: LOG_BATCH }),
        git<BranchesView | null>('branches', { path: cwd }).then(view => (view?.branches ?? []).map(row => row.name)).catch(() => [] as string[]),
        fetch(`/api/workbench/git-status?path=${encodeURIComponent(cwd)}`).then(response => response.ok ? response.json() : null).catch(() => null) as Promise<{ entries?: GitStatusEntry[] } | null>,
      ])
      setStatus(value)
      setCommits(graph?.commits ?? [])
      setCursor(graph?.nextCursor)
      setHasMore(graph?.hasMore ?? false)
      setBranches(branchView)
      setEntries(raw?.entries ?? [])
      setError('')
    } catch (reason) { setError(gitFailureText(reason, s)); setStatus(null) }
  }, [cwd, s])

  useEffect(() => { void reload() }, [reload])

  // Live sync: the host /git/events stream fires when root/branch/head
  // change (external commits and switches); a slow poll covers file churn
  // while the page is visible. KISS — no file watcher.
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => {
    if (!cwd) return
    if (typeof EventSource === 'function') {
      const source = new EventSource(`/git/events?path=${encodeURIComponent(cwd)}`)
      source.addEventListener('change', () => { void reloadRef.current() })
      return () => { source.close() }
    }
    return undefined
  }, [cwd])
  useEffect(() => {
    if (!cwd || !visible) return
    const timer = setInterval(() => { if (!document.hidden) void reloadRef.current() }, 15_000)
    return () => { clearInterval(timer) }
  }, [cwd, visible])

  // Opening this tab is the moment the user asks for the repository's truth, so it reads
  // then instead of waiting up to a full poll interval for the next tick. The mount load
  // above already covers the first open; this covers every return to the tab.
  const wasVisible = useRef(visible)
  useEffect(() => {
    if (visible && !wasVisible.current) void reloadRef.current()
    wasVisible.current = visible
  }, [visible])

  const loadMore = async (): Promise<void> => {
    if (!cwd || !cursor) return
    try {
      const graph = await git<GraphView>('graph', { path: cwd, limit: LOG_BATCH, cursor })
      setCommits(current => [...current, ...graph.commits])
      setCursor(graph.nextCursor)
      setHasMore(graph.hasMore)
    } catch (reason) { setError(gitFailureText(reason, s)) }
  }

  const showWorkingDiff = async (entry: GitStatusEntry, staged: boolean): Promise<void> => {
    if (!cwd) return
    if (isUntracked(entry)) { onOpenFile(entry.path); return }
    try {
      const next = (await git<{ diff: string }>('diff', { path: cwd, file: entry.path, staged })).diff
      const kind = staged ? s('git.diff.staged') : s('git.diff.worktree')
      setInlineDiff({ text: next, title: `${kind} · ${baseName(entry.path)}` })
      setError('')
    } catch (reason) { setError(gitFailureText(reason, s)) }
  }
  const showCommitDiff = async (commit: GraphCommit): Promise<void> => {
    if (!cwd) return
    try {
      const next = (await git<CommitDiffView>('commit-diff', { path: cwd, oid: commit.oid })).diff
      setInlineDiff({ text: next, title: `${s('git.diff.commit')} ${shortOid(commit.oid)} ${commit.subject}` })
      setError('')
    } catch (reason) { setError(gitFailureText(reason, s)) }
  }

  const stageEntry = async (entry: GitStatusEntry, staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      await git(staged ? 'unstage' : 'stage', { path: cwd, file: entry.path })
      await reload()
    } catch (reason) { setError(gitFailureText(reason, s)) }
    finally { setBusy(false) }
  }
  const stageAll = async (staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      await git(staged ? 'unstage' : 'stage', { path: cwd })
      await reload()
    } catch (reason) { setError(gitFailureText(reason, s)) }
    finally { setBusy(false) }
  }

  const commit = async (): Promise<void> => {
    const text = message.trim()
    if (!cwd || text === '' || busy) return
    setBusy(true)
    setError('')
    try {
      await git('commit', { path: cwd, message: text })
      setMessage('')
      await reload()
    } catch (reason) { setError(gitFailureText(reason, s)) }
    finally { setBusy(false) }
  }

  const checkout = async (branch: string): Promise<void> => {
    if (!cwd || branch === status?.branch || busy) return
    setBusy(true)
    setError('')
    try {
      await git('switch', { path: cwd, branch })
      await reload()
    } catch (reason) { setError(gitFailureText(reason, s)) }
    finally { setBusy(false) }
  }
  const createBranch = async (): Promise<void> => {
    const name = branchName.trim()
    if (!cwd || name === '' || busy) return
    setBusy(true)
    setError('')
    try {
      await git('create-branch', { path: cwd, name })
      setBranchName('')
      setCreateOpen(false)
      await reload()
    } catch (reason) { setError(gitFailureText(reason, s)) }
    finally { setBusy(false) }
  }

  /** Run one destructive operation after the confirm modal, then refresh. */
  const runConfirmed = (state: ConfirmState): void => {
    setConfirm({ ...state, onConfirm: async () => {
      setBusy(true)
      setError('')
      try {
        await state.onConfirm()
        await reload()
      } catch (reason) { setError(gitFailureText(reason, s)) }
      finally { setBusy(false) }
    } })
  }

  const copy = (text: string): void => { void writeClipboard(text) }

  const openFileMenu = (event: MouseEvent, entry: GitStatusEntry, staged: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setFileMenu({ entry, staged, x: event.clientX, y: event.clientY })
  }
  const openHistoryMenu = (event: MouseEvent, entry: GraphCommit): void => {
    event.preventDefault()
    event.stopPropagation()
    setHistoryMenu({ entry, x: event.clientX, y: event.clientY })
  }

  const { staged: stagedEntries, unstaged: unstagedEntries } = splitEntries(entries)

  const renderEntry = (entry: GitStatusEntry, staged: boolean): ReactNode => {
    const untracked = isUntracked(entry)
    return (
      <div key={`${staged ? 's' : 'u'}:${entry.path}`} className={css.gitRow}>
        <button
          type="button"
          className={css.gitRowMain}
          title={entry.path}
          onClick={() => { void showWorkingDiff(entry, staged) }}
          onContextMenu={(event) => { openFileMenu(event, entry, staged) }}
        >
          <span className={css.gitBadge} data-kind={untracked ? 'U' : badgeOf(entry)}>{badgeOf(entry)}</span>
          <span className={css.gitName}>{entry.path}</span>
        </button>
        <span className={css.gitRowActions}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={staged ? s('git.unstage') : s('git.stage')}
            title={staged ? s('git.unstage') : s('git.stage')}
            disabled={busy}
            onClick={() => { void stageEntry(entry, staged) }}
          >
            {staged ? <IconTrashOutline16 /> : <IconBranchOutline16 />}
          </button>
          {!untracked && (
            <button
              type="button"
              className={css.iconButton}
              aria-label={s('git.discard')}
              title={s('git.discard')}
              disabled={busy}
              onClick={() => {
                runConfirmed({
                  title: s('git.discardTitle'),
                  description: s('git.discardDesc', { path: entry.path }),
                  confirmLabel: s('git.discard'),
                  onConfirm: () => git<GitMutationResult>('discard', { path: cwd, file: entry.path }),
                })
              }}
            >
              <IconTrashOutline16 />
            </button>
          )}
        </span>
      </div>
    )
  }

  const noStaged = stagedEntries.length === 0
  const currentBranch = status?.branch ?? ''

  return (
    <section className={css.git} data-dsh-plugin="web-all" data-dsh-part="workbench-git">
      <div className={css.gitHeader}>
        <select
          className={css.gitBranchSelect}
          value={currentBranch}
          onChange={(event) => { void checkout(event.target.value) }}
          disabled={busy || status === null}
          aria-label={s('git.title')}
        >
          {currentBranch !== '' && <option value={currentBranch}>{currentBranch}</option>}
          {branches.filter(name => name !== currentBranch).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <button
          type="button"
          className={css.iconButton}
          aria-label={s('git.createBranch')}
          title={s('git.createBranch')}
          disabled={busy || status === null}
          onClick={() => { setBranchName(''); setCreateOpen(true) }}
        >
          <IconPlusOutline16 />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={s('git.refresh')}
          title={s('git.refresh')}
          disabled={busy}
          onClick={() => { void reload() }}
        >
          <IconRefreshOutline16 />
        </button>
      </div>

      {error !== '' && <div className={css.gitError} role="alert">{error}</div>}
      {status === undefined && <div className={css.gitPlaceholder}>{s('git.loading')}</div>}
      {status === null && error === '' && (
        <div className={css.gitNotRepo}>
          <div className={css.gitNotRepoTitle}>{s('git.notRepo')}</div>
          <div className={css.gitNotRepoHint}>{s('git.notRepoHint')}</div>
        </div>
      )}

      {status !== undefined && status !== null && (
        <>
          {status.conflicts > 0 && <div className={css.gitBanner} data-kind="danger">{s('git.conflictBanner')}</div>}
          {status.operationInProgress && <div className={css.gitBanner}>{s('git.opBanner')}</div>}

          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}>
              <span>{s('git.staged')} ({stagedEntries.length})</span>
              {stagedEntries.length > 0 && (
                <button type="button" className={css.gitLink} disabled={busy} onClick={() => { void stageAll(true) }}>
                  {s('git.unstageAll')}
                </button>
              )}
            </div>
            {stagedEntries.length === 0 && <div className={css.gitEmpty}>{s('git.stagedEmpty')}</div>}
            {stagedEntries.map(entry => renderEntry(entry, true))}
          </div>

          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}>
              <span>{s('git.changes')} ({unstagedEntries.length})</span>
              {unstagedEntries.length > 0 && (
                <button type="button" className={css.gitLink} disabled={busy} onClick={() => { void stageAll(false) }}>
                  {s('git.stageAll')}
                </button>
              )}
            </div>
            {unstagedEntries.length === 0 && <div className={css.gitEmpty}>{s('git.changesEmpty')}</div>}
            {unstagedEntries.map(entry => renderEntry(entry, false))}
          </div>

          <div className={css.gitCommit}>
            <Input
              className={css.gitCommitInput}
              placeholder={s('git.commitPlaceholder')}
              value={message}
              disabled={busy}
              onChange={(event) => { setMessage(event.target.value); setError('') }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void commit()
              }}
            />
            <button
              type="button"
              className={css.gitCommitButton}
              disabled={busy || message.trim() === '' || noStaged}
              onClick={() => { void commit() }}
            >
              {s('git.commit')}
            </button>
          </div>
          {noStaged && message.trim() !== '' && <div className={css.gitHint}>{s('git.commitHint')}</div>}

          {inlineDiff !== null && (
            <div className={css.gitInlineDiff}>
              <div className={css.gitInlineDiffHeader}>
                <span className={css.gitInlineDiffTitle}>{inlineDiff.title}</span>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={s('git.closeDiff')}
                  title={s('git.closeDiff')}
                  onClick={() => { setInlineDiff(null) }}
                >
                  <IconCloseOutline16 />
                </button>
              </div>
              <DiffView text={inlineDiff.text} title={inlineDiff.title} t={t} />
            </div>
          )}

          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}><span>{s('git.history')}</span></div>
            {commits.map(commit => (
              <div
                key={commit.oid}
                role="button"
                tabIndex={0}
                className={css.gitLogRow}
                title={`${commit.author}\n${commit.oid}`}
                onClick={() => { void showCommitDiff(commit) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    void showCommitDiff(commit)
                  }
                }}
                onContextMenu={(event) => { openHistoryMenu(event, commit) }}
              >
                <span className={css.gitLogLine1}>
                  <span className={css.gitLogHash}>{shortOid(commit.oid)}</span>
                  <span className={css.gitLogSubject}>{commit.subject}</span>
                </span>
                <span className={css.gitLogLine2}>
                  {commit.refs.map(ref => <span key={ref} className={css.gitLogRef}>{ref}</span>)}
                  <span className={css.gitLogMeta}>{commit.author} · {relativeText(commit.authorTime * 1000, Date.now(), t)}</span>
                </span>
              </div>
            ))}
            {hasMore && (
              <button
                type="button"
                className={css.gitLogMore}
                disabled={busy}
                onClick={() => { void loadMore() }}
              >
                {s('git.loadMore')}
              </button>
            )}
          </div>
        </>
      )}

      {/* The one shared file-row context menu, positioned at the right-click
          cursor (portal so the panel's overflow clip cannot crop it). */}
      <Menu
        open={fileMenu !== null}
        onClose={() => { setFileMenu(null) }}
        items={[
          { id: 'open', label: s('git.openEditor'), icon: <IconCodeOutline16 size={14} /> },
          fileMenu?.staged === true
            ? { id: 'stage', label: s('git.unstage'), icon: <IconTrashOutline16 size={14} /> }
            : { id: 'stage', label: s('git.stage'), icon: <IconBranchOutline16 size={14} /> },
          ...(fileMenu !== null && !isUntracked(fileMenu.entry)
            ? [{ id: 'discard', label: s('git.discard'), icon: <IconTrashOutline16 size={14} />, danger: true }]
            : []),
          { type: 'separator', id: 'sep1' },
          { id: 'relative', label: s('git.copyRelative'), icon: <IconCopyOutline16 size={14} /> },
          { id: 'absolute', label: s('git.copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
        ]}
        onSelect={(id) => {
          const target = fileMenu
          if (target === null) return
          setFileMenu(null)
          if (id === 'open') { onOpenFile(target.entry.path); return }
          if (id === 'stage') { void stageEntry(target.entry, target.staged); return }
          if (id === 'discard') {
            runConfirmed({
              title: s('git.discardTitle'),
              description: s('git.discardDesc', { path: target.entry.path }),
              confirmLabel: s('git.discard'),
              onConfirm: () => git<GitMutationResult>('discard', { path: cwd, file: target.entry.path }),
            })
            return
          }
          if (id === 'relative') { copy(workspaceRelativePath(cwd, target.entry.path)); return }
          if (id === 'absolute') copy(target.entry.path)
        }}
        portal
        align="start"
        getAnchorRect={() => (fileMenu === null ? null : new DOMRect(fileMenu.x, fileMenu.y, 0, 0))}
        anchor={<span />}
      />

      {/* The shared history-row context menu. */}
      <Menu
        open={historyMenu !== null}
        onClose={() => { setHistoryMenu(null) }}
        items={[
          { id: 'view', label: s('git.viewDiff'), icon: <IconCodeOutline16 size={14} /> },
          { id: 'copyShort', label: s('git.copyShortHash'), icon: <IconCopyOutline16 size={14} /> },
          { id: 'copyFull', label: s('git.copyFullHash'), icon: <IconCopyOutline16 size={14} /> },
          { id: 'copySubject', label: s('git.copySubject'), icon: <IconCopyOutline16 size={14} /> },
          { type: 'separator', id: 'sep2' },
          { id: 'revert', label: s('git.revert'), danger: true },
          { id: 'cherryPick', label: s('git.cherryPick'), danger: true },
        ]}
        onSelect={(id) => {
          const target = historyMenu
          if (target === null) return
          setHistoryMenu(null)
          if (id === 'view') { void showCommitDiff(target.entry); return }
          if (id === 'copyShort') { copy(shortOid(target.entry.oid)); return }
          if (id === 'copyFull') { copy(target.entry.oid); return }
          if (id === 'copySubject') { copy(target.entry.subject); return }
          if (id === 'revert') {
            runConfirmed({
              title: s('git.revertTitle'),
              description: s('git.revertDesc', { subject: commitLabel(target.entry) }),
              confirmLabel: s('git.revert'),
              onConfirm: () => git<GitMutationResult>('revert', { path: cwd, oid: target.entry.oid }),
            })
            return
          }
          if (id === 'cherryPick') {
            runConfirmed({
              title: s('git.cherryPickTitle'),
              description: s('git.cherryPickDesc', { subject: commitLabel(target.entry) }),
              confirmLabel: s('git.cherryPick'),
              onConfirm: () => git<GitMutationResult>('cherry-pick', { path: cwd, oid: target.entry.oid }),
            })
          }
        }}
        portal
        align="start"
        getAnchorRect={() => (historyMenu === null ? null : new DOMRect(historyMenu.x, historyMenu.y, 0, 0))}
        anchor={<span />}
      />

      {/* Destructive actions land here first: Cancel / Confirm. */}
      <Modal
        open={confirm !== null}
        onClose={() => { setConfirm(null) }}
        title={confirm?.title ?? ''}
        closeLabel={s('git.close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setConfirm(null) }}>{s('git.cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                const pending = confirm
                if (pending === null) return
                setConfirm(null)
                void pending.onConfirm()
              }}
            >
              {confirm?.confirmLabel ?? ''}
            </Button>
          </>
        )}
      >
        <p className={css.gitConfirmDesc}>{confirm?.description}</p>
      </Modal>

      {/* Create-branch modal. */}
      <Modal
        open={createOpen}
        onClose={() => { setCreateOpen(false) }}
        title={s('git.createBranchTitle')}
        closeLabel={s('git.close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setCreateOpen(false) }}>{s('git.cancel')}</Button>
            <Button variant="primary" disabled={busy || branchName.trim() === ''} onClick={() => { void createBranch() }}>
              {s('git.confirm')}
            </Button>
          </>
        )}
      >
        <label className={css.gitCreateLabel}>
          {s('git.branchName')}
          <Input
            value={branchName}
            placeholder={s('git.branchPlaceholder')}
            disabled={busy}
            onChange={(event) => { setBranchName(event.target.value); setError('') }}
            onKeyDown={(event) => { if (event.key === 'Enter') void createBranch() }}
          />
        </label>
      </Modal>
    </section>
  )
}

/** Strip a workspace root from an absolute path (copy-relative convenience). */
export function workspaceRelativePath(cwd: string | undefined, path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const root = cwd?.replaceAll('\\', '/').replace(/\/+$/u, '')
  return root !== undefined && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
}