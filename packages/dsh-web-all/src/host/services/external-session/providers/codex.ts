/**
 * Codex execution adapter: one exec process per turn, with native resume ids.
 *
 * Answer items are content, never error evidence. Exec JSONL errors and
 * app-server notifications have separate terminal semantics: only app-server
 * willRetry notifications may be superseded by the same turn's final status.
 * Exec startup item diagnostics are distinct from errors of the started turn.
 * Progress remains bookkeeping; only the post-exit stream decides the outcome.
 * @module host/services/external-session/providers/codex
 */
import { TURN_TAIL_MAX_CHARS } from '../../../../core/external-session/adapters.ts'
import type {
  ExternalAdapter,
  ExternalAdapterConfig,
  ExternalAdapterDeps,
  ExternalProcessHandle,
  ExternalProcessOutcome,
  TurnOutcome,
  TurnProgress,
  TurnRequest,
} from '../../../../core/external-session/adapters.ts'
import { externalError } from '../../../../core/external-session/errors.ts'
import type { ExternalUsage } from '../../../../core/external-session/types.ts'

/** Bounded stream capacities; the event stream carries one line per tool call. */
const STDOUT_MAX_BYTES = 8 << 20
const STDERR_MAX_BYTES = 1 << 20
/** Poll often enough to retain text produced just before cancellation. */
const PROGRESS_POLL_MS = 250
const UNSETTLED_TURN_CODE = 'provider-error' as const

/** Stream events reduced to the facts the engine stores. */
export interface CodexStreamSummary {
  /** Observed native id, never invented from a continuation request. */
  threadId?: string
  /** Text of the last completed agent message, without trimming. */
  finalMessage: string
  /** Accumulated target answer text, usable only as partial output on failure. */
  partialMessage?: string
  usage?: ExternalUsage
  failed: boolean
  /** Reliable error evidence only; no agent messages or command output. */
  failureMessage?: string
  authFailure: boolean
  resumeMissing: boolean
  /** A successful target terminal frame was seen; failed still takes priority. */
  settled: boolean
  /** Unreadable lines, including tolerated independent non-JSON noise. */
  damagedLines: number
}

const AUTH_FAILURE_PATTERN = /not logged in|please run codex login|authentication failed|unauthorized|401|invalid api key/i
const RESUME_MISSING_PATTERN = /no such session|session not found|thread not found|no conversation|session id not found/i
const LIMIT_PATTERN = /usage[ _]?limit|rate[ _]?limit|quota exceeded|too many requests|context[ _]?window[ _]?exceeded|sessionBudgetExceeded/i

/** Build argv after argv[0]; resume inherits the thread's approval policy. */
export function codexTurnArgv(prompt: string, providerSessionId?: string, model?: string): string[] {
  // Model is a CLI-level override, before the subcommand in both shapes.
  const head = model !== undefined && model.length > 0 ? ['-c', `model=${model}`] : []
  if (providerSessionId !== undefined && providerSessionId.length > 0) {
    return [...head, 'exec', 'resume', '--json', '--skip-git-repo-check', providerSessionId, prompt]
  }
  return [...head, 'exec', '--json', '--approve-for-me', '--skip-git-repo-check', prompt]
}

/** Read one non-empty string field. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read one finite numeric field. */
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

interface CodexEvent {
  type: string | undefined
  payload: Record<string, unknown>
  /** Keep the source: method=error must not inherit exec error semantics. */
  appServer: boolean
}

/** Decode the wire envelope without merging the two protocols' semantics. */
function decodeEvent(value: unknown): CodexEvent | undefined {
  const event = record(value)
  if (event === undefined) return undefined
  const method = text(event.method)
  return {
    type: method ?? text(event.type),
    payload: method === undefined ? event : record(event.params) ?? {},
    appServer: method !== undefined,
  }
}

/** Explicit app-server correlation fields; nested turn.id is authoritative. */
function eventTurnId(event: CodexEvent): string | undefined {
  return text(record(event.payload.turn)?.id) ?? text(event.payload.turnId)
}

