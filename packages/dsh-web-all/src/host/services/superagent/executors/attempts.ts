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

import { mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HostClock, HostLog, SessionControllerFace } from '../host-ports.ts'
import { createInprocTransport } from './transport/inproc.ts'
import { ensureExecutorSession, realmOfTarget, scopePathOf, type ExecutorTransportFactory } from './transport/index.ts'
import type { ExecutorTransport } from './transport/types.ts'
import type { KernelTx, Ledger } from '../kernel/ledger.ts'
import type { SpeechProposal } from '../kernel/ports.ts'
import { PHYSICAL } from '../protocol/db.ts'
import { parseEndReason, type AttemptRow, type CancelOrigin, type CommitmentRow, type EndReason } from '../protocol/objects.ts'
import type { ReportInput, ToolResult } from '../protocol/tools.ts'
import type { Placement, PlacementRequest } from '../world/place.ts'
import type { WorkspaceInput } from '../world/registry.ts'
import { extended, judgeBudget, ONESHOT_WALL_MS, PROGRESS_WINDOW_MS, type Budget } from './budget.ts'
import { callSignature, contentText, exitCodeOf, inputMarker, inputRequestIds, parseSessionEvent, reportFromCall, reportFromText, TurnRanges, turnEndKind } from './events.ts'
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
  /** Dispatch transport; absent means the in-process one built from `controller`. */
  transport?: ExecutorTransportFactory
  /** Sink for transport-delivered session events; defaults to this module's own handler. */
  onEvent?: (sessionId: string, event: unknown) => void
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
  /** Last assistant message, for hosts that cannot compose this process's report tool. */
  lastText?: string
}

/**
 * The directory a world scope path names on this filesystem, or undefined when it
 * names none. The desk writes a target as `local/<absolute path>`, so the same value
 * that authorizes the scope also says where the work physically lives.
 */
