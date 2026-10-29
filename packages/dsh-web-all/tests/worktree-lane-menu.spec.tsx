// @vitest-environment jsdom
/**
 * Header popover: it is now the whole lifecycle surface, so the rules that used
 * to be the management page's are asserted here — a fence refusal must read as a
 * refusal (not as an empty list), a running conversation must not be able to
 * delete its own directory, the directory's own conversation must pass its own
 * identity to the teardown, and the PR flow must read the repository's real base
 * branches before it opens the dialog.
 *
 * There used to be two teardown actions; the tests below pin the single delete
 * action and the checkbox that decides the branch, because "which of these two
 * deletes my branch?" was exactly the question users could not answer.
 *
 * The primitives are stubbed so these assertions are about the menu's own
 * logic; the real Modal/backdrop behavior is exercised in the browser lane.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Modal: ({ children, footer, title }: { children?: unknown; footer?: unknown; title?: string }) => (
    <div data-testid="modal" data-title={title}>
      <div>{children as never}</div>
      <div>{footer as never}</div>
    </div>
  ),
  Button: ({ children, onClick, disabled }: { children?: unknown; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled === true}>{children as never}</button>
  ),
}))

const cleanup = vi.fn()
const remove = vi.fn()
const prCreate = vi.fn()
const status = vi.fn()
const laneLookup = vi.fn()

vi.mock('../src/client/conversation/worktree/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/conversation/worktree/api.ts')>()
  return {
    ...actual,
    WorktreeApi: class {
      cleanup = cleanup
      remove = remove
      prCreate = prCreate
      status = status
      lane = laneLookup
      tree = vi.fn()
      createLane = vi.fn()
      bindLane = vi.fn()
      rollbackLane = vi.fn()
      create = vi.fn()
      init = vi.fn()
    },
  }
})

import { LaneMenu } from '../src/client/conversation/worktree/lane-menu.tsx'
import { WorktreeApi, WorktreeApiError } from '../src/client/conversation/worktree/api.ts'
import type { LaneView } from '../src/core/worktree/types.ts'

const t = ((key: string) => key) as never

function laneView(overrides: Partial<LaneView> = {}): LaneView {
  return {
    name: 'feature/x',
    branch: 'feature/x',
    path: '/repo/.dsh/workspaces/feature/x',
    repoPath: '/repo',
    exists: true,
    workspaceId: null,
    sessionId: 'session-1',
    permissionPresetApplied: true,
    dirty: 0,
    pushed: false,
    remoteBranchGone: false,
    merged: false,
    prUrl: null,
    prNumber: null,
    ...overrides,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.clearAllMocks()
  // Implementations outlive clearAllMocks; the lane re-read must not leak.
  laneLookup.mockReset()
})

async function renderMenu(props: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    root.render(
      <LaneMenu
        sessionId="session-1"
        lane={laneView()}
        api={new WorktreeApi()}
        running={false}
        ownLane
        onClose={vi.fn()}
        onChanged={vi.fn()}
        t={t}
        {...props}
      />,
    )
  })
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label)
}

/** The checkbox inside the row whose label text is exactly this key. */
function checkbox(label: string): HTMLInputElement | undefined {
  const row = [...container.querySelectorAll('label')].find((candidate) => candidate.textContent === label)
  return row?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? undefined
}

/** Run one click and flush every microtask it starts. */
async function click(target: HTMLElement | undefined): Promise<void> {
  await act(async () => { target?.click() })
}