function eventThreadId(event: CodexEvent): string | undefined {
  return text(event.payload.threadId) ?? text(event.payload.thread_id) ?? text(record(event.payload.thread)?.id)
}

/** Read designated error fields, not an item's id, answer text or tool output. */
function errorDetail(value: unknown): string | undefined {
  if (typeof value === 'string') return text(value)
  const error = record(value)
  if (error === undefined) return undefined
  return JSON.stringify({
    message: error.message,
    additionalDetails: error.additionalDetails,
    code: error.code,
    codexErrorInfo: error.codexErrorInfo,
    httpStatusCode: error.httpStatusCode,
    statusCode: error.statusCode,
  })
}

/**
 * Reduce one process's stdout. An optional requested id filters explicit foreign
 * threads but is not itself returned as an observed id. Pin the app-server turn
 * from its first turn/started, or (for older streams) its first scoped event.
 * Preselecting avoids a foreign completion stealing a turn already announced by
 * turn/started. Legacy fixtures without correlation fields remain readable;
 * explicit conflicting ids are never treated as missing fields.
 */
export function summarizeCodexStream(stdout: string, stderr: string, requestedThreadId?: string): CodexStreamSummary {
  const summary: CodexStreamSummary = {
    finalMessage: '', partialMessage: '', failed: false, authFailure: false,
    resumeMissing: false, settled: false, damagedLines: 0,
  }
  const events: CodexEvent[] = []
  let protocolDamaged = false
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    try {
      const event = decodeEvent(JSON.parse(line))
      if (event === undefined) {
        summary.damagedLines += 1
        protocolDamaged = true
      } else events.push(event)
    } catch {
      // Ordinary independent noise is compatible with a complete success frame.
      // A broken terminal frame cannot set settled and therefore cannot succeed.
      summary.damagedLines += 1
      // Do not use the startup-item exception to excuse a damaged JSON frame.
      // This does not change the established independent plain-noise tolerance.
      if (line.startsWith('{') || line.startsWith('[')) protocolDamaged = true
    }
  }

  const announcedThread = events.find(event => event.type === 'thread.started' || event.type === 'thread/started')
  const targetThread = requestedThreadId ?? (announcedThread === undefined ? undefined : eventThreadId(announcedThread))
    ?? events.filter(event => event.appServer).map(eventThreadId).find(id => id !== undefined)
  const sameThread = (event: CodexEvent): boolean => {
    const id = eventThreadId(event)
    return id === undefined || targetThread === undefined || id === targetThread
  }
  const appEvents = events.filter(event => event.appServer && sameThread(event))
  const startedTurn = appEvents.find(event => event.type === 'turn/started' && eventTurnId(event) !== undefined)
  const targetTurn = (startedTurn === undefined ? undefined : eventTurnId(startedTurn))
    ?? appEvents.map(eventTurnId).find(id => id !== undefined)
  const errors: string[] = []
  const retryErrors: string[] = []
  const startupItemErrors: string[] = []
  let execStarted = false
  let execCompleted = false
  let appTerminal = false
  let sawExec = false
  let sawApp = false
  const fail = (detail?: string): void => {
    summary.failed = true
    if (detail !== undefined) errors.push(detail)
  }

  for (const event of events) {
    const { type, payload, appServer } = event
    if (!sameThread(event)) {
      // Exec is one process/turn, not a multiplexed app-server subscription.
      if (!appServer) fail('Exec stream reported a different native thread')
      continue
    }
    if (appServer) {
      const turnId = eventTurnId(event)
      if (turnId !== undefined && targetTurn !== undefined && turnId !== targetTurn) continue
      // A top-level and nested id conflict is not a successful target terminal.
      if (text(payload.turnId) !== undefined && text(record(payload.turn)?.id) !== undefined
        && payload.turnId !== record(payload.turn)?.id) {
        fail('Conflicting app-server turn identifiers')
        continue
      }
      sawApp = true
    } else if (type === 'error' || type?.startsWith('thread.') === true
      || type?.startsWith('turn.') === true || type?.startsWith('item.') === true) {
      sawExec = true
    }

    if (type === 'thread.started' || type === 'thread/started') {
      summary.threadId ??= eventThreadId(event)
      continue
    }
    // Full app-server notifications can supply an observed id without a separate
    // thread/started. Missing all native ids still leaves the result unresumable.
    if (appServer) summary.threadId ??= eventThreadId(event)

    if ((!appServer && type === 'item.completed') || (appServer && type === 'item/completed')) {
      const item = record(payload.item)
      if (item !== undefined) {
        const message = agentMessageText(item)
        if (message !== undefined) {
          summary.finalMessage = message
          summary.partialMessage = (summary.partialMessage ?? '') + message
        }
        if (!appServer && item.type === 'error') {
          const detail = errorDetail(item) ?? 'Exec item error'
          // Only item-scoped diagnostics before an explicit turn start can be
          // independent startup diagnostics. Security/session/limit failures and
          // every item error of a started turn remain failures, without reset.
          if (execStarted || execCompleted || AUTH_FAILURE_PATTERN.test(detail)
            || RESUME_MISSING_PATTERN.test(detail) || LIMIT_PATTERN.test(detail)) {
            fail(detail)
          } else {
            startupItemErrors.push(detail)
          }
        }
      }
      continue
    }
    if (!appServer) {
      if (type === 'turn.started') {
        execStarted = true
      } else if (type === 'turn.completed') {
        execCompleted = execStarted
        summary.settled = true
        summary.usage ??= usageOf(payload.usage)
        if (payload.error !== undefined && payload.error !== null) fail(errorDetail(payload.error))
      } else if (type === 'turn.failed' || type === 'error') {
        // No app-server willRetry exception is applied to exec errors.
        fail(errorDetail(payload.error) ?? text(payload.message))
      }
      continue
    }
    if (type === 'error') {
      const detail = errorDetail(payload.error) ?? text(payload.message)
      if (payload.willRetry === true) {
        if (detail !== undefined) retryErrors.push(detail)
      } else {
        fail(detail)
      }
    } else if (type === 'turn/completed') {
      const turn = record(payload.turn)
      const detail = errorDetail(turn?.error)
      const hasError = turn?.error !== undefined && turn.error !== null
      const hasId = text(turn?.id) !== undefined
      // A failed/interrupted authoritative terminal also supersedes transient
      // diagnostics. Its own error, not a prior retry's 401, decides the code.
      if (hasId && (turn?.status === 'completed' || turn?.status === 'failed' || turn?.status === 'interrupted')) {
        appTerminal = true
      }
      if (hasId && turn?.status === 'completed' && !hasError) {
        summary.settled = true
        summary.usage ??= usageOf(payload.usage)
      } else {
        fail(detail ?? `App-server turn ended with status ${String(turn?.status)}`)
      }
    } else if (type === 'turn/failed') {
      appTerminal = eventTurnId(event) !== undefined
      fail(errorDetail(record(payload.turn)?.error) ?? errorDetail(payload.error) ?? text(payload.message))
    }
  }
  // Do not let a second dialect supply a missing target terminal either.
  if (sawApp && sawExec) fail('Mixed Codex stream protocols')
  // A startup item is not a target-turn verdict. Only a later explicit start and
  // clean completion can establish that distinction. Never clear actual errors.
  // Legacy success streams without turn.started still work when no such startup
  // diagnostic is present. Process exit/truncation checks remain in runTurn.
  if (!execCompleted || summary.failed || protocolDamaged) {
    for (const detail of startupItemErrors) fail(detail)
  }
  // A missing terminal is still a failure. Pending target retry diagnostics can
  // classify it, but are not evidence that an authentication terminal was seen.
  if (!appTerminal) errors.push(...retryErrors)
  // Stderr is failure evidence only when this stream has not succeeded. runTurn
  // also supplies it for nonzero/signal exits, even after a success-shaped frame.
  if (summary.failed || !summary.settled) errors.push(stderr)
  const report = errors.filter(part => part.length > 0).join('\n')
  if (report.length > 0) summary.failureMessage = report
  summary.authFailure = AUTH_FAILURE_PATTERN.test(report)
  summary.resumeMissing = RESUME_MISSING_PATTERN.test(report)
  return summary
}