export function workspaceDirOf(scopePath: string): string | undefined {
  const match = /^local(\/.*)$/.exec(scopePath.trim())
  if (match === null) return undefined
  const raw = (match[1] as string).replace(/\/+$/, '')
  if (!raw.startsWith('/')) return undefined
  try {
    if (statSync(raw).isDirectory()) return raw
  } catch {
    return undefined
  }
  // A target may name one file; its directory is then the place to work in.
  const parent = dirname(raw)
  try {
    return statSync(parent).isDirectory() ? parent : undefined
  } catch {
    return undefined
  }
}
export function createExecutors(deps: ExecutorDeps): Executors {
  const { ledger, profiles, log } = deps
  const sessions = new Map<string, SessionState>()
  /** Steers delivered per attempt (process-local); the queue path stays safe regardless. */
  const steers = new Map<string, number>()
  /** Attempts this process cancelled itself; a later `turn/end` is then not "external". */
  const cancelled = new Set<string>()
  /** Stop functions of the per-attempt event watchers. */
  const watchers = new Map<string, () => void>()
  const write = <T>(fn: (tx: KernelTx) => T): T => ledger.open(fn, { module: 'executors' })
  let localTransport: ExecutorTransport | undefined
  /** The transport of one target; `inproc` is the fallback when no factory is composed. */
  const transportFor = (target: string | null | undefined): ExecutorTransport => {
    if (deps.transport !== undefined) return deps.transport.forTarget(target)
    localTransport ??= createInprocTransport(deps.controller)
    return localTransport
  }
  const stateOf = (sessionId: string): SessionState => {
    let s = sessions.get(sessionId)
    if (!s) { s = { ranges: new TurnRanges(), calls: [] }; sessions.set(sessionId, s) }
    return s
  }
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
      ...(deps.transport?.kind === 'http'
        ? ['If the report tool is not available in this host, end your final message with one fenced JSON object of the same shape: {"state":"ready|progress|blocked|failed|dropped","summary":"...","evidence":[{"command":"...","exit":0,"reading":"..."}]}.']
        : []),
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

  /**
   * A dispatch that never reached `running` leaves the single slot claimed but
   * unused: the commitment stays open with the slot held and only a pending
   * retry, so every other durable deliver is wedged behind `ux_sa_commit_slot`
   * with no live seat to wait on. When no durable seat is live, release the slot
   * here; a later redispatch reclaims it through `claimSlot`, and the ledger
   * guard still refuses a release while a durable attempt is pending or running.
   */
  function releaseSlotIfIdle(commitmentId: string): void {
    const c = commitmentById(commitmentId)
    if (!c || c.slot === null) return
    const liveSeat = ledger.read.get(
      `SELECT 1 FROM ${A} WHERE commitment_id = ? AND lifetime = 'durable' AND state IN ('pending', 'running')`, commitmentId)
    if (liveSeat) return
    write(tx => tx.patchCommitment(commitmentId, { slot: null }))
  }

/** Where an attempt lands: the working directory and, for a durable seat, the machine. */
  function prepareCwd(c: CommitmentRow, a: AttemptRow, profile: Profile): { dir: string; host?: string } {
    if (profile.lifetime === 'oneshot') {
      // A one-shot seat is process-local by construction: its directory is created here.
      const dir = oneshotDir(deps.seatRoot, a.attempt_id)
      mkdirSync(dir, { recursive: true })
      // The same rule as a durable seat: the authorized target says where the work lives,
      // so a one-shot read still runs in the project it was asked about (C-23 counted lines
      // of a repository it had never entered).
      const scope = scopePathOf(c.target)
      const workspace = scope === undefined ? undefined : workspaceDirOf(scope)
      return { dir: workspace ?? dir }
    }
    // `04`: the target names the realm and machine; a bare commitment lands locally.
    const realm = realmOfTarget(c.target)
    const requestedPath = scopePathOf(c.target) ?? deps.workspacePath?.(c)
    const placement = deps.world.place({
      what: c.what, check_kind: c.check_kind, principal: c.creditor, needsWrite: profile.tools === 'full',
      realm: realm.realm, workspace: 'new', executorClass: profile.id,
      ...(realm.host === undefined ? {} : { host: realm.host }),
      ...(c.target ? { target: c.target } : {}), ...(requestedPath === undefined ? {} : { path: requestedPath }),
    })
    if ('denied' in placement) throw new DispatchFailure(`placement denied: ${placement.denied}`, true)
    const dir = durableDir(deps.seatRoot, c.commitment_id)
    mkdirSync(dir, { recursive: true })
    // The seat holds reports and logs; the work itself happens in the workspace the
    // authorized scope names. Leaving the session in an empty seat made every
    // relative path in a brief fail (C-17: both attempts reported a missing file).
    const workspaceDir = workspaceDirOf(placement.scopePath)
    if (placement.mandateId) {
      ledger.open(tx => deps.world.registerWorkspace(tx, { path: placement.scopePath, entity_id: placement.host ?? 'local',
        commitment_id: c.commitment_id, mandate_id: placement.mandateId as string, branch: branchOf(c.commitment_id) }), { module: 'world' })
    }
    return { dir: workspaceDir ?? dir, ...(placement.host === undefined ? {} : { host: placement.host }) }
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
    // The attempt just ended without a live seat; free the single slot before any
    // retry is queued so a failed durable dispatch cannot block the other durables.
    releaseSlotIfIdle(a.commitment_id)
    if (a.session_id && a.lifetime === 'oneshot') rmSync(oneshotDir(deps.seatRoot, a.attempt_id), { recursive: true, force: true })
    log.warn(`executors: dispatch of ${a.attempt_id} failed: ${reason}`)
    // Required setup and unknown session ownership are refusals, not capacity
    // failures: a higher profile would silently change the requested route.
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (['MODEL_UNAVAILABLE', 'PRESET_UNAVAILABLE', 'HOST_PROTOCOL', 'SESSION_CWD_CONFLICT'].includes(code)
      || /session\s+"[^"]+"\s+belongs to\s+"[^"]+",\s*not\s+"[^"]+"/iu.test(reason)) return { failed: reason }

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

  /**
   * I3: a running attempt must never hang on a commitment that already closed.
   * `dispatch` spans two awaits (session create, first prompt); release, escalation
   * or reconciliation can close the commitment inside either of them, so the state
   * is re-read on both sides of every await and the attempt is cancelled the moment
   * it is no longer dispatchable.
   */
  const commitmentOpen = (commitmentId: string): boolean => {
    const row = commitmentById(commitmentId)
    return row !== undefined && (row.state === 'open' || row.state === 'at_risk')
  }

  async function stillDispatchable(commitmentId: string, attemptId: string): Promise<boolean> {
    if (commitmentOpen(commitmentId)) return true
    if (attemptById(attemptId)?.state !== 'ended') {
      log.warn(`executors: commitment ${commitmentId} closed while dispatching ${attemptId}; cancelling`)
      await cancel(attemptId, 'dispatch')
    }
    return false
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
    let createdSessionId: string | undefined
    let dispatchTransport: ExecutorTransport | undefined
    try {
      const landed = prepareCwd(c, a, profile)
      const transport = transportFor(c.target)
      dispatchTransport = transport
      const model = profile.provider !== undefined && profile.provider !== null && profile.model !== undefined && profile.model !== null
        ? { provider: profile.provider, model: profile.model, ...(profile.effort === undefined ? {} : { effort: profile.effort }) }
        : undefined
      write(tx => tx.updateAttempt(a.attempt_id, { session_id: sessionId, cwd: landed.dir, provider: profile.provider ?? null,
        model: profile.model ?? null, effort: profile.effort ?? null, branch: profile.lifetime === 'durable' ? branchOf(c.commitment_id) : null,
        host: landed.host ?? null }))
      const closedDuring = (): { failed: string } => ({ failed: `commitment ${commitmentId} closed during dispatch` })
      if (!(await stillDispatchable(commitmentId, a.attempt_id))) return closedDuring()
      const created = await ensureExecutorSession(transport, { sessionId, cwd: landed.dir, preset: profile.preset, ...(model === undefined ? {} : { model }) })
      createdSessionId = created.sessionId
      // `stillDispatchable` cancels the attempt (through the transport) when the commitment
      // closed during the create, so no extra cancel is sent here.
      if (!(await stillDispatchable(commitmentId, a.attempt_id))) return closedDuring()
      // Record what the host reports, not what was asked (S2: the default preset is reported too).
      write(tx => tx.append(c.commitment_id, { actor: 'executors', kind: 'state', body: {
        dispatched: a.attempt_id, session_id: created.sessionId,
        agentPreset: created.agentPreset ?? null,
        ...(landed.host === undefined ? {} : { host: landed.host }),
        ...(created.presetDegraded === undefined ? {} : { presetDegraded: created.presetDegraded }) } }))
      if (created.presetDegraded !== undefined) {
        log.warn(`executors: ${a.attempt_id} asked preset ${created.presetDegraded.asked}; host runs ${created.presetDegraded.used}`)
      }
      if (!(await stillDispatchable(commitmentId, a.attempt_id))) return closedDuring()
      // The event watcher starts before the prompt so no early event can be missed;
      // `inproc` returns a no-op (its host bus forwards the same events).
      watchers.get(a.attempt_id)?.()
      const sink = deps.onEvent ?? ((sid: string, ev: unknown) => { onSessionEvent(sid, ev) })
      watchers.set(a.attempt_id, transport.watch(created.sessionId, event => sink(created.sessionId, event)))
      await transport.prompt({ requestId: `dispatch:${a.attempt_id}`, sessionId: created.sessionId, mode: 'queue', text: briefText(c) })
      if (!(await stillDispatchable(commitmentId, a.attempt_id))) return closedDuring()
      const now = attemptById(a.attempt_id)
      if (now?.state !== 'pending') {
        void Promise.resolve(transport.cancel(created.sessionId)).catch(() => undefined)
        return { failed: `attempt ${a.attempt_id} was cancelled during dispatch` }
      }
      write(tx => tx.updateAttempt(a.attempt_id, { state: 'running' }))
      return { attemptId: a.attempt_id, sessionId: created.sessionId }
    } catch (error) {
      watchers.get(a.attempt_id)?.()
      watchers.delete(a.attempt_id)
      // A session that was created but never prompted must not linger on the host.
      if (createdSessionId !== undefined) void Promise.resolve(dispatchTransport?.cancel(createdSessionId)).catch(() => undefined)
      return onDispatchFailure(attemptById(a.attempt_id) ?? a, profile, error)
    }
  }

  async function cancel(attemptId: string, origin: CancelOrigin): Promise<void> {
    const a = attemptById(attemptId)
    if (!a || a.state === 'ended') return
    cancelled.add(attemptId)
    watchers.get(attemptId)?.()
    watchers.delete(attemptId)
    if (a.session_id) {
      try { await transportFor(commitmentById(a.commitment_id)?.target).cancel(a.session_id) } catch (error) {
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
      await transportFor(commitmentById(a.commitment_id)?.target).prompt({ requestId, sessionId: a.session_id, mode,
        text: `${text}\n${inputMarker(requestId)}` })
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
        const reason = parseEndReason(turnEndKind(d))
        s.lastEnd = { turn, reason }
        // External stop (10 "外部取消"): an aborted turn this process did not cancel means
        // somebody stopped the session in its own host (GUI, another client). The attempt
        // ends; the commitment stays open and the agenda decides whether to re-dispatch.
        if (reason === 'aborted' && !cancelled.has(a.attempt_id)) {
          write(tx => tx.updateAttempt(a.attempt_id, { turn_open: 0, cancel_origin: 'external' }))
          return
        }
        write(tx => tx.updateAttempt(a.attempt_id, { turn_open: 0 }))
        return
      }
      case 'assistant/message': {
        // A host reached over HTTP cannot compose this process's report tool; the brief
        // asks for one fenced JSON report as the last message, so keep the latest text.
        s.lastText = contentText(d.message)
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
        // A `report` call is the claim; the ledger write belongs to the host that composed
        // the tool, so the claim is read from the stream and checked against the tool log.
        const claimed = reportFromCall(String(d.name ?? ''), d.arguments)
        if (claimed !== undefined) s.report = claimed
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
    // Attempts that ended outside `cancel` (closure, reconcile) stop their watchers here.
    for (const [attemptId, stop] of [...watchers]) {
      const row = attemptById(attemptId)
      if (row === undefined || row.state === 'ended') {
        stop()
        watchers.delete(attemptId)
        cancelled.delete(attemptId)
      }
    }
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
      if (!a?.session_id) return undefined
      const s = sessions.get(a.session_id)
      // The tool report wins (local executors); the text report is the HTTP fallback.
      return s?.report ?? (s?.lastText === undefined ? undefined : reportFromText(s.lastText))
    },
    toolLog(attemptId) {
      const a = attemptById(attemptId)
      return a?.session_id ? [...(sessions.get(a.session_id)?.calls ?? [])] : []
    },
  }
}
