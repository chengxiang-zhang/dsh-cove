/**
 * 记忆面板的工作区 cwd 解析。
 *
 * 记忆页是全局 `main` 主面板，框架不会给它注入会话身份，所以「当前是哪个项目」
 * 要靠 DSH 公布的选择事实源自己推导。0.2 把选择从会话服务搬走了：
 * `sessions.list` 不再带 `current`，持久选择单元格在 `uiWorkspace.selection`，
 * 中栏的绑定由 `uiSession` 公布（公开面 `adapter.current` 优先，私有孪生
 * `current` 作退路），只有项目路径仍然挂在会话列表的行上（`byId[id].cwd`）。
 *
 * 每个来源都是可选的，并且一律经守卫读取：部署形态与 DSH 版本不同，缺服务或
 * 代理层抛错时必须退化成「不知道 cwd」（宿主据此报 `source: 'unknown'`），
 * 绝不能把异常抛进面板渲染。纯逻辑、无 React，可用替身单测。
 */

/** 选择单元格、会话列表与中栏绑定共用的可观察面。 */
export interface ObservableStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 会话列表行里本模块关心的一列。 */
export interface MemorySessionRow {
  cwd?: string
}

/** 会话列表快照：0.2 之前带 `current`（会话 id），0.2 只有 `byId`。 */
export interface MemorySessionListSnapshot {
  /** 0.2 之前的选择事实源；0.2 的快照里没有这个字段。 */
  current?: string
  byId?: Record<string, MemorySessionRow | undefined>
}

/**
 * 中栏绑定/选择单元格的快照。`key` 是渲染器公开面的字段名，
 * `sessionId` 是选择单元格的字段名；两种形状都容忍，避免绑定服务换字段时面板失明。
 */
export interface MemorySessionBinding {
  key?: string
  sessionId?: string
}

/**
 * 面板读取的服务面。每个成员都可选：缺服务是正常形态，不是错误。
 */
export interface MemoryWorkspaceSources {
  /** `ctx.uiWorkspace` —— 0.2 的持久选择单元格。 */
  uiWorkspace?: { selection?: ObservableStore<MemorySessionBinding | undefined> }
  /** `ctx.sessions` —— 会话列表，行上带项目 cwd。 */
  sessions?: { list?: ObservableStore<MemorySessionListSnapshot> }
  /** `ctx.uiSession` —— 中栏绑定。 */
  uiSession?: {
    /** 渲染器公开面（`SlotScopeAdapter.current`），优先。 */
    adapter?: { current?: ObservableStore<MemorySessionBinding | undefined> }
    /** 私有孪生，旧 cohort 的退路。 */
    current?: ObservableStore<MemorySessionBinding | undefined>
  }
}

/** 读一次来源；来源缺失、抛错或形状不对都返回 `undefined`。 */
function read<T>(reader: () => T | undefined): T | undefined {
  try {
    return reader()
  } catch {
    return undefined
  }
}

/** 候选会话 id，按解析顺序排列（选择单元格 → 列表 current → 中栏绑定），空值丢弃。 */
function candidateSessionIds(sources: MemoryWorkspaceSources): string[] {
  const candidates: Array<string | undefined> = [
    read(() => pickId(sources.uiWorkspace?.selection?.getSnapshot())),
    read(() => sources.sessions?.list?.getSnapshot()?.current),
    // 公开面优先：`adapter.current` 是契约面，`uiSession.current` 是喂给它的私有孪生。
    read(() => pickId(sources.uiSession?.adapter?.current?.getSnapshot())),
    read(() => pickId(sources.uiSession?.current?.getSnapshot())),
  ]
  return candidates.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
}

/** 从绑定快照里取会话 id。 */
function pickId(binding: MemorySessionBinding | undefined): string | undefined {
  if (binding === undefined || binding === null || typeof binding !== 'object') return undefined
  const key = typeof binding.key === 'string' ? binding.key : undefined
  if (key !== undefined && key.trim() !== '') return key
  return typeof binding.sessionId === 'string' ? binding.sessionId : undefined
}

/** 订阅用的变化来源，按订阅顺序；形状不对的来源跳过。 */
function changeStores(sources: MemoryWorkspaceSources): Array<ObservableStore<unknown>> {
  const candidates: Array<ObservableStore<unknown> | undefined> = [
    sources.uiWorkspace?.selection as ObservableStore<unknown> | undefined,
    sources.sessions?.list as ObservableStore<unknown> | undefined,
    sources.uiSession?.adapter?.current as ObservableStore<unknown> | undefined,
    sources.uiSession?.current as ObservableStore<unknown> | undefined,
  ]
  return candidates.filter(
    (store): store is ObservableStore<unknown> => store !== undefined && typeof store.subscribe === 'function',
  )
}

/**
 * 解析当前工作区的 cwd。
 *
 * @param sources - 上面的服务面；字段缺失即视为该来源不存在。
 * @returns 第一个能解析出的会话的 `cwd`；一个都解析不出时返回 `''`（宿主据此报
 *   `workspace.source = 'unknown'`，面板据此显示「没有解析到当前工作区」）。
 */
export function resolveMemoryCwd(sources: MemoryWorkspaceSources): string {
  const byId = read(() => sources.sessions?.list?.getSnapshot()?.byId)
  if (byId === undefined || byId === null) return ''
  for (const id of candidateSessionIds(sources)) {
    const cwd = read(() => byId[id]?.cwd)
    if (typeof cwd === 'string' && cwd.trim() !== '') return cwd.trim()
  }
  return ''
}

/** `useSyncExternalStore` 兼容的 cwd 跟踪器。 */
export interface MemoryCwdTracker {
  getSnapshot(): string
  subscribe(listener: () => void): () => void
}

/**
 * 构造 cwd 跟踪器。
 *
 * @param resolveSources - 每次读取与订阅都重新解析服务面：注册时刻服务还没就绪时
 *   不会被冻结成空实现，之后出现的服务仍然能被观察到。
 */
export function createMemoryCwdTracker(resolveSources: () => MemoryWorkspaceSources): MemoryCwdTracker {
  let current = resolveMemoryCwd(resolveSources())
  const listeners = new Set<() => void>()
  const refresh = (): void => {
    const next = resolveMemoryCwd(resolveSources())
    if (next === current) return
    current = next
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      // 面板只在打开时挂载：订阅前重读一次，让 React 订阅后的快照比对能立刻
      // 看到期间发生的选择变化（否则要等下一次选择事件才刷新）。
      current = resolveMemoryCwd(resolveSources())
      const disposers = changeStores(resolveSources()).map((store) => store.subscribe(refresh))
      return () => {
        listeners.delete(listener)
        for (const dispose of disposers) dispose()
      }
    },
  }
}