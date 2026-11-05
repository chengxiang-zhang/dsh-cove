/**
 * Tool contracts: desk tools (the secretary's only hands on the ledger) and the
 * executor `report` tool. Inputs, outputs and closed error-code sets from 02.
 *
 * Context (desk, batch, sender, audience) is injected by the host and is never
 * part of an input; the model cannot pass it.
 */

import type {
  CheckKind,
  CommitmentKind,
  CommitmentState,
  Disposition,
  MemoryKind,
  OutboxMoment,
  ReportState,
  Tier,
} from './objects.ts'

export const DESK_TOOL_NAMES = ['judge', 'commit', 'amend', 'release', 'pushback', 'look', 'remember', 'propose', 'say'] as const
export type DeskToolName = (typeof DESK_TOOL_NAMES)[number]

export const TOOL_ERROR_CODES = {
  judge: ['ALREADY_DISPOSED', 'NOT_IN_BATCH', 'LIVE_THREAD_FORBIDS', 'ABOUT_NOT_VISIBLE', 'NEW_THREAD_REASON_REQUIRED'],
  commit: ['CHECK_MISSING', 'ASK_REQUIRED', 'TOO_MANY_ASSUMPTIONS', 'THREAD_BUSY', 'CLASS_UNKNOWN', 'SLOT_FULL',
    'BUDGET_OVER_CAP', 'BOUNDARY_DENIED', 'EXECUTOR_UNKNOWN', 'EXECUTOR_MISMATCH'],
  amend: ['TERMINAL', 'NOT_VISIBLE'],
  release: ['NOT_PERMITTED', 'TERMINAL'],
  pushback: ['NO_GROUNDS', 'PUSHBACK_REPEAT', 'PUSHBACK_QUIET'],
  look: ['NOT_VISIBLE', 'MISSING'],
  remember: ['QUOTE_NOT_IN_TRIGGER', 'CONFLICTS', 'SUPERSEDE_FORBIDDEN'],
  propose: ['NOT_GOAL', 'PROPOSAL_OPEN'],
  say: ['TOO_LONG', 'MOMENT_FORBIDDEN', 'REPLY_EXISTS', 'DISCLOSE_BLOCKED', 'PROMISE_BLOCKED', 'NO_LEASE'],
  report: ['QUESTION_REQUIRED'],
  // Kernel-internal; the last two are inferred by the plan (not listed in 02).
  kernel: ['ILLEGAL_TRANSITION', 'LEDGER_ASYNC_TX', 'SHADOW_NO_WRITE'],
} as const

export type ToolErrorScope = keyof typeof TOOL_ERROR_CODES
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[ToolErrorScope][number]

export type ToolResult<T> = ({ ok: true } & T) | { ok: false; code: ToolErrorCode; message: string }

export const MAX_ASSUMPTIONS = 5
export const MAX_PROPOSE_ITEMS = 3
export const MAX_REPORT_SUMMARY = 2000
export const MAX_EVIDENCE_READING = 500

export interface JudgeInput {
  event_id: string
  disposition: Disposition
  about?: string
  class: string
  confidence: number
  reason: string
  corrects?: string
  new_thread?: boolean
}

export interface CommitInput {
  event_id: string
  kind: CommitmentKind
  what: string
  intent: string
  check_kind: CheckKind
  done_when: string
  boundary_extra?: string
  /** At most MAX_ASSUMPTIONS. */
  assumptions?: { question: string; taken: string; reversible: boolean }[]
  executor: string
  executor_reason: string
  eta_minutes: number
  target?: string
  budget_scale?: number
}

export interface CommitOutput {
  commitment_id: string
  state: CommitmentState
  eta_at: number
  mandate: string
  asked_ordinal?: number
}

export interface AmendInput { commitment_id: string; text: string; overturns?: number[] }
export interface AmendOutput { seq: number; delivery: 'queued' | 'next-attempt' }

export interface ReleaseInput { commitment_id: string; reason: string }
export interface ReleaseOutput { state: CommitmentState; worktree: 'kept' | 'removed'; changes: string }

export interface PushbackInput {
  event_id: string
  commitment_id?: string
  concern: string
  grounds: string[]
  alternative: string
}
export interface PushbackOutput { outbox_id: string }

export interface LookInput { what: 'commitment' | 'memory' | 'attempt' | 'doc'; id?: string; q?: string; limit?: number }

export interface RememberInput {
  kind: MemoryKind
  topic: string
  body: string
  quote?: string
  about?: string
  supersedes?: string
}

/** items: at most MAX_PROPOSE_ITEMS. */
export interface ProposeInput { goal_id: string; items: { what: string; intent: string; done_when: string }[] }
export interface ProposeOutput { commitment_ids: string[] }

export interface SayInput { event_id?: string; commitment_id?: string; moment: OutboxMoment; text: string }
export interface SayOutput { outbox_id: string; tier: Tier; words: number }

/** Executor tool. summary at most MAX_REPORT_SUMMARY chars; evidence reading at most MAX_EVIDENCE_READING. */
export interface ReportInput {
  state: ReportState
  summary: string
  evidence?: { command: string; exit: number; reading: string }[]
  question?: string
}
