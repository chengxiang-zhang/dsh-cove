/**
 * Executors (T19): dispatch, appended input, cancel, stop-loss and self-heal.
 *
 * Three stages (10): `commit` writes the commitment (open) and a pending attempt in
 * one transaction and says ack in the same turn; dispatch then runs asynchronously
 * (create session + first prompt(queue) -> running); a failed dispatch ends the
 * attempt as dispatch_failed and self-heals: one redispatch one tier up, then one
 * queued retry for the agenda, then broken with one `cannot` proposal.
 *
 * Every ledger write goes through named KernelTx methods; session facts are read
 * from events per the W0 spike readings (see ./events.ts).
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { HostClock, HostLog, SessionControllerFace } from '../host-ports.ts'
import type { KernelTx, Ledger } from '../kernel/ledger.ts'
import type { SpeechProposal } from '../kernel/ports.ts'
import { PHYSICAL } from '../protocol/db.ts'
import { parseEndReason, type AttemptRow, type CancelOrigin, type CommitmentRow, type EndReason } from '../protocol/objects.ts'
import type { ReportInput, ToolResult } from '../protocol/tools.ts'
import type { Placement, PlacementRequest } from '../world/place.ts'
import type { WorkspaceInput } from '../world/registry.ts'
import { extended, judgeBudget, ONESHOT_WALL_MS, PROGRESS_WINDOW_MS, type Budget } from './budget.ts'
import { callSignature, exitCodeOf, inputMarker, inputRequestIds, parseSessionEvent, TurnRanges, turnEndKind } from './events.ts'
import type { Profile, ProfileRegistry } from './profiles/index.ts'
import { createReportTool, type ToolDefinitionLike } from './report-tool.ts'

const A = PHYSICAL.attempt
const C = PHYSICAL.commitment
const J = PHYSICAL.journal
const MAX_ATTEMPTS = 3
const PROMPT_TIMEOUT_MS = 60_000
/**
 * Appended inputs delivered into one attempt before the rest wait for the next one.
 * A person talking continuously must not be able to interleave an unbounded number
 * of steers into a single attempt; past the cap the input keeps its journal row
 * (unique request_id) and rides the next attempt's brief.
 */
export const MAX_STEER_PER_ATTEMPT = 5
const SLOT = '1'

/** The narrow world surface executors use (T15). */
export interface ExecutorWorld {
  place(request: PlacementRequest): Placement
  registerWorkspace(tx: KernelTx, workspace: WorkspaceInput): void
}

export interface ExecutorDeps {
  ledger: Ledger
  controller: () => SessionControllerFace
  world: ExecutorWorld
  profiles: ProfileRegistry
  clock: HostClock
  log: HostLog
  seatRoot: string
  /** Outlet proposals (only `cannot` here); the composition root submits them. */
  speak?: (proposal: SpeechProposal) => void
  /** Only for a missing mandate or a missing machine: one question with a default. */
  askOwner?: (commitmentId: string, question: string, fallback: string) => void
  /** Scope path a durable workspace lands on; absent means the realm root. */
  workspacePath?: (commitment: CommitmentRow) => string | undefined
}

export type SuperviseAction = { attemptId: string; action: 'extend' | 'budget' | 'stall' | 'loop' }
export interface ToolLogEntry { callId: string; name: string; arguments: string; exit?: number }

export interface Executors {
  dispatch(commitmentId: string): Promise<{ attemptId: string; sessionId: string } | { failed: string }>
  sendInput(attemptId: string, requestId: string, text: string): Promise<{ consumedTurn?: number; mode: 'steer' | 'queue' }>
  cancel(attemptId: string, origin: CancelOrigin): Promise<void>
  onSessionEvent(sessionId: string, event: unknown): void
  modelFor(sessionId: string): { provider: string; model: string; effort?: string } | undefined
  roleOf(sessionId: string): `executor:${string}` | undefined
  report: ToolDefinitionLike
  /** Stop-loss and self-heal pass over running attempts; returns what it did. */
  supervise(now: number): Promise<SuperviseAction[]>
  /** For closure (T22): last turn end, last report and the tool log of an attempt. */
  lastTurnEnd(attemptId: string): { turn: number; reason: EndReason } | undefined
  lastReport(attemptId: string): ReportInput | undefined
  toolLog(attemptId: string): readonly ToolLogEntry[]
}

