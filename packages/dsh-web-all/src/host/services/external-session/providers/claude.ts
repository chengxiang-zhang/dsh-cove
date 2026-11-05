/**
 * Claude Code execution adapter.
 *
 * One turn is one child process: `claude -p <prompt> --output-format
 * stream-json --verbose --permission-mode auto`, with `--resume <id>` appended
 * for a continuation turn. The adapter owns argv, credential injection,
 * stream-json decoding and failure classification; the engine owns the session
 * record, the concurrency gate and every bookkeeping code.
 *
 * Three measured properties of the CLI shape the decoder:
 *
 * - the process exit code is not a verdict. An unauthenticated run, a rejected
 *   argv and a resume miss all exit 0 while the turn produced no usable answer,
 *   so every verdict comes from the event stream plus its final `result` frame.
 * - the first event is not necessarily `system/init`: hook lifecycle frames can
 *   precede it. The session id is read from the first `system` frame whose
 *   subtype is `init`, with the `result` frame as the fallback carrier, so a
 *   stdout head-truncated by a long turn still yields a continuable id.
 * - the CLI applies its own `~/.claude/settings.json` `env` block, but the host
 *   scrubs credential-shaped variables from every child environment, so the
 *   adapter is the only place that can guarantee they survive: it reads them and
 *   passes them explicitly in the spawn spec. A missing entry is `auth-required`
 *   with no child started, which is the fail-closed choice the design pins.
 *
 * Two environment facts belong to the host, not to this module:
 *
 * - the CLI's own config directory is `~/.claude` on a real host; a test may
 *   point `CLAUDE_CONFIG_DIR` somewhere writable so a turn can persist a
 *   transcript and be resumed. Nothing here reads or depends on that variable.
 * - an authentication complaint is `auth-required`, never a retryable product
 *   error: a credential needs an operator, and a turn that recovers from a
 *   transient failure settles on its own success frame instead.
 * @module host/services/external-session/providers/claude
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

/** Credential entries injected into the child, in report order. */
export const CLAUDE_CREDENTIAL_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'] as const

/**
 * Bounded stream capacities. A long agentic turn emits one frame per tool call,
 * so stdout needs room; the terminal `result` frame is last, which is why a
 * lossy head still leaves a verdict and a session id.
 */
const STDOUT_MAX_BYTES = 8 << 20
const STDERR_MAX_BYTES = 1 << 20

/**
 * Code reported when the CLI ran but never settled a turn: it exited, broke the
 * event stream, or failed without a cause the caller can act on. `result` still
 * carries the exit facts and the CLI's own sentence, because the model sees the
 * fixed vocabulary message and the host log needs the detail.
 */
const UNSETTLED_TURN_CODE = 'provider-error' as const

/** Stream-json frames of one turn, reduced to the facts the engine stores. */
export interface ClaudeStreamSummary {
  /** Session id of the conversation this turn belongs to. */
  providerSessionId?: string | null
  /** Answer text of a completed turn. */
  resultText: string
  /** The CLI reported this turn as an error. */
  isError: boolean
  /** Terminal `result` frame subtype, when one was seen. */
  resultSubtype?: string
  usage?: ExternalUsage
  costUsd?: number
  cliDurationMs?: number
  /** The CLI reported a login or credential failure. */
  authFailure: boolean
  /** A requested continuation found no conversation to continue. */
  resumeMissing: boolean
  /** Well-formed `result` frame count; zero means the turn never settled. */
  resultFrames: number
  /** Event lines that were not JSON, kept as a damage count rather than a verdict. */
  damagedLines: number
}

const AUTH_FAILURE_PATTERN = /not logged in|please run \/login|authentication_failed|invalid api key|oauth token (?:has )?expired/i
const RESUME_MISSING_PATTERN = /no conversation found with session id|--resume requires a valid session id/i

/**
 * Build the stream-json argv for one turn.
 *
 * `auto` is the design's pinned permission mode: `dontAsk` would refuse every
 * unprompted action and cannot run unattended. A prompt opening with a dash is
 * kept a positional value by a `--` terminator, which has to come after every
 * flag because anything after it would be read as a positional.
 * @param prompt - the caller's prompt text.
 * @param providerSessionId - CLI conversation id to continue, when continuing.
 * @returns the argument vector after `argv[0]`.
 */
