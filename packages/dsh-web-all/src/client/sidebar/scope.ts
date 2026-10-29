/** Session-scoped facts used by every native right-sidebar page. */
import { useRef, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'

export interface WorkbenchScope {
  sessionId?: string
  cwd?: string
  root?: string
}

/**
 * 0.2 会话作用域：右栏 tab 由框架通过 inject(sessionId) 注入会话身份
 * （\`sessions.list\` 不再暴露 current），cwd 仍从会话目录读取。
 * 快照必须引用稳定，否则 fused 页面重渲染会撞 React 更新深度上限。
 */
export function useSessionWorkbenchScope(ctx: ClientContext, sessionId?: string): WorkbenchScope {
  const sessions = ctx.get('sessions') as unknown as ISessions
  const cache = useRef<{ key: string; value: WorkbenchScope }>()
  return useSyncExternalStore(
    callback => sessions.list.subscribe(callback),
    () => {
      const view = sessions.list.getSnapshot() as unknown as { byId?: Record<string, { cwd?: string }> }
      const cwd = sessionId === undefined ? undefined : view.byId?.[sessionId]?.cwd
      const key = `${sessionId ?? ''}|${cwd ?? ''}`
      if (cache.current?.key === key) return cache.current.value
      const next: WorkbenchScope = { sessionId, cwd, root: cwd }
      cache.current = { key, value: next }
      return next
    },
  )
}

/** Address one workspace-scoped host route. */
export function workbenchUrl(route: string, scope: WorkbenchScope, path = '', extra?: Record<string, string>): string {
  return `/api/workbench/${route}?${new URLSearchParams({
    root: scope.root ?? scope.cwd ?? '',
    path,
    ...(scope.sessionId ? { session: scope.sessionId } : {}),
    ...extra,
  })}`
}

export function workspaceRelative(scope: WorkbenchScope, path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const cwd = scope.cwd?.replaceAll('\\', '/').replace(/\/+$/u, '')
  return cwd && normalized.startsWith(`${cwd}/`) ? normalized.slice(cwd.length + 1) : normalized.replace(/^\.\//u, '')
}
