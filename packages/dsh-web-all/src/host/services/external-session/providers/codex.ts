/**
 * Codex execution adapter.
 *
 * One turn is one child process: `codex exec --json ... <prompt>` for the first
 * turn and `codex exec resume --json <id> <prompt>` afterwards, because this CLI
 * takes continuation as a subcommand rather than a flag. The adapter owns argv,
 * event decoding and failure classification; the engine owns session records,
 * the concurrency gate and the decision that a session has become unresumable.
 *
 * Two properties of the CLI shape the decoder:
 *
 * - the conversation id arrives as the first `thread.started` event, not with
 *   the answer. A stream that never reports one leaves `providerSessionId`
 *   absent on purpose: the engine turns that into `session-unresumable` so a
 *   caller never silently gets a fresh conversation where a continuation was
 *   promised.
 * - the final answer is not a dedicated frame either: it is the text of the last
 *   completed `agent_message` item, so the decoder keeps the last one rather
 *   than the first.
 *
 * Two output dialects exist across CLI versions (a `type`-tagged exec stream and
 * a `method`-tagged app-server stream). Both are decoded here so a CLI upgrade
 * costs no adapter change, which is what the upgrade drill in the design asks
 * for.
 * @module host/services/external-session/providers/codex
 */
import type {
  ExternalAdapter,
  ExternalAdapterConfig,
  ExternalAdapterDeps,
  ExternalProcessHandle,
  ExternalProcessOutcome,
  TurnOutcome,
  TurnRequest,
} from '../../../../core/external-session/adapters.ts'
import { externalError } from '../../../../core/external-session/errors.ts'
import type { ExternalUsage } from '../../../../core/external-session/types.ts'

/** Bounded stream capacities; the event stream carries one line per tool call. */
const STDOUT_MAX_BYTES = 8 << 20
const STDERR_MAX_BYTES = 1 << 20

/**
 * Code reported when the CLI ran but never settled a turn. The exit facts still
 * travel in `result`; the model sees the fixed vocabulary message.
 */
const UNSETTLED_TURN_CODE = 'provider-error' as const

/** Stream events reduced to the facts the engine stores. */
export interface CodexStreamSummary {
  /** Conversation id of this turn, from `thread.started`. */
  threadId?: string
  /** Text of the last completed agent message. */
  finalMessage: string
  usage?: ExternalUsage
  /** The stream reported a failed turn. */
  failed: boolean
  /** Failure sentence the CLI reported, for the diagnostic only. */
  failureMessage?: string
  /** The stream reported an authentication or login problem. */
  authFailure: boolean
  /** A requested continuation found no session to continue. */
  resumeMissing: boolean
  /** A `turn.completed` frame was seen. */
  settled: boolean
  /** Event lines that were not JSON. */
  damagedLines: number
}

const AUTH_FAILURE_PATTERN = /not logged in|please run codex login|authentication failed|unauthorized|401|invalid api key/i
const RESUME_MISSING_PATTERN = /no such session|session not found|thread not found|no conversation|session id not found/i
const LIMIT_PATTERN = /usage limit|rate limit|quota exceeded|too many requests|context window exceeded/i

/**
 * Build the argv for one turn.
 *
 * `--approve-for-me` is this CLI's analogue of the design's `auto` permission
 * mode: approvals are answered by automatic review inside the workspace-write
 * sandbox, which is the only shape that can run unattended without granting the
 * whole machine. A continuation relies on the permission policy recorded with
 * the thread, because the `resume` subcommand accepts no approval flag of its
 * own. `--skip-git-repo-check` keeps a plain directory usable, since cwd is the
 * caller's workspace rather than necessarily a repository.
 * @param prompt - the caller's prompt text.
 * @param providerSessionId - conversation id to continue, when continuing.
 * @returns the argument vector after `argv[0]`.
 */
export function codexTurnArgv(prompt: string, providerSessionId?: string): string[] {
  if (providerSessionId !== undefined && providerSessionId.length > 0) {
    return ['exec', 'resume', '--json', '--skip-git-repo-check', providerSessionId, prompt]
  }
  return ['exec', '--json', '--approve-for-me', '--skip-git-repo-check', prompt]
}

/** Read one non-empty string field. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read one numeric field, tolerating absent and non-numeric values. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Narrow one parsed value to a record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Read an agent message item's text in either dialect. */
function agentMessageText(item: Record<string, unknown>): string | undefined {
  const kind = text(item.type)
  if (kind !== 'agent_message' && kind !== 'agentMessage') return undefined
  return typeof item.text === 'string' ? item.text : undefined
}

/** Convert one usage object in either dialect. */
function usageOf(value: unknown): ExternalUsage | undefined {
  const usage = record(value)
  if (usage === undefined) return undefined
  const input = count(usage.input_tokens)
  const output = count(usage.output_tokens)
  if (input === undefined && output === undefined) return undefined
  if ((input ?? 0) === 0 && (output ?? 0) === 0) return undefined
  return { input: input ?? 0, output: output ?? 0 }
}

/**
 * Reduce one turn's event stream to the facts the engine stores.
 * @param stdout - complete JSONL stdout of the turn.
 * @param stderr - complete stderr of the turn.
 * @returns the summary the caller classifies.
 */
