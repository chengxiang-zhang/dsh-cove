/**
 * The engine interface every model-facing and browser-facing surface talks to.
 *
 * Both consumers need the same six operations but not the same blocking
 * behaviour, so the difference is explicit here rather than hidden in each
 * surface: a tool call waits for its turn (§7 — the result must land in the
 * conversation), while the panel starts a turn and returns at once so it can
 * show the turn running and offer cancellation (§11). Preflight is separated
 * from execution for the same reason: every synchronous error a panel can act
 * on — an unknown session, a missing binary, a bad directory — is reported
 * before the request returns, and only the turn's own outcome arrives later.
 * @module dsh-web-all/core/external-session/gateway
 */
import type { ExternalError } from './errors.ts'
import type {
  ExternalProvider, ExternalSessionList, ExternalSessionOverviewList, ExternalSessionStatus,
  ExternalSessionStopResult, ExternalTurnOutcome, ExternalTurnProgress, ExternalTurnResult,
  ExternalTurnStarted,
} from './types.ts'

/** One turn as a caller asks for it. */
export interface ExternalTurnRequest {
  provider: ExternalProvider
  prompt: string
  /**
   * Session to continue. Absent creates a new session and runs its first turn,
   * which is the one-shot shape the native tools had.
   */
  sessionId?: string
  /** Working directory; defaults to the session's own, then the host's. */
  cwd?: string
  /** Title for a newly created session; ignored on a continuation. */
  title?: string
  /**
   * Exact model id for this turn. Omitted means the CLI's own configured model,
   * which is also what a continuation keeps unless the caller changes it.
   */
  model?: string
  /** Cancels this turn. A panel cancellation aborts the same way. */
  signal?: AbortSignal
}

/**
 * Cordis service name of the mounted engine.
 *
 * The preset-level tool entry resolves it through the context, so the tools are
 * present exactly when a preset declares their row.
 */
export const EXTERNAL_SESSION_SERVICE = 'externalSession'

/** Operations the tool surface and the panel both use. */
export interface ExternalSessionGateway {
  /**
   * Run one turn to completion.
   * @param request - the turn to run.
   * @returns the settled turn's result, or the reason it never started.
   */
  runTurn(request: ExternalTurnRequest): Promise<ExternalTurnResult | ExternalError>

  /**
   * Start one turn without waiting for it.
   *
   * Preflight — session lookup, state, binary resolution and directory — still
   * happens before this resolves, so a caller can report every actionable error
   * synchronously. The returned identity is what a caller polls with: a new
   * session only exists once this resolved, so the id cannot be known earlier.
   * @param request - the turn to start.
   * @returns the started turn, or the reason it did not start.
   */
  startTurn(request: ExternalTurnRequest): Promise<ExternalTurnStarted | ExternalError>

  /**
   * Wait at most `timeoutMs` for the turn on `sessionId` to settle.
   *
   * This is the bounded wait a model-facing call uses instead of blocking for
   * the turn's whole runtime: inside the window the caller gets the settled
   * result, outside it the running turn plus its progress, so the answer can be
   * collected later without having held the conversation open.
   * @param sessionId - session to wait on.
   * @param timeoutMs - how long to wait; 0 returns the current state at once.
   * @returns the settled result, the still-running turn, or a refusal.
   */
  awaitTurn(sessionId: string, timeoutMs: number): Promise<ExternalTurnOutcome | ExternalError>

  /**
   * Live progress of the turn running on `sessionId`, or null when it is quiet.
   * @param sessionId - session to read.
   */
  progressOf(sessionId: string): ExternalTurnProgress | null

  /** Cancel the turn running on `sessionId`, if one is. */
  cancel(sessionId: string): Promise<ExternalError | null>

  /** Close a session; an in-flight turn is cancelled first. */
  close(sessionId: string): Promise<ExternalSessionStopResult | ExternalError>

  /** The panel snapshot, including the turn running right now. */
  listViews(): Promise<ExternalSessionList>

  /** The compact model-facing list, optionally filtered by status. */
  listOverviews(status?: ExternalSessionStatus): Promise<ExternalSessionOverviewList>
}