/** Native right-sidebar additions owned exclusively by the web-all sidebar position. */
import { createElement, type ComponentType, type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { IconBranchOutline16 } from '../ui-icons.ts'
import { IconAgentBrowser16 } from './icons.tsx'
import { AgentBrowserPanel } from './agent-browser.tsx'
import { GitWorkbench } from './git-workbench.tsx'
import { RenderBoundary } from './RenderBoundary.tsx'
import { fileAddressFor } from '../../core/right-pane/protocol.ts'
import {
  RIGHT_PANE_LOCALE, rightPaneEn, rightPaneZh, type RightPaneLocaleKey,
} from './right-pane-i18n.ts'
import { useSessionWorkbenchScope } from './scope.ts'
import css from './sidebar.module.css'

export { RIGHT_PANE_LOCALE, rightPaneEn, rightPaneZh }
export type { RightPaneLocaleKey }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'web-all-right-pane': RightPaneLocaleKey }
}

interface NativeTabDefinition {
  id: string
  kind: string
  title: (address?: string) => string
  guide?: readonly {
    id: string
    order: number
    title: () => string
    description?: () => string
    icon?: ComponentType<{ size?: number; className?: string }>
  }[]
}
interface TabRegistry { register(definition: NativeTabDefinition): () => void }
interface Rightbar {
  openTab(kind: string, options?: { params?: Record<string, unknown> }): void
  openResource?(address: string): void
}
type BindLocale = (key: RightPaneLocaleKey, params?: Record<string, string | number>) => string
interface NativeTabInfo {
  sidebar: { expanded: boolean; fullscreen: boolean }
  panel: { id: string }
  tab: { visible: boolean; navigation: { params: Record<string, unknown>; revision: number }; signal: AbortSignal }
}
type UseTabInfo = () => NativeTabInfo
interface PositionTabProps { useTabInfo?: UseTabInfo }
interface PageSpec {
  id: 'git' | 'browser' | 'agent-browser'
  kind: 'web-ui.git' | 'web-ui.browser' | 'web-ui.agent-browser'
  title: () => string
  description: () => string
  order: number
  icon: ComponentType<{ size?: number; className?: string }>
  requiresWorkspace: boolean
  render(ctx: ClientContext, info: NativeTabInfo | undefined, sessionId?: string): ReactNode
}

function optionalService<T>(ctx: ClientContext, name: string): T | undefined {
  try { return (ctx as unknown as { get(id: string, strict?: boolean): unknown }).get(name, false) as T | undefined } catch { return undefined }
}
function stableInfo(useTabInfo?: UseTabInfo): NativeTabInfo | undefined { return useTabInfo?.() }

/** z/h text helper shared by the pages; falls back to the en dictionary so a
 *  direct render (tests, skins) never shows bare keys. */
export function bindRightPaneLocale(ctx: ClientContext): BindLocale {
  const bind = ctx.locale.bind(RIGHT_PANE_LOCALE)
  return (key, params) => {
    const text = bind(key) ?? rightPaneEn[key]
    if (params === undefined) return text
    return text.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
  }
}

function NativePage({ ctx, spec, useTabInfo, sessionId }: { ctx: ClientContext; spec: PageSpec; useTabInfo?: UseTabInfo; sessionId?: string }) {
  const info = stableInfo(useTabInfo)
  const scope = useSessionWorkbenchScope(ctx, sessionId)
  const t = bindRightPaneLocale(ctx)
  if (spec.requiresWorkspace && (!scope.sessionId || !scope.cwd)) {
    return <section className={css.nativeFused} data-dsh-plugin="web-all" data-dsh-better-sidebar="" data-dsh-part="native-fused"><div className={css.emptyState}>{t('workspaceRequired')}</div></section>
  }
  return <section className={css.nativeFused} data-dsh-plugin="web-all" data-dsh-better-sidebar="" data-dsh-part="native-fused" data-visible={info?.tab.visible ?? true}><RenderBoundary>{spec.render(ctx, info, sessionId)}</RenderBoundary></section>
}

