/**
 * 位置装配：外援会话的浏览器半边。
 *
 * 本模块自己装配三件事，装配方式逐条对着既有先例抄，没有新布局体系：
 * 1. 右栏页签 —— 与 `sidebar/right-pane.tsx` 同一套：向 `sidebarRightTabs` 注册
 *    一个 `sidebar.right.pane.tab` 槽，页面本体是 `ExternalSessionPanel`；
 * 2. 会话头部子智能体下拉的「外援」分组 —— 与 `conversation/subagent-model-dom.ts`
 *    同一套：官方 UI 渲染下拉，本模块只追加自己的分组，原生计数一个字不动；
 * 3. locale 命名空间 —— 一个能力一个命名空间，zh 是键集来源。
 *
 * 数据面只有一份（`createExternalSessionStore`），面板与下拉分组读同一份快照，
 * 因此「外援 · N」的计数与列表内容不会互相漂移。
 */
import { createElement } from 'react'
import type { ComponentType } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createExternalSessionApi } from './api.ts'
import { createExternalSessionStore, type ExternalSessionStore } from './store.ts'
import { NS, en, interpolate, zh, type ExternalSessionLocaleKey } from './i18n.ts'
import {
  findSubagentTree,
  syncExternalGroup,
  type ExternalGroupText,
} from './dom.ts'
import {
  ExternalSessionTab,
  type ExternalSessionTabInfo,
  type ExternalSessionTranslate,
} from './panel.tsx'
import type { ExternalSessionView } from './types.ts'
import { scopeSessionViews } from '../../core/external-session/views.ts'

/**
 * Snapshot sources the shell exposes for "which conversation is on screen".
 *
 * The same three faces the subagent-model badge reads: the public adapter
 * binding first, then the inner session store, then the workspace selection.
 * Any of them may be absent on a given build, so every read is optional.
 */
interface ConversationFaces {
  uiSession?: {
    adapter?: { current?: { getSnapshot?: () => { key?: string } | undefined } }
    current?: { getSnapshot?: () => { key?: string } | undefined }
  }
  uiWorkspace?: { selection?: { getSnapshot?: () => { sessionId?: string } | undefined } }
}

/** Read a face without letting a proxied or hostile one throw. */
function readFace<T>(reader: () => T): T | undefined {
  try { return reader() } catch { return undefined }
}

