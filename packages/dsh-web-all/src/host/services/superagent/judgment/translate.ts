/**
 * Third judgment (08): translate a request into delegable work (T26).
 *
 * `translateToCommit` is pure over its ports: it checks the five mandatory parts
 * (intent, check, boundary, prior, open questions) and the 02 commit error codes in
 * the T-09 order, then returns a `CommitSpec` the commit tool writes in one
 * transaction. It never writes and never calls the model.
 *
 * Seam (T21): gate facts arrive through `TranslateDeps.facts`, structurally the
 * shape of T21's `gateFacts`; this file does not import judge.ts or gates.ts.
 */

import { budget as computeBudget, type Budget } from '../executors/budget.ts'
import type { Profile, ProfileRegistry } from '../executors/profiles/index.ts'
import type { Ledger } from '../kernel/ledger.ts'
import type { Audience } from '../memory/visibility.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { InboundEvent } from '../protocol/events.ts'
import { threadKeyOf } from '../kernel/claim.ts'
import type { AttemptRow, Capability, CommitmentRow, Strength, WorkClassRow } from '../protocol/objects.ts'
import { normalizeClassId, parseEndReason } from '../protocol/objects.ts'
import type { CommitInput, ToolErrorCode } from '../protocol/tools.ts'

/** Turn context as the desk injects it; T21's TurnContext is structurally assignable. */
export interface JudgmentTurn {
  deskId: string
  deliberationId: string
  shadow: boolean
  batch: readonly InboundEvent[]
  audience: Audience
  sender?: string
  now?: number
  shadowOps?: { tool: string; input: unknown; verdict: string }[]
}

/** The gate facts commit needs: T21's GateFacts satisfies this. */
export interface CommitFacts {
  g1_answered: { commitment_id?: string; memory_id?: string; conclusion: string }[]
  g3_mandate: (capability: Capability, path: string) => Strength
  g4_said: { memory_id: string; quote: string }[]
  g6_cost?: { class_id: string; eta_factor: number; p90_turns: number; preferred_executor?: string }
}

/** Work classes belong to rules; judgment reads and asks for a new row through this port. */
export interface WorkClassPort {
  get(classId: string): WorkClassRow | undefined
  ensure(classId: string): WorkClassRow
}

export interface TranslateDeps {
  ledger: Ledger
  profiles: ProfileRegistry
  facts(ctx: JudgmentTurn, event: InboundEvent): CommitFacts
  classes: WorkClassPort
  owner: string
  budget?: typeof computeBudget
}

export const MAX_ASSUMPTIONS = 5
export const MAX_BUDGET_SCALE = 4
export const SLOT_QUEUE_MAX = 5
export const CLASS_NAME = /^[a-z][a-z0-9-]{1,40}$/
/** One class gate for judge and commit: the same predicate and the same sentence, so a
 *  value that cannot name a work class is refused before it is ever written down. */
export function classGate(raw: string): { classId: string; error?: Translation } {
  const classId = normalizeClassId(raw)
  return CLASS_NAME.test(classId) ? { classId } : { classId, error: fail('CLASS_UNKNOWN', `work class "${classId}" must match ${CLASS_NAME}`) }
}
/** Technical choices are the system's to make (B14): never asked of the owner. */
export const TECHNICAL_QUESTION = /执行体|模型|重试|继续还是停|换档|executor|model|retry|keep going|continue or stop/i

export type AssumptionIn = { question: string; taken: string; reversible: boolean; mode?: 'declared' | 'asked' }

export interface CommitSpec {
  event: InboundEvent
  threadKey: string
  sender: string
  classId: string
  classIsNew: boolean
  profile: Profile
  state: 'open' | 'proposed'
  mandate: Strength
  parentId: string | null
  etaAt: number
  budget: Budget
  boundary: string
  prior: string[]
  assumptions: { question: string; taken: string; reversible: boolean; mode: 'declared' | 'asked' }[]
  input: CommitInput
}

export type Translation = { ok: true; spec: CommitSpec } | { ok: false; code: ToolErrorCode; message: string }

