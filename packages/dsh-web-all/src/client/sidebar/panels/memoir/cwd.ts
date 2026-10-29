/**
 * Project-path tracker for the memoir panel.
 *
 * DSH 0.2 moved session selection out of the sessions service: `sessions.list`
 * no longer carries `current` and `sessions.open` is gone. The durable
 * selection cell now lives on `uiWorkspace.selection` (`dsh.sessions.current`)
 * and the center column's binding is published by `uiSession` — through the
 * public `adapter.current` face first, with the private `current` twin as a
 * fallback — while the project path still rides the sessions list rows
 * (`byId[id].cwd`).
 *
 * The memoir page is a global main panel, so it receives no injected session
 * id; it resolves the project from the selection sources in order and reads the
 * cwd off the sessions list. Sources are resolved lazily on every read so a
 * service provided after registration is picked up instead of frozen into a
 * stub. Pure logic — unit-testable with doubles.
 */

/** Observable face shared by the sessions list and the selection stores. */
export interface ObservableLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface SessionRecordLike {
  cwd?: string
}

export interface SessionListSnapshot {
  /** Pre-0.2 sessions service only; absent from the 0.2 list snapshot. */
  current?: string
  byId: Record<string, SessionRecordLike>
}

/**
 * Service faces the resolver reads. Every member is optional: deployments and
 * DSH versions differ, and a missing source must degrade, never throw.
 */
export interface MemoirProjectSources {
  /** `ctx.sessions` — session list rows carry the project cwd. */
  sessions?: { list?: ObservableLike<SessionListSnapshot> }
  /** `ctx.uiWorkspace` — the durable selection cell (0.2). */
  uiWorkspace?: { selection?: ObservableLike<{ sessionId?: string } | undefined> }
  /** `ctx.uiSession` — the main-view binding the center column renders. */
  uiSession?: {
    /**
     * The renderer-facing adapter: the only *public* face of the main-view
     * binding (`SlotScopeAdapter.current`). Preferred over the private twin.
     */
    adapter?: { current?: ObservableLike<{ key?: string } | undefined> }
    /** The private binding twin; kept as a fallback for older cohorts. */
    current?: ObservableLike<{ key?: string } | undefined>
  }
}

/** Read through a source without letting a hostile/proxied service throw. */
function read<T>(reader: () => T): T | undefined {
  try {
    return reader()
  } catch {
    return undefined
  }
}

/** Selected session ids in resolution order, blanks dropped. */
function candidateSessionIds(sources: MemoirProjectSources): string[] {
  const candidates = [
    read(() => sources.uiWorkspace?.selection?.getSnapshot()?.sessionId),
    read(() => sources.sessions?.list?.getSnapshot().current),
    // Public first: the adapter's binding is the contract face, while
    // `uiSession.current` is the private twin that feeds it.
    read(() => sources.uiSession?.adapter?.current?.getSnapshot()?.key),
    read(() => sources.uiSession?.current?.getSnapshot()?.key),
  ]
  return candidates.filter((id): id is string => typeof id === 'string' && id !== '')
}

/** Available change sources, in subscription order. */
function changeSources(sources: MemoirProjectSources): Array<ObservableLike<unknown>> {
  const candidates: Array<ObservableLike<unknown> | undefined> = [
    sources.uiWorkspace?.selection,
    sources.sessions?.list,
    sources.uiSession?.adapter?.current,
    sources.uiSession?.current,
  ]
  return candidates.filter(
    (source): source is ObservableLike<unknown> => source !== undefined && typeof source.subscribe === 'function',
  )
}

/**
 * Resolve the project path of the session the operator is working in.
 * @param sources - the service faces above.
 * @returns the first selected session's cwd, or '' when nothing resolves.
 */
export function resolveProjectPath(sources: MemoirProjectSources): string {
  const byId = read(() => sources.sessions?.list?.getSnapshot().byId)
  if (byId === undefined) return ''
  for (const id of candidateSessionIds(sources)) {
    const cwd = read(() => byId[id]?.cwd)
    if (typeof cwd === 'string' && cwd !== '') return cwd
  }
  return ''
}

/** A useSyncExternalStore-compatible tracker over the project path. */
export interface CwdTracker {
  getSnapshot(): string
  subscribe(listener: () => void): () => void
}

/**
 * Build a { getSnapshot, subscribe } tracker.
 * @param resolveSources - called on every read and subscription, so services
 *   that appear after the position module mounted are still observed.
 */
export function createCwdTracker(resolveSources: () => MemoirProjectSources): CwdTracker {
  let current = resolveProjectPath(resolveSources())
  const listeners = new Set<() => void>()
  const refresh = (): void => {
    const next = resolveProjectPath(resolveSources())
    if (next === current) return
    current = next
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      // The panel is mounted only while open: re-read before React's
      // post-subscribe snapshot check so a selection made meanwhile shows up.
      current = resolveProjectPath(resolveSources())
      const disposers = changeSources(resolveSources()).map((source) => source.subscribe(refresh))
      return () => {
        listeners.delete(listener)
        for (const dispose of disposers) dispose()
      }
    },
  }
}