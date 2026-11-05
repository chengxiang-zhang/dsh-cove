/**
 * Gate facts (T21): the six questions of `08-判断` as host-computed data.
 *
 * The model may not invent these. Gate 3 (boundary) is answered by the world
 * model's mandate decision, gates 1/4/5 come from the ledger and from memory
 * filtered for this audience, and gate 6 is the calibrated cost of the work
 * class. Anything a gate needs but the host cannot prove is absent from these
 * facts, which is exactly the `NO_GROUNDS` condition in pushback: no fact, no
 * pushback.
 *
 * "Same topic" is resolved mechanically: the work class of the live commitment on
 * this thread, else the class most recently used at this desk. Without a class
 * the window is the only filter, and the caller sees that in `class_id`.
 *
 * Pure reads: this file opens no transaction and writes nothing.
 */

import type { Claim } from '../kernel/claim.ts'
import type { Ledger } from '../kernel/ledger.ts'
import type { SpeechProposal } from '../kernel/ports.ts'
import { PHYSICAL, type LedgerReader } from '../protocol/db.ts'
import type { InboundEvent } from '../protocol/events.ts'
import { threadKeyOf } from '../kernel/claim.ts'
import {
  OPEN_STATES,
  type Capability,
  type CommitmentRow,
  type PartyRow,
  type Strength,
  type WorkClassRow,
} from '../protocol/objects.ts'
import type { SayOutput, ToolResult } from '../protocol/tools.ts'
import type { ProfileRegistry } from '../executors/profiles/index.ts'
import type { MemoryLog } from '../memory/log.ts'
import type { Audience } from '../memory/visibility.ts'
import type { RuleRegistry } from '../rules/registry.ts'
import type { ScopePath } from '../world/paths.ts'
import type { WorldRegistry } from '../world/registry.ts'

const C = PHYSICAL.commitment
const J = PHYSICAL.journal
const M = PHYSICAL.memory
const P = PHYSICAL.party
const WC = PHYSICAL.work_class

const DAY = 86_400_000
/** Gate 1 looks at conclusions from the last seven days (`08`). */
export const ANSWER_WINDOW_MS = 7 * DAY
/** Gate 5 looks wider: an intent precedent older than a week still informs. */
export const PRECEDENT_WINDOW_MS = 30 * DAY
export const ANSWER_LIMIT = 5
export const PRECEDENT_LIMIT = 3
export const SAID_LIMIT = 5
const MEMORY_SCAN = 50

/**
 * Host-injected turn context. The model cannot pass any of it: the desk builds it
 * from the claim, the batch and the desk row (`02`: context is injected).
 *
 * `sender`, `senderClass`, `chatId` and `now` may be omitted; when omitted they
 * are derived from the batch event, the party table and the ledger clock, so the
 * desk's own richer context stays structurally acceptable.
 */
export interface TurnContext {
  deskId: string
  deliberationId: string
  shadow: boolean
  batch: readonly InboundEvent[]
  audience: Audience
  sender?: string
  senderClass?: string
  chatId?: string
  now?: number
}

export interface JudgmentDeps {
  ledger: Ledger
  claim: Claim
  world: WorldRegistry
  memory: MemoryLog
  /** Reserved for the commit path (T26): the gate order is hard-coded, rules feed its evidence. */
  rules: RuleRegistry
  outletSay: (ctx: TurnContext, proposal: Omit<SpeechProposal, 'idem_key'>) => ToolResult<SayOutput>
  profiles: ProfileRegistry
}

