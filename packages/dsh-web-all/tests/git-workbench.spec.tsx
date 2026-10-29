// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { GraphCommit } from '../src/core/git-graph/protocol.ts'
import {
  badgeOf, gitErrorMessage, gitFailureText, GitWorkbench, isStagedEntry, isUnstagedEntry, isUntracked, relativeText,
  splitEntries, workspaceRelativePath, type GitT,
} from '../src/client/sidebar/git-workbench.tsx'
import { rightPaneEn, rightPaneZh } from '../src/client/sidebar/right-pane-i18n.ts'
import type { GitStatusEntry as RightPaneStatusEntry } from '../src/core/right-pane/protocol.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); cleanup() })

interface Repo {
  branch: string
  branches: string[]
  entries: RightPaneStatusEntry[]
  commits: GraphCommit[]
  hasMore?: boolean
  nextCursor?: string
}

function commit(oid: string, subject: string, authorTime = 1_700_000_000): GraphCommit {
  return { oid, parents: [], subject, author: 'Ada', authorTime, refs: [] }
}

/** A fetch router speaking the /git/* envelope plus the porcelain status route. */
function mountFetch(repo: Repo): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.startsWith('/git/')) {
      const route = url.slice('/git/'.length)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      if (route === 'status') {
        return json({ ok: true, value: { root: '/repo', branch: repo.branch, head: 'abc12345', dirtyFiles: repo.entries.length, untrackedFiles: repo.entries.filter(e => e.xy === '??').length, conflicts: 0, operationInProgress: false } })
      }
      if (route === 'branches') {
        return json({ ok: true, value: { root: '/repo', branch: repo.branch, branches: repo.branches.map(name => ({ name, current: name === repo.branch })), dirtyFiles: 0, untrackedFiles: 0, conflicts: 0, operationInProgress: false } })
      }
      if (route === 'graph') {
        return json({ ok: true, value: { root: '/repo', branch: repo.branch, commits: repo.commits, hasMore: repo.hasMore ?? false, nextCursor: repo.nextCursor } })
      }
      if (route === 'diff') {
        const file = typeof body.file === 'string' ? body.file : 'all'
        return json({ ok: true, value: { diff: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,3 @@\n same\n+new line\n` } })
      }
      if (route === 'discard' || route === 'revert' || route === 'cherry-pick') {
        return json({ ok: true, value: { changed: true, kind: route, head: 'abc12345' } })
      }
      if (route === 'commit' || route === 'stage' || route === 'unstage' || route === 'switch' || route === 'create-branch') {
        return json({ ok: true, value: { changed: true } })
      }
      return json({ ok: false, error: { code: 'internal', message: `unexpected route ${route}` } })
    }
    if (url.startsWith('/api/workbench/git-status')) {
      return json({ entries: repo.entries })
    }
    return new Response('{}', { status: 404 })
  })
  globalThis.fetch = spy as never
  return spy
}

describe('git status entry grouping', () => {
  it('splits staged and unstaged like VSCode; both-sides files land in both sections', () => {
    const entries: RightPaneStatusEntry[] = [
      { xy: 'MM', path: 'both.ts' },
      { xy: 'M ', path: 'staged-only.ts' },
      { xy: ' M', path: 'unstaged.ts' },
      { xy: '??', path: 'new.txt' },
      { xy: 'A ', path: 'added.ts' },
      { xy: ' D', path: 'gone.ts' },
    ]
    const { staged, unstaged } = splitEntries(entries)
    expect(staged.map(e => e.path)).toEqual(['both.ts', 'staged-only.ts', 'added.ts'])
    expect(unstaged.map(e => e.path)).toEqual(['both.ts', 'unstaged.ts', 'new.txt', 'gone.ts'])
  })

  it('badge prefers the index letter; untracked is never staged', () => {
    expect(badgeOf({ xy: 'MM', path: 'x' })).toBe('M')
    expect(badgeOf({ xy: '??', path: 'x' })).toBe('?')
    expect(badgeOf({ xy: ' D', path: 'x' })).toBe('D')
    expect(isStagedEntry({ xy: 'MM', path: 'x' })).toBe(true)
    expect(isUnstagedEntry({ xy: 'MM', path: 'x' })).toBe(true)
    expect(isUntracked({ xy: '??', path: 'x' })).toBe(true)
    expect(isUntracked({ xy: 'M ', path: 'x' })).toBe(false)
  })
})

describe('git failure copy', () => {
  const translate: GitT = (key, params) => {
    const text = rightPaneZh[key] ?? rightPaneEn[key] ?? key
    return params === undefined ? text : text.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
  }

  it('never renders a bare template for a shapeless or empty error', () => {
    // A refused request answers with `{ error: 'forbidden: loopback-only' }`:
    // no code and no message, which used to render "Git operation failed:".
    expect(gitErrorMessage('forbidden: loopback-only', translate)).toBe('Git 操作失败：未知错误')
    expect(gitErrorMessage({ code: 'internal', message: '   ' }, translate)).toBe('Git 操作失败：未知错误')
    expect(gitErrorMessage({ code: 'internal', message: 'git status timed out' }, translate)).toBe('Git 操作失败：git status timed out')
    expect(gitErrorMessage({ code: 'dirty-worktree', message: 'ignored' }, translate)).toBe(rightPaneZh['git.error.dirtyWorktree'])
    expect(gitErrorMessage({ code: 'dirty-worktree', message: 'ignored' })).toBe(rightPaneEn['git.error.dirtyWorktree'])
  })

  it('keeps the structured git error for localization after a catch', () => {
    const thrown = Object.assign(new Error('Git operation failed: nope'), { gitError: { code: 'workspace-unknown', message: 'nope' } })
    expect(gitFailureText(thrown, translate)).toBe(rightPaneZh['git.error.workspaceUnknown'])
    expect(gitFailureText(new Error('offline'))).toBe('offline')
    expect(gitFailureText('')).toBe(rightPaneEn['git.error.unknown'])
  })
})

describe('relative history time', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0)
  it('buckets compact labels', () => {
    expect(relativeText(now - 30_000, now)).toBe('now')
    expect(relativeText(now - 5 * 6e4, now)).toBe('5m ago')
    expect(relativeText(now - 3 * 36e5, now)).toBe('3h ago')
    expect(relativeText(now - 2 * 864e5, now)).toBe('2d ago')
    expect(relativeText(now - 100 * 864e5, now)).toBe('3mo ago')
    expect(relativeText(now - 400 * 864e5, now)).toBe('1y ago')
  })

  it('strips the workspace root for copy-relative', () => {
    expect(workspaceRelativePath('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(workspaceRelativePath('/repo', '/other/a.ts')).toBe('/other/a.ts')
    expect(workspaceRelativePath(undefined, '/repo/src/a.ts')).toBe('/repo/src/a.ts')
  })
})

describe('GitWorkbench page', () => {
  const base = (): Repo => ({
    branch: 'dev',
    branches: ['dev', 'main'],
    commits: [commit('abcdef1234567890', 'First commit'), commit('1234567890abcdef', 'Second commit')],
    entries: [{ xy: ' M', path: 'a.ts' }, { xy: 'M ', path: 'b.ts' }],
  })

  it('renders staged/unstaged sections with counts and gates commit on staged changes', async () => {
    mountFetch(base())
    render(<GitWorkbench scope={{ sessionId: 's1', cwd: '/repo' }} onOpenFile={vi.fn()}/>)
    await waitFor(() => expect(screen.getByText('Staged Changes (1)')).toBeTruthy())
    expect(screen.getByText('Changes (1)')).toBeTruthy()
    const commitInput = screen.getByPlaceholderText('Commit message (Ctrl+Enter to commit)')
    const commitButton = () => screen.getByRole('button', { name: 'Commit' })
    expect((commitButton() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(commitInput, { target: { value: 'a message' } })
    expect((commitButton() as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(commitButton())
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/git/commit', expect.objectContaining({ method: 'POST' })))
  })

  it('blocks committing unstaged-only changes and shows the hint', async () => {
    const repo = base()
    repo.entries = [{ xy: ' M', path: 'a.ts' }]
    mountFetch(repo)
    render(<GitWorkbench scope={{ sessionId: 's1', cwd: '/repo' }} onOpenFile={vi.fn()}/>)
    await waitFor(() => expect(screen.getByText(/Staged Changes \(0\)/)).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('Commit message (Ctrl+Enter to commit)'), { target: { value: 'x' } })
    expect((screen.getByRole('button', { name: 'Commit' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Stage the changes you want to commit first\./)).toBeTruthy()
  })

  it('lists branches and switches on select', async () => {
    const fetchSpy = mountFetch(base())
    render(<GitWorkbench scope={{ sessionId: 's1', cwd: '/repo' }} onOpenFile={vi.fn()}/>)
    await waitFor(() => expect(screen.getByLabelText('Source Control').tagName).toBe('SELECT'))
    const select = screen.getByLabelText('Source Control') as HTMLSelectElement
    expect(Array.from(select.options).map(o => o.value)).toEqual(['dev', 'main'])
    fireEvent.change(select, { target: { value: 'main' } })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/git/switch', expect.objectContaining({ method: 'POST' })))
  })

  it('opens untracked files in the editor instead of a diff', async () => {
    const repo = base()
    repo.entries = [{ xy: '??', path: 'new.txt' }]
    mountFetch(repo)
    const onOpenFile = vi.fn()
    render(<GitWorkbench scope={{ sessionId: 's1', cwd: '/repo' }} onOpenFile={onOpenFile}/>)
    await waitFor(() => expect(screen.getByText('new.txt')).toBeTruthy())
    fireEvent.click(screen.getByText('new.txt'))
    expect(onOpenFile).toHaveBeenCalledWith('new.txt')
  })

  it('opens a tracked diff inline and renders the confirm modal for discard', async () => {
    const fetchSpy = mountFetch(base())
    render(<GitWorkbench scope={{ sessionId: 's1', cwd: '/repo' }} onOpenFile={vi.fn()}/>)
    await waitFor(() => expect(screen.getByText('a.ts')).toBeTruthy())
    fireEvent.click(screen.getByText('a.ts'))
    await waitFor(() => expect(screen.getByText(/new line/)).toBeTruthy())
    expect(screen.getByLabelText('Close diff view')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Discard changes' })[1]!)
    await waitFor(() => expect(screen.getByText(/Discard all changes to "a\.ts"/)).toBeTruthy())
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/git/discard', expect.objectContaining({ method: 'POST' })))
  })

  it('shows history rows with ref badges and relative time', async () => {
    const repo = base()
    repo.commits = [{ ...commit('abcdef1234567890', 'First commit'), refs: ['dev', 'tag: v1'] }]
    mountFetch(repo)
    render(<GitWorkbench scope={{ sessionId: 's1', cwd: '/repo' }} onOpenFile={vi.fn()}/>)
    await waitFor(() => expect(screen.getByText('First commit')).toBeTruthy())
    expect(screen.getAllByText('dev').length).toBeGreaterThan(0)
    expect(screen.getByText(/Ada · .*ago/)).toBeTruthy()
  })

  it('creates a branch through the modal', async () => {
    const fetchSpy = mountFetch(base())
    render(<GitWorkbench scope={{ sessionId: 's1', cwd: '/repo' }} onOpenFile={vi.fn()}/>)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' }))
    const input = screen.getByPlaceholderText('Enter a branch name')
    fireEvent.change(input, { target: { value: 'feature/x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/git/create-branch', expect.objectContaining({ method: 'POST' })))
  })

  it('reports a refused envelope-free answer instead of an empty message', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden: loopback-only' }), { status: 403, headers: { 'content-type': 'application/json' } })) as never
    render(<GitWorkbench scope={{ sessionId: 's1', cwd: '/repo' }} onOpenFile={vi.fn()}/>)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/^Git operation failed: 40[35]/u)
  })

  it('localizes operation errors through the zh dictionary', async () => {
    const repo = base()
    mountFetch(repo)
    const zh: Record<string, string> = { 'git.error.dirtyWorktree': '请先提交、暂存或丢弃工作区更改。', 'git.error.internal': 'Git 操作失败：{message}' }
    const t: GitT = (key, params) => {
      const text = zh[key] ?? rightPaneEn[key] ?? key
      return params === undefined ? text : text.replace(/\{(\w+)\}/gu, (_m, name: string) => String(params[name] ?? ''))
    }
    render(<GitWorkbench scope={{ sessionId: 's1', cwd: '/repo' }} t={t} onOpenFile={vi.fn()}/>)
    await waitFor(() => expect(screen.getByText(/Staged Changes \(1\)/)).toBeTruthy())
  })

  it('re-reads the repository when its tab is opened again', async () => {
    // A right-side tab stays mounted while another tab is shown, so the page can hold a
    // reading from before the tab was hidden. Opening it is the moment the user asks for
    // the repository's truth, so it reads then instead of waiting for the next poll tick.
    const fetchSpy = mountFetch(base())
    const view = render(<GitWorkbench scope={{ sessionId: 's1', cwd: '/repo' }} onOpenFile={vi.fn()} visible={false}/>)
    await waitFor(() => expect(screen.getByText(/Staged Changes \(1\)/)).toBeTruthy())
    const statusCalls = (): number => fetchSpy.mock.calls.filter(([url]) => String(url) === '/git/status').length
    const before = statusCalls()
    view.rerender(<GitWorkbench scope={{ sessionId: 's1', cwd: '/repo' }} onOpenFile={vi.fn()} visible/>)
    await waitFor(() => expect(statusCalls()).toBe(before + 1))
  })
})
