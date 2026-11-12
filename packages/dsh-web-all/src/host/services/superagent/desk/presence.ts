/**
 * Desk presence (T20): one desk per chat, one session per desk, one turn at a time.
 *
 * Lifecycle (07): lazy session creation on the first message; 30 minutes idle evicts
 * (session_id cleared, persistence kept, generation + 1 so the next message cold-
 * resumes from the ledger, N11); rotation by 4000 events, by local day, or by hand.
 * Human turns go first: an agenda turn meeting live human messages on its desk
 * waits 60 seconds, at most five times.
 *
 * Every turn starts with the tool-face self-check and fails closed. The dossier is
 * the head of the turn's user message, never a system prompt section.
 */

import type { HostClock, HostLog, SessionControllerFace } from '../host-ports.ts'
import { finishTurnAndPush } from '../kernel/clock.ts'
import type { Ledger } from '../kernel/ledger.ts'
import type { Outlet } from '../kernel/outlet.ts'
import type { OutletPolicy, TurnRequest } from '../kernel/ports.ts'
import type { MemoryLog } from '../memory/log.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { InboundEvent } from '../protocol/events.ts'
import type { CommitmentRow, DeskRow } from '../protocol/objects.ts'
import { DESK_TOOL_NAMES } from '../protocol/tools.ts'
import { compileDossier, splitBySender } from './dossier.ts'
import { compileNow } from './now.ts'
import { selfCheck, type SelfCheckResult } from './self-check.ts'
import { DESK_REFUSAL, deskMayRun, type ToolFace } from './toolface.ts'
import { createDeskTools, type DeskHandlers, type DocArea } from './tools.ts'
import { audienceOf, buildView, dossierFingerprint, newTurnContext, windowOf, type TurnContext } from './turn.ts'
import { attributeTurnEnd } from '../judgment/translate.ts'

export interface DeskConfig {
  seatDir: string
  preset: string
  model?: { provider: string; model: string; effort?: string }
  idleEvictMs: number
  rotateEvents: number
  collectWindowMs: number
  dossierTokens: number
  /** Owner principal (union_id): decides owner_p2p and owner-said. */
  owner: string
  /** Executor candidates for `commit`, formatted for the dossier reader (`08` 派给谁). */
  executorCandidates?: readonly string[]
  tz?: string
}

export interface DeskDeps {
  ledger: Ledger
  controller: () => SessionControllerFace
  clock: HostClock
  log: HostLog
  memory: MemoryLog
  docs: DocArea
  outlet: Outlet
  outletPolicy: OutletPolicy
  mode: () => 'responder' | 'shadow' | 'superagent'
  handlers: DeskHandlers
  toolface: ToolFace
  config: () => DeskConfig
  /** degrade_event belongs to recovery; the desk reports, the composition root writes. */
  degrade: (entry: { reason: string; scope: string; now: number }) => void
  /** Closes the open degradation once the condition is healthy again (desk_toolface, desk_unavailable). */
  recover?: (entry: { reason: string; scope: string }) => void
}

export interface TurnOutcome { deliberationId: string; ops: number; endReason: string }

export interface Presence {
  enqueue(event: InboundEvent): void
  runTurn(trigger: TurnRequest): Promise<TurnOutcome>
  evictIdle(now: number): string[]
  rotate(deskId: string, reason: 'events' | 'day' | 'manual'): number
  modelFor(sessionId: string): { provider: string; model: string; effort?: string } | undefined
  roleOf(sessionId: string): `desk:${string}` | undefined
  /** Closes collect windows, launches queued turns, retries deferred agenda turns, times out stuck turns. */
  tick(now: number): Promise<string[]>
  /** Forwarded session/event of a desk session (turn/end, tool calls). */
  onSessionEvent(sessionId: string, event: unknown): void
  /** Self-check of every desk with a session; failing desks are not enabled. */
  startupCheck(): Promise<{ enabled: string[]; disabled: string[] }>
  /**
   * Close turns no live process is running (11: a `turn/end` lost to a crash or a
   * hot-reload window must not leave the desk mute forever). At boot every running
   * row is stale by definition; afterwards only rows past the turn timeout are.
   * @returns how many deliberations were closed.
   */
  settleStaleTurns(now: number, opts: { boot: boolean }): number
  /** Resolves when every launched turn has finished. */
  drain(): Promise<void>
}

