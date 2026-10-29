/**
 * 位置模块：侧栏（sidebar）— 唯一负责侧栏注入的位置模块。
 *
 * SSH / 记忆都是 0.2 原生面板（`sidebar.panellist` 行 + `main` 主栏 body），
 * 与官方 Plugins 页同一套外观、选中语义与页面版心；右栏（right-pane）由本
 * 模块装载（Git 管理 / Agent 浏览器页签，见 right-pane.tsx）。
 *
 * Git Worktree 不是侧栏页面：分支在新建对话时由输入框选择器选定，其生命周期
 * 挂在会话顶部的 lane chip 上（见 conversation 位置模块）。
 *
 * 侧栏标题行是官方 DOM，本模块只做样式编排（不注册官方槽位、不改官方节点）：
 * 品牌位不出现、标题行收掉、折叠按钮搬到页脚与「设置」行并列，规则与取舍见
 * sidebar-header.module.css。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { registerNativePanels } from './native-panels.tsx'
import { mountRightPane } from './right-pane.tsx'
import './sidebar-header.module.css'

/** 装配侧栏位置模块：原生面板 + 右栏。 */
export function mountSidebar(ctx: ClientContext): () => void {
  const disposers = [
    registerNativePanels(ctx),
    mountRightPane(ctx),
  ]
  return () => { for (const dispose of disposers) dispose() }
}