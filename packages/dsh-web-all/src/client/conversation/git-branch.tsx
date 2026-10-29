/** Git branch surface adapter owned by the conversation position module. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

// Locale registration remains inside the conversation position owner while
// preserving the legacy git-graph dictionary contract.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'web-all-git-graph': GitGraphKey
  }
}
import type { GitError, SwitchResult } from '../../core/git-graph/protocol.ts'
import { GitApi, subscribeChanges } from './git-graph/api.ts'
import { BranchChip, type GitGraphInjected } from './git-graph/branch-chip.tsx'
import { en, zh, type GitGraphKey } from './git-graph/locales.ts'
import { WorktreeApi } from './worktree/api.ts'
import { createLaneBinder } from './worktree/lane-binding.ts'
import { openLaneForBranch, type LaneOpenNavigation } from './worktree/lane-open.ts'

const NO_WORKSPACE: GitError = { code: 'workspace-unknown', message: 'session has no workspace' }

interface SessionSnapshot {
  byId?: Record<string, { cwd?: string }>
  ids?: string[]
}

/** Take an optional client service; a missing or throwing lookup yields undefined. */
function optionalService<T>(ctx: ClientContext, name: string): T | undefined {
  try {
    return (ctx.get as unknown as (id: string, strict?: boolean) => unknown)(name, false) as T | undefined
  } catch {
    return undefined
  }
}

function createFace(ctx: ClientContext) {
  const translate = ctx.locale.bind('web-all-git-graph')
  const api = new GitApi()
  const worktrees = new WorktreeApi()
  const sessions = ctx.get('sessions') as unknown as ISessions
  // 0.2 的 sessions.list 不再有 current：会话身份一律由 dock 槽的 inject(sessionId)
  // 注入（见 selector-context.tsx），这里只按传入的 sessionId 取 cwd。
  const snapshot = (): SessionSnapshot => sessions.list.getSnapshot() as unknown as SessionSnapshot
  const cwd = (sessionId?: string): string | undefined => {
    return sessionId === undefined ? undefined : snapshot().byId?.[sessionId]?.cwd
  }
  const path = (sessionId?: string): { ok: true; value: string } | { ok: false; error: GitError } => {
    const value = cwd(sessionId)
    return value ? { ok: true, value } : { ok: false, error: NO_WORKSPACE }
  }

  /**
   * Branch selection IS worktree creation.
   *
   * Picking an existing local branch attaches it, naming a new one cuts it:
   * either way the branch gets its own directory, registered as a DSH workspace
   * (which the platform requires: a session is only accounted to a workspace
   * while its cwd equals that workspace's path, and a blank conversation no
   * workspace accounts for renders its composer inert), and this conversation is
   * moved onto it through the platform's own workspace navigation
   * (`uiWorkspace.openWorkspace` — the call behind the shell's workspace picker,
   * resolved per attempt instead of frozen at registration).
   *
   * The chip's dock seat carries `{ session, input }` only, so no seat prop can
   * do the moving: reading a workspace switch from one was a silent no-op that
   * left every branch choice in the old checkout.
   *
   * When the shell provides no navigation service the lane is still created and
   * reported as ready, and the user picks it in the workspace selector; nothing
   * is bound in that case, because a conversation that still runs in the old
   * checkout must not be recorded as the lane's own.
   */
  const laneForBranch = async (
    sessionId: string | undefined,
    branch: string,
    base?: string,
  ): Promise<SwitchResult> => {
    const resolved = path(sessionId)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const result = await openLaneForBranch({
      createLane: (input) => worktrees.createLane(input),
      bindLane: (input) => worktrees.bindLane(input),
      navigation: optionalService<LaneOpenNavigation>(ctx, 'uiWorkspace'),
      listSessions: () => snapshot(),
    }, {
      sessionId,
      repoPath: resolved.value,
      branch,
      ...(base === undefined ? {} : { base }),
    })
    return result.ok
      ? result
      : { ok: false, error: { code: 'internal', message: result.message } }
  }

  /**
   * Lane binding runs off the same read the chip already performs. The composer
   * chip is the only surface that exists while a conversation is still blank —
   * which is exactly when a conversation has just landed on a lane (this picker
   * moved it, the user picked the lane in the workspace selector, or a selection
   * was restored) — and the header chip cannot see it yet. Binding is idempotent
   * and attempted once per session, so this stays a cheap, best-effort side
   * effect of a status read rather than a second source of truth.
   */
  const binder = createLaneBinder({ lane: (input) => worktrees.lane(input), bindLane: (input) => worktrees.bindLane(input) })
  const injected: GitGraphInjected = {
    repoStatus: async (sessionId) => {
      const resolved = path(sessionId)
      if (!resolved.ok) return null
      void binder.bind(sessionId)
      const result = await api.status(resolved.value)
      return result.ok ? result.value : null
    },
    branches: async (sessionId) => {
      const resolved = path(sessionId)
      if (!resolved.ok) return null
      const result = await api.branches(resolved.value)
      return result.ok ? result.value : null
    },
    switchBranch: (sessionId, branch) => laneForBranch(sessionId, branch),
    createBranch: (sessionId, branch) => laneForBranch(sessionId, branch),
    graph: async (sessionId, limit) => {
      const resolved = path(sessionId)
      if (!resolved.ok) return null
      const result = await api.graph(resolved.value, limit)
      return result.ok ? result.value : null
    },
    subscribeChanges: (sessionId, onChange) => {
      const resolved = path(sessionId)
      return resolved.ok ? subscribeChanges(resolved.value, onChange) : () => {}
    },
  }
  const t: import('@deepseek-ai/dsh-client-ui-slots').Translate<GitGraphKey> =
    (key, params?: Record<string, unknown>): string => translate(key, params)
  return function GitBranchFace(props: PropsRuntime<'conversation.input.dock'>) {
    return (
      <BranchChip
        {...props}
        {...injected}
        t={t}
      />
    )
  }
}

export function createGitBranchFace(ctx: ClientContext) {
  return createFace(ctx)
}

export { en as gitGraphEn, zh as gitGraphZh }
export type { GitGraphKey }
