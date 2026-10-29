/**
 * The memoir page resolves its project from live DSH selection facts.
 *
 * Regression: DSH 0.2 removed `current` from `sessions.list` and moved the
 * selection to `uiWorkspace.selection`; the panel used to read only
 * `sessions.list.current`, so it always rendered "未打开项目会话" and never
 * loaded the project's memory. The tracker must also survive a service that is
 * provided after the position module mounted (it used to freeze an empty stub).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createCwdTracker,
  resolveProjectPath,
  type MemoirProjectSources,
  type ObservableLike,
} from '../src/client/sidebar/panels/memoir/cwd.ts'

const REPO = '/Users/tester/code/dsh-cove'

/** A minimal observable store double. */
function store<T>(initial: T): ObservableLike<T> & { set(value: T): void } {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function sources(overrides: {
  rows?: Record<string, { cwd?: string }>
  current?: string
  selectionId?: string
  /** The public `uiSession.adapter.current` binding. */
  adapterKey?: string
  /** The private `uiSession.current` twin. */
  mainKey?: string
} = {}): MemoirProjectSources {
  return {
    sessions: {
      list: store({
        ...(overrides.current === undefined ? {} : { current: overrides.current }),
        byId: overrides.rows ?? {},
      }),
    },
    uiWorkspace: { selection: store(overrides.selectionId === undefined ? {} : { sessionId: overrides.selectionId }) },
    uiSession: {
      adapter: { current: store(overrides.adapterKey === undefined ? undefined : { key: overrides.adapterKey }) },
      current: store(overrides.mainKey === undefined ? undefined : { key: overrides.mainKey }),
    },
  }
}

describe('memoir project resolution', () => {
  it('resolves the 0.2 workspace selection against the session list rows', () => {
    const path = resolveProjectPath(sources({
      rows: { 'session-a': { cwd: REPO } },
      selectionId: 'session-a',
    }))
    expect(path).toBe(REPO)
  })

  it('falls back to a legacy sessions list current and to the main-view binding', () => {
    const legacy = resolveProjectPath(sources({
      rows: { 'session-b': { cwd: '/legacy' } },
      current: 'session-b',
    }))
    expect(legacy).toBe('/legacy')

    // Public renderer adapter: the contract face of the main-view binding.
    const adapter = resolveProjectPath(sources({
      rows: { 'session-c': { cwd: '/main' } },
      adapterKey: 'session-c',
    }))
    expect(adapter).toBe('/main')

    // Private twin still resolves when the adapter is absent (older cohorts).
    const privateTwin = resolveProjectPath(sources({
      rows: { 'session-d': { cwd: '/private' } },
      mainKey: 'session-d',
    }))
    expect(privateTwin).toBe('/private')
  })

  it('prefers the public adapter over the private binding twin', () => {
    const path = resolveProjectPath(sources({
      rows: { 'session-public': { cwd: '/public' }, 'session-private': { cwd: '/private' } },
      adapterKey: 'session-public',
      mainKey: 'session-private',
    }))
    expect(path).toBe('/public')
  })

  it('prefers the selection, then skips selected rows without a cwd', () => {
    const path = resolveProjectPath(sources({
      rows: { 'session-new': {}, 'session-old': { cwd: REPO } },
      selectionId: 'session-new',
      current: 'session-old',
      mainKey: 'session-old',
    }))
    expect(path).toBe(REPO)
  })

  it('returns an empty path when nothing resolves', () => {
    expect(resolveProjectPath({})).toBe('')
    expect(resolveProjectPath(sources({ rows: { 'session-a': { cwd: REPO } } }))).toBe('')
    expect(resolveProjectPath(sources({ rows: {}, selectionId: 'missing' }))).toBe('')
  })

  it('degrades instead of throwing on a hostile or malformed service face', () => {
    const hostile = {
      sessions: { list: { getSnapshot: () => { throw new Error('inactive context') }, subscribe: () => () => {} } },
      uiWorkspace: { selection: { getSnapshot: () => ({ sessionId: 'session-a' }), subscribe: () => () => {} } },
    } as unknown as MemoirProjectSources
    expect(resolveProjectPath(hostile)).toBe('')

    const malformed = { sessions: { list: store({ byId: {} }) }, uiSession: { current: { getSnapshot: () => ({ key: 42 }) } } } as unknown as MemoirProjectSources
    expect(resolveProjectPath(malformed)).toBe('')
  })
})

describe('memoir cwd tracker', () => {
  it('follows the workspace selection while subscribed', () => {
    const rows = store<Record<string, { cwd?: string }>>({ 'session-a': { cwd: REPO } })
    const selection = store<{ sessionId?: string } | undefined>({ sessionId: 'session-a' })
    const tracker = createCwdTracker(() => ({
      sessions: { list: store({ byId: rows.getSnapshot() }) },
      uiWorkspace: { selection },
    }))
    const listener = vi.fn()
    const dispose = tracker.subscribe(listener)
    expect(tracker.getSnapshot()).toBe(REPO)

    selection.set({ sessionId: 'session-b' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(tracker.getSnapshot()).toBe('')

    dispose()
    selection.set({ sessionId: 'session-a' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('picks up sources provided after the tracker was created', () => {
    let available: MemoirProjectSources = {}
    const tracker = createCwdTracker(() => available)
    expect(tracker.getSnapshot()).toBe('')

    const selection = store<{ sessionId?: string } | undefined>({ sessionId: 'session-a' })
    available = {
      sessions: { list: store({ byId: { 'session-a': { cwd: REPO } } }) },
      uiWorkspace: { selection },
    }
    const listener = vi.fn()
    tracker.subscribe(listener)
    // The panel mounts only while open: the subscription re-reads before
    // React's post-subscribe snapshot check.
    expect(tracker.getSnapshot()).toBe(REPO)

    selection.set({ sessionId: 'session-z' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(tracker.getSnapshot()).toBe('')
  })

  it('tolerates a deployment without any selection service', () => {
    const tracker = createCwdTracker(() => ({}))
    expect(tracker.getSnapshot()).toBe('')
    expect(() => tracker.subscribe(() => {})()).not.toThrow()
  })
})