/**
 * Record, view and status vocabulary for external CLI sessions.
 *
 * One external session mirrors one CLI conversation. The DSH-side record keeps
 * the stable `id` the tools and the panel use, while `providerSessionId` is the
 * CLI's own conversation number: a further turn carrying it is a continuation
 * of the same CLI conversation rather than a re-dispatch. These records are
 * this plugin's own JSON — nothing here registers a subagent provider or writes
 * a kernel event type, so the agent-visible surface stays a plain tool card.
 *
 * The shapes below mirror the design record field for field. They are shared by
 * the host service, the tool surface and the panel so the three cannot drift.
 * @module dsh-web-all/core/external-session/types
 */

/** External CLI this session drives. */
export type ExternalProvider = 'claude' | 'codex'

/** Every provider this capability knows, in panel order. */
export const EXTERNAL_PROVIDERS: readonly ExternalProvider[] = ['claude', 'codex']

/** Human-facing provider names used in tool names and messages. */
export const EXTERNAL_PROVIDER_LABELS: Readonly<Record<ExternalProvider, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
}

/** Session status. `closed` is terminal and never accepts another turn. */
export type ExternalSessionStatus = 'running' | 'idle' | 'failed' | 'closed'

/** Every session status, in the order the panel shows them. */
export const EXTERNAL_SESSION_STATUSES: readonly ExternalSessionStatus[] = ['running', 'idle', 'failed', 'closed']

/** Outcome of one turn: a clean finish, a CLI failure, or a cancellation. */
export type ExternalTurnStatus = 'completed' | 'failed' | 'aborted'

/** Every turn status. */
export const EXTERNAL_TURN_STATUSES: readonly ExternalTurnStatus[] = ['completed', 'failed', 'aborted']

/** Token usage reported by the CLI for one turn. */
export interface ExternalUsage {
  input: number
  output: number
}

/** One turn: one child process from start to exit. */
export interface ExternalTurnRecord {
  /** 1-based turn number inside this session. */
  n: number
  /** The prompt as submitted, kept as the panel's input summary. */
  prompt: string
  status: ExternalTurnStatus
  /** ISO-8601 instant the process started. */
  startedAt: string
  durationMs: number
  usage?: ExternalUsage
  /** The CLI's own price-table estimate. Never a bill. */
  costUsd?: number
  /** Final text of the turn; a diagnostic summary when the turn failed. */
  result: string
}

/** One external session as persisted. */
export interface ExternalSessionRecord {
  /** Stable id used by both the calling model and the panel. */
  id: string
  provider: ExternalProvider
  /** CLI conversation id; absent means the session cannot take another turn. */
  providerSessionId?: string
  /** Absolute working directory of the CLI process. */
  cwd: string
  title: string
  status: ExternalSessionStatus
  /** ISO-8601 instant the session was created. */
  createdAt: string
  /** ISO-8601 instant of the last turn that settled. */
  lastTurnAt: string
  turns: ExternalTurnRecord[]
}

/** The whole persisted file. `version` is the breaking-change gate. */
export interface ExternalStoreFile {
  version: typeof EXTERNAL_STORE_VERSION
  sessions: ExternalSessionRecord[]
}

/** Current file format version. */
export const EXTERNAL_STORE_VERSION = 1

/** Status of a turn as any view shows it: the persisted statuses plus the live one. */
export type ExternalTurnViewStatus = 'running' | ExternalTurnStatus

/** A turn that is running right now and therefore not yet a record. */
export interface ExternalLiveTurn {
  n: number
  prompt: string
  startedAt: string
}

/**
 * One turn as the panel timeline shows it. A settled turn carries its result
 * and duration; the running turn carries only what is known while the child
 * process is alive.
 */
export interface ExternalTurnView {
  n: number
  prompt: string
  status: ExternalTurnViewStatus
  startedAt?: string
  durationMs?: number
  usage?: ExternalUsage
  costUsd?: number
  result?: string
}

/**
 * One session as the panel shows it: the stored record plus the two facts a
 * record cannot answer, the live turn and whether a follow-up is possible.
 */
export interface ExternalSessionView {
  id: string
  provider: ExternalProvider
  title: string
  status: ExternalSessionStatus
  cwd: string
  createdAt: string
  lastTurnAt: string
  /** Whether `external_session_continue` may be used on this session. */
  canContinue: boolean
  turns: ExternalTurnView[]
}

/** The panel list payload: one snapshot, refreshed whole after every action. */
export interface ExternalSessionList {
  sessions: ExternalSessionView[]
}

/** The part of a settled turn the compact overview keeps. */
export interface ExternalTurnDigest {
  n: number
  status: ExternalTurnStatus
  durationMs: number
  usage: ExternalUsage | null
  costUsd: number | null
}

/**
 * One session as the model-facing list tool reports it. Deliberately compact:
 * the model needs the state and the last outcome, not every prompt it ran.
 */
export interface ExternalSessionOverview {
  id: string
  provider: ExternalProvider
  title: string
  status: ExternalSessionStatus
  cwd: string
  createdAt: string
  lastTurnAt: string
  canContinue: boolean
  turnCount: number
  lastTurn: ExternalTurnDigest | null
}

/** The model-facing session list payload. */
export interface ExternalSessionOverviewList {
  sessions: ExternalSessionOverview[]
}

/** Result of one successful turn, exactly as the tool returns it. */
export interface ExternalTurnResult {
  session_id: string
  turn: number
  status: ExternalTurnStatus
  result: string
  /** Null when the CLI reported no usage for this turn. */
  usage: ExternalUsage | null
  /** The CLI's own estimate; null when unavailable. */
  cost_usd: number | null
  /** Whether another turn can be sent on this session. */
  can_continue: boolean
}

/** Result of closing a session. */
export interface ExternalSessionStopResult {
  session_id: string
  status: Extract<ExternalSessionStatus, 'closed'>
}

/** Whether `value` names a provider this capability drives. */
export function isExternalProvider(value: unknown): value is ExternalProvider {
  return value === 'claude' || value === 'codex'
}

/** Whether `value` is one of the four session statuses. */
export function isExternalSessionStatus(value: unknown): value is ExternalSessionStatus {
  return value === 'running' || value === 'idle' || value === 'failed' || value === 'closed'
}

/** Whether `value` is one of the three turn statuses. */
export function isExternalTurnStatus(value: unknown): value is ExternalTurnStatus {
  return value === 'completed' || value === 'failed' || value === 'aborted'
}

/** Whether `value` is a finite, non-negative token count pair. */
export function isExternalUsage(value: unknown): value is ExternalUsage {
  if (typeof value !== 'object' || value === null) return false
  const usage = value as Partial<ExternalUsage>
  return isCount(usage.input) && isCount(usage.output)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Whether `value` is a string that parses as an instant. */
export function isInstant(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value))
}

/** A session whose CLI conversation id is known can take another turn. */
export function canResumeSession(session: ExternalSessionRecord): boolean {
  return session.status !== 'closed'
    && typeof session.providerSessionId === 'string'
    && session.providerSessionId !== ''
}