/**
 * The `commit` desk tool (02, 08 third judgment, T26).
 *
 * One ledger transaction writes the commitment (open), the pending attempt, the
 * open questions, the thread subscription and the brief; the same turn then says
 * the ack ("I took it", never "dispatched"); dispatch runs after, off the turn.
 * A draft mandate turns the commitment into a proposal: proposed, ball on the
 * owner, no attempt. A shadow turn validates and writes nothing but intake(shadow=1).
 */

import { recordPendingAttempt } from '../executors/attempts.ts'
import type { SpeechProposal } from '../kernel/ports.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { CommitInput, CommitOutput, ToolResult } from '../protocol/tools.ts'
import type { Dispatcher } from './dispatch.ts'
import { ackText, translateToCommit, type JudgmentTurn, type TranslateDeps } from './translate.ts'

export type SayPort = (ctx: JudgmentTurn, proposal: Omit<SpeechProposal, 'idem_key'>) => unknown

export interface CommitDeps extends TranslateDeps {
  dispatcher: Dispatcher
  say?: SayPort
}

const DAY = 86_400_000
export const chatOfDesk = (deskId: string): string => deskId.slice(deskId.indexOf(':') + 1)

/** Marks the event's intake as handled by commit when judge has not done it yet. */
function disposeAsCommit(tx: { get<T>(sql: string, ...p: Array<string | number | null>): T | undefined; disposeIntake: (e: string, s: 0 | 1, d: { disposition: 'commit'; reason?: string }) => void },
  eventId: string, shadow: 0 | 1): void {
  const row = tx.get<{ state: string }>(`SELECT state FROM ${PHYSICAL.intake} WHERE event_id = ? AND shadow = ?`, eventId, shadow)
  if (row && row.state !== 'disposed') tx.disposeIntake(eventId, shadow, { disposition: 'commit', reason: 'commit' })
}

export function commitTool(deps: CommitDeps): (ctx: JudgmentTurn, input: CommitInput) => ToolResult<CommitOutput> {
  return (ctx, input) => {
    const t = translateToCommit(ctx, input, deps)
    if (!t.ok) return t
    const spec = t.spec
    const now = ctx.now ?? deps.ledger.nowMs()

    if (ctx.shadow) {
      ctx.shadowOps?.push({ tool: 'commit', input, verdict: `would ${spec.state} as ${spec.profile.id}` })
      deps.ledger.open(tx => disposeAsCommit(tx, spec.event.event_id, 1), { shadow: true, module: 'judgment' })
      return { ok: true, commitment_id: 'shadow', state: spec.state, eta_at: spec.etaAt, mandate: spec.mandate }
    }

    if (spec.classIsNew) deps.classes.ensure(spec.classId)
    const asked = spec.assumptions.findIndex(a => a.mode === 'asked')
    let row
    try {
      row = deps.ledger.open(tx => {
        const c = tx.createCommitment({
          kind: input.kind, debtor: 'me', creditor: spec.sender, on_behalf_of: spec.sender === deps.owner ? null : deps.owner,
          ball: spec.state === 'proposed' ? deps.owner : 'me', desk_id: ctx.deskId, thread_key: spec.threadKey,
          origin_ref: spec.event.event_id, work_class: spec.classId, what: input.what, intent: input.intent,
          check_kind: input.check_kind, done_when: input.done_when, boundary: spec.boundary || null, target: input.target ?? null,
          state: spec.state, parent_id: spec.parentId, eta_at: spec.etaAt, eta_model_min: input.eta_minutes,
          eta_factor: spec.etaAt === now ? 1 : (spec.etaAt - now) / Math.max(1, input.eta_minutes * 60_000),
          next_look_at: spec.state === 'proposed' ? now + DAY : Math.min(spec.etaAt, now + DAY),
          ...(input.kind === 'deliver' ? { budget_wall_ms: spec.budget.wall_ms, budget_turns: spec.budget.turns } : {}),
        })
        const attempt = spec.state === 'open' ? recordPendingAttempt(tx, c.commitment_id, spec.profile, input.executor_reason) : undefined
        spec.assumptions.forEach((a, i) => tx.run(`INSERT INTO ${PHYSICAL.assumption} (commitment_id, ordinal, question, taken, reversible, mode, status,
          created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`, c.commitment_id, i + 1, a.question, a.taken, a.reversible ? 1 : 0, a.mode, now, now))
        if (attempt) {
          tx.run(`INSERT OR IGNORE INTO ${PHYSICAL.subscription} (thread_key, commitment_id, attempt_id, input_seq, created_at, updated_at)
            VALUES (?, ?, ?, 0, ?, ?)`, spec.threadKey, c.commitment_id, attempt.attempt_id, now, now)
        }
        tx.append(c.commitment_id, { actor: 'desk', kind: 'brief', body: {
          intent: input.intent, check_kind: input.check_kind, done_when: input.done_when, boundary: spec.boundary, prior: spec.prior,
          executor: spec.profile.id, executor_reason: input.executor_reason, mandate: spec.mandate } })
        disposeAsCommit(tx, spec.event.event_id, 0)
        return c
      }, { module: 'judgment' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/THREAD_BUSY|ux_sa_commit_thread/.test(message)) return { ok: false, code: 'THREAD_BUSY', message }
      throw error
    }

    const question = asked >= 0 ? spec.assumptions[asked].question : undefined
    deps.say?.(ctx, {
      event_id: spec.event.event_id, commitment_id: row.commitment_id, chat_id: chatOfDesk(ctx.deskId), reply_to: spec.event.message_id,
      moment: 'ack', audience: 'requester', payload: 'text',
      text: ackText(row.commitment_id, input.what, (spec.etaAt - now) / 60_000, question),
    })
    if (row.state === 'open') deps.dispatcher.dispatch(row.commitment_id)
    return { ok: true, commitment_id: row.commitment_id, state: row.state, eta_at: spec.etaAt, mandate: spec.mandate,
      ...(asked >= 0 ? { asked_ordinal: asked + 1 } : {}) }
  }
}