export function summarizeCodexStream(stdout: string, stderr: string): CodexStreamSummary {
  const summary: CodexStreamSummary = {
    finalMessage: '',
    failed: false,
    authFailure: false,
    resumeMissing: false,
    settled: false,
    damagedLines: 0,
  }
  let failureMessage: string | undefined

  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      summary.damagedLines += 1
      continue
    }
    const event = record(parsed)
    if (event === undefined) {
      summary.damagedLines += 1
      continue
    }
    // The app-server dialect wraps its payload in `params` and names the event
    // in `method`; the exec dialect tags it in `type`.
    const method = text(event.method)
    const params = record(event.params)
    const type = method ?? text(event.type)
    const payload = method === undefined ? event : params ?? {}

    if (type === 'thread.started' || type === 'thread/started') {
      const thread = record(payload.thread)
      summary.threadId ??= text(payload.thread_id) ?? text(thread?.id)
      continue
    }
    if (type === 'item.completed' || type === 'item/completed') {
      const item = record(payload.item)
      if (item !== undefined) {
        const message = agentMessageText(item)
        if (message !== undefined) summary.finalMessage = message
      }
      continue
    }
    if (type === 'turn.completed' || type === 'turn/completed') {
      summary.settled = true
      summary.usage ??= usageOf(payload.usage)
      continue
    }
    if (type === 'turn.failed' || type === 'turn/failed') {
      summary.failed = true
      failureMessage ??= text(record(payload.error)?.message) ?? text(payload.message)
      continue
    }
    if (type === 'error') {
      summary.failed = true
      failureMessage ??= text(payload.message)
    }
  }

  summary.failureMessage = failureMessage
  const report = `${stdout}\n${stderr}`
  summary.authFailure = AUTH_FAILURE_PATTERN.test(report)
  summary.resumeMissing = RESUME_MISSING_PATTERN.test(report)
  return summary
}

/** A bounded diagnostic for a failed turn; never the model-facing explanation. */
function diagnostic(exit: ExternalProcessOutcome | undefined, stderr: string, cause?: unknown): string {
  const parts: string[] = []
  if (exit !== undefined) parts.push(`exit ${String(exit.exitCode)}`)
  if (exit?.signal !== null && exit?.signal !== undefined) parts.push(`signal ${exit.signal}`)
  if (cause !== undefined) parts.push(cause instanceof Error ? cause.message : String(cause))
  const tail = stderr.trim()
  if (tail.length > 0) parts.push(tail.slice(-600))
  return parts.join('; ')
}

/**
 * Build the Codex adapter.
 * @param deps - host process port, plus the clock and cancellation seams.
 * @param config - the resolved binary override or default.
 * @returns the adapter the engine drives.
 */
export function createCodexAdapter(deps: ExternalAdapterDeps, config: ExternalAdapterConfig): ExternalAdapter {
  async function resolveExecutable(): Promise<string | null> {
    return deps.process.resolveExecutable(config.bin)
  }

  /** Failed turn carrying the vocabulary code for this failure. */
  function failed(
    startedAt: number,
    code: Parameters<typeof externalError>[0],
    result: string,
    usage?: ExternalUsage,
    providerSessionId?: string,
  ): TurnOutcome {
    return {
      status: 'failed',
      result,
      durationMs: deps.now() - startedAt,
      error: externalError(code, { provider: 'codex' }),
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      ...(usage === undefined ? {} : { usage }),
    }
  }

  return {
    provider: 'codex',
    resolveExecutable,

    async runTurn(request: TurnRequest): Promise<TurnOutcome> {
      const startedAt = deps.now()
      const executable = await resolveExecutable()
      if (executable === null) return failed(startedAt, 'provider-missing', '')

      let handle: ExternalProcessHandle
      try {
        handle = deps.process.spawn({
          argv: [executable, ...codexTurnArgv(request.prompt, request.providerSessionId)],
          cwd: request.cwd,
          graceMs: deps.cancelGraceMs,
          signal: request.signal,
          stdoutMaxBytes: STDOUT_MAX_BYTES,
          stderrMaxBytes: STDERR_MAX_BYTES,
        })
      } catch (error) {
        return failed(startedAt, UNSETTLED_TURN_CODE, diagnostic(undefined, '', error))
      }

      let exit: ExternalProcessOutcome
      try {
        exit = await handle.done
      } catch (error) {
        return failed(startedAt, UNSETTLED_TURN_CODE, diagnostic(undefined, '', error))
      }

      const stdoutText = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderrText = handle.collected.stderr?.readFrom(0).text ?? ''
      const summary = summarizeCodexStream(stdoutText, stderrText)

      if (request.signal?.aborted === true) {
        return {
          status: 'aborted',
          result: summary.finalMessage,
          durationMs: deps.now() - startedAt,
          ...(summary.threadId === undefined ? {} : { providerSessionId: summary.threadId }),
          ...(summary.usage === undefined ? {} : { usage: summary.usage }),
        }
      }
      // Exit code 2 is the CLI's own authentication verdict; the stream may also
      // say so directly.
      if (summary.authFailure || exit.exitCode === 2) {
        return failed(startedAt, 'auth-required', '', summary.usage, summary.threadId)
      }
      if (summary.resumeMissing && request.providerSessionId !== undefined) {
        return failed(startedAt, 'session-unresumable', diagnostic(exit, stderrText), summary.usage, summary.threadId)
      }
      const detail = diagnostic(exit, stderrText)
      const failureText = `${summary.failureMessage ?? ''}\n${detail}`
      if (summary.failed) {
        const limited = LIMIT_PATTERN.test(failureText)
        return failed(startedAt, limited ? 'limit' : UNSETTLED_TURN_CODE, failureText, summary.usage, summary.threadId)
      }
      if (!summary.settled) {
        return failed(startedAt, UNSETTLED_TURN_CODE, failureText, summary.usage, summary.threadId)
      }
      return {
        status: 'completed',
        result: summary.finalMessage,
        durationMs: deps.now() - startedAt,
        ...(summary.threadId === undefined ? {} : { providerSessionId: summary.threadId }),
        ...(summary.usage === undefined ? {} : { usage: summary.usage }),
      }
    },
  }
}