export const AGENDA_DEFER_MS = 60_000
export const AGENDA_DEFER_MAX = 5
export const TURN_TIMEOUT_MS = 600_000
/** Said when a turn is abandoned by the timeout: the person gets a closing line, not silence. */
export const TURN_TIMEOUT_MESSAGE = '这条我处理超时了，要我重试吗'
/** Consecutive session-creation failures before the desk stops trying and explains (T31). */
export const MAX_SESSION_FAILURES = 3
/** After the failure cap the batch waits one agenda window instead of looping. */
export const PENDING_CLOSE_RETRY_MS = AGENDA_DEFER_MS
export const sessionFailureMessage = (reason: string): string => `这个对话我起不来（原因：${reason}），稍后再试`
/**
 * Cumulative failed turns per event before its intake is closed terminally. The
 * count is read from the ledger (error deliberations whose rule_trace lists the
 * event, or whose request id names it), so neither a desk-level reset nor a
 * restart starts it again: a permanent host failure costs at most this many turns.
 */
export const MAX_EVENT_FAILURES = 3
export const eventFailureReason = (n: number, code: string, message: string): string =>
  `host fallback: desk failed ${n} turns on this event [${code}] ${message}`.slice(0, 500)

/** The host's error code: an explicit \`code\`, else the error class name. */
export function hostCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code !== '') return code
  return error instanceof Error ? error.name : 'Error'
}
export const ACK_REACT_MS = 20_000
export const ACK_TEMPLATE_MS = 60_000
export const ACK_TEMPLATE = '收到，正在判断'
export const FALLBACK_REACTION = 'OK'

const D = PHYSICAL.desk
const C = PHYSICAL.commitment

export const deskIdOf = (event: InboundEvent): string => `${event.chat.type}:${event.chat.id}`
export const deskSessionId = (deskId: string, generation: number): string => `sa-desk-${deskId.replace(/:/g, '')}-g${generation}`

interface Inflight { deskId: string; sessionId: string; startedAt: number; human: boolean; done: Promise<TurnOutcome>; ctx?: TurnContext; reacted: boolean; templated: boolean }

