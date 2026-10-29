// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BranchPopover } from '../src/client/conversation/git-graph/branch-popover.tsx'
import { GraphDialog } from '../src/client/conversation/git-graph/graph-dialog.tsx'
import { CreateBranchDialog } from '../src/client/conversation/git-graph/create-branch-dialog.tsx'
import { Chip } from '../src/client/conversation/git-graph/chip.tsx'
import { heroPlacementIn, heroRowFor, shouldProbeInFlow } from '../src/client/conversation/git-graph/hero-seat.ts'
import { GitApi } from '../src/client/conversation/git-graph/api.ts'
import { zh, type GitGraphKey } from '../src/client/conversation/git-graph/locales.ts'

vi.mock('../src/client/conversation/git-graph/git-graph.module.css', () => ({ default: {} }))
// The client resolves icons through `ui-icons.ts`, which prefers the 0.2
// runtime names (`*Medium`) and falls back to the typed `*16/*14` names, so the
// mock has to carry both sets.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconBranchOutlineMedium: () => <span />,
  IconCheckOutlineMedium: () => <span />,
  IconSearchOutlineMedium: () => <span />,
  IconCloseOutlineMedium: () => <span />,
  IconChevronDownOutlineMedium: () => <span />,
  IconCodeOutlineMedium: () => <span />,
  IconCopyOutlineMedium: () => <span />,
  IconGlobeOutlineMedium: () => <span />,
  IconPlusOutlineMedium: () => <span />,
  IconRefreshOutlineMedium: () => <span />,
  IconTrashOutlineMedium: () => <span />,
  IconWorkspaceTreeOutlineMedium: () => <span />,
  IconBranchOutline16: () => <span />,
  IconCheckOutline14: () => <span />,
  IconSearchOutline16: () => <span />,
  IconCloseOutline16: () => <span />,
  IconChevronDownOutline14: () => <span />,
}))

const t = ((key: GitGraphKey, params?: Record<string, unknown>): string => {
  let value = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as import('@deepseek-ai/dsh-client-ui-slots').Translate<GitGraphKey>

afterEach(() => { vi.restoreAllMocks() })

describe('conversation-owned git graph UI', () => {
  it('keeps the branch-chip hook used by shipped skins', () => {
    const { container } = render(<div data-dsh-plugin="git-graph" data-dsh-part="chip"><Chip icon={<span />} label="main" ariaLabel="分支" open={false} onClick={vi.fn()} /></div>)
    expect(container.querySelector('[data-dsh-plugin="git-graph"][data-dsh-part="chip"] [data-gitgraph-chip]')).not.toBeNull()
  })

  it('renders searchable branch actions and skin semantic hooks', () => {
    const onGraph = vi.fn()
    const { container } = render(<BranchPopover
      view={{ root: '/repo', branch: 'main', dirtyFiles: 1, untrackedFiles: 0, conflicts: 0, operationInProgress: false, branches: [
        { name: 'main', current: true }, { name: 'feature/graph', current: false },
      ] }}
      onSwitch={vi.fn()}
      onSwitched={vi.fn()}
      onCreate={vi.fn()}
      onGraph={onGraph}
      onClose={vi.fn()}
      t={t}
    />)
    expect(container.querySelector('[data-dsh-plugin="git-graph"][data-gitgraph-popover]')).not.toBeNull()
    fireEvent.change(screen.getByPlaceholderText('搜索分支'), { target: { value: 'feature' } })
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(screen.getByText('feature/graph')).toBeTruthy()
    fireEvent.click(screen.getByText('Git 图谱'))
    expect(onGraph).toHaveBeenCalledOnce()
  })

  it('renders lanes, glyph categories, refs, and current-branch hooks', async () => {
    const graph = vi.fn(async () => ({
      root: '/repo', branch: 'main', hasMore: false,
      commits: [
        { oid: 'aaaaaaa1', parents: ['bbbbbbb2', 'ccccccc3'], subject: 'merge', author: 'Ada', authorTime: 0, refs: ['main'] },
        { oid: 'bbbbbbb2', parents: [], subject: 'base', author: 'Bob', authorTime: 0, refs: [] },
      ],
    }))
    const { container } = render(<GraphDialog graph={graph} onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByText('merge')).toBeTruthy() })
    expect(container.querySelector('[data-dsh-plugin="git-graph"][data-dsh-part="dialog"][data-gitgraph-dialog]')).not.toBeNull()
    expect(container.querySelector('[data-gitgraph-lanes]')).not.toBeNull()
    expect(container.querySelector('[data-gitgraph-glyph="merge"]')).not.toBeNull()
    expect(container.querySelector('[data-gitgraph-ref]')).not.toBeNull()
    expect(container.querySelector('[data-gitgraph-current-branch="true"][data-gitgraph-ref-current="true"]')?.textContent).toBe('main')
  })

  it('preserves the /git transport contract', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, value: { branch: 'dev' } }), {
      headers: { 'content-type': 'application/json' },
    }))
    await expect(new GitApi().switchBranch('/repo', 'dev')).resolves.toEqual({ ok: true, value: { branch: 'dev' } })
    expect(fetchMock).toHaveBeenCalledWith('/git/switch', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: '/repo', branch: 'dev' }),
    }))
  })
})

