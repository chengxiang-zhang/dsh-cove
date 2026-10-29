/**
 * compat shim — data-pane / data-dsh-frame 补标。
 *
 * 官方 shell 的三列容器只带 css-module 哈希类（*_sidebarCol / *_centerCol /
 * *_detailsCol），不带稳定的 data-pane / data-dsh-frame 属性。全家桶各位置
 * 模块与皮肤按这些属性锚定 DOM，因此本 shim 把列容器标记出来，并在 React
 * 重建列结构时自动重打。
 *
 * 行为契约（保持稳定，勿改）：
 *  - 侧栏列 → data-pane="sidebar"；中栏列 → data-pane="conversation"；
 *    右栏列 → data-pane="details"；列容器父级 → data-dsh-frame=""
 *  - 只写属性，不删节点、不扰动 React 协调；幂等。
 */
export interface CompatStamp {
  /** 列选择器 → 要打的属性。 */
  columns: ReadonlyArray<readonly [selector: string, attribute: string]>
  /** 列集合之上再补标的 frame 属性名。 */
  frameAttribute: 'data-dsh-frame'
}

export const DEFAULT_STAMPS: CompatStamp = {
  columns: [
    ['[class*="sidebarCol"]', 'data-pane="sidebar"'],
    ['[class*="centerCol"]', 'data-pane="conversation"'],
    ['[class*="detailsCol"], [class*="rightbarCol"]', 'data-pane="details"'],
  ],
  frameAttribute: 'data-dsh-frame',
}

const COLUMN_OR = '[class*="sidebarCol"], [class*="centerCol"], [class*="detailsCol"], [class*="rightbarCol"]'

/** 单次扫描：给列与 frame 打标。返回 true 表示发生过变化。 */
export function applyCompat(stamps: CompatStamp = DEFAULT_STAMPS): boolean {
  // 裸 host / 测试环境没有 document：直接返回（无副作用）。
  if (typeof document === 'undefined') return false
  let changed = false
  for (const [selector, attribute] of stamps.columns) {
    const el = document.querySelector(selector)
    if (el === null) continue
    const eq = attribute.indexOf('=')
    const name = attribute.slice(0, eq)
    const value = attribute.slice(eq + 1).replace(/^"|"$/g, '')
    if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value)
      changed = true
    }
  }
  // frame：列集合共同的父级网格项。
  const column = document.querySelector(COLUMN_OR)
  const frame = column?.parentElement ?? null
  if (frame !== null && frame.getAttribute(stamps.frameAttribute) !== '') {
    frame.setAttribute(stamps.frameAttribute, '')
    changed = true
  }
  return changed
}

/**
 * 挂载 compat 补标：首次立即应用，之后用 rAF 合并 MutationObserver 突发并
 * 在每帧重打一次，直到全部打标到位。
 * @returns disposer。
 */
export function mountCompat(stamps: CompatStamp = DEFAULT_STAMPS): () => void {
  let scheduled = false
  let done = false
  const pass = (): void => {
    scheduled = false
    if (applyCompat(stamps)) done = false
    else done = true
  }
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      pass()
      if (!done) schedule()
    })
  }
  schedule()
  const observer = new MutationObserver(() => schedule())
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    scheduled = false
  }
}