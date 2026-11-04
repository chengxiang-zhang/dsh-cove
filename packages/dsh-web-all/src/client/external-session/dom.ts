/**
 * 会话头部子智能体下拉里的「外援」分组（设计稿 §11.1）。
 *
 * 做法与 `conversation/subagent-model-dom.ts` 一致：官方 UI 负责渲染下拉，本模块
 * 只在**已经渲染出来**的树上追加自己的分组与叶节点 —— 不改官方节点、不接管点击
 * 语义、不动原生「N 个子智能体」这个计数。分组头自己数（外援 · N），所以两个
 * 数字永远各算各的，不会把外援混进原生口径。
 *
 * 叶节点只显示标题与「外部任务」标签：外援的轮次进度属于右侧面板，下拉里不显示
 * 执行状态（设计稿 §11.1 的明确要求）。
 *
 * 幂等：同一棵树里只会存在一个分组；重建时按 `data-session-id` 复用既有行，
 * 因此 DOM 观察器反复触发也不会抖动、不会把焦点节点换掉。
 */
import { EXTERNAL_SESSION_PLUGIN, GROUP_PART, ROW_PART } from './constants.ts'
import css from './external-session.module.css'
import type { ExternalSessionView } from './types.ts'
import { sortSessions } from './view.ts'

/** 语义属性里的能力短名（下拉分组与面板共用一份定义）。 */
export const EXTERNAL_GROUP_PLUGIN = EXTERNAL_SESSION_PLUGIN

/** 分组头的部件名。 */
export const GROUP_HEADER_PART = 'group-header'

/** 子智能体下拉的可访问名（中文 / 英文两种构建）。 */
const SUBAGENT_TREE_LABEL = /子智能体|subagent/i

/** 分组与行的稳定选择器（测试与同步逻辑共用一份）。 */
export const GROUP_SELECTOR = `[data-dsh-plugin="${EXTERNAL_GROUP_PLUGIN}"][data-dsh-part="${GROUP_PART}"]`
export const ROW_SELECTOR = `[data-dsh-plugin="${EXTERNAL_GROUP_PLUGIN}"][data-dsh-part="${ROW_PART}"]`

/** 分组里要用的三句话，由调用方从 locale 取好。 */
export interface ExternalGroupText {
  /** 分组头：「外援 · 3」。 */
  readonly title: string
  /** 叶节点标签：「外部任务」。 */
  readonly tag: string
  /** 行内无障碍名：`openAria(title)`。 */
  readonly openAria: (title: string) => string
}

/** 找会话头部的子智能体下拉树；不是这棵树就返回 undefined。 */
export function findSubagentTree(root: ParentNode): HTMLElement | undefined {
  let trees: NodeListOf<Element>
  try {
    trees = root.querySelectorAll('[role="tree"]')
  } catch {
    return undefined
  }
  for (const tree of Array.from(trees)) {
    const label = tree.getAttribute('aria-label') ?? ''
    if (SUBAGENT_TREE_LABEL.test(label) && tree instanceof HTMLElement) return tree
  }
  return undefined
}

function directChild(root: Element, selector: string): HTMLElement | undefined {
  for (const child of Array.from(root.children)) {
    if (child.matches(selector) && child instanceof HTMLElement) return child
  }
  return undefined
}

function textOf(element: Element | null | undefined): string {
  return element?.textContent ?? ''
}

/** 只在文本真的变了时才写，避免多余的重排与观察器回路。 */
function setText(element: Element, value: string): void {
  if (element.textContent !== value) element.textContent = value
}

function removeGroup(tree: Element): void {
  const existing = directChild(tree, GROUP_SELECTOR)
  existing?.remove()
}

/**
 * 把外援会话同步进子智能体下拉。
 *
 * @param root - 观察根（通常是 `document.body`）。
 * @param sessions - 宿主返回的会话列表。
 * @param text - 已经本地化的三句话。
 * @param onOpen - 叶节点被选中时打开该会话的右侧面板。
 */
