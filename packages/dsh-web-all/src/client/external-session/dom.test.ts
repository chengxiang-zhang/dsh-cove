// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GROUP_SELECTOR,
  ROW_SELECTOR,
  countExternalRows,
  findSubagentTree,
  groupHeaderText,
  syncExternalGroup,
} from './dom.ts'
import type { ExternalSessionView } from './types.ts'

const text = {
  title: '外援 · {count}',
  tag: '外部任务',
  openAria: (title: string) => `打开外援会话「${title}」`,
  // 行状态由调用方给；这组用例只钉分组与行结构，状态文案另见下方用例。
  stateOf: (_session: ExternalSessionView) => '',
}

/** The three strings the group needs, already interpolated per count. */
function groupText(count: number) {
  return { ...text, title: text.title.replace('{count}', String(count)) }
}

function nativeTree(label = '子智能体会话'): HTMLElement {
  const tree = document.createElement('div')
  tree.setAttribute('role', 'tree')
  tree.setAttribute('aria-label', label)
  const nativeRow = document.createElement('div')
  nativeRow.setAttribute('role', 'treeitem')
  nativeRow.setAttribute('aria-level', '1')
  nativeRow.textContent = '原生子智能体'
  tree.appendChild(nativeRow)
  document.body.appendChild(tree)
  return tree
}

const session: ExternalSessionView = {
  id: 'ext-1',
  provider: 'claude',
  title: '修登录 bug',
  status: 'idle',
  cwd: '/tmp',
  createdAt: '2026-11-04T09:00:00Z',
  lastTurnAt: '2026-11-04T09:01:00Z',
  canContinue: true,
  turns: [],
}

beforeEach(() => { document.body.innerHTML = '' })

describe('subagent dropdown external group', () => {
  it('finds the subagent tree by its accessible name and ignores other trees', () => {
    const other = document.createElement('div')
    other.setAttribute('role', 'tree')
    other.setAttribute('aria-label', '会话')
    document.body.appendChild(other)
    const tree = nativeTree()
    expect(findSubagentTree(document.body)).toBe(tree)
    expect(findSubagentTree(document.createElement('div'))).toBeUndefined()
  })

  it('appends one group with its own count and leaves the native row untouched', () => {
    const tree = nativeTree()
    syncExternalGroup(document.body, [session, { ...session, id: 'ext-2', title: '第二个' }], groupText(2))

    const groups = tree.querySelectorAll(GROUP_SELECTOR)
    expect(groups).toHaveLength(1)
    expect(groupHeaderText(tree)).toBe('外援 · 2')
    expect(countExternalRows(tree)).toBe(2)
    // 原生行一个字节都不改，原生「N 个子智能体」口径也不受影响。
    expect(tree.firstElementChild?.textContent).toBe('原生子智能体')
    expect(tree.textContent).not.toContain('个子智能体运行中')
  })

  it('shows title plus the external-task tag and no execution state', () => {
    const tree = nativeTree()
    syncExternalGroup(document.body, [session], groupText(1))
    const row = tree.querySelector(ROW_SELECTOR) as HTMLElement
    expect(row.getAttribute('role')).toBe('treeitem')
    expect(row.getAttribute('aria-level')).toBe('1')
    expect(row.getAttribute('aria-label')).toBe('打开外援会话「修登录 bug」')
    expect(row.textContent).toBe('修登录 bug外部任务')
    // 叶节点不显示执行状态：没有状态圆点、没有 data-state、没有 token/耗时。
    expect(row.querySelector('[data-state]')).toBeNull()
    expect(row.querySelector('[data-dsh-part="row-activity"]')).toBeNull()
    expect(row.textContent).not.toMatch(/tok|运行中|已完成/)
  })

  it('is idempotent: a second sync reuses the same nodes', () => {
    const tree = nativeTree()
    syncExternalGroup(document.body, [session], groupText(1))
    const group = tree.querySelector(GROUP_SELECTOR)
    const row = tree.querySelector(ROW_SELECTOR)
    syncExternalGroup(document.body, [session], groupText(1))
    expect(tree.querySelector(GROUP_SELECTOR)).toBe(group)
    expect(tree.querySelector(ROW_SELECTOR)).toBe(row)
    expect(tree.querySelectorAll(ROW_SELECTOR)).toHaveLength(1)
  })

  it('removes rows that disappeared and the group itself when the list empties', () => {
    const tree = nativeTree()
    syncExternalGroup(document.body, [session, { ...session, id: 'ext-2' }], groupText(2))
    syncExternalGroup(document.body, [session], groupText(1))
    expect(countExternalRows(tree)).toBe(1)
    syncExternalGroup(document.body, [], groupText(0))
    expect(tree.querySelector(GROUP_SELECTOR)).toBeNull()
    expect(tree.querySelectorAll(ROW_SELECTOR)).toHaveLength(0)
  })

  it('opens the panel for the clicked session and ignores clicks when no opener is given', () => {
    const tree = nativeTree()
    const open = vi.fn()
    syncExternalGroup(document.body, [session], groupText(1), open)
    const row = tree.querySelector(ROW_SELECTOR) as HTMLElement
    row.click()
    expect(open).toHaveBeenCalledWith('ext-1')

    document.body.innerHTML = ''
    const bareTree = nativeTree()
    syncExternalGroup(document.body, [session], groupText(1))
    ;(bareTree.querySelector(ROW_SELECTOR) as HTMLElement).click()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the subagent dropdown is not on screen', () => {
    expect(() => { syncExternalGroup(document.body, [session], groupText(1)) }).not.toThrow()
    expect(document.body.querySelector(GROUP_SELECTOR)).toBeNull()
  })

  it('renders nothing for an empty list instead of an empty group', () => {
    const tree = nativeTree()
    syncExternalGroup(document.body, [], groupText(0))
    expect(tree.querySelector(GROUP_SELECTOR)).toBeNull()
  })
})