/** The conversation currently on screen, or undefined when no shell face answers. */
function currentConversation(ctx: ClientContext): string | undefined {
  const faces = (() => {
    try { return (ctx.get as unknown as (id: string, strict?: boolean) => unknown)('uiSession', false) } catch { return undefined }
  })() as ConversationFaces['uiSession'] | undefined
  const workspace = (() => {
    try { return (ctx.get as unknown as (id: string, strict?: boolean) => unknown)('uiWorkspace', false) } catch { return undefined }
  })() as ConversationFaces['uiWorkspace'] | undefined
  const candidates = [
    readFace(() => faces?.adapter?.current?.getSnapshot?.()?.key),
    readFace(() => faces?.current?.getSnapshot?.()?.key),
    readFace(() => workspace?.selection?.getSnapshot?.()?.sessionId),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/** 右栏页签的 kind（官方页签注册用的稳定 id）。 */
export const EXTERNAL_SESSION_TAB_KIND = 'web-ui.external-session'

/** 页签在注册表里的 key。 */
const TAB_KEY = 'dsh-web-all/external-session'


/** 下拉分组的同步防抖：官方弹层是批量挂载的，一帧内只同步一次。 */
const GROUP_SYNC_DEBOUNCE_MS = 60

/** 弹层展开且存在运行中的会话时的刷新间隔（宿主 continue 立刻返回，运行态靠轮询收敛）。 */
const GROUP_RUNNING_POLL_MS = 2_000

/** 弹层开着但没有会话在跑时的刷新节拍：够看到新派发与刚失败的会话。 */
const GROUP_IDLE_POLL_MS = 5_000

/** 官方右栏页签定义（本模块只用到这几个字段）。 */
interface NativeTabDefinition {
  id: string
  kind: string
  title: () => string
  guide?: readonly {
    id: string
    order: number
    title: () => string
    description?: () => string
    icon?: ComponentType<{ size?: number; className?: string }>
  }[]
}

interface TabRegistry {
  register(definition: NativeTabDefinition): () => void
}

interface Rightbar {
  openTab(kind: string, options?: { params?: Record<string, unknown> }): void
}

/** 只读地拿一个可选服务，缺了不影响装配。 */
function optionalService<T>(ctx: ClientContext, name: string): T | undefined {
  try {
    return (ctx.get as unknown as (id: string, strict?: boolean) => unknown)(name, false) as T | undefined
  } catch {
    return undefined
  }
}

/** 绑定本能力的 locale 命名空间；未注册时退回 zh，绝不显示裸键。 */
function bindTranslate(ctx: ClientContext): ExternalSessionTranslate {
  const bind = ctx.locale.bind(NS)
  return (key, params) => {
    const text = bind(key) ?? zh[key] ?? en[key] ?? key
    return params === undefined ? text : interpolate(text, params)
  }
}

/** 下拉分组要的三句话（自有计数在这里成形）。 */
/** 秒级耗时压成 12s / 3m / 2h，行内只放得下这么长。 */
function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

/**
 * 一行现在处于什么状态。
 *
 * 空闲行返回空串：一个列表里全是「就绪」等于没说。还在跑、失败、已关闭、或刚
 * 返回部分结果的行才需要一句话，这也正是用户判断「是不是卡住了」的依据。
 */
function stateOf(session: ExternalSessionView, t: ExternalSessionTranslate): string {
  const live = [...(session.turns ?? [])].reverse().find(turn => turn.status === 'running')
  if (live !== undefined) {
    const progress = live.progress
    const elapsed = progress === undefined ? '0s' : shortDuration(progress.elapsed_ms)
    if (progress !== undefined && progress.idle_ms >= 5_000) {
      return t('group.state.runningIdle', { elapsed, idle: shortDuration(progress.idle_ms) })
    }
    return t('group.state.running', { elapsed })
  }
  const last = session.turns?.[session.turns.length - 1]
  if (session.status === 'closed') return t('group.state.closed')
  if (session.status === 'failed') return t('group.state.failed')
  if (last?.partial === true) return t('group.state.partial')
  return ''
}

function groupText(t: ExternalSessionTranslate, count: number): ExternalGroupText {
  return {
    title: t('group.title', { count }),
    tag: t('group.tag'),
    openAria: (title: string) => t('group.openAria', { title }),
    stateOf: (session: ExternalSessionView) => stateOf(session, t),
  }
}

interface FaceDeps {
  readonly api: ReturnType<typeof createExternalSessionApi>
  readonly store: ExternalSessionStore
  readonly t: ExternalSessionTranslate
  readonly openSession: (sessionId: string) => void
}

/**
 * 向官方的右栏页签注册表登记本能力的页签，**不进右栏的启动菜单**。
 *
 * 右栏那排入口（工作区文件 / 终端 / Git）是各页签注册时 `guide`
 * 数组的展开；外援会话是按会话产生的从属视图，不是一件常驻工具，放在那里只会
 * 占一格并与原生工具混在一起。不登记 `guide` 之后：`openTab` 仍能打开它（从
 * 会话头部的下发条目点进来），但它不出现在启动菜单里。
 */
function registerTab(scope: ClientContext, tabs: TabRegistry, deps: FaceDeps): () => void {
  const title = (): string => deps.t('tab.title')
  const disposeRegister = tabs.register({
    id: TAB_KEY,
    kind: EXTERNAL_SESSION_TAB_KIND,
    title,
  })
  // keyed 槽：key 用类型 id，inject(sessionId) 由框架按会话作用域给出。
  const disposeSlot = scope.slots.inject('sidebar.right.pane.tab' as never, () => scope.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_KEY, locale: NS, inject: (sessionId: string) => ({ sessionId }) } as never,
    ((props: { useTabInfo?: () => ExternalSessionTabInfo; sessionId?: string }) => createElement(ExternalSessionTab, {
      conversationId: props.sessionId,
      api: deps.api,
      store: deps.store,
      t: deps.t,
      ...(props.useTabInfo === undefined ? {} : { useTabInfo: props.useTabInfo }),
    })) as never,
  ))
  return () => {
    try { disposeSlot() } catch { /* 槽已随框架卸载 */ }
    try { disposeRegister() } catch { /* 注册表已随框架卸载 */ }
  }
}