const fail = (code: ToolErrorCode, message: string): Translation => ({ ok: false, code, message })
const OPEN = `('proposed', 'open', 'at_risk')`
const TERMINAL = ['fulfilled', 'unverified', 'broken', 'released', 'withdrawn', 'orphaned']

/** 02 check_kind requirements on `done_when`. */
export function checkComplete(kind: CommitInput['check_kind'], doneWhen: string): string | undefined {
  const text = doneWhen.trim()
  if (kind === 'command') {
    if (!/`[^`]+`/.test(text)) return 'command check needs the command in backticks'
    if (!/(期望|expect|==|>=|<=|!=|[=<>≥≤])/i.test(text.replace(/`[^`]+`/g, ''))) return 'command check needs the expected reading'
    return undefined
  }
  if (kind === 'artifact') return /([\w.-]+\/[\w./-]+|\.[a-z0-9]{1,6}\b|分支|branch\s+\S+)/i.test(text) ? undefined : 'artifact check needs a path or a branch'
  if (kind === 'observation') return /\S+\s*(>=|<=|==|[<>=≥≤])\s*-?\d/.test(text) ? undefined : 'observation check needs a reading and a threshold number'
  return /(要包含|需包含|must include|包含[:：])/i.test(text) ? undefined : 'answer check needs the list it must include'
}

/** 08 selection: who may do this work. Write work needs full tools; preference and last failure reorder. */
export function candidates(spec: Pick<CommitInput, 'kind' | 'check_kind'>, cls: WorkClassRow | undefined, last: AttemptRow | undefined, profiles: ProfileRegistry): string[] {
  const needsWrite = spec.kind === 'deliver' && (spec.check_kind === 'command' || spec.check_kind === 'artifact')
  let ids = profiles.all().filter(p => !needsWrite || p.tools === 'full').map(p => p.id)
  if (cls?.preferred_executor && ids.includes(cls.preferred_executor)) ids = [cls.preferred_executor, ...ids.filter(i => i !== cls.preferred_executor)]
  if (last && last.end_reason !== 'completed') {
    const up = profiles.higher(last.executor)?.id
    if (up && ids.includes(up)) ids = [up, ...ids.filter(i => i !== up)]
  }
  return ids
}

function normalizeAssumptions(raw: readonly AssumptionIn[], cls: WorkClassRow | undefined): { list: CommitSpec['assumptions'] } | { error: string } {
  const list = raw.map(a => ({ question: a.question, taken: a.taken, reversible: a.reversible, mode: a.mode ?? 'declared' as 'declared' | 'asked' }))
  if (list.some(a => !a.reversible && a.mode !== 'asked')) return { error: 'an irreversible assumption must be asked' }
  if (cls?.ask_mode === 'ask' && list.length > 0 && list[0].mode !== 'asked') return { error: 'this work class asks first' }
  const asked = list.filter(a => a.mode === 'asked')
  if (asked.length > 1) return { error: 'at most one open question per commitment' }
  if (asked.some(a => TECHNICAL_QUESTION.test(a.question))) return { error: 'technical choices are not asked of the owner' }
  if (asked.some(a => !a.taken.trim())) return { error: 'a question carries its default' }
  return { list }
}

/** The capability the work needs and where, for gate 3. */
function capabilityOf(input: CommitInput, profile: Profile): { capability: Capability; path: string } {
  const path = input.target && /^(local|netbird|external)\//.test(input.target) ? input.target : 'local/'
  return { capability: profile.tools === 'full' && input.kind === 'deliver' ? 'write_repo' : 'read', path }
}

