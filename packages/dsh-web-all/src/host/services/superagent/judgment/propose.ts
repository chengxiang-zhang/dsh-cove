/**
 * The `propose` desk tool (02, T26): a goal's next steps as proposals.
 *
 * Up to three child commitments, `proposed`, ball on the owner, on this desk, so the
 * claim snapshot lists them in `n` order and the owner's reply "1" / "1、3" maps back
 * by ordinal (fastpath-apply.ts). Approval never goes through the model.
 *
 * Known limit: the spec asks for next_look_at = now + 7d, but the kernel's I1 cap
 * (kernel/ledger.ts, read-only here) holds non-goal commitments to 24 h; the 7-day
 * withdrawal is the agenda's to decide from created_at.
 */

import { budget } from '../executors/budget.ts'
import type { Ledger } from '../kernel/ledger.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { CommitmentRow } from '../protocol/objects.ts'
import type { ProposeInput, ProposeOutput, ToolResult } from '../protocol/tools.ts'
import { chatOfDesk, type SayPort } from './commit.ts'
import type { JudgmentTurn } from './translate.ts'

export const MAX_PROPOSE_ITEMS = 3
const WEEK = 7 * 86_400_000

export interface ProposeDeps { ledger: Ledger; owner: string; say?: SayPort }

/** The desk's open proposals in ordinal order (same query as the claim snapshot). */
export function proposalsOnDesk(ledger: Ledger, deskId: string): CommitmentRow[] {
  return ledger.read.all<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} WHERE desk_id = ? AND state = 'proposed' ORDER BY n`, deskId)
}

export function proposeTool(deps: ProposeDeps): (ctx: JudgmentTurn, input: ProposeInput) => ToolResult<ProposeOutput> {
  return (ctx, input) => {
    const goal = deps.ledger.read.get<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} WHERE commitment_id = ?`, input.goal_id)
    if (!goal || goal.kind !== 'goal') return { ok: false, code: 'NOT_GOAL', message: `${input.goal_id} is not a goal` }
    const open = deps.ledger.read.get(`SELECT 1 FROM ${PHYSICAL.commitment} WHERE parent_id = ? AND state = 'proposed'`, goal.commitment_id)
    if (open) return { ok: false, code: 'PROPOSAL_OPEN', message: `${goal.commitment_id} already has proposals waiting for the owner` }
    if (input.items.length === 0 || input.items.length > MAX_PROPOSE_ITEMS) throw new Error(`propose: 1..${MAX_PROPOSE_ITEMS} items, got ${input.items.length}`)
    if (ctx.shadow) {
      ctx.shadowOps?.push({ tool: 'propose', input, verdict: 'validated' })
      return { ok: true, commitment_ids: [] }
    }
    const b = budget(30, 1, undefined)
    const ids = deps.ledger.open(tx => input.items.map((item, i) => tx.createCommitment({
      kind: 'deliver', debtor: 'me', creditor: deps.owner, ball: deps.owner, desk_id: ctx.deskId, thread_key: goal.thread_key,
      parent_id: goal.commitment_id, origin_ref: `prop:${goal.commitment_id}:${ctx.deliberationId}:${i + 1}`,
      work_class: goal.work_class, what: item.what, intent: item.intent, check_kind: 'answer', done_when: item.done_when,
      state: 'proposed', next_look_at: tx.now + WEEK, budget_wall_ms: b.wall_ms, budget_turns: b.turns,
    }).commitment_id), { module: 'judgment' })
    const listed = proposalsOnDesk(deps.ledger, ctx.deskId)
    deps.say?.(ctx, { commitment_id: goal.commitment_id, chat_id: chatOfDesk(ctx.deskId), moment: 'ask', audience: 'owner', payload: 'text',
      text: `${goal.commitment_id} 下一步，回序号批准：${listed.map((c, i) => `${i + 1}. ${c.what}`).join('；')}` })
    return { ok: true, commitment_ids: ids }
  }
}