export function syncExternalGroup(
  root: ParentNode,
  sessions: readonly ExternalSessionView[],
  text: ExternalGroupText,
  onOpen?: (sessionId: string) => void,
): void {
  const tree = findSubagentTree(root)
  if (tree === undefined) return
  if (sessions.length === 0) {
    // 没有外援会话就不占位：空的分组只会把原生下拉变吵。
    removeGroup(tree)
    return
  }
  const ordered = sortSessions(sessions)
  const group = directChild(tree, GROUP_SELECTOR) ?? createGroup(tree, text)
  const header = group.querySelector(`[data-dsh-part="${GROUP_HEADER_PART}"]`) ?? createHeader(group)
  setText(header, text.title)
  group.setAttribute('aria-label', text.title)

  // 按 id 复用既有行：顺序变了只移动，不重建。
  const existing = new Map<string, HTMLElement>()
  for (const row of Array.from(group.querySelectorAll(ROW_SELECTOR))) {
    const id = row instanceof HTMLElement ? row.dataset.sessionId : undefined
    if (id !== undefined) existing.set(id, row as HTMLElement)
  }
  const keep = new Set<string>()
  for (const session of ordered) {
    keep.add(session.id)
    const row = existing.get(session.id) ?? createRow(session, text, onOpen)
    updateRow(row, session, text, onOpen)
    group.appendChild(row)
  }
  for (const [id, row] of existing) {
    if (!keep.has(id)) row.remove()
  }
}

function createGroup(tree: Element, text: ExternalGroupText): HTMLElement {
  const group = (tree.ownerDocument ?? document).createElement('div')
  group.setAttribute('data-dsh-plugin', EXTERNAL_GROUP_PLUGIN)
  group.setAttribute('data-dsh-part', GROUP_PART)
  // role=group 在 role=tree 里是合法的分组容器，不会篡改原生树的可访问性。
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', text.title)
  tree.appendChild(group)
  return group
}

function createHeader(group: Element): HTMLElement {
  const header = (group.ownerDocument ?? document).createElement('div')
  header.setAttribute('data-dsh-part', GROUP_HEADER_PART)
  header.className = css.groupHeader
  group.appendChild(header)
  return header
}

function createRow(
  session: ExternalSessionView,
  text: ExternalGroupText,
  onOpen?: (sessionId: string) => void,
): HTMLElement {
  const doc = document
  const row = doc.createElement('div')
  row.setAttribute('data-dsh-plugin', EXTERNAL_GROUP_PLUGIN)
  row.setAttribute('data-dsh-part', ROW_PART)
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-level', '1')
  row.setAttribute('tabindex', '0')
  row.dataset.sessionId = session.id
  row.className = css.groupRow
  const label = doc.createElement('span')
  label.setAttribute('data-dsh-part', 'row-label')
  label.className = css.groupLabel
  row.appendChild(label)
  const tag = doc.createElement('span')
  tag.setAttribute('data-dsh-part', 'row-tag')
  tag.className = css.groupTag
  tag.textContent = text.tag
  row.appendChild(tag)
  if (onOpen !== undefined) {
    const open = (event: Event): void => {
      event.preventDefault()
      onOpen(session.id)
    }
    row.addEventListener('click', open)
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') open(event)
    })
  }
  updateRow(row, session, text, onOpen)
  return row
}

function updateRow(
  row: HTMLElement,
  session: ExternalSessionView,
  text: ExternalGroupText,
  onOpen?: (sessionId: string) => void,
): void {
  row.dataset.sessionId = session.id
  const label = row.querySelector('[data-dsh-part="row-label"]')
  if (label !== null) setText(label, session.title === '' ? session.id : session.title)
  row.setAttribute('aria-label', text.openAria(session.title === '' ? session.id : session.title))
  row.setAttribute('aria-selected', 'false')
  // 行不显示执行状态；只有平台与终端标签，正文里也不写 token/耗时。
  if (onOpen !== undefined) row.dataset.openable = ''
}

/** 分组当前显示的会话数（面板与测试都读它，避免各算各的）。 */
export function countExternalRows(tree: Element): number {
  const group = directChild(tree, GROUP_SELECTOR)
  if (group === undefined) return 0
  return group.querySelectorAll(ROW_SELECTOR).length
}

/** 给测试与调试用：分组头文本。 */
export function groupHeaderText(tree: Element): string {
  const group = directChild(tree, GROUP_SELECTOR)
  if (group === undefined) return ''
  return textOf(group.querySelector(`[data-dsh-part="${GROUP_HEADER_PART}"]`))
}