export function translateToCommit(ctx: JudgmentTurn, input: CommitInput, deps: TranslateDeps): Translation {
  const read = deps.ledger.read
  const now = ctx.now ?? deps.ledger.nowMs()
  const event = ctx.batch.find(e => e.event_id === input.event_id)
  if (!event) return fail('NOT_IN_BATCH', `${input.event_id} is not in this batch`)
  const sender = ctx.sender ?? event.sender.union_id ?? event.sender.open_id
  const key = threadKeyOf(event)

  // 1. Check.
  const missing = checkComplete(input.check_kind, input.done_when)
  if (missing || !input.intent.trim()) return fail('CHECK_MISSING', missing ?? 'intent is the result wanted, not the action')
  // 2-3. Open questions.
  const rawAssumptions = (input.assumptions ?? []) as AssumptionIn[]
  if (rawAssumptions.length > MAX_ASSUMPTIONS) return fail('TOO_MANY_ASSUMPTIONS', `${rawAssumptions.length} > ${MAX_ASSUMPTIONS}`)
  const intake = read.get<{ class: string | null; about: string | null }>(
    `SELECT class, about FROM ${PHYSICAL.intake} WHERE event_id = ? AND shadow = ?`, event.event_id, ctx.shadow ? 1 : 0)
  // 5. Work class.
  const gate = classGate(intake?.class ?? '')
  if (gate.error) return gate.error
  const classId = gate.classId
  const cls = deps.classes.get(classId)
  const norm = normalizeAssumptions(rawAssumptions, cls)
  if ('error' in norm) return fail('ASK_REQUIRED', norm.error)

  // 4. Thread: same debtor, same thread; a different sender opens a child (02).
  const about = intake?.about ? read.get<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} WHERE commitment_id = ?`, intake.about) : undefined
  let parentId: string | null = null
  if (about && TERMINAL.includes(about.state)) {
    parentId = about.commitment_id   // N30: delivered work gets a follow-up child with its history
  } else if (input.kind === 'deliver') {
    const top = read.get<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} WHERE thread_key = ? AND debtor = 'me' AND kind = 'deliver'
      AND parent_id IS NULL AND state IN ${OPEN} ORDER BY n LIMIT 1`, key)
    if (top && top.creditor === sender) return fail('THREAD_BUSY', `${top.commitment_id} is still open on this thread`)
    if (top) parentId = top.commitment_id
  }
  // 6. Budget scale.
  const scale = input.budget_scale ?? 1
  if (!(scale > 0) || scale > MAX_BUDGET_SCALE) return fail('BUDGET_OVER_CAP', `budget_scale ${scale} > ${MAX_BUDGET_SCALE}`)
  // 7-9. Executor and mandate. The id is typed by the model, so fold case and
  // whitespace before rejecting, and name the candidates when it still does not
  // resolve: a blind guess must be able to correct itself in the next step.
  const profile = deps.profiles.get(input.executor.trim())
    ?? deps.profiles.get(input.executor.trim().toLowerCase())
  if (!profile) {
    const available = deps.profiles.all().map(p => p.id).join(', ')
    return fail('EXECUTOR_UNKNOWN', `${input.executor} is not a registered profile; available: ${available}`)
  }
  const facts = deps.facts(ctx, event)
  const need = capabilityOf(input, profile)
  const graded = facts.g3_mandate(need.capability, need.path)
  if (graded === 'deny') return fail('BOUNDARY_DENIED', `${need.capability} on ${need.path} is denied for ${sender}`)
  // The owner's own request is not a proposal for the owner to approve: draft means
  // "ask before doing" for everyone else, so an owner's draft is read as allow. The
  // mandate the spec carries is the one that governs the work.
  const mandate: Strength = graded === 'draft' && deps.owner !== '' && sender === deps.owner ? 'allow' : graded
  const last = read.get<AttemptRow>(`SELECT a.* FROM ${PHYSICAL.attempt} a JOIN ${PHYSICAL.commitment} c ON c.commitment_id = a.commitment_id
    WHERE c.thread_key = ? ORDER BY a.created_at DESC, a.n DESC LIMIT 1`, key)
  if (!candidates(input, cls, last, deps.profiles).includes(profile.id)) return fail('EXECUTOR_MISMATCH', `${profile.id} cannot do ${input.kind}/${input.check_kind} work`)
  // 10. Slot queue (N27): durable full deliver waits in line; the line has five places.
  if (profile.lifetime === 'durable' && profile.tools === 'full' && input.kind === 'deliver' && mandate === 'allow') {
    const inLine = read.get<{ n: number }>(`SELECT count(DISTINCT c.commitment_id) AS n FROM ${PHYSICAL.commitment} c JOIN ${PHYSICAL.attempt} a
      ON a.commitment_id = c.commitment_id WHERE c.kind = 'deliver' AND c.state IN ('open', 'at_risk') AND a.lifetime = 'durable'
      AND a.state IN ('pending', 'running')`)?.n ?? 0
    if (inLine >= SLOT_QUEUE_MAX) return fail('SLOT_FULL', `${inLine} durable deliveries already in line`)
  }

  // Boundary: the owner's constraints are joined in with their source; the desk may only add.
  const said = facts.g4_said.map(s => `${s.quote}（出处 ${s.memory_id}）`)
  const boundary = [...said, ...(input.boundary_extra?.trim() ? [input.boundary_extra.trim()] : [])].join('；')
  const prior = priorOf(deps.ledger, key, about, facts)
  const factor = cls?.eta_factor ?? facts.g6_cost?.eta_factor ?? 1
  const p90 = cls && cls.samples >= 12 && cls.p90_turns ? cls.p90_turns : undefined
  const b = (deps.budget ?? computeBudget)(input.eta_minutes, factor, p90, scale)
  return {
    ok: true,
    spec: {
      event, threadKey: key, sender, classId, classIsNew: cls === undefined, profile,
      state: mandate === 'draft' ? 'proposed' : 'open', mandate, parentId,
      etaAt: now + Math.round(input.eta_minutes * factor * 60_000), budget: b, boundary, prior,
      assumptions: norm.list, input,
    },
  }
}

