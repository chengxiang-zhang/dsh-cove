// @vitest-environment jsdom
/**
 * Dialog lifecycles: a request that is already running must not be dismissed
 * (the PR case used to lose a PR the host had already created), the surface must
 * refresh as soon as the PR landed rather than when the user dismisses the
 * result view, and the one delete dialog must translate its single question
 * ("does the local branch go too?") into the host's two operations — with the
 * force choice appearing exactly when the host will demand it.
 *
 * The primitives are stubbed so the assertions are about these dialogs' own
 * logic; the real Modal behavior is exercised in the browser lane.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Modal: ({ children, footer, onClose }: { children?: unknown; footer?: unknown; onClose?: () => void }) => (
    <div data-testid="modal">
      <button data-testid="modal-close" onClick={() => { onClose?.() }}>x</button>
      <div>{children as never}</div>
      <div>{footer as never}</div>
    </div>
  ),
  Button: ({ children, onClick, disabled }: { children?: unknown; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled === true}>{children as never}</button>
  ),
}))

import { PrCreateDialog } from '../src/client/conversation/worktree/dialogs/PrCreateDialog.tsx'
import { DeleteWorktreeDialog } from '../src/client/conversation/worktree/dialogs/DeleteWorktreeDialog.tsx'

const t = ((key: string) => key) as never

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
})

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label)
}

/** The checkbox inside the row whose label text is exactly this key. */
function checkbox(label: string): HTMLInputElement | undefined {
  const row = [...container.querySelectorAll('label')].find((candidate) => candidate.textContent === label)
  return row?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? undefined
}

function checkboxes(): NodeListOf<HTMLInputElement> {
  return container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
}

async function renderDelete(props: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    root.render(
      <DeleteWorktreeDialog
        repoPath="/repo"
        name="feature/x"
        merged={false}
        dirty={0}
        api={{ cleanup: vi.fn(), remove: vi.fn() } as never}
        onClose={vi.fn()}
        onRemoved={vi.fn()}
        t={t}
        {...props}
      />,
    )
  })
}

describe('PR dialog', () => {
  it('refuses to close while the request is in flight and refreshes on success', async () => {
    const onClose = vi.fn()
    const onSettled = vi.fn()
    let release: ((value: { prUrl: string; method: 'url' }) => void) | undefined
    const api = { prCreate: vi.fn(() => new Promise((resolve) => { release = resolve })) } as never

    await act(async () => {
      root.render(
        <PrCreateDialog
          repoPath="/repo"
          name="feature/x"
          branches={['dev']}
          defaultBaseRef="dev"
          api={api}
          onClose={onClose}
          onCreated={vi.fn()}
          onSettled={onSettled}
          t={t}
        />,
      )
    })

    await act(async () => { button('worktree.prConfirm')?.click() })
    // Escape / mask / the close affordance all land on onClose: refuse while busy.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="modal-close"]')?.click() })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => { release?.({ prUrl: 'https://github.com/o/r/pull/1', method: 'url' }) })
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('https://github.com/o/r/pull/1')

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="modal-close"]')?.click() })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('delete dialog', () => {
  it('keeps the branch and deletes only the directory when the checkbox is off', async () => {
    const remove = vi.fn(async () => ({ name: 'feature/x', path: '/repo/.dsh/workspaces/feature/x' }))
    const onRemoved = vi.fn()
    await renderDelete({ api: { cleanup: vi.fn(), remove } as never, onRemoved })

    expect(checkboxes()).toHaveLength(1)
    expect(checkbox('worktree.deleteBranch')?.checked).toBe(false)
    // No force choice: nothing here needs it.
    expect(container.textContent).not.toContain('worktree.deleteForce')

    await act(async () => { button('worktree.deleteConfirm')?.click() })
    expect(remove).toHaveBeenCalledWith({ repoPath: '/repo', name: 'feature/x', force: false })
    expect(onRemoved).toHaveBeenCalledTimes(1)
  })

  it('deletes the branch for a merged directory without asking anything', async () => {
    const cleanup = vi.fn(async () => ({ name: 'feature/x', path: '/repo/.dsh/workspaces/feature/x' }))
    await renderDelete({ merged: true, api: { cleanup, remove: vi.fn() } as never })

    expect(checkboxes()).toHaveLength(1)
    expect(checkbox('worktree.deleteBranch')?.checked).toBe(true)
    await act(async () => { button('worktree.deleteConfirm')?.click() })
    expect(cleanup).toHaveBeenCalledWith({ repoPath: '/repo', name: 'feature/x', force: false })
  })

  it('asks for force before an unmerged branch can go with the directory', async () => {
    const cleanup = vi.fn(async () => ({ name: 'feature/x', path: '/repo/.dsh/workspaces/feature/x' }))
    await renderDelete({ merged: false, api: { cleanup, remove: vi.fn() } as never })

    await act(async () => { checkbox('worktree.deleteBranch')?.click() })
    expect(container.textContent).toContain('worktree.deleteForce')
    expect(container.textContent).not.toContain('worktree.deleteForceWarning')

    await act(async () => { checkbox('worktree.deleteForce')?.click() })
    expect(container.textContent).toContain('worktree.deleteForceWarning')

    await act(async () => { button('worktree.deleteConfirm')?.click() })
    expect(cleanup).toHaveBeenCalledWith({ repoPath: '/repo', name: 'feature/x', force: true })
  })

  it('asks for force for uncommitted work even when the branch is merged', async () => {
    const cleanup = vi.fn(async () => ({ name: 'feature/x', path: '/repo/.dsh/workspaces/feature/x' }))
    await renderDelete({ merged: true, dirty: 3, api: { cleanup, remove: vi.fn() } as never })

    expect(checkboxes()).toHaveLength(2)
    // force is not smuggled in: the host drops work only when the user says so
    await act(async () => { button('worktree.deleteConfirm')?.click() })
    expect(cleanup).toHaveBeenCalledWith({ repoPath: '/repo', name: 'feature/x', force: false })
  })

  it('sends force once the user takes the force choice for uncommitted work', async () => {
    const cleanup = vi.fn(async () => ({ name: 'feature/x', path: '/repo/.dsh/workspaces/feature/x' }))
    await renderDelete({ merged: true, dirty: 3, api: { cleanup, remove: vi.fn() } as never })

    await act(async () => { checkbox('worktree.deleteForce')?.click() })
    expect(container.textContent).toContain('worktree.deleteForceWarning')
    await act(async () => { button('worktree.deleteConfirm')?.click() })
    expect(cleanup).toHaveBeenCalledWith({ repoPath: '/repo', name: 'feature/x', force: true })
  })

  it('passes the conversation its own identity when the directory is this conversation', async () => {
    const remove = vi.fn(async () => ({ name: 'feature/x', path: '/repo/.dsh/workspaces/feature/x' }))
    await renderDelete({ sessionId: 'session-1', api: { cleanup: vi.fn(), remove } as never })

    await act(async () => { button('worktree.deleteConfirm')?.click() })
    expect(remove).toHaveBeenCalledWith({ repoPath: '/repo', name: 'feature/x', force: false, sessionId: 'session-1' })
  })
})