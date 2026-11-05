/**
 * One desk turn's context and the ledger reads that feed the dossier (T20).
 *
 * The public core is global on purpose: single presence (07) means every desk in
 * the same window and audience class sees the same `pub`, so the dossier
 * fingerprint (`dossier_hash` = hash of pubHash + audience class) is equal across
 * desks; only the audience layer and the batch differ.
 */

import type { LedgerReader } from '../protocol/db.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { InboundEvent } from '../protocol/events.ts'
import type { AudienceClass, CommitmentRow, DeskRow, MemoryRow, WorkClassRow } from '../protocol/objects.ts'
import type { Audience } from '../memory/visibility.ts'
import { hashOf, type LedgerView } from './now.ts'

export interface ShadowOp { tool: string; input: unknown; verdict: string }

/** Mutable per-turn state the desk tools write into. */
export interface TurnContext {
  deskId: string
  chatId: string
  sessionId: string
  deliberationId: string
  shadow: boolean
  batch: readonly InboundEvent[]
  judged: Set<string>
  audience: Audience
  ops: number
  toolErrors: number
  sayCount: number
  trace: { tool: string; ok: boolean; code?: string }[]
  shadowOps: ShadowOp[]
}

export const WINDOW_MS = 300_000
export const windowOf = (now: number): number => Math.floor(now / WINDOW_MS)

const OPEN = `('proposed', 'open', 'at_risk')`

export function buildView(read: LedgerReader, owner: string, now: number): LedgerView {
  const open = read.all<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} WHERE state IN ${OPEN} ORDER BY n`)
  const questions = read.all<{ commitment_id: string; question: string; taken: string }>(
    `SELECT commitment_id, question, taken FROM ${PHYSICAL.assumption} WHERE mode = 'asked' AND status = 'open'`)
  const waiting = open.filter(c => c.ball === owner).map(c => {
    const q = questions.find(x => x.commitment_id === c.commitment_id)
    return q ? { ...c, question: q.question, default: q.taken } : { ...c }
  })
  const dayStart = now - (now % 86_400_000)
  const interrupts = read.get<{ n: number }>(
    `SELECT count(*) AS n FROM ${PHYSICAL.outbox} WHERE tier = 'interrupt' AND created_at >= ?`, dayStart)?.n ?? 0
  return {
    open,
    waiting,
    recentConclusions: [],
    memories: read.all<MemoryRow>(`SELECT * FROM ${PHYSICAL.memory} WHERE state = 'active' ORDER BY memory_id LIMIT 50`),
    workClasses: read.all<WorkClassRow>(`SELECT * FROM ${PHYSICAL.work_class} ORDER BY class_id`),
    recentClosed: read.all<CommitmentRow>(
      `SELECT * FROM ${PHYSICAL.commitment} WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 5`),
    attention: { interruptsToday: interrupts, quota: 3, quiet: '' },
  }
}

/** Audience of a desk for this batch: the stored snapshot, else the conservative inference. */
export function audienceOf(desk: DeskRow, batch: readonly InboundEvent[], owner: string): Audience {
  const senders = batch.map(e => e.sender.union_id ?? e.sender.open_id)
  let principals: string[] = senders
  if (desk.audience_json) {
    try {
      const parsed: unknown = JSON.parse(desk.audience_json)
      if (Array.isArray(parsed)) principals = parsed.filter((x): x is string => typeof x === 'string')
    } catch { /* keep the senders */ }
  }
  const cls: AudienceClass = desk.audience_class
    ?? (desk.chat_type === 'p2p' ? (senders.every(s => s === owner) ? 'owner_p2p' : 'external') : 'group_without_owner')
  return { principals, cls }
}

/** Single-presence fingerprint: equal for every desk with the same public core and audience class. */
export function dossierFingerprint(pubHash: string, cls: AudienceClass): string {
  return hashOf({ pub: pubHash, cls })
}

export function newTurnContext(input: Omit<TurnContext, 'judged' | 'ops' | 'toolErrors' | 'sayCount' | 'trace' | 'shadowOps'>): TurnContext {
  return { ...input, judged: new Set(), ops: 0, toolErrors: 0, sayCount: 0, trace: [], shadowOps: [] }
}
