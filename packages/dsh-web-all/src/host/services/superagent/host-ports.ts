/**
 * Host-side port types used by desk and executors. Types only; this file
 * imports nothing.
 *
 * SessionControllerFace mirrors the shape lark-inbox already uses against the
 * sessionController service (F1), with `inspect` made required and returning
 * the session events (F2).
 */

export interface SessionControllerFace {
  create(req: { sessionId?: string; cwd?: string; agentPreset?: string }): Promise<{ sessionId?: unknown }>
  prompt(
    req: {
      requestId: string
      sessionId: string
      mode: 'queue' | 'steer'
      content: readonly { type: 'text'; text: string }[]
    },
    signal: AbortSignal,
  ): Promise<{ accepted?: unknown }>
  cancel(req: { sessionId: string }): unknown
  inspect(sessionId: string): Promise<{ meta?: { cwd?: unknown }; events?: readonly unknown[] }>
}

export interface HostClock {
  now(): number
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(h: unknown): void
}

export interface HostLog {
  info(m: string): void
  warn(m: string): void
  error(m: string): void
}
