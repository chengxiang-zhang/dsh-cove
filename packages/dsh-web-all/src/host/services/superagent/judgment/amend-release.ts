/**
 * `amend` and `release` desk tools (02, 10, T26).
 *
 * amend: a terminal commitment refuses (TERMINAL; delivered work gets a follow-up
 * child through commit, N30); running work receives the input now (sendInput),
 * otherwise the next attempt carries it. The journal row's request_id makes the
 * input count once; unconsumed input keeps the commitment from closing (T22).
 *
 * release is the immediate path (10, G2): intent first, then every live attempt is
 * cancelled, the workspace is kept or removed, the commitment is released and a
 * receipt says where it stopped and what happens to the changes. No clock wait.
 */

import type { Executors } from '../executors/attempts.ts'
import type { Ledger } from '../kernel/ledger.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { AttemptRow, CommitmentRow } from '../protocol/objects.ts'
import type { AmendInput, AmendOutput, ReleaseInput, ReleaseOutput, ToolResult } from '../protocol/tools.ts'
import { chatOfDesk, type SayPort } from './commit.ts'
import type { JudgmentTurn } from './translate.ts'

/** What became of the working directory; the composition root binds the real check. */
export interface WorkspacePort { settle(commitmentId: string): { worktree: 'kept' | 'removed'; changes: string } }

export interface AmendReleaseDeps {
  ledger: Ledger
  executors: Pick<Executors, 'sendInput' | 'cancel'>
  owner: string
  say?: SayPort
  workspace?: WorkspacePort
}

const TERMINAL = ['fulfilled', 'unverified', 'broken', 'released', 'withdrawn', 'orphaned']

const visibleAt = (c: CommitmentRow, ctx: JudgmentTurn): boolean => ctx.audience.cls === 'owner_p2p' || c.desk_id === ctx.deskId
const senderOf = (ctx: JudgmentTurn): string => ctx.sender ?? (ctx.batch[0] ? (ctx.batch[0].sender.union_id ?? ctx.batch[0].sender.open_id) : '')

/** Default when no workspace port is bound: no row means nothing to keep. */
function defaultSettle(ledger: Ledger, commitmentId: string): { worktree: 'kept' | 'removed'; changes: string } {
  const ws = ledger.read.get<{ path: string }>(`SELECT path FROM ${PHYSICAL.workspace} WHERE commitment_id = ? AND removed_at IS NULL`, commitmentId)
  return ws ? { worktree: 'kept', changes: `工作区 ${ws.path} 保留，改动未核对` } : { worktree: 'removed', changes: '没有工作区，无改动' }
}