describe('create branch dialog result', () => {
  it('says where the new worktree is and whether this conversation moved into it', async () => {
    const onClose = vi.fn()
    const onCreate = vi.fn(async (name: string) => ({ ok: true as const, branch: name, opened: false }))
    const { container } = render(<CreateBranchDialog onCreate={onCreate} onClose={onClose} t={t} />)

    fireEvent.change(container.querySelector('#git-graph-branch-name') as HTMLInputElement, { target: { value: 'feature/x' } })
    fireEvent.click(screen.getByText('创建并切换'))

    await waitFor(() => { expect(onCreate).toHaveBeenCalledWith('feature/x') })
    // The worktree is ready but the conversation did not move: the dialog has to
    // say so instead of closing as if the user were now on feature/x.
    await waitFor(() => { expect(container.textContent).toContain('选择工作区') })
    expect(onClose).not.toHaveBeenCalled()
    expect(container.textContent).toContain('feature/x')

    fireEvent.click(screen.getByText('知道了'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reports the moved conversation when the shell opened one on the lane', async () => {
    const onCreate = vi.fn(async (name: string) => ({ ok: true as const, branch: name, opened: true }))
    const { container } = render(<CreateBranchDialog onCreate={onCreate} onClose={vi.fn()} t={t} />)

    fireEvent.change(container.querySelector('#git-graph-branch-name') as HTMLInputElement, { target: { value: 'feature/y' } })
    fireEvent.click(screen.getByText('创建并切换'))

    await waitFor(() => { expect(container.textContent).toContain('已在其中开始本对话') })
    expect(container.textContent).not.toContain('选择工作区')
  })
})

describe('branch chip hero seat', () => {
  /** A DOMRect stand-in: jsdom lays nothing out, so the geometry is stubbed. */
  const box = (width: number, height: number, top = 0): DOMRect => ({
    x: 0, y: top, top, left: 0, right: width, bottom: top + height, width, height,
    toJSON: () => ({}),
  }) as DOMRect

  /** Mount `<row><outlet><anchor>` the way the shell renders the dock seat. */
  const mount = (options: { display?: string, rowHeight?: number, chipRow?: boolean } = {}) => {
    const host = document.createElement('div')
    const row = document.createElement('div')
    if (options.chipRow !== false) row.appendChild(document.createElement('button'))
    row.getBoundingClientRect = () => box(744, options.rowHeight ?? 28, 186)
    const outlet = document.createElement('div')
    outlet.style.display = options.display ?? 'contents'
    const anchor = document.createElement('div')
    outlet.appendChild(anchor)
    host.append(row, outlet)
    return { anchor, row }
  }

  it('finds the hero chip row above a display:contents dock outlet', () => {
    const { anchor, row } = mount()
    expect(heroRowFor(anchor)).toBe(row)
  })

  it('stays in flow when the previous sibling is not a chip row', () => {
    expect(heroRowFor(mount({ chipRow: false }).anchor)).toBeNull()
    expect(heroRowFor(mount({ rowHeight: 44 }).anchor)).toBeNull()
    expect(heroRowFor(mount({ display: 'block' }).anchor)).toBeNull()
    expect(heroRowFor(document.createElement('div'))).toBeNull()
  })

  it('places the chip in the containing block, not in the composer stack', () => {
    // 0.2 regression: the composer stack is `position: static`, so a
    // stack-relative offset (origin 380.5/114) lands ~130px away from the
    // hero row. The lifted chip is positioned against the app body instead.
    const placement = heroPlacementIn({ left: 280, top: 40, clientLeft: 0, clientTop: 0 }, { top: 186, height: 28 }, 616.796875)
    expect(placement.left).toBeCloseTo(338.796875, 3)
    expect(placement.top).toBeCloseTo(146, 3)
  })

  it('centres a taller or shorter official row on the 28px chip', () => {
    expect(heroPlacementIn({ left: 0, top: 0, clientLeft: 0, clientTop: 0 }, { top: 100, height: 32 }, 0).top).toBe(102)
    expect(heroPlacementIn({ left: 0, top: 0, clientLeft: 0, clientTop: 0 }, { top: 100, height: 24 }, 0).top).toBe(98)
  })

  it('probes the settled layout only while the anchor is still in flow', () => {
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    expect(shouldProbeInFlow(anchor)).toBe(true)
    anchor.style.position = 'absolute'
    expect(shouldProbeInFlow(anchor)).toBe(false)
    anchor.remove()
  })
})