export function createPresence(deps: DeskDeps): Presence {
  const { ledger, log } = deps
  const cfg = (): DeskConfig => deps.config()
  const writeDesk = (sql: string, ...p: Array<string | number | null>): number => ledger.open(tx => tx.run(sql, ...p).changes, { module: 'desk' })
  const deskRow = (id: string): DeskRow | undefined => ledger.read.get<DeskRow>(`SELECT * FROM ${D} WHERE desk_id = ?`, id)
  const deskBySession = (sid: string): DeskRow | undefined => ledger.read.get<DeskRow>(`SELECT * FROM ${D} WHERE session_id = ?`, sid)

  const pending = new Map<string, { firstAt: number; events: InboundEvent[] }>()
  const queued = new Map<string, InboundEvent[][]>()
  const unjudgedStreak = new Map<string, number>()
  const turns = new Map<string, TurnContext>()
  const waiters = new Map<string, (kind: string) => void>()
  const inflight = new Map<string, Inflight>()
  const violations = new Map<string, number>()
  const callNames = new Map<string, Map<string, string>>()
  const disposers = new Map<string, () => void>()
  const disabled = new Set<string>()
  const deferrals = new Map<string, number>()
  /** Consecutive session-creation failures per desk (T31). */
  const sessionFailures = new Map<string, number>()
  /** Desks whose batch is marked pending_close: the queue waits until this timestamp. */
  const pendingClose = new Map<string, number>()
  let agendaRetries: { at: number; trigger: TurnRequest }[] = []
  let requestSeq = 0

  const tools = createDeskTools({ ledger, memory: deps.memory, docs: deps.docs, outlet: deps.outlet, outletPolicy: deps.outletPolicy,
    mode: deps.mode, handlers: deps.handlers, owner: cfg().owner, turnOf: sid => turns.get(sid) })

  function rotate(deskId: string, _reason: 'events' | 'day' | 'manual'): number {
    const desk = deskRow(deskId)
    if (!desk) throw new Error(`desk ${deskId} does not exist`)
    if (desk.session_id) { disposers.get(desk.session_id)?.(); disposers.delete(desk.session_id) }
    writeDesk(`UPDATE ${D} SET generation = generation + 1, session_id = NULL, event_count = 0, updated_at = ? WHERE desk_id = ?`, ledger.nowMs(), deskId)
    return desk.generation + 1
  }

  const dayOf = (ms: number): string => new Date(ms).toLocaleDateString('en-CA', cfg().tz ? { timeZone: cfg().tz } : {})

  /** Lazy creation; rotation by event count or local day first. */
  async function ensureSession(deskId: string, now: number): Promise<string> {
    let desk = deskRow(deskId) as DeskRow
    if (desk.session_id && desk.event_count >= cfg().rotateEvents) { rotate(deskId, 'events'); desk = deskRow(deskId) as DeskRow }
    else if (desk.session_id && desk.last_event_at !== null && dayOf(desk.last_event_at) !== dayOf(now)) { rotate(deskId, 'day'); desk = deskRow(deskId) as DeskRow }
    if (desk.session_id) return desk.session_id
    const sessionId = deskSessionId(deskId, desk.generation)
    await deps.controller().create({ sessionId, cwd: cfg().seatDir, agentPreset: cfg().preset })
    disposers.set(sessionId, await deps.toolface.apply(sessionId, tools))
    writeDesk(`UPDATE ${D} SET session_id = ?, updated_at = ? WHERE desk_id = ?`, sessionId, now, deskId)
    return sessionId
  }

  function chatOf(deskId: string): string { return deskId.slice(deskId.indexOf(':') + 1) }

  /**
   * A failed self-check is an internal fault (B14): it self-heals or degrades, it is
   * never put to the owner. Degradation plus log only; no outbound line (R5).
   */
  function alertToolface(deskId: string, now: number, detail: SelfCheckResult): void {
    deps.degrade({ reason: 'desk_toolface', scope: deskId, now })
    log.warn(`desk ${deskId}: tool face self-check failed ${JSON.stringify(detail)}`)
  }

  /** The self-check failure as a host error, so the per-event cap reads one shape. */
  function selfCheckError(check: SelfCheckResult): Error {
    const detail = { missing: check.missing, denied_visible: check.denied_visible, violations: check.violations }
    return Object.assign(new Error(`selfcheck ${JSON.stringify(detail)}`), { code: 'selfcheck' })
  }

  const humanBusy = (deskId: string): boolean =>
    (pending.get(deskId)?.events.length ?? 0) > 0 || (queued.get(deskId)?.length ?? 0) > 0
    || [...inflight.values()].some(t => t.deskId === deskId && t.human)

  function finish(deliberationId: string, r: Parameters<import('../kernel/ledger.ts').KernelTx['finishTurn']>[1]): void {
    finishTurnAndPush(ledger, 'desk', deliberationId, r)
  }

  /** Events of the batch nobody judged: back to the queue once, host fallback on the second miss. */
  function settleUnjudged(ctx: TurnContext): void {
    const shadow: 0 | 1 = ctx.shadow ? 1 : 0
    const retry: InboundEvent[] = []
    for (const event of ctx.batch) {
      if (ctx.judged.has(event.event_id)) continue
      const row = ledger.read.get<{ state: string }>(`SELECT state FROM ${PHYSICAL.intake} WHERE event_id = ? AND shadow = ?`, event.event_id, shadow)
      if (!row || row.state === 'disposed') continue
      const streak = (unjudgedStreak.get(event.event_id) ?? 0) + 1
      unjudgedStreak.set(event.event_id, streak)
      ctx.toolErrors += 1
      if (streak < 2) { retry.push(event); continue }
      unjudgedStreak.delete(event.event_id)
      ledger.open(tx => tx.disposeIntake(event.event_id, shadow, { disposition: 'acknowledge', reason: 'host fallback: not judged in two turns' }), { module: 'desk', shadow: ctx.shadow })
      if (!ctx.shadow) {
        deps.outlet.submit({ event_id: event.event_id, chat_id: ctx.chatId, reply_to: event.message_id, moment: 'ack', audience: 'requester',
          payload: 'react', text: FALLBACK_REACTION, idem_key: `sa:fb:${event.event_id}`.slice(0, 50) }, deps.outletPolicy, deps.mode())
      }
    }
    if (retry.length) queued.set(ctx.deskId, [retry, ...(queued.get(ctx.deskId) ?? [])])
  }

  /** Failed turns recorded against one event so far (this turn's row included once finished). */
  function failuresOf(eventId: string): number {
    // error: the host refused (T31 storm); blocked: the self-check refused. Both are host-side, both count.
    return ledger.read.get<{ n: number }>(`SELECT count(*) AS n FROM ${PHYSICAL.deliberation} d WHERE d.end_reason IN ('error', 'blocked')
      AND ((json_valid(d.rule_trace) AND EXISTS (SELECT 1 FROM json_each(d.rule_trace, '$.events') j WHERE j.value = ?))
        OR d.request_id LIKE 'in:' || ? || ':%')`, eventId, eventId)?.n ?? 0
  }

  /**
   * After a failed human turn: events under the cap go back to the queue; an event
   * at the cap is disposed terminally (acknowledge, the reason names the host error)
   * and is never retried. The caller keeps the desk's degradation open until a turn
   * gets a session again (recover; the registry keeps one open row per scope).
   */
  function settleFailed(deskId: string, batch: readonly InboundEvent[], error: unknown): { retry: InboundEvent[]; closed: number } {
    const code = hostCodeOf(error)
    const message = error instanceof Error ? error.message : String(error)
    const retry: InboundEvent[] = []
    let closed = 0
    for (const event of batch) {
      const rows = ledger.read.all<{ shadow: number }>(`SELECT shadow FROM ${PHYSICAL.intake} WHERE event_id = ? AND state != 'disposed'`, event.event_id)
      if (!rows.length) continue
      const n = failuresOf(event.event_id)
      if (n < MAX_EVENT_FAILURES) { retry.push(event); continue }
      for (const row of rows) {
        const shadow: 0 | 1 = row.shadow === 1 ? 1 : 0
        ledger.open(tx => tx.disposeIntake(event.event_id, shadow, { disposition: 'acknowledge', reason: eventFailureReason(n, code, message) }),
          { module: 'desk', shadow: shadow === 1 })
      }
      closed += 1
      log.warn(`desk ${deskId}: event ${event.event_id} closed after ${n} failed turns [${code}]`)
    }
    return { retry, closed }
  }

  /**
   * A turn abandoned by the timeout must not leave the person with only the ack.
   * `END_REASONS` is a closed protocol set (N6), so the abandonment is recorded in
   * the journal body (`{closed:'timeout'}`) and in the turn's rule trace; the
   * deliberation row keeps `end_reason='unknown'`, which downstream already treats
   * as a failure.
   */
  function closeTimedOut(deskId: string, trigger: TurnRequest, ctx: TurnContext): void {
    const target = trigger.commitment_id ?? ledger.read.get<CommitmentRow>(
      `SELECT * FROM ${C} WHERE desk_id = ? ORDER BY n DESC LIMIT 1`, deskId)?.commitment_id
    if (target !== undefined) {
      ledger.open(tx => tx.append(target, {
        actor: 'desk', kind: 'state',
        body: { closed: 'timeout', deliberation_id: trigger.deliberation_id },
      }), { module: 'desk' })
    }
    if (ctx.shadow) return
    const first = ctx.batch[0]
    // No `event_id`: that event already got its ack, and one inbound allows one
    // reply-tier line. The closing line is a new line in the same chat. The host
    // prefix (`cannot:`) is what lets the outlet accept it: a model-authored
    // `cannot` still has to earn its moment through a broken commitment.
    deps.outlet.submit({
      ...(first ? { reply_to: first.message_id } : {}),
      chat_id: ctx.chatId, moment: 'cannot', audience: 'requester', payload: 'text',
      text: TURN_TIMEOUT_MESSAGE,
      idem_key: `cannot:${trigger.deliberation_id}`.slice(0, 50),
    }, deps.outletPolicy, deps.mode())
  }

  async function runTurn(trigger: TurnRequest, batch: readonly InboundEvent[] = []): Promise<TurnOutcome> {
    const now = ledger.nowMs()
    const human = trigger.trigger_kind === 'intake'
    const deskId = trigger.desk_id ?? (trigger.commitment_id
      ? ledger.read.get<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} WHERE commitment_id = ?`, trigger.commitment_id)?.desk_id ?? undefined
      : undefined)
    const out = (endReason: string, ops = 0): TurnOutcome => ({ deliberationId: trigger.deliberation_id, ops, endReason })
    if (!deskId || !deskRow(deskId)) { finish(trigger.deliberation_id, { ops: 0, tool_errors: 0, tokens: 0, end_reason: 'error', rule_trace: { reason: 'no desk' } }); return out('error') }
    if (disabled.has(deskId)) return out('disabled')

    if (!human && humanBusy(deskId)) {
      const n = deferrals.get(trigger.deliberation_id) ?? 0
      if (n < AGENDA_DEFER_MAX) {
        deferrals.set(trigger.deliberation_id, n + 1)
        agendaRetries.push({ at: now + AGENDA_DEFER_MS, trigger })
        return out('deferred')
      }
    }
    const desk = deskRow(deskId) as DeskRow
    if (desk.turn_open === 1) {
      if (!human) agendaRetries.push({ at: now + AGENDA_DEFER_MS, trigger })
      return out('busy')
    }
    deferrals.delete(trigger.deliberation_id)
    writeDesk(`UPDATE ${D} SET turn_open = 1, updated_at = ? WHERE desk_id = ?`, now, deskId)
    // The turn is taken now: running + started_at (idle-rate and fingerprint readings key on it).
    writeDesk(`UPDATE ${PHYSICAL.deliberation} SET state = 'running', started_at = coalesce(started_at, ?), desk_id = coalesce(desk_id, ?), updated_at = ?
      WHERE deliberation_id = ? AND state = 'requested'`, now, deskId, now, trigger.deliberation_id)
    const closeDesk = (): void => {
      writeDesk(`UPDATE ${D} SET turn_open = 0, event_count = event_count + ?, last_event_at = coalesce(?, last_event_at), updated_at = ? WHERE desk_id = ?`,
        batch.length, batch.length ? ledger.nowMs() : null, ledger.nowMs(), deskId)
    }

    let sessionId: string
    try {
      sessionId = await ensureSession(deskId, now)
      sessionFailures.delete(deskId)
      deps.recover?.({ reason: 'desk_unavailable', scope: deskId })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const failures = (sessionFailures.get(deskId) ?? 0) + 1
      sessionFailures.set(deskId, failures)
      const capped = failures >= MAX_SESSION_FAILURES
      log.warn(`desk ${deskId}: session create failed ${failures}/${MAX_SESSION_FAILURES}: ${reason}`)
      finish(trigger.deliberation_id, {
        ops: 0, tool_errors: 0, tokens: 0, end_reason: 'error',
        rule_trace: { reason, code: hostCodeOf(error), events: batch.map(e => e.event_id), session_failures: failures, pending_close: capped },
      })
      closeDesk()
      if (capped) sessionFailures.delete(deskId)
      const { retry, closed } = human ? settleFailed(deskId, batch, error) : { retry: [], closed: 0 }
      // One error row per turn: the degradation is recorded on the first failure, at
      // the cap and when an event is closed, never once per retry.
      if (failures === 1 || capped || closed) deps.degrade({ reason: 'desk_unavailable', scope: deskId, now })
      if (retry.length) queued.set(deskId, [retry, ...(queued.get(deskId) ?? [])])
      if (!capped) return out('error')
      // Cap reached: stop looping, tell the person once, and let the agenda retry the
      // kept batch after a window. `pending_close` is the marker the tick honours.
      if (retry.length) pendingClose.set(deskId, ledger.nowMs() + PENDING_CLOSE_RETRY_MS)
      if (human && deps.mode() !== 'shadow') {
        deps.outlet.submit({
          ...(batch[0] ? { event_id: batch[0].event_id, reply_to: batch[0].message_id } : {}),
          chat_id: chatOf(deskId), moment: 'cannot', audience: 'requester', payload: 'text',
          text: sessionFailureMessage(reason),
          idem_key: `sa:dc:${deskId.replace(/:/g, '')}:${windowOf(now)}`.slice(0, 50),
        }, deps.outletPolicy, deps.mode())
      }
      return out('error')
    }

    // Fail closed before anything reaches the model.
    const check = selfCheck(await deps.toolface.visible(sessionId), violations.get(sessionId) ?? 0)
    if (!check.ok) {
      alertToolface(deskId, now, check)
      finish(trigger.deliberation_id, { ops: 0, tool_errors: 0, tokens: 0, end_reason: 'blocked',
        rule_trace: { selfcheck: check, code: 'selfcheck', events: batch.map(e => e.event_id) } })
      closeDesk()
      // Self-healing failure: the batch retries after a window under the same per-event
      // cap as host errors; at the cap the intake closes with the self-check detail.
      const { retry } = human ? settleFailed(deskId, batch, selfCheckError(check)) : { retry: [] }
      if (retry.length) {
        queued.set(deskId, [retry, ...(queued.get(deskId) ?? [])])
        pendingClose.set(deskId, ledger.nowMs() + PENDING_CLOSE_RETRY_MS)
      }
      return out('toolface')
    }
    deps.recover?.({ reason: 'desk_toolface', scope: deskId })

    const current = deskRow(deskId) as DeskRow
    const owner = cfg().owner
    const view = buildView(ledger.read, owner, now)
    const audience = audienceOf(current, batch, owner)
    const projection = compileNow(view, audience)
    const dossier = compileDossier(view, projection, batch,
      { tz: cfg().tz ?? 'UTC', nowMs: now, generation: current.generation, deskLabel: deskId,
        executorCandidates: cfg().executorCandidates ?? [] }, cfg().dossierTokens)
    const ctx = newTurnContext({ deskId, chatId: chatOf(deskId), sessionId, deliberationId: trigger.deliberation_id,
      shadow: deps.mode() === 'shadow', batch, audience })
    turns.set(sessionId, ctx)
    const record = inflight.get(trigger.deliberation_id)
    if (record) record.ctx = ctx

    const ended = new Promise<string>(resolve => waiters.set(sessionId, resolve))
    try {
      await deps.controller().prompt({ requestId: trigger.request_id, sessionId, mode: 'queue',
        content: [{ type: 'text', text: dossier.text }] }, AbortSignal.timeout(60_000))
    } catch (error) {
      waiters.delete(sessionId)
      turns.delete(sessionId)
      deps.degrade({ reason: 'desk_unavailable', scope: deskId, now })
      finish(trigger.deliberation_id, { ops: 0, tool_errors: 0, tokens: 0, end_reason: 'error',
        rule_trace: { reason: String(error), code: hostCodeOf(error), events: batch.map(e => e.event_id) } })
      closeDesk()
      const { retry } = human ? settleFailed(deskId, batch, error) : { retry: [] }
      if (retry.length) queued.set(deskId, [retry, ...(queued.get(deskId) ?? [])])
      return out('error')
    }
    startedSignal.get(trigger.deliberation_id)?.()

    const endKind = await ended
    const attributed = attributeTurnEnd(endKind, ctx.trace)
    turns.delete(sessionId)
    if (endKind === 'timeout') closeTimedOut(deskId, trigger, ctx)
    settleUnjudged(ctx)
    const finishedAt = ledger.nowMs()
    finish(trigger.deliberation_id, {
      ops: ctx.ops, tool_errors: ctx.toolErrors, tokens: 0, end_reason: attributed.end_reason,
      rule_trace: { tools: ctx.trace, ...(attributed.commit ? { commit: attributed.commit } : {}), ...(ctx.shadow ? { shadow_ops: ctx.shadowOps } : {}),
        selfcheck: { extra: check.extra, extra_count: check.extra_count, denied_visible: check.denied_visible, violations: check.violations },
        ...(endKind === 'timeout' ? { closed: 'timeout' } : {}), truncated: dossier.truncated, alarms: dossier.alarms },
      pub_hash: projection.pubHash, dossier_hash: dossierFingerprint(projection.pubHash, projection.audienceClass),
      audience_class: projection.audienceClass, dossier_tokens: dossier.tokens, window_id: windowOf(finishedAt),
    })
    closeDesk()
    return out(endKind, ctx.ops)
  }

  const startedSignal = new Map<string, () => void>()

  /** Launch a turn and wait until its prompt is out (or it ended early). */
  async function launch(trigger: TurnRequest, batch: readonly InboundEvent[], human: boolean, deskId: string): Promise<void> {
    let signal!: () => void
    const started = new Promise<void>(resolve => { signal = resolve })
    startedSignal.set(trigger.deliberation_id, signal)
    const record: Inflight = { deskId, sessionId: '', startedAt: ledger.nowMs(), human, reacted: false, templated: false, done: Promise.resolve(null as never) }
    inflight.set(trigger.deliberation_id, record)
    record.done = runTurn(trigger, batch).finally(() => {
      inflight.delete(trigger.deliberation_id)
      startedSignal.delete(trigger.deliberation_id)
      signal()
    })
    await started
  }

  function ackTimers(now: number): void {
    for (const t of inflight.values()) {
      if (!t.human || !t.ctx || t.ctx.sayCount > 0 || t.ctx.shadow) continue
      const first = t.ctx.batch[0]
      if (!first) continue
      if (!t.reacted && now - t.startedAt >= ACK_REACT_MS) {
        t.reacted = true
        deps.outlet.submit({ event_id: first.event_id, chat_id: t.ctx.chatId, reply_to: first.message_id, moment: 'ack', audience: 'requester',
          payload: 'react', text: FALLBACK_REACTION, idem_key: `sa:rx:${first.event_id}`.slice(0, 50) }, deps.outletPolicy, deps.mode())
      }
      if (!t.templated && now - t.startedAt >= ACK_TEMPLATE_MS) {
        t.templated = true
        // Deliberately without `event_id`: one inbound has one text reply (`02`), and
        // the fallback must not consume the slot the desk is still going to answer in.
        // The timeout line works the same way; the commit ack carries the event id.
        deps.outlet.submit({ chat_id: t.ctx.chatId, reply_to: first.message_id, moment: 'ack', audience: 'requester',
          payload: 'text', text: ACK_TEMPLATE, idem_key: `sa:ack:${first.event_id}`.slice(0, 50) }, deps.outletPolicy, deps.mode())
      }
    }
  }

  /**
   * Close turns the ledger still calls running but nothing in this process is.
   *
   * A crash or a hot-reload window loses the `turn/end`; without this the desk's
   * `turn_open` stays 1, `tick` skips the desk forever and every later message gets
   * only the 60-second acknowledgement. At boot every running row is stale by
   * definition (this process has not launched anything yet); during the clock the
   * turn timeout is the same threshold `tick` cancels at, so a live turn is never
   * closed out from under itself.
   */
  function settleStaleTurns(now: number, opts: { boot: boolean }): number {
    const rows = ledger.read.all<{ deliberation_id: string; desk_id: string | null; started_at: number | null }>(
      `SELECT deliberation_id, desk_id, started_at FROM ${PHYSICAL.deliberation} WHERE state = 'running'`)
    let closed = 0
    for (const row of rows) {
      if (inflight.has(row.deliberation_id)) continue
      if (!opts.boot && now - (row.started_at ?? now) < TURN_TIMEOUT_MS) continue
      try {
        ledger.open(tx => {
          tx.finishTurn(row.deliberation_id, { ops: 0, tool_errors: 0, tokens: 0, end_reason: 'orphaned',
            rule_trace: { reason: opts.boot ? 'stale turn closed at startup' : 'stale turn closed by reconcile' } })
          if (row.desk_id !== null) tx.run(`UPDATE ${D} SET turn_open = 0, updated_at = ? WHERE desk_id = ?`, tx.now, row.desk_id)
        }, { module: 'desk' })
        closed += 1
        log.warn(`desk ${row.desk_id ?? '?'}: closed stale turn ${row.deliberation_id} (${opts.boot ? 'startup' : 'reconcile'})`)
      } catch (error) {
        // Finished between the read and the write: nothing to repair.
        log.warn(`desk ${row.desk_id ?? '?'}: stale turn ${row.deliberation_id} already closed (${String(error)})`)
      }
    }
    // A desk flagged open with no running row behind it is stale by definition.
    ledger.open(tx => tx.run(`UPDATE ${D} SET turn_open = 0, updated_at = ? WHERE turn_open = 1
      AND NOT EXISTS (SELECT 1 FROM ${PHYSICAL.deliberation} AS d WHERE d.desk_id = ${D}.desk_id AND d.state = 'running')`, tx.now), { module: 'desk' })
    return closed
  }

  async function tick(now: number): Promise<string[]> {
    const launched: string[] = []
    for (const [deskId, p] of [...pending]) {
      if (now - p.firstAt < cfg().collectWindowMs) continue
      pending.delete(deskId)
      queued.set(deskId, [...(queued.get(deskId) ?? []), ...splitBySender(p.events)])
    }
    for (const [deskId, batches] of [...queued]) {
      if (!batches.length) { queued.delete(deskId); continue }
      const closeAt = pendingClose.get(deskId)
      if (closeAt !== undefined) {
        // pending_close: the batch is kept, the desk is not relaunched before the window.
        if (closeAt > now) continue
        pendingClose.delete(deskId)
      }
      if ([...inflight.values()].some(t => t.deskId === deskId) || deskRow(deskId)?.turn_open === 1) continue
      const batch = batches[0]
      requestSeq += 1
      const requestId = `in:${batch[0].event_id}:${requestSeq}`
      const deliberationId = ledger.open(tx => tx.requestTurn({ trigger_kind: 'intake', desk_id: deskId, request_id: requestId }), { module: 'desk', shadow: deps.mode() === 'shadow' })
      if (deliberationId === undefined) continue
      batches.shift()
      if (!batches.length) queued.delete(deskId)
      await launch({ deliberation_id: deliberationId, request_id: requestId, desk_id: deskId, trigger_kind: 'intake' }, batch, true, deskId)
      launched.push(deliberationId)
    }
    const due = agendaRetries.filter(r => r.at <= now)
    agendaRetries = agendaRetries.filter(r => r.at > now)
    for (const r of due) {
      await launch(r.trigger, [], false, r.trigger.desk_id ?? '')
      launched.push(r.trigger.deliberation_id)
    }
    for (const t of inflight.values()) {
      if (t.ctx && now - t.startedAt >= TURN_TIMEOUT_MS) {
        try { await deps.controller().cancel({ sessionId: t.ctx.sessionId }) } catch { /* the waiter still closes the turn */ }
        waiters.get(t.ctx.sessionId)?.('timeout')
        waiters.delete(t.ctx.sessionId)
      }
    }
    ackTimers(now)
    return launched
  }

  function onSessionEvent(sessionId: string, raw: unknown): void {
    const event = (typeof raw === 'object' && raw !== null && 'event' in raw && !('type' in raw) ? (raw as { event: unknown }).event : raw) as
      { type?: unknown; data?: Record<string, unknown> } | null
    if (!event || typeof event.type !== 'string') return
    const data = event.data ?? {}
    if (event.type === 'turn/end') {
      const reason = data.reason as { kind?: unknown } | undefined
      const resolve = waiters.get(sessionId)
      waiters.delete(sessionId)
      resolve?.(typeof reason?.kind === 'string' ? reason.kind : 'unknown')
      return
    }
    if (event.type === 'tool/call') {
      const names = callNames.get(sessionId) ?? new Map<string, string>()
      names.set(String(data.callId ?? ''), String(data.name ?? ''))
      callNames.set(sessionId, names)
      return
    }
    if (event.type === 'tool/result') {
      const message = data.message as { toolCallId?: unknown; content?: { text?: unknown }[] } | undefined
      const name = callNames.get(sessionId)?.get(String(message?.toolCallId ?? ''))
      if (name === undefined || deskMayRun(name)) return
      const text = (message?.content ?? []).map(b => (typeof b.text === 'string' ? b.text : '')).join('\n')
      // A tool outside the desk and dispatch sets that ran (no refusal): the face is broken.
      if (!text.includes(DESK_REFUSAL)) violations.set(sessionId, (violations.get(sessionId) ?? 0) + 1)
    }
  }

  return {
    enqueue(event) {
      const deskId = deskIdOf(event)
      const now = ledger.nowMs()
      writeDesk(`INSERT OR IGNORE INTO ${D} (desk_id, chat_id, chat_type, generation, turn_open, event_count, created_at, updated_at)
        VALUES (?, ?, ?, 0, 0, 0, ?, ?)`, deskId, event.chat.id, event.chat.type, now, now)
      const p = pending.get(deskId) ?? { firstAt: now, events: [] }
      p.events.push(event)
      pending.set(deskId, p)
    },
    runTurn: trigger => runTurn(trigger),
    evictIdle(now) {
      const idle = ledger.read.all<DeskRow>(`SELECT * FROM ${D} WHERE session_id IS NOT NULL AND turn_open = 0
        AND coalesce(last_event_at, created_at) < ?`, now - cfg().idleEvictMs)
      for (const desk of idle) {
        disposers.get(desk.session_id as string)?.()
        disposers.delete(desk.session_id as string)
        writeDesk(`UPDATE ${D} SET session_id = NULL, generation = generation + 1, updated_at = ? WHERE desk_id = ?`, now, desk.desk_id)
      }
      return idle.map(d => d.desk_id)
    },
    rotate,
    modelFor(sessionId) {
      const model = cfg().model
      return model && deskBySession(sessionId) ? { ...model } : undefined
    },
    roleOf(sessionId) {
      const desk = deskBySession(sessionId)
      return desk ? `desk:${desk.desk_id}` : undefined
    },
    tick,
    onSessionEvent,
    settleStaleTurns,
    async startupCheck() {
      const enabled: string[] = []
      const failed: string[] = []
      const now = ledger.nowMs()
      for (const desk of ledger.read.all<DeskRow>(`SELECT * FROM ${D} WHERE session_id IS NOT NULL ORDER BY desk_id`)) {
        const sessionId = desk.session_id as string
        try {
          const check = selfCheck(await deps.toolface.visible(sessionId), violations.get(sessionId) ?? 0)
          if (check.ok) { enabled.push(desk.desk_id); disabled.delete(desk.desk_id) }
          else { failed.push(desk.desk_id); disabled.add(desk.desk_id) }
        } catch (error) {
          // Cold start: the previous process's agent scope is gone. Drop the stale
          // binding so the next message recreates (same shape as idle eviction). A
          // dead scope must never abort the whole plugin load.
          log.warn(`desk ${desk.desk_id}: startup self-check skipped (${error instanceof Error ? error.message : String(error)}); clearing stale session`)
          writeDesk(`UPDATE ${D} SET session_id = NULL, generation = generation + 1, updated_at = ? WHERE desk_id = ?`, now, desk.desk_id)
          disabled.delete(desk.desk_id)
        }
      }
      return { enabled, disabled: failed }
    },
    async drain() {
      while (inflight.size) await Promise.all([...inflight.values()].map(t => t.done))
    },
  }
}
