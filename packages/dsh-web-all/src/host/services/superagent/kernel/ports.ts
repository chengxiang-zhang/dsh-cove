/**
 * The four interfaces the kernel defines and the composition root implements
 * (03 dependency inversion). The kernel sits at the bottom of the graph: it
 * imports only the protocol, and nothing here points at an upper module.
 *
 * - ClaimPolicy   implemented by judgment (fast paths): who owns an event.
 * - TickSignal    implemented by timing: does a due commitment have news.
 * - OutletPolicy  implemented by timing/surface: tier, template, pre-send check.
 * - SenderPort    implemented by the host channel: actually sends.
 */

import type { InboundEvent } from '../protocol/events.ts'
import type { Audience, Disposition, OutboxMoment, Owner, Payload, Route, Tier, TriggerKind } from '../protocol/objects.ts'

/**
 * Ledger facts only. Sender identity classes are looked up by the ClaimPolicy
 * implementation through the world model; the kernel does not read sa_party.
 */
export interface ClaimSnapshot {
  liveCommitmentOnThread?: string
  liveSubscription?: { commitment_id: string; attempt_id: string }
  openQuestionOnDesk?: { commitment_id: string; ordinal: number }
  openProposalsOnDesk: string[]
}

export interface ClaimDecision { owner: Owner; route: Route; disposition?: Disposition; detail?: Record<string, unknown> }

export interface ClaimPolicy { decide(event: InboundEvent, snapshot: ClaimSnapshot): ClaimDecision }

export interface Signal { kind: string; detail: Record<string, unknown> }

export interface TickSignal { has(commitmentId: string, now: number): Signal | null }

export interface SpeechProposal {
  event_id?: string
  commitment_id?: string
  chat_id: string
  reply_to?: string
  moment: OutboxMoment
  audience: Audience
  payload: Payload
  text: string
  /**
   * Which tool produced the line, when the moment is not the model's to choose.
   * `pushback` is the only such moment: `02` says it comes from the pushback tool
   * and never from `say`, so the outlet policy has to see the provenance.
   */
  source?: 'pushback'
  idem_key: string
  expects_reply?: boolean
}

export type OutletVerdict =
  | { ok: true; tier: Tier; text: string; words: number }
  | { ok: false; code: 'TOO_LONG' | 'MOMENT_FORBIDDEN' | 'DISCLOSE_BLOCKED' | 'PROMISE_BLOCKED' | 'COMPLETION_UNVERIFIED'; message: string }

export interface OutletPolicy { check(proposal: SpeechProposal, now: number): OutletVerdict }

export interface SenderPort {
  send(chatId: string, text: string, idemKey: string, replyTo?: string): Promise<{ messageId: string }>
  react(messageId: string, emoji: string): Promise<void>
}

export interface TurnRequest {
  deliberation_id: string
  request_id: string
  desk_id?: string
  commitment_id?: string
  trigger_kind: TriggerKind
}