/** The six gates' host facts: what the dossier "this batch" section shows, and what `commit` reuses. */
export interface GateFacts {
  /** Gate 1: conclusions already on the ledger or in memory, inside seven days. */
  g1_answered: { commitment_id?: string; memory_id?: string; conclusion: string }[]
  /** Gate 2: open work at this desk, so a second commitment is not opened blindly. */
  g2_in_progress: { commitment_id: string; what: string }[]
  /** Gate 3: the world model's three-state mandate answer for the sender. */
  g3_mandate: (capability: Capability, path: ScopePath) => Strength
  /** Gate 4: the owner's constraints and preferences this audience may use. */
  g4_said: { memory_id: string; quote: string }[]
  /** Gate 5: what similar intents actually produced. */
  g5_precedents: { commitment_id: string; intent: string; outcome: string }[]
  /** Gate 6: calibrated cost of the work class. */
  g6_cost: { class_id: string; eta_factor: number; p90_turns: number; preferred_executor?: string }
}

/** The thread a message belongs to (`02` thread identity). */
export function threadOf(event: InboundEvent): string {
  return threadKeyOf(event)
}

/** The sending party id as the ledger records it. */
export function senderOf(event: InboundEvent): string {
  return event.sender.union_id ?? event.sender.open_id
}

/**
 * Party id used for mandate questions: the row keyed by union id wins, then the
 * single party row whose `union_id` matches, then the raw sender id.
 */
export function principalOf(read: LedgerReader, sender: string): string {
  const direct = read.get<PartyRow>(`SELECT * FROM ${P} WHERE party_id = ?`, sender)
  if (direct !== undefined) return direct.party_id
  const byUnion = read.get<PartyRow>(`SELECT * FROM ${P} WHERE union_id = ? ORDER BY party_id LIMIT 1`, sender)
  return byUnion?.party_id ?? sender
}

/** Sender class for direction decisions; an unregistered sender is `external`, never `owner`. */
export function senderClassOf(read: LedgerReader, sender: string): string {
  const party = read.get<PartyRow>(`SELECT * FROM ${P} WHERE party_id = ?`, principalOf(read, sender))
  return party?.class ?? 'external'
}

/** The work class the batch is about: the live commitment's, else the desk's last one. */
export function topicClassOf(read: LedgerReader, ctx: TurnContext, liveCommitmentId: string | undefined): string | undefined {
  if (liveCommitmentId !== undefined) {
    const live = read.get<CommitmentRow>(`SELECT work_class FROM ${C} WHERE commitment_id = ?`, liveCommitmentId)
    if (live?.work_class !== null && live?.work_class !== undefined) return live.work_class
  }
  const last = read.get<{ work_class: string | null }>(
    `SELECT work_class FROM ${C} WHERE desk_id = ? AND work_class IS NOT NULL ORDER BY n DESC LIMIT 1`, ctx.deskId)
  return last?.work_class ?? undefined
}

function conclusionOf(read: LedgerReader, row: CommitmentRow): { conclusion: string; memory_id?: string } {
  const parts = [`${row.state}: ${row.intent}`]
  if (row.evidence_json !== null) {
    try {
      const decoded = JSON.parse(row.evidence_json) as unknown
      if (Array.isArray(decoded)) {
        const reading = (decoded[0] as { reading?: unknown } | undefined)?.reading
        if (typeof reading === 'string' && reading.length > 0) parts.push(reading)
      }
    } catch {
      // An evidence blob we cannot read is not a conclusion we may quote.
    }
  }
  const memory = read.get<{ memory_id: string }>(
    `SELECT memory_id FROM ${M} WHERE commitment_id = ? AND state = 'active' ORDER BY memory_id LIMIT 1`, row.commitment_id)
  return memory === undefined ? { conclusion: parts.join(' | ') } : { conclusion: parts.join(' | '), memory_id: memory.memory_id }
}

/**
 * The six gate facts for this event. Every field is a read; nothing here decides.
 */