export function claudeTurnArgv(prompt: string, providerSessionId?: string, model?: string): string[] {
  const argv = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto']
  // A pinned model is a query-level override, so it belongs with the other flags
  // and before the terminator that protects a dash-leading prompt.
  if (model !== undefined && model.length > 0) argv.push('--model', model)
  if (providerSessionId !== undefined && providerSessionId.length > 0) argv.push('--resume', providerSessionId)
  if (prompt.startsWith('-')) argv.push('--')
  argv.push(prompt)
  return argv
}

/** Read one numeric field, tolerating absent and non-numeric values. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read one non-empty string field. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Narrow one parsed frame to a record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Reduce one turn's stdout and stderr to the facts the engine stores.
 *
 * Unparseable lines and unexpected frames are counted, never treated as a
 * verdict: the terminal `result` frame decides the turn.
 * @param stdout - complete stream-json stdout of the turn.
 * @param stderr - complete stderr of the turn.
 * @returns the summary the caller classifies.
 */
export function summarizeClaudeStream(stdout: string, stderr: string): ClaudeStreamSummary {
  const summary: ClaudeStreamSummary = {
    resultText: '',
    isError: false,
    authFailure: false,
    resumeMissing: false,
    resultFrames: 0,
    damagedLines: 0,
  }
  let initSessionId: string | undefined
  let resultSessionId: string | undefined
  let answered = false
  let assistantError: string | undefined

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
    const frame = record(parsed)
    if (frame === undefined) {
      summary.damagedLines += 1
      continue
    }
    const type = text(frame.type)
    const subtype = text(frame.subtype)
    if (type === 'system' && subtype === 'init') {
      initSessionId ??= text(frame.session_id)
      continue
    }
    if (type === 'assistant') {
      assistantError ??= text(frame.error)
      continue
    }
    if (type !== 'result') continue
    summary.resultFrames += 1
    if (answered) continue
    answered = true
    resultSessionId = text(frame.session_id)
    summary.resultSubtype = subtype
    summary.isError = frame.is_error === true
    summary.resultText = typeof frame.result === 'string' ? frame.result : ''
    summary.cliDurationMs = count(frame.duration_ms)
    summary.costUsd = count(frame.total_cost_usd)
    const usage = record(frame.usage)
    if (usage !== undefined) {
      const input = count(usage.input_tokens) ?? 0
      const output = count(usage.output_tokens) ?? 0
      if (input > 0 || output > 0) summary.usage = { input, output }
    }
  }

  summary.providerSessionId = initSessionId ?? resultSessionId
  const report = `${stdout}\n${stderr}`
  summary.authFailure = assistantError === 'authentication_failed' || AUTH_FAILURE_PATTERN.test(report)
  summary.resumeMissing = RESUME_MISSING_PATTERN.test(report)
  return summary
}

/** Read the `env` block of the CLI's own settings file through the host seam. */
export async function readClaudeSettingsEnv(
  deps: Pick<ExternalAdapterDeps, 'homeDir' | 'readTextFile'>,
): Promise<Record<string, string>> {
  const raw = await deps.readTextFile(`${deps.homeDir}/.claude/settings.json`)
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  const env = record(record(parsed)?.env)
  if (env === undefined) return {}
  const strings: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length > 0) strings[key] = value
  }
  return strings
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
 * Full spawn argv for one turn.
 *
 * The model is threaded here rather than at the call site, because a builder that
 * accepts a model and a spawn that forgets to pass it looks identical in review and
 * silently falls back to the CLI's own configured model.
 * @param executable - resolved CLI path.
 * @param request - the turn being run.
 * @returns the argument vector, executable first.
 */
export function spawnArgv(executable: string, request: TurnRequest): string[] {
  return [executable, ...claudeTurnArgv(request.prompt, request.providerSessionId, request.model)]
}

/**
 * Build the Claude Code adapter.
 * @param deps - host process port plus the settings, home and clock seams.
 * @param config - the resolved binary override or default.
 * @returns the adapter the engine drives.
 */