/** 下拉分组的 DOM 增强；官方弹层出现时才动，消失时什么都不留。 */
function mountDropdownGroup(deps: FaceDeps, conversationOf: () => string | undefined): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let pollCadence = 0
  let disposed = false

  /**
   * 弹层在就刷新，弹层关掉就停。
   *
   * 只在「有会话在跑」时轮询，会让刚派发完或刚失败的列表停在旧快照上：用户看到
   * 的永远是打开时那几行。空闲用一个更慢的节拍，仍在跑用快节拍。
   */
  const keepPolling = (present: boolean, running: boolean): void => {
    const cadence = running ? GROUP_RUNNING_POLL_MS : GROUP_IDLE_POLL_MS
    if (!present) {
      if (poll !== undefined) {
        clearInterval(poll)
        poll = undefined
        pollCadence = 0
      }
      return
    }
    if (poll !== undefined && pollCadence === cadence) return
    if (poll !== undefined) clearInterval(poll)
    pollCadence = cadence
    poll = setInterval(() => { void deps.store.refresh() }, cadence)
  }

  const sync = (): void => {
    if (disposed) return
    try {
      const tree = findSubagentTree(document.body)
      const snapshot = deps.store.getSnapshot()
      keepPolling(tree !== undefined, snapshot.sessions.some(item => item.status === 'running'))
      if (tree === undefined) return
      // 弹层是「用到才出现」的：第一次看见它就先补一次数据，避免显示上一次的旧计数。
      if (snapshot.state === 'idle') void deps.store.refresh()
      // 下拉属于当前会话：别的会话派出去的外援不出现在这里，否则每个会话看起来
      // 都挂着同一份全局清单。
      const scoped = scopeSessionViews(snapshot.sessions, conversationOf())
      syncExternalGroup(document.body, scoped, groupText(deps.t, scoped.length), deps.openSession)
    } catch {
      // 下拉分组是渐进增强：任何异常都不许影响官方下拉本身。
    }
  }

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      sync()
    }, GROUP_SYNC_DEBOUNCE_MS)
  }

  const observer = new MutationObserver(schedule)
  try {
    observer.observe(document.body, { childList: true, subtree: true })
  } catch {
    return () => {}
  }
  const unsubscribe = deps.store.subscribe(sync)
  return () => {
    disposed = true
    observer.disconnect()
    unsubscribe()
    if (timer !== undefined) clearTimeout(timer)
    if (poll !== undefined) clearInterval(poll)
  }
}

/**
 * 装配外援会话的浏览器半边。
 *
 * 现在由 sidebar 位置模块调用（位置模块是右栏槽位的唯一注入者），所以这里
 * **必须自己不抛错**：否则一次异常会连带拖垮侧栏位置模块里的原生面板与右栏。
 * 失败时留一行可诊断日志并返回空卸载函数。
 *
 * @param ctx - client root context。
 * @returns 卸载函数（位置模块统一收集）。
 */
export function mountExternalSession(ctx: ClientContext): () => void {
  try {
    return assemble(ctx)
  } catch (error) {
    console.error('[web-all] external session mount threw:', error)
    return () => {}
  }
}

/** 实际装配；异常由 {@link mountExternalSession} 兜住。 */
function assemble(ctx: ClientContext): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(ctx.locale.register(NS, { zh, en }))
  } catch {
    // 重复注册同一个命名空间不该让整块客户端起不来。
  }
  const t = bindTranslate(ctx)
  const api = createExternalSessionApi()
  const store = createExternalSessionStore(api)
  // 点开下拉条目 = 在右栏打开本能力的页签并带上会话号。官方的 openTab 要求
  // 「当前会话的右栏面板已挂载」，否则抛错；下拉是渐进增强，抛错就当没点。
  const openSession = (sessionId: string): void => {
    try {
      optionalService<Rightbar>(ctx, 'sidebarRight')?.openTab(EXTERNAL_SESSION_TAB_KIND, { params: { sessionId } })
    } catch {
      // 右栏未挂载（例如极窄视口）：条目仍在，点开无效而不是报错。
    }
  }
  const deps: FaceDeps = { api, store, t, openSession }

  let disposeTab = (): void => {}
  const owner = ctx as unknown as {
    inject?: (services: string[], setup: (scope: ClientContext) => void | (() => void)) => void
  }
  if (typeof owner.inject === 'function') {
    owner.inject(['sidebarRightTabs', 'sidebarRight'], scope => {
      const tabs = optionalService<TabRegistry>(scope, 'sidebarRightTabs')
      if (tabs === undefined || optionalService<Rightbar>(scope, 'sidebarRight') === undefined) return
      disposeTab = registerTab(scope, tabs, deps)
      return disposeTab
    })
  } else {
    const tabs = optionalService<TabRegistry>(ctx, 'sidebarRightTabs')
    if (tabs !== undefined && optionalService<Rightbar>(ctx, 'sidebarRight') !== undefined) {
      disposeTab = registerTab(ctx, tabs, deps)
    }
  }
  disposers.push(() => { disposeTab() })
  disposers.push(mountDropdownGroup(deps, () => currentConversation(ctx)))

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* 卸载顺序不该互相拖垮 */ }
    }
  }
}

/** 供测试与外部读的键集类型出口。 */
export type { ExternalSessionLocaleKey }