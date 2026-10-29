/**
 * Per-session browser registry.
 *
 * Lazily creates one {@link SessionBrowser} per conversation and keeps the
 * mapping stable while the session stays active: a session's first playwright
 * tool call spawns its browser, every later call reuses it, and no other
 * session can ever see it. Failure to create a handle removes the entry so the
 * next call retries instead of wedging the session.
 *
 * Lifecycle guards (both optional via config):
 * - idle TTL — unused browsers are disposed after `idleTimeoutMs`
 * - concurrency cap — creating a new browser may dispose the least-recently
 *   used idle browser so at most `maxConcurrentBrowsers` stay alive
 */

import type { SessionBrowser } from './child.ts'

export type SessionBrowserFactory = (sessionId: string) => Promise<SessionBrowser>

export interface SessionBrowserManagerOptions {
  /**
   * Dispose a browser after this many milliseconds with no get/call.
   * `0` disables idle eviction. Default is set by the plugin apply site.
   */
  idleTimeoutMs: number
  /**
   * Soft cap on live browsers. Creating one more may dispose the LRU idle
   * entry. `0` disables the cap.
   */
  maxConcurrentBrowsers: number
  /** Optional clock for tests. */
  now?: () => number
  /** Optional timer hooks for tests. */
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  /**
   * Called after a session browser process is disposed (idle TTL, concurrency
   * eviction, browser_close, or disposeAll). Used for disk profile GC.
   */
  onDispose?: (sessionId: string) => void | Promise<void>
}

interface Entry {
  browser: Promise<SessionBrowser>
  lastUsedAt: number
  idleTimer?: ReturnType<typeof setTimeout>
  /** In-flight tool-call count; idle eviction skips busy entries. */
  busy: number
}

export class SessionBrowserManager {
  private readonly sessions = new Map<string, Entry>()
  private readonly now: () => number
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void

  constructor(
    private readonly factory: SessionBrowserFactory,
    private readonly options: SessionBrowserManagerOptions,
  ) {
    this.now = options.now ?? Date.now
    this.setTimeoutFn = options.setTimeout ?? setTimeout
    this.clearTimeoutFn = options.clearTimeout ?? clearTimeout
  }

  /** Resolve the browser for one session, creating it on first use. */
  async get(sessionId: string): Promise<SessionBrowser> {
    let entry = this.sessions.get(sessionId)
    if (entry === undefined) {
      await this.ensureCapacity(sessionId)
      const browser = this.factory(sessionId).catch((error: unknown) => {
        this.sessions.delete(sessionId)
        throw error
      })
      entry = { browser, lastUsedAt: this.now(), busy: 0 }
      this.sessions.set(sessionId, entry)
      this.armIdleTimer(sessionId, entry)
    } else {
      this.touch(sessionId)
    }
    return this.wrap(sessionId, await entry.browser)
  }

  /** Number of sessions that have (or are creating) a browser. */
  get size(): number {
    return this.sessions.size
  }

  /** Every session id currently tracked. */
  ids(): string[] {
    return [...this.sessions.keys()]
  }

  /** Whether a session currently owns (or is creating) a browser connection. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * The host-owned persistent context of a session browser, when one exists
   * AND was created in liveView mode (dual-owner). Never creates a browser:
   * the live-view upgrade must not spawn a browser just because a client
   * opened the view.
   */
  contextOf(sessionId: string): Promise<SessionBrowser['context']> {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return Promise.resolve(null)
    return entry.browser.then(browser => browser.context ?? null, () => null)
  }

  /** Dispose one session browser and drop it from the registry. */
  async dispose(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return
    this.clearIdleTimer(entry)
    this.sessions.delete(sessionId)
    try {
      await (await entry.browser).dispose()
    } catch {
      // A failed creation leaves no browser to dispose.
    }
    try {
      await this.options.onDispose?.(sessionId)
    } catch {
      // Disk GC failures must not block browser lifecycle.
    }
  }

  /** Close and dispose every session browser; the registry empties. */
  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    await Promise.allSettled(ids.map((id) => this.dispose(id)))
  }

  /**
   * Wrap call so each use refreshes the idle timer and marks the entry busy
   * (idle eviction will not steal a browser mid-call).
   */
  private wrap(sessionId: string, browser: SessionBrowser): SessionBrowser {
    return {
      sessionId: browser.sessionId,
      profileDir: browser.profileDir,
      outputDir: browser.outputDir,
      call: async (rawName, args, signal) => {
        this.beginUse(sessionId)
        try {
          return await browser.call(rawName, args, signal)
        } finally {
          this.endUse(sessionId)
        }
      },
      close: () => browser.close(),
      dispose: () => browser.dispose(),
    }
  }

  private beginUse(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return
    entry.busy += 1
    this.touch(sessionId)
  }

  private endUse(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return
    entry.busy = Math.max(0, entry.busy - 1)
    this.touch(sessionId)
  }

  private touch(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return
    entry.lastUsedAt = this.now()
    this.armIdleTimer(sessionId, entry)
  }

  private armIdleTimer(sessionId: string, entry: Entry): void {
    this.clearIdleTimer(entry)
    const idleTimeoutMs = this.options.idleTimeoutMs
    if (idleTimeoutMs <= 0) return
    entry.idleTimer = this.setTimeoutFn(() => {
      void this.disposeIdle(sessionId)
    }, idleTimeoutMs)
  }

  private clearIdleTimer(entry: Entry): void {
    if (entry.idleTimer === undefined) return
    this.clearTimeoutFn(entry.idleTimer)
    entry.idleTimer = undefined
  }

  /** Idle timer fired: dispose only if still idle and not busy. */
  private async disposeIdle(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return
    if (entry.busy > 0) {
      this.armIdleTimer(sessionId, entry)
      return
    }
    const idleTimeoutMs = this.options.idleTimeoutMs
    if (idleTimeoutMs > 0 && this.now() - entry.lastUsedAt < idleTimeoutMs) {
      this.armIdleTimer(sessionId, entry)
      return
    }
    await this.dispose(sessionId)
  }

  /**
   * Before creating `incomingId`, dispose LRU idle browsers until under the
   * concurrency cap. Busy browsers are skipped; if every other browser is
   * busy and the cap is still reached, the absolute LRU (including busy) is
   * force-disposed so a new session can start.
   */
  private async ensureCapacity(incomingId: string): Promise<void> {
    const max = this.options.maxConcurrentBrowsers
    if (max <= 0) return
    while (this.sessions.size >= max) {
      const victim = this.pickEvictionVictim(incomingId, /*preferIdle*/ true)
        ?? this.pickEvictionVictim(incomingId, /*preferIdle*/ false)
      if (victim === undefined) return
      await this.dispose(victim)
    }
  }

  private pickEvictionVictim(incomingId: string, preferIdle: boolean): string | undefined {
    let bestId: string | undefined
    let bestUsed = Number.POSITIVE_INFINITY
    for (const [id, entry] of this.sessions) {
      if (id === incomingId) continue
      if (preferIdle && entry.busy > 0) continue
      if (entry.lastUsedAt < bestUsed) {
        bestUsed = entry.lastUsedAt
        bestId = id
      }
    }
    return bestId
  }
}
