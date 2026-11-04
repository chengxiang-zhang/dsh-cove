/**
 * The external-session engine: state, ordering, concurrency and cancellation.
 *
 * One engine owns every external session of a host process. A turn is one child
 * process from start to exit, so the engine's job is to decide when that process
 * may exist and what its exit means:
 *
 * - a session runs one turn at a time, and its turns are appended in the order
 *   they settle, so the `turn` a caller sees back is the panel's ordering key;
 * - the whole host runs at most `maxConcurrentTurns` turns, and a request over
 *   that bound is refused with `busy` rather than queued, because a silent queue
 *   turns a refusal the caller can act on into latency it cannot see;
 * - cancelling aborts the turn's signal, and the host subprocess seam runs the
 *   documented `SIGTERM → grace → SIGKILL` ladder on the process group;
 * - a failed turn is recorded and never retried automatically: the caller
 *   decides, and the session stays continuable.
 * @module dsh-web-all/host/services/external-session/engine
 */
import { randomUUID } from 'node:crypto'
import {
  checkTurnAllowed, applyTurn, closeSession, markRunning, nextTurnNumber,
} from '../../../core/external-session/lifecycle.ts'
import { externalError, type ExternalError } from '../../../core/external-session/errors.ts'
import {
  EXTERNAL_SESSION_SERVICE,
  type ExternalSessionGateway, type ExternalTurnRequest,
} from '../../../core/external-session/gateway.ts'
import {
  outcomeSessionId, turnOutcomeError,
  type ExternalAdapter, type TurnOutcome,
} from '../../../core/external-session/adapters.ts'
import {
  toSessionList, toSessionOverviewList, usageOrNull,
} from '../../../core/external-session/views.ts'
import type {
  ExternalLiveTurn, ExternalProvider, ExternalSessionList, ExternalSessionOverviewList,
  ExternalSessionRecord, ExternalSessionStatus, ExternalSessionStopResult, ExternalTurnRecord,
  ExternalTurnResult,
} from '../../../core/external-session/types.ts'
import type { ResolvedExternalSessionConfig } from './config.ts'
import type { ExternalSessionStore } from './store.ts'

export { EXTERNAL_SESSION_SERVICE }

/** A turn that currently holds a session. */
interface RunningTurn {
  sessionId: string
  live: ExternalLiveTurn
  controller: AbortController
  settled: Promise<void>
}

/** Where the engine reports conditions it survives rather than reports upward. */
export interface EngineLogger {
  warn(message: string): void
}

/** Engine dependencies. */
export interface ExternalSessionEngineOptions {
  config: ResolvedExternalSessionConfig
  store: ExternalSessionStore
  /** Per-provider adapters; a provider absent here reports `provider-missing`. */
  adapters: Partial<Record<ExternalProvider, ExternalAdapter>>
  /** Preflight seam for `cwd-invalid`; the host supplies the real directory check. */
  directoryProbe?: (path: string) => Promise<boolean>
  /** Millisecond clock; defaults to `Date.now`. */
  now?: () => number
  /** Session id factory; defaults to `ext-<uuid>`. */
  newId?: () => string
  logger?: EngineLogger
}

/** A turn that passed preflight and may now start. */
interface PreparedTurn {
  session: ExternalSessionRecord
  adapter: ExternalAdapter
  /** True when this turn is the session's first, so the record must be inserted. */
  isNew: boolean
  cwd: string
}

/** Title of a session created without one: the first line of its prompt. */
function deriveTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0] ?? ''
  const clipped = line.length > 60 ? `${line.slice(0, 57)}...` : line
  return clipped === '' ? 'external session' : clipped
}

function isError(value: PreparedTurn | ExternalError): value is ExternalError {
  return 'code' in value
}

/** The engine behind both the tool surface and the panel. */
export class ExternalSessionEngine implements ExternalSessionGateway {
  private readonly running = new Map<string, RunningTurn>()
  private readonly now: () => number
  private readonly newId: () => string
  private readonly probe: (path: string) => Promise<boolean>
  /** Turns in flight across every session, against `maxConcurrentTurns`. */
  private active = 0