function GitPage({ ctx, sessionId, visible }: { ctx: ClientContext; sessionId?: string; visible?: boolean }) {
  const scope = useSessionWorkbenchScope(ctx, sessionId)
  const t = bindRightPaneLocale(ctx)
  const openInEditor = (path: string): void => {
    if (scope.sessionId === undefined) return
    const address = fileAddressFor(scope.sessionId, scope.cwd, path)
    optionalService<Rightbar>(ctx, 'sidebarRight')?.openResource?.(address)
  }
  return <GitWorkbench scope={scope} t={t} onOpenFile={openInEditor} visible={visible}/>
}

function pages(ctx: ClientContext): readonly PageSpec[] {
  const t = bindRightPaneLocale(ctx)
  return [
    { id: 'git', kind: 'web-ui.git', title: () => t('git.title'), description: () => t('git.description'), order: 30, icon: IconBranchOutline16, requiresWorkspace: true, render: (owner, info, sessionId) => <GitPage ctx={owner} sessionId={sessionId} visible={info?.tab.visible ?? true}/> },
    { id: 'agent-browser', kind: 'web-ui.agent-browser', title: () => t('agentBrowser.title'), description: () => t('agentBrowser.description'), order: 32, icon: IconAgentBrowser16, requiresWorkspace: false, render: (_owner, info, sessionId) => <AgentBrowserPanel sessionId={sessionId} visible={info?.tab.visible ?? true} signal={info?.tab.signal} t={t}/> },
  ]
}

/** Register the Git management page DSH does not ship. */
function mountRightPaneFaces(ctx: ClientContext, tabs: TabRegistry): () => void {
  const disposers: Array<() => void> = []
  for (const spec of pages(ctx)) {
    const key = `dsh-web-all/${spec.id}`
    disposers.push(tabs.register({
      id: key,
      kind: spec.kind,
      title: spec.title,
      guide: [{ id: spec.id, order: spec.order, title: spec.title, description: spec.description, icon: spec.icon }],
    }))
    // 原生 keyed 槽：key 用类型 id，inject(sessionId) 由框架按会话作用域注入。
    disposers.push(ctx.slots.inject('sidebar.right.pane.tab' as never, () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key, locale: RIGHT_PANE_LOCALE, inject: (sessionId: string) => ({ sessionId }) } as never,
      ((props: PositionTabProps & { sessionId?: string }) => createElement(NativePage, { ctx, spec, useTabInfo: props.useTabInfo, sessionId: props.sessionId })) as never,
    )))
  }
  return () => { for (const dispose of disposers.reverse()) { try { dispose() } catch {} } }
}

export function mountRightPane(ctx: ClientContext): () => void {
  const disposeLocale = ctx.locale.register(RIGHT_PANE_LOCALE, { zh: rightPaneZh, en: rightPaneEn })
  let disposeFaces = (): void => {}
  const owner = ctx as unknown as { inject?: (services: string[], setup: (scope: ClientContext) => void | (() => void)) => void }
  if (typeof owner.inject === 'function') {
    owner.inject(['sidebarRightTabs', 'sidebarRight'], scope => {
      const tabs = optionalService<TabRegistry>(scope, 'sidebarRightTabs')
      if (!tabs || !optionalService<Rightbar>(scope, 'sidebarRight')) return
      disposeFaces = mountRightPaneFaces(scope, tabs)
      return disposeFaces
    })
    return () => { disposeFaces(); disposeLocale() }
  }
  const tabs = optionalService<TabRegistry>(ctx, 'sidebarRightTabs')
  if (tabs && optionalService<Rightbar>(ctx, 'sidebarRight')) disposeFaces = mountRightPaneFaces(ctx, tabs)
  return () => { disposeFaces(); disposeLocale() }
}