/** Live progress bookkeeping; it never decides success or failure. */
interface CodexLiveStream {
  cursor: number
  remainder: string
  frames: number
  toolCalls: number
  text: string
  lastFrameAt: number
}

function newLiveStream(): CodexLiveStream {
  return { cursor: 0, remainder: '', frames: 0, toolCalls: 0, text: '', lastFrameAt: 0 }
}

function isItemFrame(type: string | undefined): boolean {
  return type === 'item.started' || type === 'item.completed'
    || type === 'item/started' || type === 'item/completed'
}

/** Fold complete lines only; keep a fragment for the next poll. */
function consumeDelta(live: CodexLiveStream, delta: string, at: number): number {
  const lines = (live.remainder + delta).split('\n')
  live.remainder = lines.pop() ?? ''
  let added = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const event = decodeEvent(parsed)
    if (event === undefined) continue
    added += 1
    live.frames += 1
    live.lastFrameAt = at
    if (!isItemFrame(event.type)) continue
    const item = record(event.payload.item)
    if (item === undefined) continue
    const message = agentMessageText(item)
    if (message === undefined) live.toolCalls += 1
    else live.text += message
  }
  return added
}

function tailOf(value: string): string {
  return value.slice(-TURN_TAIL_MAX_CHARS)
}

/** A bounded diagnostic for a failed turn. */
function diagnostic(exit: ExternalProcessOutcome | undefined, stderr: string, cause?: unknown): string {
  const parts: string[] = []
  if (exit !== undefined) parts.push(`exit ${String(exit.exitCode)}`)
  if (exit?.signal !== null && exit?.signal !== undefined) parts.push(`signal ${exit.signal}`)
  if (cause !== undefined) parts.push(cause instanceof Error ? cause.message : String(cause))
  const tail = stderr.trim()
  if (tail.length > 0) parts.push(tail.slice(-600))
  return parts.join('; ')
}