  constructor(private readonly options: ExternalSessionEngineOptions) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => `ext-${randomUUID()}`)
    this.probe = options.directoryProbe ?? (async () => true)
  }

  /** The live turn of one session, for the panel projection. */
  private liveTurns(): ReadonlyMap<string, ExternalLiveTurn> {
    const live = new Map<string, ExternalLiveTurn>()
    for (const [sessionId, turn] of this.running) live.set(sessionId, turn.live)
    return live
  }

  /** Read the store at least once before the first read of state. */
  private async ensureLoaded(): Promise<void> {
    if (!this.options.store.isLoaded) await this.options.store.load()
  }

  async listViews(): Promise<ExternalSessionList> {
    await this.ensureLoaded()
    return { sessions: toSessionList(this.options.store.list(), this.liveTurns()) }
  }

  async listOverviews(status?: ExternalSessionStatus): Promise<ExternalSessionOverviewList> {
    await this.ensureLoaded()
    const sessions = this.options.store.list()
    const filtered = status === undefined ? sessions : sessions.filter(session => session.status === status)
    return toSessionOverviewList(filtered)
  }

  async runTurn(request: ExternalTurnRequest): Promise<ExternalTurnResult | ExternalError> {
    const prepared = await this.prepare(request)
    if (isError(prepared)) return prepared
    return this.execute(prepared, request)
  }

  async startTurn(request: ExternalTurnRequest): Promise<ExternalError | null> {
    const prepared = await this.prepare(request)
    if (isError(prepared)) return prepared
    // The panel must see the turn running, so the settle is not awaited here.
    // The turn's own failures land in its record and never as an unhandled
    // rejection: `execute` contains every outcome.
    void this.execute(prepared, request).catch(() => undefined)
    return null
  }

  async cancel(sessionId: string): Promise<ExternalError | null> {
    await this.ensureLoaded()
    if (this.options.store.get(sessionId) === undefined) return externalError('session-unknown')
    const turn = this.running.get(sessionId)
    if (turn === undefined) return null
    turn.controller.abort(new Error('cancelled by caller'))
    // Waiting for quiescence is what makes "cancelled" truthful: the caller
    // learns after the process group is gone, not merely after a signal was sent.
    await turn.settled.catch(() => undefined)
    return null
  }

  async close(sessionId: string): Promise<ExternalSessionStopResult | ExternalError> {
    await this.ensureLoaded()
    const session = this.options.store.get(sessionId)
    if (session === undefined) return externalError('session-unknown')
    await this.cancel(sessionId)
    const current = this.options.store.get(sessionId)
    if (current === undefined) return externalError('session-unknown')
    await this.options.store.upsert(closeSession(current))
    return { session_id: sessionId, status: 'closed' }
  }

  /**
   * Decide whether a turn may start, and prepare the session it runs on.
   *
   * Every synchronous refusal happens here, which is what lets the panel report
   * an actionable error before its request returns.
   */
  private async prepare(request: ExternalTurnRequest): Promise<PreparedTurn | ExternalError> {
    // The slot is taken before the first await, not after preflight: three
    // simultaneous calls would otherwise all observe `active === 0`, all pass
    // the bound, and all spawn. Reservation transfers to `execute`, which
    // releases it; every refusal below releases it here.
    if (this.active >= this.options.config.maxConcurrentTurns) return externalError('busy')
    this.active += 1
    let handedOver = false
    try {
      const prepared = await this.prepareWithinSlot(request)
      handedOver = !('code' in prepared)
      return prepared
    } finally {
      if (!handedOver) this.active -= 1
    }
  }

  /** Preflight, run while the caller already holds a concurrency slot. */
  private async prepareWithinSlot(request: ExternalTurnRequest): Promise<PreparedTurn | ExternalError> {
    await this.ensureLoaded()
    const adapter = this.options.adapters[request.provider]
    if (adapter === undefined) return externalError('provider-missing', { provider: request.provider })

    let session: ExternalSessionRecord
    let isNew: boolean
    if (request.sessionId === undefined) {
      if (!this.options.store.canAdd()) return externalError('limit')
      const at = new Date(this.now()).toISOString()
      session = {
        id: this.newId(),
        provider: request.provider,
        cwd: request.cwd ?? process.cwd(),
        title: request.title ?? deriveTitle(request.prompt),
        status: 'idle',
        createdAt: at,
        lastTurnAt: at,
        turns: [],
      }
      isNew = true
    } else {
      const existing = this.options.store.get(request.sessionId)
      if (existing === undefined) return externalError('session-unknown', { provider: request.provider })
      // A continuation is bound to the directory the CLI conversation started in.
      const refusal = checkTurnAllowed(existing, { resume: true })
      if (refusal !== null) return refusal
      session = existing
      isNew = false
    }

    const executable = await adapter.resolveExecutable().catch(() => null)
    if (executable === null) return externalError('provider-missing', { provider: request.provider })
    if (!(await this.probe(session.cwd).catch(() => false))) {
      return externalError('cwd-invalid', { provider: request.provider })
    }
    return { session, adapter, isNew, cwd: session.cwd }
  }

  /** Run the prepared turn to completion and record its outcome. */
  private async execute(prepared: PreparedTurn, request: ExternalTurnRequest): Promise<ExternalTurnResult | ExternalError> {
    const { session, adapter, isNew, cwd } = prepared
    const n = nextTurnNumber(session)
    const startedAt = new Date(this.now()).toISOString()
    const controller = new AbortController()
    const detach = linkSignal(request.signal, controller)
    let settle: () => void = () => {}
    const settled = new Promise<void>(resolve => { settle = resolve })
    const running: RunningTurn = {
      sessionId: session.id,
      live: { n, prompt: request.prompt, startedAt },
      controller,
      settled,
    }

    this.running.set(session.id, running)
    try {
      // The record says `running` while the process is alive, so a second
      // request is refused by the state gate rather than run against the same
      // CLI conversation — including on a session created by this very turn.
      await this.options.store.upsert(markRunning(session))
      const outcome = await this.runAdapter(adapter, {
        prompt: request.prompt,
        cwd,
        providerSessionId: isNew ? undefined : session.providerSessionId,
        signal: controller.signal,
      }, request.provider)
      return await this.settle(turnRecord(n, request.prompt, startedAt, outcome), outcome, session.id)
    } catch (error) {
      // An adapter must resolve its failures; reaching here is a bug. Record it
      // as a failed turn so the session is left in a readable state.
      this.options.logger?.warn(`external-session turn failed unexpectedly: ${String(error)}`)
      const failedOutcome: TurnOutcome = {
        status: 'failed',
        result: '',
        durationMs: this.now() - Date.parse(startedAt),
      }
      return await this.settle(turnRecord(n, request.prompt, startedAt, failedOutcome), failedOutcome, session.id)
    } finally {
      detach()
      this.running.delete(session.id)
      this.active -= 1
      settle()
    }
  }

  /** Run one adapter turn, converting a thrown error into a failed outcome. */
  private async runAdapter(
    adapter: ExternalAdapter,
    request: { prompt: string; cwd: string; providerSessionId?: string; signal: AbortSignal },
    provider: ExternalProvider,
  ): Promise<TurnOutcome> {
    try {
      return await adapter.runTurn(request)
    } catch (error) {
      this.options.logger?.warn(`external-session ${provider} adapter threw: ${String(error)}`)
      return { status: 'failed', result: '', durationMs: 0, error: externalError('provider-missing', { provider }) }
    }
  }

  /** Persist a settled turn and project the tool result. */
  private async settle(
    turn: ExternalTurnRecord,
    outcome: TurnOutcome,
    sessionId: string,
  ): Promise<ExternalTurnResult | ExternalError> {
    const current = this.options.store.get(sessionId)
    if (current === undefined) return externalError('session-unknown')
    const withSessionId = outcomeSessionId(outcome)
    const resumedSession: ExternalSessionRecord = withSessionId === undefined
      ? current
      : { ...current, providerSessionId: withSessionId }
    const next = applyTurn(resumedSession, turn)
    await this.options.store.upsert(next)
    const failure = turnOutcomeError(outcome)
    if (failure !== null && turn.status === 'failed') return failure
    return {
      session_id: next.id,
      turn: turn.n,
      status: turn.status,
      result: turn.result,
      usage: usageOrNull(outcome.usage),
      cost_usd: outcome.costUsd ?? null,
      can_continue: next.providerSessionId !== undefined && next.status !== 'closed',
    }
  }
}

/** Build the persisted turn record for one outcome. */
function turnRecord(
  n: number,
  prompt: string,
  startedAt: string,
  outcome: TurnOutcome,
): ExternalTurnRecord {
  const record: ExternalTurnRecord = {
    n,
    prompt,
    status: outcome.status,
    startedAt,
    durationMs: outcome.durationMs,
    result: outcome.result,
  }
  if (outcome.usage !== undefined) record.usage = outcome.usage
  if (outcome.costUsd !== undefined) record.costUsd = outcome.costUsd
  return record
}

/** Forward one caller cancellation onto the turn's own controller. */
function linkSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => {}
  if (signal.aborted) {
    controller.abort(signal.reason)
    return () => {}
  }
  const forward = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', forward, { once: true })
  return () => signal.removeEventListener('abort', forward)
}