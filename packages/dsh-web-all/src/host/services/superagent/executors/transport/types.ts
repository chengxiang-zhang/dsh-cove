/**
 * Executor transport (T19 addendum): the seam between "what to dispatch" and
 * "which host runs it".
 *
 * Two implementations exist today:
 *
 * - `inproc` runs the session in this process through the host's
 *   `sessionController`; it is the historical behaviour and stays the fallback.
 * - `http` drives a web host over its `/api` Remote surface (loopback by default,
 *   a NetBird peer when the target names a machine), so the executor session belongs
 *   to that host: it is visible in its GUI, resumable there, and survives this
 *   process restarting.
 *
 * The interface deliberately speaks raw Session events, because closure and the
 * probes read tool calls, exit codes and turn endings out of them (`./events.ts`).
 */

/** One raw Session event as the host emits it: `{ type, seq, time?, data }`. */
export interface ExecutorEventLike {
  type: string
  seq: number
  time?: number
  data: Record<string, unknown>
}

/** A model route the attempt pinned before the first prompt. */
export interface ExecutorModelRoute {
  provider: string
  model: string
  effort?: string
}

export interface ExecutorCreateRequest {
  /** Attempt-scoped session identity (`sa-x-<commitment>-a<n>`). */
  sessionId: string
  cwd: string
  /** Executor preset; a host that lacks it degrades to `standard` and says so. */
  preset?: string
  model?: ExecutorModelRoute
}

export interface ExecutorCreateResult {
  sessionId: string
  /** The preset the host reports it is actually running. */
  agentPreset?: string
  /** Present when the preferred preset was missing and `standard` was used instead. */
  presetDegraded?: { asked: string; used: string }
}

/** What the ledger needs to know about a session without opening its body. */
export interface ExecutorSnapshot {
  exists: boolean
  /** True while the session's last turn has not ended. */
  running: boolean
  /** Last durable sequence number (the page cursor). */
  cursor: number
  /** Tail events, oldest first (probes read this). */
  events: readonly ExecutorEventLike[]
  /** The working directory the host reports for the session, when it reports one. */
  cwd?: string
}

export interface ExecutorTransport {
  readonly kind: 'inproc' | 'http'
  create(req: ExecutorCreateRequest): Promise<ExecutorCreateResult>
  prompt(req: { sessionId: string; requestId: string; text: string; mode: 'queue' | 'steer' }): Promise<void>
  cancel(sessionId: string): Promise<void>
  snapshot(sessionId: string): Promise<ExecutorSnapshot>
  /**
   * Forward new events for one session into `onEvent`; returns the stop function.
   * `inproc` returns a no-op because the host event bus already forwards them.
   */
  watch(sessionId: string, onEvent: (event: ExecutorEventLike) => void): () => void
  dispose(): void
}