/**
 * Pushback (T21): disagreeing with the owner once, with grounds, and with a way
 * forward (`08-判断` "顶住老板：一次，有据，给替代").
 *
 * Three mechanical constraints keep this from becoming nagging or flattery:
 *   - an argument needs a fact: at least one visible `M-…`, `C-…` or
 *     `calib:<class>` ground, plus a non-empty alternative that reaches the intent;
 *   - one disagreement per thread: a second `pushback` journal row on the same
 *     thread is refused with PUSHBACK_REPEAT;
 *   - when the work class is muted (four of the last five pushbacks were
 *     overturned) it only states one risk sentence and does not disagree.
 *
 * The direction reverses when speaking for the owner: a colleague's request that
 * collides with the owner's constraint is never argued with. The secretary routes
 * it to the owner with both quotes, and the fixed message says so.
 *
 * Shadow turns validate and write nothing (N18): no journal row, no outbox.
 */

import type { KernelTx } from '../kernel/ledger.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { CommitmentRow, MemoryRow, WorkClassRow } from '../protocol/objects.ts'
import type { PushbackInput, PushbackOutput, ToolResult } from '../protocol/tools.ts'
import { canUse } from '../memory/visibility.ts'
import {
  chatIdOf,
  commitmentVisibleAt,
  pushbacksOnThread,
  senderClassOf,
  senderOf,
  threadOf,
  type JudgmentDeps,
  type TurnContext,
} from './gates.ts'

const C = PHYSICAL.commitment
const M = PHYSICAL.memory
const WC = PHYSICAL.work_class
const CALIBRATION_PREFIX = 'calib:'

/** Fixed text: a colleague's collision is routed, never argued (R15). */
export const NON_OWNER_MESSAGE = "non-owner request: use judge(disposition='route')"
/** Fixed text: a muted class gets one risk sentence inside the intake, not a disagreement. */
export const MUTED_MESSAGE = 'work class is muted; state one risk sentence instead of disagreeing'

export type GroundKind = 'memory' | 'commitment' | 'calibration'

/** Classifies one ground string; anything else is not a ground. */
export function groundKind(ground: string): GroundKind | undefined {
  if (/^M-\d+$/.test(ground)) return 'memory'
  if (/^C-\d+$/.test(ground)) return 'commitment'
  if (ground.startsWith(CALIBRATION_PREFIX) && ground.length > CALIBRATION_PREFIX.length) return 'calibration'
  return undefined
}

function fail(code: 'NO_GROUNDS' | 'PUSHBACK_REPEAT' | 'PUSHBACK_QUIET', message: string) {
  return { ok: false as const, code, message }
}

/** Why this ground is not usable here, or undefined when it is. */
function groundProblem(deps: JudgmentDeps, ctx: TurnContext, ground: string): string | undefined {
  const kind = groundKind(ground)
  if (kind === undefined) return `'${ground}' is not an M-…, C-… or calib:<class> ground`
  if (kind === 'memory') {
    const row = deps.ledger.read.get<MemoryRow>(`SELECT * FROM ${M} WHERE memory_id = ?`, ground)
    if (row === undefined || row.state !== 'active') return `memory ${ground} is not an active row`
    if (!canUse(row, ctx.audience)) return `memory ${ground} is not usable at this audience`
    return undefined
  }
  if (kind === 'commitment') {
    if (!commitmentVisibleAt(deps.ledger.read, ground, ctx.deskId)) return `commitment ${ground} is not visible at this desk`
    return undefined
  }
  const classId = ground.slice(CALIBRATION_PREFIX.length)
  const row = deps.ledger.read.get<WorkClassRow>(`SELECT * FROM ${WC} WHERE class_id = ?`, classId)
  return row === undefined ? `calibration ${ground} names an unknown work class` : undefined
}

function targetOf(deps: JudgmentDeps, ctx: TurnContext, input: PushbackInput): CommitmentRow | undefined {
  const read = deps.ledger.read
  const event = ctx.batch.find((candidate) => candidate.event_id === input.event_id)
  const live = event === undefined ? undefined : deps.claim.snapshot(event).liveCommitmentOnThread
  const candidates = [input.commitment_id, live].filter((id): id is string => id !== undefined)
  for (const id of candidates) {
    const row = read.get<CommitmentRow>(`SELECT * FROM ${C} WHERE commitment_id = ?`, id)
    if (row !== undefined) return row
  }
  if (event === undefined) return undefined
  return read.get<CommitmentRow>(
    `SELECT * FROM ${C} WHERE thread_key = ? ORDER BY n DESC LIMIT 1`, threadOf(event))
}

export function pushbackTool(deps: JudgmentDeps) {
  return (ctx: TurnContext, input: PushbackInput): ToolResult<PushbackOutput> => {
    const grounds = input.grounds.map((ground) => ground.trim()).filter((ground) => ground.length > 0)
    if (grounds.length === 0) {
      return fail('NO_GROUNDS', 'pushback needs at least one ground: a visible M-…, C-… or calib:<class>')
    }
    for (const ground of grounds) {
      const problem = groundProblem(deps, ctx, ground)
      if (problem !== undefined) return fail('NO_GROUNDS', problem)
    }
    if ((input.alternative ?? '').trim() === '') {
      return fail('NO_GROUNDS', 'pushback needs a non-empty alternative that reaches the intent')
    }

    const target = targetOf(deps, ctx, input)
    if (target === undefined) {
      // The closed pushback error set has no "no target" code: without a
      // commitment there is nothing to disagree about, so it is treated as
      // groundless rather than invented into another code.
      return fail('NO_GROUNDS', 'pushback needs a commitment: pass commitment_id or judge on the live thread')
    }

    const key = target.thread_key ?? ''
    if (key !== '' && pushbacksOnThread(deps.ledger.read, key) > 0) {
      return fail('PUSHBACK_REPEAT', `thread ${key} already has a pushback; the owner's insistence is recorded by commit`)
    }

    const classId = target.work_class ?? undefined
    const workClass = classId === undefined
      ? undefined
      : deps.ledger.read.get<WorkClassRow>(`SELECT * FROM ${WC} WHERE class_id = ?`, classId)
    if (workClass?.pushback_mode === 'muted') return fail('PUSHBACK_QUIET', MUTED_MESSAGE)

    const event = ctx.batch.find((candidate) => candidate.event_id === input.event_id)
    const sender = ctx.sender ?? (event === undefined ? '' : senderOf(event))
    const senderClass = ctx.senderClass ?? senderClassOf(deps.ledger.read, sender)
    if (senderClass !== 'owner') return fail('PUSHBACK_QUIET', NON_OWNER_MESSAGE)

    // Shadow turns prove what the secretary would do, and leave nothing behind.
    if (ctx.shadow) return { ok: true, outbox_id: '' }

    deps.ledger.open((tx: KernelTx) => tx.append(target.commitment_id, {
      actor: 'me',
      kind: 'pushback',
      request_id: `pb:${input.event_id}`,
      body: { concern: input.concern, grounds, alternative: input.alternative },
    }), { shadow: false })

    const said = deps.outletSay(ctx, {
      event_id: input.event_id,
      commitment_id: target.commitment_id,
      chat_id: chatIdOf(ctx),
      moment: 'pushback',
      payload: 'text',
      audience: 'requester',
      text: `${input.concern} 备选：${input.alternative}`,
      expects_reply: true,
    })
    if (!said.ok) return { ok: false, code: said.code, message: said.message }
    return { ok: true, outbox_id: said.outbox_id }
  }
}