export function gateFacts(deps: JudgmentDeps, ctx: TurnContext, event: InboundEvent): GateFacts {
  const read = deps.ledger.read
  const now = ctx.now ?? deps.ledger.nowMs()
  const live = deps.claim.snapshot(event).liveCommitmentOnThread
  const classId = topicClassOf(read, ctx, live)
  const classFilter = classId === undefined ? '' : ' AND work_class = ?'
  const classParams = classId === undefined ? [] : [classId]

  const answered = read.all<CommitmentRow>(
    `SELECT * FROM ${C} WHERE closed_at IS NOT NULL AND closed_at >= ?${classFilter}
      ORDER BY closed_at DESC, n DESC LIMIT ?`,
    now - ANSWER_WINDOW_MS, ...classParams, ANSWER_LIMIT)
  const g1 = answered.map((row) => ({ commitment_id: row.commitment_id, ...conclusionOf(read, row) }))

  const open = read.all<CommitmentRow>(
    `SELECT * FROM ${C} WHERE state IN (${OPEN_STATES.map(() => '?').join(', ')}) AND desk_id = ?
      ORDER BY n LIMIT ?`, ...OPEN_STATES, ctx.deskId, ANSWER_LIMIT)

  const said = deps.memory.recall({}, ctx.audience, 'judge', MEMORY_SCAN)
    .filter((view) => view.kind === 'constraint' || view.kind === 'preference' || view.kind === 'standing')
    .slice(0, SAID_LIMIT)
    // An unsayable memory reaches the model as a derived hint, never as its text.
    .map((view) => ({ memory_id: view.memory_id, quote: view.source_quote ?? view.body ?? view.hint ?? '' }))

  const precedents = read.all<CommitmentRow>(
    `SELECT * FROM ${C} WHERE closed_at IS NOT NULL AND closed_at >= ?${classFilter}
      ORDER BY closed_at DESC, n DESC LIMIT ?`,
    now - PRECEDENT_WINDOW_MS, ...classParams, PRECEDENT_LIMIT)

  const workClass = classId === undefined
    ? undefined
    : read.get<WorkClassRow>(`SELECT * FROM ${WC} WHERE class_id = ?`, classId)
  const sender = ctx.sender ?? senderOf(event)
  const principal = principalOf(read, sender)

  return {
    g1_answered: g1,
    g2_in_progress: open.map((row) => ({ commitment_id: row.commitment_id, what: row.what })),
    g3_mandate: (capability, path) => deps.world.mandate(principal, path, capability).strength,
    g4_said: said,
    g5_precedents: precedents.map((row) => ({
      commitment_id: row.commitment_id,
      intent: row.intent,
      outcome: row.state,
    })),
    g6_cost: {
      class_id: workClass?.class_id ?? classId ?? '',
      eta_factor: workClass?.eta_factor ?? 1,
      p90_turns: workClass?.p90_turns ?? 0,
      preferred_executor: workClass?.preferred_executor ?? undefined,
    },
  }
}

/** The journal rows of one chain: used by pushback's repeat check and by T26's overturn count. */
export function pushbacksOnThread(read: LedgerReader, key: string): number {
  return read.get<{ n: number }>(
    `SELECT count(*) AS n FROM ${J} j JOIN ${C} c ON c.commitment_id = j.commitment_id
      WHERE j.kind = 'pushback' AND c.thread_key = ?`, key)?.n ?? 0
}

/** Whether a commitment may be named at this desk: same desk, or a host-originated one. */
export function commitmentVisibleAt(read: LedgerReader, commitmentId: string, deskId: string): boolean {
  const row = read.get<CommitmentRow>(`SELECT * FROM ${C} WHERE commitment_id = ?`, commitmentId)
  if (row === undefined) return false
  return row.desk_id === null || row.desk_id === deskId
}

/** The chat id a turn answers into; the desk id carries it (`chat type:chat id`). */
export function chatIdOf(ctx: TurnContext): string {
  if (ctx.chatId !== undefined && ctx.chatId.length > 0) return ctx.chatId
  const separator = ctx.deskId.indexOf(':')
  return separator === -1 ? ctx.deskId : ctx.deskId.slice(separator + 1)
}