/** Prior (08 four): last three closed conclusions on the topic plus the thread's last attempt. */
function priorOf(ledger: Ledger, key: string, about: CommitmentRow | undefined, facts: CommitFacts): string[] {
  const lines: string[] = []
  if (about) lines.push(`接续 ${about.commitment_id}（${about.state}）：${about.what}；结论 ${about.evidence_json ?? '无证据'}`)
  for (const a of facts.g1_answered.slice(0, 3)) lines.push(`${a.commitment_id ?? a.memory_id ?? '记忆'}：${a.conclusion}`)
  const last = ledger.read.get<AttemptRow>(`SELECT a.* FROM ${PHYSICAL.attempt} a JOIN ${PHYSICAL.commitment} c ON c.commitment_id = a.commitment_id
    WHERE c.thread_key = ? ORDER BY a.created_at DESC, a.n DESC LIMIT 1`, key)
  if (last) lines.push(`同线程上一尝试 ${last.attempt_id}：${last.executor} ${last.end_reason ?? last.state}${last.cancel_origin ? `/${last.cancel_origin}` : ''}`)
  return lines
}

/** 08 fixed acknowledgement: understanding, calibrated time, then "say if wrong" or the one question. */
export function ackText(commitmentId: string, understanding: string, etaMinutes: number, question?: string): string {
  return `接了 ${commitmentId}：${understanding}。预计 ${Math.max(1, Math.round(etaMinutes))} 分钟。${question ? `先回答我：${question}` : '不对就说'}`
}

// M3 helper: wired by `desk/presence.ts` (around line 411). The one-line call-site
// change is intentionally not done here because `desk/*` is owned by another writer.
/**
 * A turn that ends without a protocol reason is recorded as `unknown`, which is
 * indistinguishable from "the host never said". When a tool refused the work, the
 * turn failed for a known reason: attribute it to `error` and name the refusing
 * tool in the rule trace. `END_REASONS` is a DDL CHECK set, so no member is added.
 */
export function attributeTurnEnd(
  rawKind: string | undefined,
  trace: readonly { tool: string; ok: boolean; code?: string }[],
): { end_reason: ReturnType<typeof parseEndReason>; commit?: { ok: false; code: string } } {
  const base = parseEndReason(rawKind)
  if (base !== 'unknown') return { end_reason: base }
  const last = [...trace].reverse().find(t => !t.ok)
  if (!last) return { end_reason: base }
  // The failing tool is not necessarily the commit: a refused `look` explained the
  // end just as well, but its code does not belong under a `commit` key.
  return { end_reason: 'error', ...(last.tool === 'commit' && last.code !== undefined ? { commit: { ok: false as const, code: last.code } } : {}) }
}
