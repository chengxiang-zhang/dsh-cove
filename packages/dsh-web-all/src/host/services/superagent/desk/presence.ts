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
import { selfCheck, TOOLFACE_ALERT, TOOLFACE_ALERT_EVERY_MS } from './self-check.ts'
import { DESK_REFUSAL, type ToolFace } from './toolface.ts'
import { createDeskTools, type DeskHandlers, type DocArea } from './tools.ts'
import { audienceOf, buildView, dossierFingerprint, newTurnContext, windowOf, type TurnContext } from './turn.ts'

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
  /** Resolves when every launched turn has finished. */
  drain(): Promise<void>
}

export const AGENDA_DEFER_MS = 60_000
export const AGENDA_DEFER_MAX = 5
export const TURN_TIMEOUT_MS = 600_000
export const ACK_REACT_MS = 20_000
export const ACK_TEMPLATE_MS = 60_000
export const ACK_TEMPLATE = '收到，正在判断'
export const FALLBACK_REACTION = 'OK'

const D = PHYSICAL.desk

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
  const lastAlert = new Map<string, number>()
  const deferrals = new Map<string, number>()
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

  function alertToolface(deskId: string, now: number, detail: unknown): void {
    deps.degrade({ reason: 'desk_toolface', scope: deskId, now })
    log.warn(`desk ${deskId}: tool face self-check failed ${JSON.stringify(detail)}`)
    if ((lastAlert.get(deskId) ?? -Infinity) + TOOLFACE_ALERT_EVERY_MS > now) return
    lastAlert.set(deskId, now)
    deps.outlet.submit({ chat_id: chatOf(deskId), moment: 'alert', audience: 'requester', payload: 'text', text: TOOLFACE_ALERT,
      idem_key: `sa:toolface:${deskId.replace(/:/g, '')}:${windowOf(now)}`.slice(0, 50) }, deps.outletPolicy, deps.mode())
  }

  const humanBusy = (deskId: string): boolean =>
    (pending.get(deskId)?.events.length ?? 0) > 0 || (queued.get(deskId)?.length ?? 0) > 0
    || [...inflight.values()].some(t => t.deskId === deskId && t.human)

  function finish(deliberationId: string, r: Parameters<import('../kernel/ledger.ts').KernelTx['finishTurn']>[1]): void {
    ledger.open(tx => tx.finishTurn(deliberationId, r))
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
      ledger.open(tx => tx.disposeIntake(event.event_id, shadow, { disposition: 'acknowledge', reason: 'host fallback: not judged in two turns' }), { shadow: ctx.shadow })
      if (!ctx.shadow) {
        deps.outlet.submit({ event_id: event.event_id, chat_id: ctx.chatId, reply_to: event.message_id, moment: 'ack', audience: 'requester',
          payload: 'react', text: FALLBACK_REACTION, idem_key: `sa:fb:${event.event_id}`.slice(0, 50) }, deps.outletPolicy, deps.mode())
      }
    }
    if (retry.length) queued.set(ctx.deskId, [retry, ...(queued.get(ctx.deskId) ?? [])])
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
    const closeDesk = (): void => {
      writeDesk(`UPDATE ${D} SET turn_open = 0, event_count = event_count + ?, last_event_at = coalesce(?, last_event_at), updated_at = ? WHERE desk_id = ?`,
        batch.length, batch.length ? ledger.nowMs() : null, ledger.nowMs(), deskId)
    }

    let sessionId: string
    try {
      sessionId = await ensureSession(deskId, now)
    } catch (error) {
      deps.degrade({ reason: 'desk_unavailable', scope: deskId, now })
      finish(trigger.deliberation_id, { ops: 0, tool_errors: 0, tokens: 0, end_reason: 'error', rule_trace: { reason: String(error) } })
      closeDesk()
      if (human) queued.set(deskId, [batch.slice(), ...(queued.get(deskId) ?? [])])
      return out('error')
    }

    // Fail closed before anything reaches the model.
    const check = selfCheck(await deps.toolface.visible(sessionId), violations.get(sessionId) ?? 0)
    if (!check.ok) {
      alertToolface(deskId, now, check)
      finish(trigger.deliberation_id, { ops: 0, tool_errors: 0, tokens: 0, end_reason: 'blocked', rule_trace: { selfcheck: check } })
      closeDesk()
      return out('toolface')
    }

    const current = deskRow(deskId) as DeskRow
    const owner = cfg().owner
    const view = buildView(ledger.read, owner, now)
    const audience = audienceOf(current, batch, owner)
    const projection = compileNow(view, audience)
    const dossier = compileDossier(view, projection, batch,
      { tz: cfg().tz ?? 'UTC', nowMs: now, generation: current.generation, deskLabel: deskId }, cfg().dossierTokens)
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
      finish(trigger.deliberation_id, { ops: 0, tool_errors: 0, tokens: 0, end_reason: 'error', rule_trace: { reason: String(error) } })
      closeDesk()
      if (human) queued.set(deskId, [batch.slice(), ...(queued.get(deskId) ?? [])])
      return out('error')
    }
    startedSignal.get(trigger.deliberation_id)?.()

    const endKind = await ended
    turns.delete(sessionId)
    settleUnjudged(ctx)
    const finishedAt = ledger.nowMs()
    finish(trigger.deliberation_id, {
      ops: ctx.ops, tool_errors: ctx.toolErrors, tokens: 0, end_reason: endKind,
      rule_trace: { tools: ctx.trace, ...(ctx.shadow ? { shadow_ops: ctx.shadowOps } : {}), truncated: dossier.truncated, alarms: dossier.alarms },
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
        deps.outlet.submit({ event_id: first.event_id, chat_id: t.ctx.chatId, reply_to: first.message_id, moment: 'ack', audience: 'requester',
          payload: 'text', text: ACK_TEMPLATE, idem_key: `sa:ack:${first.event_id}`.slice(0, 50) }, deps.outletPolicy, deps.mode())
      }
    }
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
      if ([...inflight.values()].some(t => t.deskId === deskId) || deskRow(deskId)?.turn_open === 1) continue
      const batch = batches[0]
      requestSeq += 1
      const requestId = `in:${batch[0].event_id}:${requestSeq}`
      const deliberationId = ledger.open(tx => tx.requestTurn({ trigger_kind: 'intake', desk_id: deskId, request_id: requestId }), { shadow: deps.mode() === 'shadow' })
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
      if (name === undefined || (DESK_TOOL_NAMES as readonly string[]).includes(name)) return
      const text = (message?.content ?? []).map(b => (typeof b.text === 'string' ? b.text : '')).join('\n')
      // A non-desk tool result that is not our refusal ran: the face is broken.
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
    async startupCheck() {
      const enabled: string[] = []
      const failed: string[] = []
      for (const desk of ledger.read.all<DeskRow>(`SELECT * FROM ${D} WHERE session_id IS NOT NULL ORDER BY desk_id`)) {
        const check = selfCheck(await deps.toolface.visible(desk.session_id as string), violations.get(desk.session_id as string) ?? 0)
        if (check.ok) { enabled.push(desk.desk_id); disabled.delete(desk.desk_id) } else { failed.push(desk.desk_id); disabled.add(desk.desk_id) }
      }
      return { enabled, disabled: failed }
    },
    async drain() {
      while (inflight.size) await Promise.all([...inflight.values()].map(t => t.done))
    },
  }
}
