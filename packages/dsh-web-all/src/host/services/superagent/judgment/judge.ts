/**
 * Judge (T21): the one tool every model-visible message must call exactly once,
 * whose first field is the routing decision (`08-判断` "第一判断").
 *
 * The tool answers one question: does this message belong to the live work of this
 * thread, to a new piece of work, or to a direct answer? It does not execute
 * anything: `commit`, `amend`, `release` and `pushback` are their own tools, so a
 * disposition recorded here is a decision, not an action.
 *
 * Validation order is the protocol's (02 `judge`), and the error set is closed:
 *   1. the event is in this turn's batch                     -> NOT_IN_BATCH
 *   2. this shadow row is not disposed yet                   -> ALREADY_DISPOSED
 *   3. a live commitment on the thread allows only
 *      check/nudge/amend/release/answer, unless the model
 *      opens a new thread with a reason                     -> LIVE_THREAD_FORBIDS
 *                                                            -> NEW_THREAD_REASON_REQUIRED
 *   4. the `about` commitment is visible at this desk        -> ABOUT_NOT_VISIBLE
 *
 * Shadow turns (N18) write only the shadow intake: no journal, no outbox, no
 * commitment. The reading `intake(shadow=1)` therefore proves what the secretary
 * would have done without letting it touch the real work.
 */

import type { KernelTx } from '../kernel/ledger.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { InboundEvent } from '../protocol/events.ts'
import type { Disposition, IntakeRow } from '../protocol/objects.ts'
import type { JudgeInput, ToolErrorCode, ToolResult } from '../protocol/tools.ts'
import { commitmentVisibleAt, threadOf, type JudgmentDeps, type TurnContext } from './gates.ts'

const I = PHYSICAL.intake
const C = PHYSICAL.commitment

/** The only dispositions a thread with live work accepts (`08` first judgement). */
export const LIVE_THREAD_DISPOSITIONS: readonly Disposition[] = ['check', 'nudge', 'amend', 'release', 'answer']

function fail(code: ToolErrorCode, message: string): { ok: false; code: ToolErrorCode; message: string } {
  return { ok: false, code, message }
}

export function judgeTool(deps: JudgmentDeps) {
  return (ctx: TurnContext, input: JudgeInput): ToolResult<{}> => {
    const event = ctx.batch.find((candidate: InboundEvent) => candidate.event_id === input.event_id)
    if (event === undefined) {
      return fail('NOT_IN_BATCH', `event ${input.event_id} is not in this turn's batch`)
    }
    // The tool schema already restricts `disposition` to the protocol enum; the
    // intake DDL repeats it, so an invalid value cannot reach the ledger.
    const disposition = input.disposition
    const shadow = ctx.shadow ? 1 : 0

    return deps.ledger.open((tx: KernelTx) => {
      const intake = tx.get<IntakeRow>(`SELECT * FROM ${I} WHERE event_id = ? AND shadow = ?`, event.event_id, shadow)
      if (intake?.state === 'disposed') {
        return fail('ALREADY_DISPOSED', `event ${event.event_id} already has a disposition on shadow=${shadow}`)
      }

      const live = deps.claim.snapshot(event).liveCommitmentOnThread
      if (live !== undefined && !LIVE_THREAD_DISPOSITIONS.includes(disposition)) {
        if (input.new_thread !== true) {
          return fail('LIVE_THREAD_FORBIDS',
            `thread has live commitment ${live}; choose check/nudge/amend/release/answer or set new_thread`)
        }
        if ((input.reason ?? '').trim() === '') {
          return fail('NEW_THREAD_REASON_REQUIRED', 'new_thread needs a reason')
        }
      }

      if (input.about !== undefined && !commitmentVisibleAt(deps.ledger.read, input.about, ctx.deskId)) {
        return fail('ABOUT_NOT_VISIBLE', `commitment ${input.about} is not visible at this desk`)
      }

      try {
        tx.disposeIntake(event.event_id, shadow, {
          disposition,
          reason: input.reason,
          about: input.about,
          corrects: input.corrects,
          class: input.class,
          confidence: input.confidence,
          ...(input.new_thread === undefined ? {} : { new_thread: input.new_thread }),
          deliberation_id: ctx.deliberationId,
        })
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code === 'ALREADY_DISPOSED') {
          return fail('ALREADY_DISPOSED', `event ${event.event_id} has no open intake row on shadow=${shadow}`)
        }
        throw error
      }

      // A nudge leaves a journal row so the executor sees the chase on its next
      // turn; a shadow nudge leaves nothing behind.
      if (!ctx.shadow && disposition === 'nudge') {
        const target = input.about ?? live ?? tx.get<{ commitment_id: string }>(
          `SELECT commitment_id FROM ${C} WHERE thread_key = ? ORDER BY n DESC LIMIT 1`, threadOf(event))?.commitment_id
        if (target !== undefined) {
          tx.append(target, {
            actor: 'me',
            kind: 'nudge',
            request_id: `nudge:${event.event_id}`,
            body: { text: event.text },
          })
        }
      }
      return { ok: true }
    }, { module: 'judgment', shadow: ctx.shadow })
  }
}