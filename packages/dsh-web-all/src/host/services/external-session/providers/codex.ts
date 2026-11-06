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
 *
 * One more property belongs to this adapter rather than to the engine: stdout is
 * readable from the process handle while the child is still alive. The stream is
 * therefore polled and decoded incrementally, so the answer accumulates and is
 * published through `report` before the process exits. That is what lets a
 * cancelled turn return the text it had already produced instead of an empty
 * result — the exit code is not a verdict, but it is also not the only evidence.
 *
 * Two environment facts belong to the host, not to this module:
 *
 * - the CLI's own config directory is `~/.codex` on a real host. A test may point
 *   `CODEX_HOME` somewhere writable so a turn can persist a thread; nothing here
 *   reads or depends on that variable.
 * - a 401 is classified as `auth-required`, not as a retryable product error.
 *   Fail-closed is deliberate: an unauthenticated credential needs an operator,
 *   and presenting it as a transient failure would invite endless retries. A
 *   turn that retries past a transient 401 settles on its own success frame, so
 *   the terminal event decides, not an intermediate one.
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

/**
 * Interval at which a running turn's stdout is polled.
 *
 * The CLI emits its frames seconds apart, so a shorter interval only spends
 * wakeups; a longer one would let a cancelled turn lose the answer that had just
 * arrived. A quarter second keeps a report close enough to the frame it describes
 * while staying far below the rate at which a turn writes.
 */
const PROGRESS_POLL_MS = 250

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
export function codexTurnArgv(prompt: string, providerSessionId?: string, model?: string): string[] {
  // `-c` is a CLI-level override, so it precedes the subcommand; a resume inherits
  // the thread's policy but not necessarily its model, which is why both shapes
  // carry the same override when the caller pinned one.
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
 * Decode one stdout line into the event type and payload this adapter reads.
 *
 * The app-server dialect wraps its payload in `params` and names the event in
 * `method`; the exec dialect tags the event itself in `type`. Both shape into one
 * reading here so the verdict decoder and the progress accumulator cannot read
 * the same stream two different ways.
 * @param value - one parsed JSON line.
 * @returns the event, or undefined when the line is not an object.
 */
function decodeEvent(value: unknown): { type: string | undefined; payload: Record<string, unknown> } | undefined {
  const event = record(value)
  if (event === undefined) return undefined
  const method = text(event.method)
  const params = record(event.params)
  return {
    type: method ?? text(event.type),
    payload: method === undefined ? event : params ?? {},
  }
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
    const event = decodeEvent(parsed)
    if (event === undefined) {
      summary.damagedLines += 1
      continue
    }
    const { type, payload } = event

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

/**
 * Live accumulation of one turn's stdout.
 *
 * `cursor` and `remainder` are stream bookkeeping; the rest are exactly the facts
 * {@link TurnProgress} reports. Keeping them in one object is what lets the poll
 * loop and the settle-time rebuild fold a stream the same way, so the text a
 * cancelled turn returns cannot disagree with the progress it published.
 */
interface CodexLiveStream {
  /** Whole-stream offset the next poll resumes from. */
  cursor: number
  /** Trailing fragment of the previous poll: a line that is still being written. */
  remainder: string
  /** Well-formed frames seen so far. */
  frames: number
  /** Tool-call frames seen so far. */
  toolCalls: number
  /** Model-authored text accumulated so far. */
  text: string
  /** Clock reading of the most recent frame. */
  lastFrameAt: number
}

function newLiveStream(): CodexLiveStream {
  return { cursor: 0, remainder: '', frames: 0, toolCalls: 0, text: '', lastFrameAt: 0 }
}

/**
 * Whether a frame carries an `item`, in either dialect.
 *
 * Everything else is a turn-level frame. `item.started` and `item.completed` are
 * the pair the CLI emits today; a frame type this adapter does not recognise is
 * simply not counted as a tool call rather than guessed at.
 */
function isItemFrame(type: string | undefined): boolean {
  return type === 'item.started' || type === 'item.completed'
    || type === 'item/started' || type === 'item/completed'
}

/**
 * Fold one stdout delta into the running accumulation.
 *
 * Only complete lines are consumed, so a frame split across two polls is decoded
 * once, whole: the trailing fragment waits for the next delta instead of being
 * parsed as if it were finished.
 * @param live - the running accumulation.
 * @param delta - stdout text that has not been consumed yet.
 * @param at - clock reading to stamp on every frame this delta carries.
 * @returns how many well-formed frames the delta added, so the caller knows
 *   whether the poll produced anything worth reporting.
 */
function consumeDelta(live: CodexLiveStream, delta: string, at: number): number {
  const buffered = live.remainder + delta
  const lines = buffered.split('\n')
  live.remainder = lines.pop() ?? ''
  let added = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Damage is the verdict decoder's business. Progress counts only frames it
      // can read, so a broken line can never be allowed to decide anything here.
      continue
    }
    const event = decodeEvent(parsed)
    if (event === undefined) continue
    added += 1
    live.frames += 1
    live.lastFrameAt = at
    // `thread.started` and `turn.started` are progress too, and they used to be
    // dropped: a frame is evidence the CLI is alive even when it decides nothing.
    if (!isItemFrame(event.type)) continue
    const item = record(event.payload.item)
    if (item === undefined) continue
    const message = agentMessageText(item)
    // Any item that is not an agent message is an action the model took: a
    // command, a file edit, a reasoning frame. The count stays a progress fact
    // and is never read as a verdict.
    if (message === undefined) live.toolCalls += 1
    else live.text += message
  }
  return added
}