export function amendTool(deps: AmendReleaseDeps): (ctx: JudgmentTurn, input: AmendInput) => Promise<ToolResult<AmendOutput>> {
  return async (ctx, input) => {
    const c = deps.ledger.read.get<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} WHERE commitment_id = ?`, input.commitment_id)
    if (!c || !visibleAt(c, ctx)) return { ok: false, code: 'NOT_VISIBLE', message: `${input.commitment_id} is not visible from this desk` }
    if (TERMINAL.includes(c.state)) return { ok: false, code: 'TERMINAL', message: `${c.commitment_id} is ${c.state}; follow-up work is a new commit` }
    const eventId = ctx.batch[0]?.event_id ?? ctx.deliberationId
    const requestId = `am:${eventId}:${c.commitment_id}`
    if (ctx.shadow) {
      ctx.shadowOps?.push({ tool: 'amend', input, verdict: 'validated' })
      return { ok: true, seq: 0, delivery: 'next-attempt' }
    }
    const seq = deps.ledger.open(tx => {
      const s = tx.append(c.commitment_id, { actor: senderOf(ctx), kind: 'amend', request_id: requestId, body: { text: input.text, overturns: input.overturns ?? [] } })
      for (const ordinal of input.overturns ?? []) {
        tx.run(`UPDATE ${PHYSICAL.assumption} SET status = 'overturned', resolved_by = ?, updated_at = ? WHERE commitment_id = ? AND ordinal = ?`,
          requestId, tx.now, c.commitment_id, ordinal)
      }
      return s
    }, { module: 'judgment' })
    const running = deps.ledger.read.get<AttemptRow>(`SELECT * FROM ${PHYSICAL.attempt} WHERE commitment_id = ? AND state = 'running'`, c.commitment_id)
    if (!running) return { ok: true, seq, delivery: 'next-attempt' }
    await deps.executors.sendInput(running.attempt_id, requestId, input.text)
    return { ok: true, seq, delivery: 'queued' }
  }
}

/** The release path shared by the tool and the fast path. */
export async function releaseCommitment(deps: AmendReleaseDeps, ctx: JudgmentTurn, c: CommitmentRow, reason: string): Promise<ReleaseOutput> {
  const by = senderOf(ctx)
  deps.ledger.open(tx => tx.append(c.commitment_id, { actor: by, kind: 'state', body: { release_intent: reason, by } }), { module: 'judgment' })
  const live = deps.ledger.read.all<AttemptRow>(`SELECT * FROM ${PHYSICAL.attempt} WHERE commitment_id = ? AND state IN ('pending', 'running') ORDER BY n`, c.commitment_id)
  const stoppedAt = live.map(a => `${a.attempt_id} 第 ${a.turns} 回合（${a.state}）`)
  for (const a of live) await deps.executors.cancel(a.attempt_id, 'release')
  const ws = deps.workspace ? deps.workspace.settle(c.commitment_id) : defaultSettle(deps.ledger, c.commitment_id)
  deps.ledger.open(tx => tx.transition(c.commitment_id, 'released', { ball: 'me' }), { module: 'judgment' })
  deps.say?.(ctx, {
    commitment_id: c.commitment_id, chat_id: chatOfDesk(c.desk_id ?? ctx.deskId), moment: 'deliver', audience: 'requester', payload: 'text',
    text: `停了 ${c.commitment_id}：${stoppedAt.length ? `停在 ${stoppedAt.join('、')}` : '还没开始执行'}。${ws.changes}。`,
  })
  return { state: 'released', worktree: ws.worktree, changes: ws.changes }
}

export function releaseTool(deps: AmendReleaseDeps): (ctx: JudgmentTurn, input: ReleaseInput) => Promise<ToolResult<ReleaseOutput>> {
  return async (ctx, input) => {
    const c = deps.ledger.read.get<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} WHERE commitment_id = ?`, input.commitment_id)
    if (!c || !visibleAt(c, ctx)) return { ok: false, code: 'NOT_PERMITTED', message: `${input.commitment_id} is not visible from this desk` }
    const by = senderOf(ctx)
    if (by !== c.creditor && by !== deps.owner) return { ok: false, code: 'NOT_PERMITTED', message: `${by} neither asked for ${c.commitment_id} nor owns it` }
    if (TERMINAL.includes(c.state)) return { ok: false, code: 'TERMINAL', message: `${c.commitment_id} is already ${c.state}` }
    if (ctx.shadow) {
      ctx.shadowOps?.push({ tool: 'release', input, verdict: 'validated' })
      return { ok: true, state: c.state, worktree: 'kept', changes: 'shadow' }
    }
    return { ok: true, ...(await releaseCommitment(deps, ctx, c, input.reason)) }
  }
}

/** What the host release path reports; the `stop` command maps it to an exit code. */
export interface HostReleaseOutcome { ok: boolean; reason?: 'missing' | 'terminal' }

/**
 * Host entry for `stop C-n` (T27 gap 5): synchronous, no model, no clock.
 *
 * One transaction ends every live attempt as aborted/release and releases the
 * commitment, so the ledger never shows a running attempt on a released
 * commitment (I3). Cancelling the sessions themselves follows, fire and forget.
 */
export function releaseHost(deps: { ledger: Ledger; cancelSession?: (sessionId: string) => void }, commitmentId: string): HostReleaseOutcome {
  const c = deps.ledger.read.get<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} WHERE commitment_id = ?`, commitmentId)
  if (!c) return { ok: false, reason: 'missing' }
  if (TERMINAL.includes(c.state)) return { ok: false, reason: 'terminal' }
  const live = deps.ledger.open(tx => {
    const rows = tx.all<AttemptRow>(`SELECT * FROM ${PHYSICAL.attempt} WHERE commitment_id = ? AND state IN ('pending', 'running')`, commitmentId)
    tx.append(commitmentId, { actor: 'host', kind: 'state', body: { release_intent: 'stop command', by: 'host' } })
    for (const a of rows) tx.updateAttempt(a.attempt_id, { state: 'ended', end_reason: 'aborted', cancel_origin: 'release' })
    tx.transition(commitmentId, 'released', { ball: 'me' })
    return rows
  }, { module: 'executors' })
  for (const a of live) if (a.session_id) {
    try { deps.cancelSession?.(a.session_id) } catch { /* the session is already gone from the ledger's view */ }
  }
  return { ok: true }
}
