/**
 * The one fixed error vocabulary of the external-session capability.
 *
 * Every failure the model can observe is one of these eight codes with a
 * one-sentence explanation; the checksum behind that promise is that messages
 * live in a total table, so adding a code without a message does not compile.
 * Raw CLI stderr never reaches the model: it is diagnostics for the host log.
 * @module dsh-web-all/core/external-session/errors
 */
import { EXTERNAL_PROVIDER_LABELS, type ExternalProvider } from './types.ts'

/** Every failure shape the tools and routes can report. */
export type ExternalErrorCode =
  /** The CLI executable could not be resolved on this host. */
  | 'provider-missing'
  /** The working directory does not exist or cannot be entered. */
  | 'cwd-invalid'
  /** The given `session_id` is not in the store. */
  | 'session-unknown'
  /** The session is closed and takes no further turns. */
  | 'session-closed'
  /** The session has no CLI conversation id, so it cannot continue. */
  | 'session-unresumable'
  /** The global concurrency gate or the session itself is already busy. */
  | 'busy'
  /** The store holds as many sessions as the configured limit allows. */
  | 'limit'
  /** The CLI is not signed in or is missing its credentials. */
  | 'auth-required'
  /**
   * The CLI process ran but the turn never reached a verdict: no terminal
   * frame, a broken event stream, or an unrecognized non-zero exit. The exit
   * code alone cannot decide this — an unauthenticated or rejected run can
   * still exit 0 — so the adapter reports it explicitly.
   */
  | 'provider-error'
  /**
   * The turn produced no output for the configured stall window and the host
   * cancelled it. The text it had already written comes back with `partial`.
   */
  | 'turn-stalled'
  /** The turn hit the host's wall-clock ceiling for one dispatch. Same partial rule. */
  | 'turn-timeout'
  /**
   * The host could not persist a session record: an unwritable directory, a full
   * disk, a failed rename. Distinct from `session-unknown` on purpose — retrying
   * with another id cannot help, and only the operator can fix storage.
   */
  | 'store-unavailable'

/** Every error code, in the order the design lists them. */
export const EXTERNAL_ERROR_CODES: readonly ExternalErrorCode[] = [
  'provider-missing',
  'cwd-invalid',
  'session-unknown',
  'session-closed',
  'session-unresumable',
  'busy',
  'limit',
  'auth-required',
  'provider-error',
  'turn-stalled',
  'turn-timeout',
  'store-unavailable',
]

/** A code plus the sentence shown to the model; the `{code, message}` shape every surface reports. */
export interface ExternalError {
  code: ExternalErrorCode
  message: string
}

/** Optional facts a message may name without leaking CLI output. */
export interface ExternalErrorContext {
  /** Provider the failing call addressed; names the CLI in the message. */
  provider?: ExternalProvider
}

type MessageTable = Readonly<Record<ExternalErrorCode, (context: ExternalErrorContext) => string>>

function cliLabel(context: ExternalErrorContext): string {
  return context.provider === undefined ? 'The external CLI' : `The ${EXTERNAL_PROVIDER_LABELS[context.provider]} CLI`
}

/**
 * One sentence per code. The table is total on purpose: a new code fails to
 * typecheck until it has an explanation the model can act on.
 */
const MESSAGES: MessageTable = {
  'provider-missing': context =>
    `${cliLabel(context)} is not installed on this host, or its binary is not on the host PATH. `
    + 'Ask the operator to install it or to set the external-session binary override in the plugin config.',
  'cwd-invalid': () =>
    'That working directory does not exist or cannot be entered. '
    + 'Pass an existing absolute directory, or omit cwd to use the conversation working directory.',
  'session-unknown': () =>
    'No external session has that session_id. Omit session_id to start a new external session.',
  'session-closed': () =>
    'That external session is closed and takes no further turns. Start a new external session instead.',
  'session-unresumable': () =>
    'That external session has no CLI conversation id, so it cannot take another turn. '
    + 'Start a new external session for the follow-up work.',
  busy: () =>
    'Every external session slot is busy, or that session is already running a turn. '
    + 'Wait for a running turn to finish, then retry.',
  limit: () =>
    'The external session store has reached its session limit. '
    + 'Close and delete external sessions from the panel before starting another one.',
  'auth-required': context =>
    `${cliLabel(context)} is not signed in: ~/.claude/settings.json has no ANTHROPIC_BASE_URL `
    + 'or no ANTHROPIC_AUTH_TOKEN in its env block. '
    + 'Ask the operator to fill both in, then retry.',
  'provider-error': context =>
    `${cliLabel(context)} ran the turn but did not report a result. `
    + 'Retry the turn; if it fails again, ask the operator to check the host log for the CLI diagnostics.',
  'turn-stalled': context =>
    `${cliLabel(context)} stopped producing output and the turn was cancelled as stalled. `
    + 'The text it had already produced is returned with partial set; continue the same session '
    + 'to pick the work up, or retry with a smaller ask.',
  'turn-timeout': context =>
    `${cliLabel(context)} hit the host ceiling for one dispatch and the turn was cancelled. `
    + 'The text it had already produced is returned with partial set; split the job into smaller '
    + 'turns, or continue the same session to carry on from where it stopped.',
  'store-unavailable': () =>
    'The host could not save the external session record. Retrying cannot help: '
    + 'the session store on the host is unwritable or full, so ask the operator to fix '
    + 'the host filesystem or free space before running another turn.',
}

/** Build the reportable error for `code`. */
export function externalError(code: ExternalErrorCode, context: ExternalErrorContext = {}): ExternalError {
  return { code, message: MESSAGES[code](context) }
}

/** Whether `value` is one of the eight codes. */
export function isExternalErrorCode(value: unknown): value is ExternalErrorCode {
  return typeof value === 'string' && (EXTERNAL_ERROR_CODES as readonly string[]).includes(value)
}

/** Whether `value` is a reportable error rather than a successful result. */
export function isExternalError(value: unknown): value is ExternalError {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ExternalError>
  return isExternalErrorCode(candidate.code) && typeof candidate.message === 'string'
}