/**
 * 原生主面板注册（DSH 0.2）：SSH 家族页面统一用官方
 * `sidebar.panellist` 行 + `main` 主栏面板渲染 —— 行外观、选中态、折叠行为与
 * 官方「Plugins」页一致，页面版心与加载态复用 page-shell.tsx（同一套官方插件
 * 页度量）。旧的「DOM 注入中栏 + html 属性显隐 + footer 动作」接管方式已全部
 * 移除。
 *
 * Git Worktree 不在其中：它没有页面。分支在新建对话时由输入框选择器选定，该
 * worktree 的状态与收尾动作都在会话顶部的 lane chip 上。
 *
 * 飞书不占侧栏：它的连接与配置都在设置页（见 client/settings/lark-inbox.tsx）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PanelController as SshPanelController } from './panels/ssh/controller.ts'
import { SshApi } from './panels/ssh/api.ts'
import { SshPanel } from './panels/ssh/SshPanel.tsx'

/** 家族面板控制器面（与 PanelMount 同形，但不含面板挂载职责）。 */
interface PanelHandle {
  getSnapshot(): { panelOpen: boolean }
  open(): void
  close(): void
  subscribe(listener: () => void): () => void
}

/** 主栏面板 id（同时也是 sidebar.panellist 行的 id）。 */
export const SSH_PANEL_ID = 'web-all-ssh'

const SSH_ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.75"/><path d="M4.25 5.25l2.75 2.75-2.75 2.75"/><path d="M8.5 10.75h3.25"/></svg>'

/** 官方 layout 服务面（选中主面板 + 选中态订阅）。 */
interface LayoutFace {
  selectPanel(id: string | null): void
  panelInfo: {
    getSnapshot(): { activePanelId: string | null }
    subscribe(listener: () => void): () => void
  }
}

function optionalService<T>(ctx: ClientContext, name: string): T | undefined {
  try { return (ctx.get as unknown as (id: string, strict?: boolean) => unknown)(name, false) as T | undefined } catch { return undefined }
}

/**
 * 面板行 glyph：官方行容器负责配色，并按 owner 下发的 `size` 请求边长；
 * SVG 里写死的 18 只作为缺省，实际边长跟随 owner（0.2 的
 * `SidebarPanelIconOwnerProps.size`）。
 */
function Glyph({ svg, size = 18 }: { svg: string; size?: number }) {
  const scaled = svg.replace(/width="\d+"/u, 'width="100%"').replace(/height="\d+"/u, 'height="100%"')
  return <span style={{ display: 'inline-flex', width: size, height: size }} dangerouslySetInnerHTML={{ __html: scaled }} />
}

/** 家族面板控制器与原生选中状态双向绑定：选中即打开，取消选中即关闭。 */
function bindNativeSelection(ctx: ClientContext, handle: PanelHandle, layout: LayoutFace | undefined, id: string, disposers: Array<() => void>): void {
  if (layout === undefined) return
  disposers.push(layout.panelInfo.subscribe(() => {
    const active = layout.panelInfo.getSnapshot().activePanelId === id
    if (active && !handle.getSnapshot().panelOpen) handle.open()
    if (!active && handle.getSnapshot().panelOpen) handle.close()
  }))
  disposers.push(handle.subscribe(() => {
    // 面板内的动作只关闭自身（例如 worktree 里打开会话），这里把原生选中态一并清掉。
    if (!handle.getSnapshot().panelOpen && layout.panelInfo.getSnapshot().activePanelId === id) layout.selectPanel(null)
  }))
  void ctx
}

/** 注册一个原生面板：main 主栏 body + sidebar.panellist 行。 */
function registerPanel(
  ctx: ClientContext,
  disposers: Array<() => void>,
  id: string,
  order: number,
  label: () => string,
  icon: string,
  inject: () => Record<string, unknown>,
  Body: (props: never) => React.JSX.Element,
): void {
  disposers.push(ctx.slots.inject('main' as never, () => ctx.slots.register(
    { name: 'main', key: id, inject } as never,
    Body as never,
  ) as unknown as () => void))
  disposers.push(ctx.slots.inject('sidebar.panellist' as never, () => ctx.slots.register(
    { name: 'sidebar.panellist', id, order, label } as never,
    ((props: { owner?: { size?: number } }) => <Glyph svg={icon} size={props?.owner?.size}/>) as never,
  ) as unknown as () => void))
}

/** 挂载 SSH 原生面板；返回统一 disposer。 */
export function registerNativePanels(ctx: ClientContext): () => void {
  const layout = optionalService<LayoutFace>(ctx, 'layout')
  const disposers: Array<() => void> = []

  // ---- SSH：主机 / 终端 / 传输 / 隧道 / 集群
  const sshController = new SshPanelController()
  const sshApi = new SshApi()
  bindNativeSelection(ctx, sshController, layout, SSH_PANEL_ID, disposers)
  registerPanel(ctx, disposers, SSH_PANEL_ID, 30, () => 'SSH', SSH_ICON,
    () => ({ api: sshApi }),
    ((props: { api: never }) => <SshPanel api={props.api}/>) as never)


  return () => { for (const dispose of disposers.reverse()) { try { dispose() } catch { /* tolerant */ } } }
}