/** In the same transaction as createCommitment (T26 `commit`): the pending attempt. */
export function recordPendingAttempt(tx: KernelTx, commitmentId: string, profile: Profile, reason: string): AttemptRow {
  return tx.recordAttempt({ commitment_id: commitmentId, executor: profile.id, reason, lifetime: profile.lifetime,
    provider: profile.provider ?? null, model: profile.model ?? null, effort: profile.effort ?? null })
}

export const sessionIdOf = (commitmentId: string, n: number): string => `sa-x-${commitmentId}-a${n}`
export const oneshotDir = (seatRoot: string, attemptId: string): string => join(seatRoot, 'tmp', attemptId.replace(/[^\w.-]/g, '_'))
export const durableDir = (seatRoot: string, commitmentId: string): string => join(seatRoot, 'work', commitmentId)
export const branchOf = (commitmentId: string): string => `sa/${commitmentId}`

class DispatchFailure extends Error {
  constructor(message: string, readonly needsOwner: boolean) { super(message) }
}

interface SessionState {
  ranges: TurnRanges
  lastEnd?: { turn: number; reason: EndReason }
  report?: ReportInput
  calls: ToolLogEntry[]
}

export function createExecutors(deps: ExecutorDeps): Executors {
  const { ledger, profiles, log } = deps
  const sessions = new Map<string, SessionState>()
  /** Steers delivered per attempt (process-local); the queue path stays safe regardless. */
  const steers = new Map<string, number>()
  const stateOf = (sessionId: string): SessionState => {
    let s = sessions.get(sessionId)
    if (!s) { s = { ranges: new TurnRanges(), calls: [] }; sessions.set(sessionId, s) }
    return s
  }
  const write = <T>(fn: (tx: KernelTx) => T): T => ledger.open(fn, { module: 'executors' })
  const attemptById = (id: string): AttemptRow | undefined => ledger.read.get<AttemptRow>(`SELECT * FROM ${A} WHERE attempt_id = ?`, id)
  const attemptBySession = (sid: string): AttemptRow | undefined => ledger.read.get<AttemptRow>(`SELECT * FROM ${A} WHERE session_id = ?`, sid)
  const commitmentById = (id: string): CommitmentRow | undefined => ledger.read.get<CommitmentRow>(`SELECT * FROM ${C} WHERE commitment_id = ?`, id)

  function briefText(c: CommitmentRow): string {
    const brief = ledger.read.get<{ body_json: string | null }>(
      `SELECT body_json FROM ${J} WHERE commitment_id = ? AND kind = 'brief' ORDER BY seq DESC LIMIT 1`, c.commitment_id)
    const questions = ledger.read.all<{ question: string; taken: string; mode: string }>(
      `SELECT question, taken, mode FROM ${PHYSICAL.assumption} WHERE commitment_id = ? AND status = 'open' ORDER BY ordinal`, c.commitment_id)
    // R23: input appended while no attempt ran (amend -> next-attempt, passthrough) rides the
    // first prompt with its marker, so the consuming turn is recorded like any steered input.
    const pendingInput = ledger.read.all<{ request_id: string | null; body_json: string | null }>(
      `SELECT request_id, body_json FROM ${J} WHERE commitment_id = ? AND kind IN ('amend', 'passthrough')
       AND consumed_turn IS NULL AND request_id IS NOT NULL ORDER BY seq`, c.commitment_id)
    return [
      `Commitment ${c.commitment_id}: ${c.what}`,
      `Intent: ${c.intent}`,
      `Done when (${c.check_kind}): ${c.done_when}`,
      `Boundary: ${c.boundary ?? 'none stated'}`,
      `Context: ${brief?.body_json ?? 'none'}`,
      `Open assumptions: ${questions.length ? questions.map(q => `${q.question} -> ${q.taken} (${q.mode})`).join('; ') : 'none'}`,
      ...pendingInput.map(p => `Added input: ${p.body_json ?? ''} ${inputMarker(p.request_id as string)}`),
      'Report through the report tool: report(state: ready|progress|blocked|failed|dropped, summary, evidence?: [{command, exit, reading}], question?).',
      'For ready, list the exact commands you ran and their exit codes; blocked needs one question.',
    ].join('\n')
  }

  /**
   * Durable full deliver takes the single slot (D3, N2) by writing `slot='1'`; the
   * partial unique index ux_sa_commit_slot refuses a second holder among open and
   * at_risk commitments, so the check and the claim are one write.
   */
  function claimSlot(c: CommitmentRow): boolean {
    if (c.slot === SLOT) return true
    try {
      write(tx => tx.patchCommitment(c.commitment_id, { slot: SLOT }))
      return true
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) return false
      throw error
    }
  }

  function prepareCwd(c: CommitmentRow, a: AttemptRow, profile: Profile): string {
    if (profile.lifetime === 'oneshot') {
      const dir = oneshotDir(deps.seatRoot, a.attempt_id)
      mkdirSync(dir, { recursive: true })
      return dir
    }
    const placement = deps.world.place({
      what: c.what, check_kind: c.check_kind, principal: c.creditor, needsWrite: profile.tools === 'full',
      realm: 'local', workspace: 'new', executorClass: profile.id,
      ...(c.target ? { target: c.target } : {}), ...(deps.workspacePath?.(c) ? { path: deps.workspacePath(c) } : {}),
    })
    if ('denied' in placement) throw new DispatchFailure(`placement denied: ${placement.denied}`, true)
    const dir = durableDir(deps.seatRoot, c.commitment_id)
    mkdirSync(dir, { recursive: true })
    if (placement.mandateId) {
      ledger.open(tx => deps.world.registerWorkspace(tx, { path: placement.scopePath, entity_id: placement.host ?? 'local',
        commitment_id: c.commitment_id, mandate_id: placement.mandateId as string, branch: branchOf(c.commitment_id) }), { module: 'world' })
    }
    return dir
  }

  function cannotProposal(c: CommitmentRow, tried: string[]): void {
    const chat = c.desk_id?.includes(':') ? c.desk_id.slice(c.desk_id.indexOf(':') + 1) : (c.desk_id ?? '')
    deps.speak?.({ commitment_id: c.commitment_id, chat_id: chat, moment: 'cannot', audience: 'requester', payload: 'text',
      text: `${c.commitment_id} cannot be done for now. Tried: ${tried.join('; ')}.`, idem_key: `cannot:${c.commitment_id}` })
  }

  function triedSoFar(commitmentId: string): string[] {
    return ledger.read.all<{ n: number; executor: string; end_reason: string | null; cancel_origin: string | null }>(
      `SELECT n, executor, end_reason, cancel_origin FROM ${A} WHERE commitment_id = ? ORDER BY n`, commitmentId)
      .map(r => `a${r.n} ${r.executor} ${r.end_reason ?? 'open'}${r.cancel_origin ? `/${r.cancel_origin}` : ''}`)
  }

  function breakCommitment(commitmentId: string, why: string): void {
    const tried = triedSoFar(commitmentId)
    const c = write(tx => {
      tx.append(commitmentId, { actor: 'executors', kind: 'state', body: { broken: why, tried } })
      return tx.transition(commitmentId, 'broken', { ball: 'me' })
    })
    cannotProposal(c, tried)
  }

  /** Next attempt for the commitment, or broken when the three attempts are used. */
  function nextAttempt(commitmentId: string, profile: Profile, reason: string): AttemptRow | undefined {
    const used = ledger.read.get<{ n: number | null }>(`SELECT max(n) AS n FROM ${A} WHERE commitment_id = ?`, commitmentId)?.n ?? 0
    if (used >= MAX_ATTEMPTS) { breakCommitment(commitmentId, reason); return undefined }
    return write(tx => recordPendingAttempt(tx, commitmentId, profile, reason))
  }

  async function onDispatchFailure(a: AttemptRow, profile: Profile, error: unknown): Promise<{ attemptId: string; sessionId: string } | { failed: string }> {
    const reason = error instanceof Error ? error.message : String(error)
    const needsOwner = error instanceof DispatchFailure && error.needsOwner
    write(tx => {
      tx.updateAttempt(a.attempt_id, { state: 'ended', end_reason: 'dispatch_failed', cancel_origin: 'dispatch' })
      tx.append(a.commitment_id, { actor: 'executors', kind: 'state', body: { dispatch_failed: a.attempt_id, reason } })
    })
    if (a.session_id && a.lifetime === 'oneshot') rmSync(oneshotDir(deps.seatRoot, a.attempt_id), { recursive: true, force: true })
    log.warn(`executors: dispatch of ${a.attempt_id} failed: ${reason}`)
    const failures = ledger.read.get<{ k: number }>(
      `SELECT count(*) AS k FROM ${A} WHERE commitment_id = ? AND end_reason = 'dispatch_failed'`, a.commitment_id)?.k ?? 0

    if (needsOwner) {
      // New authority or a new machine is the only case worth a question; default = wait in the queue.
      deps.askOwner?.(a.commitment_id, `${a.commitment_id} needs ${reason.replace('placement denied: ', '')} to start`, 'queue and wait')
      nextAttempt(a.commitment_id, profile, `queued after ${reason}`)
      return { failed: reason }
    }
    if (failures >= MAX_ATTEMPTS) {
      breakCommitment(a.commitment_id, `dispatch failed ${failures} times`)
      return { failed: reason }
    }
    if (failures === 1) {
      // Self-heal: one immediate redispatch, one tier up when there is one.
      const next = profiles.higher(profile.id) ?? profile
      const retry = nextAttempt(a.commitment_id, next, `self-heal after dispatch failure: ${reason}`)
      if (!retry) return { failed: reason }
      return dispatch(a.commitment_id)
    }
    // Second failure: queue one more attempt for the agenda to retry.
    nextAttempt(a.commitment_id, profile, `queued for agenda retry after: ${reason}`)
    return { failed: reason }
  }

  async function dispatch(commitmentId: string): Promise<{ attemptId: string; sessionId: string } | { failed: string }> {
    const c = commitmentById(commitmentId)
    if (!c || !['open', 'at_risk'].includes(c.state)) return { failed: `commitment ${commitmentId} is not open` }
    const a = ledger.read.get<AttemptRow>(`SELECT * FROM ${A} WHERE commitment_id = ? AND state = 'pending' ORDER BY n DESC LIMIT 1`, commitmentId)
    if (!a) return { failed: `no pending attempt on ${commitmentId}` }
    const profile = profiles.get(a.executor)
    if (!profile) return onDispatchFailure(a, profiles.all()[0], new Error(`unknown executor profile ${a.executor}`))
    if (profile.lifetime === 'durable' && profile.tools === 'full' && c.kind === 'deliver' && !claimSlot(c)) {
      return { failed: 'SLOT_FULL' }   // stays pending; the agenda retries
    }
    const sessionId = sessionIdOf(c.commitment_id, a.n)
    try {
      const cwd = prepareCwd(c, a, profile)
      write(tx => tx.updateAttempt(a.attempt_id, { session_id: sessionId, cwd, provider: profile.provider ?? null,
        model: profile.model ?? null, effort: profile.effort ?? null, branch: profile.lifetime === 'durable' ? branchOf(c.commitment_id) : null }))
      const created = await deps.controller().create({ sessionId, cwd, agentPreset: profile.preset })
      // Record what the host reports, not what was asked (S2: the default preset is reported too).
      const reported = created as { sessionId?: unknown; agentPreset?: unknown }
      write(tx => tx.append(c.commitment_id, { actor: 'executors', kind: 'state', body: {
        dispatched: a.attempt_id, session_id: typeof reported.sessionId === 'string' ? reported.sessionId : sessionId,
        agentPreset: typeof reported.agentPreset === 'string' ? reported.agentPreset : null } }))
      await deps.controller().prompt({ requestId: `dispatch:${a.attempt_id}`, sessionId, mode: 'queue',
        content: [{ type: 'text', text: briefText(c) }] }, AbortSignal.timeout(PROMPT_TIMEOUT_MS))
      const now = attemptById(a.attempt_id)
      if (now?.state !== 'pending') {
        deps.controller().cancel({ sessionId })
        return { failed: `attempt ${a.attempt_id} was cancelled during dispatch` }
      }
      write(tx => tx.updateAttempt(a.attempt_id, { state: 'running' }))
      return { attemptId: a.attempt_id, sessionId }
    } catch (error) {
      return onDispatchFailure(attemptById(a.attempt_id) ?? a, profile, error)
    }
  }

  async function cancel(attemptId: string, origin: CancelOrigin): Promise<void> {
    const a = attemptById(attemptId)
    if (!a || a.state === 'ended') return
    if (a.session_id) {
      try { await deps.controller().cancel({ sessionId: a.session_id }) } catch (error) {
        log.warn(`executors: cancel of ${a.session_id} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    write(tx => {
      tx.updateAttempt(attemptId, { state: 'ended', end_reason: 'aborted', cancel_origin: origin })
      tx.append(a.commitment_id, { actor: 'executors', kind: 'state', body: { cancelled: attemptId, origin } })
    })
    steers.delete(attemptId)
    if (a.lifetime === 'oneshot') rmSync(oneshotDir(deps.seatRoot, attemptId), { recursive: true, force: true })
  }

  async function sendInput(attemptId: string, requestId: string, text: string): Promise<{ consumedTurn?: number; mode: 'steer' | 'queue' }> {
    const a = attemptById(attemptId)
    if (!a) throw new Error(`executors: unknown attempt ${attemptId}`)
    const known = ledger.read.get(`SELECT 1 FROM ${J} WHERE request_id = ?`, requestId)
    if (!known) write(tx => tx.append(a.commitment_id, { actor: 'executors', kind: 'amend', request_id: requestId, body: { text } }))
    // No live session: the next attempt carries it as context.
    if (a.state === 'ended' || !a.session_id) return { mode: 'queue' }
    const open = stateOf(a.session_id).ranges.isOpen()
    const delivered = steers.get(attemptId) ?? 0
    if (open && delivered >= MAX_STEER_PER_ATTEMPT) {
      // Cap reached: the journal row written above stays unconsumed, so the next
      // attempt's brief carries the input exactly once (R23). Nothing is dropped.
      log.warn(`executors: attempt ${attemptId} took ${delivered} steers; queued ${requestId} for the next attempt`)
      return { mode: 'queue' }
    }
    const mode = open ? 'steer' : 'queue'
    try {
      await deps.controller().prompt({ requestId, sessionId: a.session_id, mode,
        content: [{ type: 'text', text: `${text}\n${inputMarker(requestId)}` }] }, AbortSignal.timeout(PROMPT_TIMEOUT_MS))
    } catch (error) {
      log.warn(`executors: input ${requestId} not delivered: ${error instanceof Error ? error.message : String(error)}`)
      return { mode: 'queue' }
    }
    if (mode === 'steer') steers.set(attemptId, delivered + 1)
    return { mode }
  }

  function onSessionEvent(sessionId: string, raw: unknown): void {
    const event = parseSessionEvent(raw)
    if (!event) return
    const a = attemptBySession(sessionId)
    if (!a || a.state === 'ended') return
    const s = stateOf(sessionId)
    const d = event.data
    switch (event.type) {
      case 'turn/start': {
        const turn = typeof d.turn === 'number' ? d.turn : (s.ranges.last() ?? 0) + 1
        s.ranges.open(turn, event.seq)
        write(tx => tx.updateAttempt(a.attempt_id, { turn_open: 1, turns: a.turns + 1 }))
        return
      }
      case 'turn/end': {
        const turn = typeof d.turn === 'number' ? d.turn : s.ranges.last() ?? 0
        s.ranges.close(turn, event.seq)
        s.lastEnd = { turn, reason: parseEndReason(turnEndKind(d)) }
        write(tx => tx.updateAttempt(a.attempt_id, { turn_open: 0 }))
        return
      }
      case 'user/message': {
        // S4: no turn on the message; the open turn's seq range decides.
        const turn = s.ranges.turnOf(event.seq)
        if (turn === undefined) return
        for (const id of inputRequestIds(d)) write(tx => tx.markConsumed(id, turn))
        return
      }
      case 'tool/call': {
        const sig = callSignature(d)
        s.calls.push({ callId: String(d.callId ?? ''), name: String(d.name ?? ''), arguments: String(d.arguments ?? '') })
        write(tx => tx.updateAttempt(a.attempt_id, {
          tool_calls: a.tool_calls + 1, last_tool_at: event.time ?? deps.clock.now(),
          repeat_sig: sig, repeat_count: sig === a.repeat_sig ? a.repeat_count + 1 : 1,
        }))
        return
      }
      case 'tool/result': {
        const callId = typeof d.message === 'object' && d.message !== null ? String((d.message as { toolCallId?: unknown }).toolCallId ?? '') : ''
        const entry = [...s.calls].reverse().find(x => x.callId === callId)
        if (entry) entry.exit = exitCodeOf(d)
        return
      }
      default:
    }
  }

  function lineOf(c: CommitmentRow, a: AttemptRow): Budget | undefined {
    if (c.budget_wall_ms === null || c.budget_turns === null) return undefined
    return { wall_ms: a.lifetime === 'oneshot' ? Math.min(c.budget_wall_ms, ONESHOT_WALL_MS) : c.budget_wall_ms, turns: c.budget_turns }
  }

  async function redispatch(a: AttemptRow, profile: Profile, why: string): Promise<void> {
    if (nextAttempt(a.commitment_id, profile, why)) await dispatch(a.commitment_id)
  }

  async function supervise(now: number): Promise<SuperviseAction[]> {
    const actions: SuperviseAction[] = []
    const running = ledger.read.all<AttemptRow>(`SELECT * FROM ${A} WHERE state = 'running' ORDER BY attempt_id`)
    for (const a of running) {
      const c = commitmentById(a.commitment_id)
      const profile = profiles.get(a.executor)
      if (!c || !profile) continue
      const line = lineOf(c, a)
      const verdict = line === undefined ? 'ok' : judgeBudget({ now, startedAt: a.started_at ?? a.created_at, turns: a.turns, line,
        alreadyExtended: c.extended === 1, lastToolAt: a.last_tool_at, repeatCount: a.repeat_count })
      if (verdict === 'extend' && line) {
        // Once per commitment, at most +50% of the original line; the state is left alone.
        const wider = extended(line)
        write(tx => {
          tx.patchCommitment(c.commitment_id, { extended: 1, budget_wall_ms: wider.wall_ms, budget_turns: wider.turns })
          tx.append(c.commitment_id, { actor: 'executors', kind: 'state', body: { budget_extended: a.attempt_id, from: line, to: wider } })
        })
        actions.push({ attemptId: a.attempt_id, action: 'extend' })
        continue
      }
      if (verdict !== 'ok') {
        // Stop; escalation (T22) decides retry, upgrade or broken. No interrupt either way.
        await cancel(a.attempt_id, 'budget')
        actions.push({ attemptId: a.attempt_id, action: 'budget' })
        continue
      }
      if (a.repeat_count >= 3) {
        await cancel(a.attempt_id, 'loop')
        actions.push({ attemptId: a.attempt_id, action: 'loop' })
        await redispatch(a, profiles.higher(profile.id) ?? profile, `loop on ${a.repeat_sig ?? '?'}`)
        continue
      }
      if ((a.last_tool_at ?? a.started_at ?? a.created_at) <= now - 2 * PROGRESS_WINDOW_MS) {
        await cancel(a.attempt_id, 'stall')
        actions.push({ attemptId: a.attempt_id, action: 'stall' })
        await redispatch(a, profile, 'stall: two windows without a tool call')
      }
    }
    return actions
  }

  function acceptReport(sessionId: string, report: ReportInput): ToolResult<{ seq: number }> {
    const a = attemptBySession(sessionId)
    if (!a || a.state === 'ended') throw new Error(`report: session ${sessionId} is not a live executor`)
    stateOf(sessionId).report = report
    const seq = write(tx => tx.append(a.commitment_id, { actor: `executor:${a.executor}`, kind: 'report', body: { attempt_id: a.attempt_id, ...report } }))
    return { ok: true, seq }
  }

  const profileOfSession = (sessionId: string): Profile | undefined => {
    const a = attemptBySession(sessionId)
    return a ? profiles.get(a.executor) : undefined
  }

  return {
    dispatch,
    sendInput,
    cancel,
    onSessionEvent,
    supervise,
    report: createReportTool(acceptReport),
    modelFor(sessionId) {
      const p = profileOfSession(sessionId)
      if (!p?.provider || !p.model) return undefined
      return { provider: p.provider, model: p.model, ...(p.effort ? { effort: p.effort } : {}) }
    },
    roleOf(sessionId) {
      const a = attemptBySession(sessionId)
      return a ? `executor:${a.executor}` : undefined
    },
    lastTurnEnd(attemptId) {
      const a = attemptById(attemptId)
      return a?.session_id ? sessions.get(a.session_id)?.lastEnd : undefined
    },
    lastReport(attemptId) {
      const a = attemptById(attemptId)
      return a?.session_id ? sessions.get(a.session_id)?.report : undefined
    },
    toolLog(attemptId) {
      const a = attemptById(attemptId)
      return a?.session_id ? [...(sessions.get(a.session_id)?.calls ?? [])] : []
    },
  }
}