/** Full spawn argv; both first turns and continuations carry the model override. */
export function spawnArgv(executable: string, request: TurnRequest): string[] {
  return [executable, ...codexTurnArgv(request.prompt, request.providerSessionId, request.model)]
}

/** Build the adapter from the host's process and clock seams. */
export function createCodexAdapter(deps: ExternalAdapterDeps, config: ExternalAdapterConfig): ExternalAdapter {
  async function resolveExecutable(): Promise<string | null> {
    return deps.process.resolveExecutable(config.bin)
  }

  function failed(
    startedAt: number,
    code: Parameters<typeof externalError>[0],
    result: string,
    facts: { usage?: ExternalUsage; providerSessionId?: string; partial?: boolean } = {},
  ): TurnOutcome {
    return {
      status: 'failed', result, durationMs: deps.now() - startedAt,
      error: externalError(code, { provider: 'codex' }),
      ...(facts.providerSessionId === undefined ? {} : { providerSessionId: facts.providerSessionId }),
      ...(facts.usage === undefined ? {} : { usage: facts.usage }),
      ...(facts.partial === true ? { partial: true } : {}),
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
          argv: spawnArgv(executable, request), cwd: request.cwd,
          graceMs: deps.cancelGraceMs, signal: request.signal,
          stdoutMaxBytes: STDOUT_MAX_BYTES, stderrMaxBytes: STDERR_MAX_BYTES,
        })
      } catch (error) {
        return failed(startedAt, UNSETTLED_TURN_CODE, diagnostic(undefined, '', error))
      }
      const live = newLiveStream()
      const publish = (): void => {
        const progress: TurnProgress = {
          frames: live.frames, toolCalls: live.toolCalls, chars: live.text.length,
          lastFrameAt: live.lastFrameAt, tail: tailOf(live.text),
        }
        try {
          request.report?.(progress)
        } catch {
          // Progress callbacks cannot fail an otherwise healthy turn.
        }
      }
      const poll = (): void => {
        const reader = handle.collected.stdout
        if (reader === undefined) return
        const read = reader.readFrom(live.cursor)
        if (!read.lossy && read.text.length === 0) return
        if (read.lossy) {
          // Rebuild from the retained tail; never append a replay of old text.
          live.remainder = ''
          live.frames = 0
          live.toolCalls = 0
          live.text = ''
        }
        live.cursor = read.nextOffset
        if (consumeDelta(live, read.text, deps.now()) > 0) publish()
      }
      const timer = setInterval(poll, PROGRESS_POLL_MS)
      let exit: ExternalProcessOutcome
      try {
        exit = await handle.done
      } catch (error) {
        return failed(startedAt, UNSETTLED_TURN_CODE, diagnostic(undefined, '', error))
      } finally {
        clearInterval(timer)
      }

      const stdoutRead = handle.collected.stdout?.readFrom(0)
      const stderrRead = handle.collected.stderr?.readFrom(0)
      const stdoutText = stdoutRead?.text ?? ''
      const stderrText = stderrRead?.text ?? ''
      const summary = summarizeCodexStream(stdoutText, stderrText, request.providerSessionId)
      const exitFailed = exit.exitCode !== 0 || exit.signal !== null
      const streamLost = stdoutRead?.lossy === true || stderrRead?.lossy === true
      const unsuccessful = summary.failed || !summary.settled || exitFailed || streamLost
      // The reducer accumulates only target messages, including a final JSON line
      // without a newline; foreign turns cannot leak into failed partial output.
      const partial = unsuccessful ? text(summary.partialMessage) : undefined
      if (request.signal?.aborted === true) {
        return {
          status: 'aborted', result: partial ?? summary.finalMessage,
          durationMs: deps.now() - startedAt,
          ...(partial === undefined ? {} : { partial: true }),
          ...(summary.threadId === undefined ? {} : { providerSessionId: summary.threadId }),
          ...(summary.usage === undefined ? {} : { usage: summary.usage }),
        }
      }
      // Failed process stderr is authoritative diagnostic input, not stdout
      // answer text. Successful exit stderr does not override a clean terminal.
      const failureEvidence = `${summary.failureMessage ?? ''}\n${unsuccessful ? stderrText : ''}`
      const facts = {
        usage: summary.usage, providerSessionId: summary.threadId,
        partial: partial !== undefined,
      }
      // Preserve the established CLI exit-2 authentication classification.
      if (summary.authFailure || exit.exitCode === 2 || AUTH_FAILURE_PATTERN.test(failureEvidence)) {
        return failed(startedAt, 'auth-required', partial ?? '', facts)
      }
      if ((summary.resumeMissing || RESUME_MISSING_PATTERN.test(failureEvidence)) && request.providerSessionId !== undefined) {
        return failed(startedAt, 'session-unresumable', partial ?? diagnostic(exit, stderrText), facts)
      }
      if (unsuccessful) {
        const failureText = `${summary.failureMessage ?? ''}\n${diagnostic(exit, stderrText)}${streamLost ? '; captured stream truncated' : ''}`
        return failed(startedAt, LIMIT_PATTERN.test(failureEvidence) ? 'limit' : UNSETTLED_TURN_CODE, partial ?? failureText, facts)
      }
      return {
        status: 'completed', result: summary.finalMessage,
        durationMs: deps.now() - startedAt,
        ...(summary.threadId === undefined ? {} : { providerSessionId: summary.threadId }),
        ...(summary.usage === undefined ? {} : { usage: summary.usage }),
      }
    },
  }
}