describe('lane menu facts', () => {
  it('names the directory and links a PR that already exists', async () => {
    await renderMenu({ lane: laneView({ prUrl: 'https://github.com/o/r/pull/7' }) })

    expect(container.textContent).toContain('/repo/.dsh/workspaces/feature/x')
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://github.com/o/r/pull/7')
  })

  it('shows the fence refusal as a refusal, not as a missing directory', async () => {
    status.mockRejectedValue(new WorktreeApiError('forbidden: loopback-only', 403, 'permission'))
    await renderMenu()

    await click(button('menu.refresh'))

    expect(container.textContent).toContain('error.permissionDenied')
  })

  it('offers exactly three actions: the PR, one delete, and the re-check', async () => {
    await renderMenu()

    const items = [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(items).toEqual(['menu.pr', 'menu.delete', 'menu.refresh'])
  })
})

describe('lane menu delete guards', () => {
  it('disables deleting while the conversation is running', async () => {
    await renderMenu({ running: true })

    expect(button('menu.delete')?.disabled).toBe(true)
    expect(container.textContent).toContain('menu.running')
  })

  it('passes the conversation its own identity so the host accepts the delete', async () => {
    cleanup.mockResolvedValue({ name: 'feature/x', path: '/tmp/x' })
    await renderMenu({ lane: laneView({ merged: true }) })

    await click(button('menu.delete'))
    await click(button('worktree.deleteConfirm'))

    expect(cleanup).toHaveBeenCalledWith({ repoPath: '/repo', name: 'feature/x', force: false, sessionId: 'session-1' })
  })

  it('deletes a merged, clean directory in one click with no force choice', async () => {
    cleanup.mockResolvedValue({ name: 'feature/x', path: '/tmp/x' })
    await renderMenu({ lane: laneView({ merged: true, dirty: 0 }) })

    await click(button('menu.delete'))

    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
    expect(checkbox('worktree.deleteBranch')?.checked).toBe(true)
    expect(container.textContent).not.toContain('worktree.deleteForce')

    await click(button('worktree.deleteConfirm'))
    expect(cleanup).toHaveBeenCalledWith({ repoPath: '/repo', name: 'feature/x', force: false, sessionId: 'session-1' })
  })

  it('re-reads the directory before offering to delete it', async () => {
    // Regression (found in the browser lane): the chip's snapshot predates work
    // the user has just left in the directory, so a decision taken from it hid
    // the force row the host will demand — the dialog lied about being one click.
    laneLookup.mockResolvedValue({ merged: true, dirty: 2 })
    cleanup.mockResolvedValue({ name: 'feature/x', path: '/tmp/x' })
    await renderMenu({ lane: laneView({ merged: false, dirty: 0 }) })

    await click(button('menu.delete'))

    expect(laneLookup).toHaveBeenCalledWith({ path: '/repo/.dsh/workspaces/feature/x' })
    expect(checkbox('worktree.deleteBranch')?.checked).toBe(true)
    expect(container.textContent).toContain('worktree.deleteForce')
  })

  it('does not claim another conversation as itself when the directory belongs to someone else', async () => {
    remove.mockResolvedValue({ name: 'feature/x', path: '/tmp/x' })
    await renderMenu({ ownLane: false, lane: laneView({ sessionId: 'session-other' }) })

    expect(container.textContent).not.toContain('menu.selfTeardown')
    await click(button('menu.delete'))
    // Unmerged: the branch checkbox stays off, so this is the keep-the-branch path.
    expect(checkbox('worktree.deleteBranch')?.checked).toBe(false)
    await click(button('worktree.deleteConfirm'))

    expect(remove).toHaveBeenCalledWith({ repoPath: '/repo', name: 'feature/x', force: false })
  })

  it('still lets an unmerged branch go, behind the force choice', async () => {
    cleanup.mockResolvedValue({ name: 'feature/x', path: '/tmp/x' })
    await renderMenu({ lane: laneView({ merged: false }) })

    await click(button('menu.delete'))
    await click(checkbox('worktree.deleteBranch'))
    expect(container.textContent).toContain('worktree.deleteForce')
    await click(checkbox('worktree.deleteForce'))
    await click(button('worktree.deleteConfirm'))

    expect(cleanup).toHaveBeenCalledWith({ repoPath: '/repo', name: 'feature/x', force: true, sessionId: 'session-1' })
  })
})

describe('lane menu dismissal', () => {
  it('does not dismiss itself while its dialog is showing', async () => {
    // Regression: the dialog is portaled to the body, so the menu's outside
    // click handler treated every click inside the dialog as "outside" and
    // unmounted it mid-flight (a PR the host had already created disappeared).
    const onClose = vi.fn()
    status.mockResolvedValue({ baseBranch: 'dev', branches: ['dev'], worktrees: [] })
    await renderMenu({ onClose })

    await click(button('menu.pr'))
    expect(container.querySelector('[data-testid="modal"]')).not.toBeNull()

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(onClose).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="modal"]')).not.toBeNull()
  })

  it('dismisses itself on an outside click while no dialog is open', async () => {
    const onClose = vi.fn()
    await renderMenu({ onClose })

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('lane menu PR flow', () => {
  it('reads the repository base branches before opening the dialog', async () => {
    status.mockResolvedValue({ baseBranch: 'dev', branches: ['dev', 'main'], worktrees: [] })
    await renderMenu()

    await click(button('menu.pr'))

    expect(status).toHaveBeenCalledWith({ repoPath: '/repo' })
    expect(container.querySelector('[data-testid="modal"]')).not.toBeNull()
    const options = [...container.querySelectorAll('option')].map((option) => option.textContent)
    expect(options).toEqual(['dev', 'main'])
  })

  it('never opens the dialog for a merged directory', async () => {
    await renderMenu({ lane: laneView({ merged: true }) })

    expect(button('menu.pr')?.disabled).toBe(true)
  })

  it('reports a failed probe instead of opening an empty base list', async () => {
    status.mockRejectedValue(new WorktreeApiError('unreachable', 0, 'transport'))
    await renderMenu()

    await click(button('menu.pr'))

    expect(container.querySelector('[data-testid="modal"]')).toBeNull()
    expect(container.textContent).toContain('error.unreachable')
  })
})