/** Bounded tail of the accumulated answer: the END of the text, not its start. */
function tailOf(text: string): string {
  return text.slice(-TURN_TAIL_MAX_CHARS)
}

/**
 * Text a turn had already produced when it ended without a terminal frame.
 * @param stdout - the whole stream, read after the process exited.
 * @returns the accumulated answer, or undefined when the stream carried none.
 */
function partialAnswer(stdout: string): string | undefined {
  const live = newLiveStream()
  consumeDelta(live, stdout, 0)
  // The stream is over, so a trailing line that never got its newline is a whole
  // frame. The poll loop cannot assume that: for it the same fragment may still be
  // the first half of a line another write will finish.
  if (live.remainder.length > 0) consumeDelta(live, '\n', 0)
  return live.text.length > 0 ? live.text : undefined
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
  return [executable, ...codexTurnArgv(request.prompt, request.providerSessionId, request.model)]
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

  /**
   * Failed turn carrying the vocabulary code for this failure.
   * @param startedAt - clock reading the turn started at.
   * @param code - the vocabulary code this failure maps to.
   * @param result - model-facing result text: the accumulated answer when the
   *   stream produced one, otherwise the diagnostic fallback.
   * @param facts - usage, conversation id and whether `result` is partial.
   */
  function failed(
    startedAt: number,
    code: Parameters<typeof externalError>[0],
    result: string,
    facts: { usage?: ExternalUsage; providerSessionId?: string; partial?: boolean } = {},
  ): TurnOutcome {
    return {
      status: 'failed',
      result,
      durationMs: deps.now() - startedAt,
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
          argv: spawnArgv(executable, request),
          cwd: request.cwd,
          graceMs: deps.cancelGraceMs,
          signal: request.signal,
          stdoutMaxBytes: STDOUT_MAX_BYTES,
          stderrMaxBytes: STDERR_MAX_BYTES,
        })
      } catch (error) {
        return failed(startedAt, UNSETTLED_TURN_CODE, diagnostic(undefined, '', error))
      }

      // A turn is observed while it runs, not only once it exits. The same read
      // that makes cancellation observable is the one that keeps the answer, so
      // the loop below is the only reason a cancelled dispatch is not silent.
      const live = newLiveStream()

      /** Publish the current accumulation; bookkeeping, so it may never fail a turn. */
      const publish = (): void => {
        const progress: TurnProgress = {
          frames: live.frames,
          toolCalls: live.toolCalls,
          chars: live.text.length,
          lastFrameAt: live.lastFrameAt,
          tail: tailOf(live.text),
        }
        try {
          request.report?.(progress)
        } catch {
          // Ignored on purpose: progress is bookkeeping. Failing the turn here would
          // report a healthy process as broken because a caller's callback threw.
        }
      }

      /** Read the delta since the last poll, and publish when it carried a frame. */
      const poll = (): void => {
        const reader = handle.collected.stdout
        if (reader === undefined) return
        const read = reader.readFrom(live.cursor)
        if (!read.lossy && read.text.length === 0) return
        if (read.lossy) {
          // The in-memory tail window slid, so `cursor` no longer addresses it and
          // the read carries the whole surviving tail — exactly what a read from 0
          // returns. Restart from 0: the accumulation is rebuilt from that tail,
          // never appended to, because appending it would replay text the answer
          // already holds.
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
        // The poll loop belongs to the process: once it is gone, nothing may keep
        // reading a stream nobody will classify again.
        clearInterval(timer)
      }

      // The verdict still comes from the whole stream after exit, exactly as it did
      // before progress existed: the poll loop only adds facts, it never decides.
      const stdoutText = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderrText = handle.collected.stderr?.readFrom(0).text ?? ''
      const summary = summarizeCodexStream(stdoutText, stderrText)
      // A turn that never reached its terminal frame has no answer of its own, so
      // the text it had already produced is the only thing a caller can act on. It
      // is rebuilt from the whole stream through the same fold the poll loop uses,
      // because a turn can settle between two polls and accumulate nothing at all.
      const partial = summary.settled ? undefined : partialAnswer(stdoutText)

      if (request.signal?.aborted === true) {
        return {
          status: 'aborted',
          // A cancelled turn keeps the text it already produced, flagged so no
          // reader mistakes it for a finished answer.
          result: partial ?? summary.finalMessage,
          durationMs: deps.now() - startedAt,
          ...(partial === undefined ? {} : { partial: true }),
          ...(summary.threadId === undefined ? {} : { providerSessionId: summary.threadId }),
          ...(summary.usage === undefined ? {} : { usage: summary.usage }),
        }
      }
      // Exit code 2 is the CLI's own authentication verdict; the stream may also
      // say so directly.
      if (summary.authFailure || exit.exitCode === 2) {
        return failed(startedAt, 'auth-required', partial ?? '', {
          usage: summary.usage,
          providerSessionId: summary.threadId,
          partial: partial !== undefined,
        })
      }
      if (summary.resumeMissing && request.providerSessionId !== undefined) {
        return failed(startedAt, 'session-unresumable', partial ?? diagnostic(exit, stderrText), {
          usage: summary.usage,
          providerSessionId: summary.threadId,
          partial: partial !== undefined,
        })
      }
      const detail = diagnostic(exit, stderrText)
      const failureText = `${summary.failureMessage ?? ''}\n${detail}`
      if (summary.failed) {
        const limited = LIMIT_PATTERN.test(failureText)
        // Text already streamed beats every failure-shaped sentence: the CLI's exit
        // facts are diagnostics for the host log, and the answer is what a caller
        // can use. The fallback keeps those facts reachable when nothing was said.
        return failed(startedAt, limited ? 'limit' : UNSETTLED_TURN_CODE, partial ?? failureText, {
          usage: summary.usage,
          providerSessionId: summary.threadId,
          partial: partial !== undefined,
        })
      }
      if (!summary.settled) {
        return failed(startedAt, UNSETTLED_TURN_CODE, partial ?? failureText, {
          usage: summary.usage,
          providerSessionId: summary.threadId,
          partial: partial !== undefined,
        })
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