export function createClaudeAdapter(deps: ExternalAdapterDeps, config: ExternalAdapterConfig): ExternalAdapter {
  async function resolveExecutable(): Promise<string | null> {
    return deps.process.resolveExecutable(config.bin)
  }

  /** Failed turn carrying the vocabulary code for this failure. */
  function failed(
    startedAt: number,
    code: Parameters<typeof externalError>[0],
    result = '',
    usage?: ExternalUsage,
    costUsd?: number,
    providerSessionId?: string,
  ): TurnOutcome {
    return {
      status: 'failed',
      result,
      durationMs: deps.now() - startedAt,
      error: externalError(code, { provider: 'claude' }),
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      ...(usage === undefined ? {} : { usage }),
      ...(costUsd === undefined ? {} : { costUsd }),
    }
  }

  async function injectedEnv(): Promise<{ ok: true; env: Record<string, string> } | { ok: false }> {
    const settings = await readClaudeSettingsEnv(deps)
    const env: Record<string, string> = {}
    for (const key of CLAUDE_CREDENTIAL_KEYS) {
      const value = settings[key]
      if (value === undefined) return { ok: false }
      env[key] = value
    }
    return { ok: true, env }
  }

  return {
    provider: 'claude',
    resolveExecutable,

    async runTurn(request: TurnRequest): Promise<TurnOutcome> {
      const startedAt = deps.now()
      const executable = await resolveExecutable()
      if (executable === null) return failed(startedAt, 'provider-missing')

      const credentials = await injectedEnv()
      if (!credentials.ok) return failed(startedAt, 'auth-required')

      let handle: ExternalProcessHandle
      try {
        handle = deps.process.spawn({
          argv: spawnArgv(executable, request),
          cwd: request.cwd,
          graceMs: deps.cancelGraceMs,
          env: credentials.env,
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
      const summary = summarizeClaudeStream(stdoutText, stderrText)
      const sessionId = summary.providerSessionId === null ? undefined : summary.providerSessionId

      if (request.signal?.aborted === true) {
        return {
          status: 'aborted',
          result: summary.resultText,
          durationMs: deps.now() - startedAt,
          ...(sessionId === undefined ? {} : { providerSessionId: sessionId }),
          ...(summary.usage === undefined ? {} : { usage: summary.usage }),
          ...(summary.costUsd === undefined ? {} : { costUsd: summary.costUsd }),
        }
      }
      if (summary.authFailure) return failed(startedAt, 'auth-required', '', summary.usage, summary.costUsd, sessionId)
      if (summary.resumeMissing && request.providerSessionId !== undefined) {
        return failed(startedAt, 'session-unresumable', diagnostic(exit, stderrText), summary.usage, summary.costUsd, sessionId)
      }
      if (summary.resultFrames === 0) {
        return failed(startedAt, UNSETTLED_TURN_CODE, diagnostic(exit, stderrText), summary.usage, summary.costUsd, sessionId)
      }
      if (summary.isError) {
        const limited = summary.resultSubtype === 'error_max_turns' || summary.resultSubtype === 'error_max_budget_usd'
        // The CLI's own sentence is the only actionable part of a turn-level
        // failure, so it leads the diagnostic; the model still sees the fixed
        // vocabulary message, not this text.
        const reported = summary.resultText.trim().slice(0, 600)
        const detail = reported.length > 0 ? `${reported}; ${diagnostic(exit, stderrText)}` : diagnostic(exit, stderrText)
        return failed(
          startedAt,
          limited ? 'limit' : UNSETTLED_TURN_CODE,
          detail,
          summary.usage,
          summary.costUsd,
          sessionId,
        )
      }
      return {
        status: 'completed',
        result: summary.resultText,
        durationMs: deps.now() - startedAt,
        ...(sessionId === undefined ? {} : { providerSessionId: sessionId }),
        ...(summary.usage === undefined ? {} : { usage: summary.usage }),
        ...(summary.costUsd === undefined ? {} : { costUsd: summary.costUsd }),
      }
    },
  }
}