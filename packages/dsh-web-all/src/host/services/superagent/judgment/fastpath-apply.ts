/**
 * Host execution of fast-path decisions (08 fast path, T26): no model involved.
 *
 * - release: the release tool's host path, immediate.
 * - ordinal on proposals: each named proposal goes proposed -> open, gets its pending
 *   attempt and subscription, and is dispatched once (N26: recorded as commit by claim).
 * - ordinal on the open question: the assumption is answered and the answer is
 *   appended to the commitment as an amend.
 * - acknowledge: a reaction, or a desk rotation; decline: the fixed identity notice (R16).
 * An ordinal out of range or repeated is an error, never silently dropped. Claim's
 * owner CAS makes a repeated message a no-op before it reaches this function.
 */

import { recordPendingAttempt } from '../executors/attempts.ts'
import type { ProfileRegistry } from '../executors/profiles/index.ts'
import type { ClaimDecision } from '../kernel/ports.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { InboundEvent } from '../protocol/events.ts'
import type { CommitmentRow } from '../protocol/objects.ts'
import { amendTool, releaseCommitment, type AmendReleaseDeps } from './amend-release.ts'
import { chatOfDesk } from './commit.ts'
import type { Dispatcher } from './dispatch.ts'
import { proposalsOnDesk } from './propose.ts'
import type { JudgmentTurn } from './translate.ts'

export interface FastpathDeps extends AmendReleaseDeps {
  dispatcher: Dispatcher
  profiles: ProfileRegistry
  /** Profile for an approved proposal that names none. */
  defaultProfile: string
  rotateDesk?: (deskId: string) => void
}

export const IDENTITY_NOTICE = '我是老板的秘书，只处理老板交代或授权的事；这件事请直接联系老板。'
export const ACK_REACTION = 'OK'

export class FastpathError extends Error {
  constructor(readonly code: 'ORDINAL_OUT_OF_RANGE' | 'ORDINAL_REPEATED' | 'NOTHING_TO_APPLY', message: string) { super(`${code}: ${message}`) }
}

const deskOf = (e: InboundEvent): string => `${e.chat.type}:${e.chat.id}`

function hostTurn(event: InboundEvent): JudgmentTurn {
  const sender = event.sender.union_id ?? event.sender.open_id
  return { deskId: deskOf(event), deliberationId: `fp:${event.event_id}`, shadow: false, batch: [event],
    audience: { principals: [sender], cls: event.chat.type === 'p2p' ? 'owner_p2p' : 'group_with_owner' }, sender }
}

function checkedOrdinals(raw: unknown, size: number): number[] {
  const ordinals = Array.isArray(raw) ? raw.map(Number) : []
  if (ordinals.length === 0) throw new FastpathError('NOTHING_TO_APPLY', 'no ordinal in the message')
  if (new Set(ordinals).size !== ordinals.length) throw new FastpathError('ORDINAL_REPEATED', ordinals.join(','))
  const bad = ordinals.filter(n => !Number.isInteger(n) || n < 1 || n > size)
  if (bad.length) throw new FastpathError('ORDINAL_OUT_OF_RANGE', `${bad.join(',')} not in 1..${size}`)
  return ordinals
}

function approve(deps: FastpathDeps, c: CommitmentRow, event: InboundEvent): void {
  if (c.state !== 'proposed') return   // already approved: never dispatch twice
  const profile = deps.profiles.get(deps.defaultProfile)
  if (!profile) throw new Error(`fastpath: default profile ${deps.defaultProfile} is not registered`)
  deps.ledger.open(tx => {
    tx.transition(c.commitment_id, 'open', { ball: 'me' })
    const a = recordPendingAttempt(tx, c.commitment_id, profile, `approved by owner reply ${event.event_id}`)
    if (c.thread_key) {
      tx.run(`INSERT OR IGNORE INTO ${PHYSICAL.subscription} (thread_key, commitment_id, attempt_id, input_seq, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)`, c.thread_key, c.commitment_id, a.attempt_id, tx.now, tx.now)
    }
    tx.append(c.commitment_id, { actor: event.sender.union_id ?? event.sender.open_id, kind: 'state', body: { approved_by: event.event_id } })
  }, { module: 'judgment' })
  deps.dispatcher.dispatch(c.commitment_id)
}

export async function applyFastpath(deps: FastpathDeps, event: InboundEvent, decision: ClaimDecision): Promise<void> {
  const detail = decision.detail ?? {}
  const ctx = hostTurn(event)
  switch (decision.disposition) {
    case 'release': {
      const id = detail.commitment_id
      const c = typeof id === 'string' ? deps.ledger.read.get<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} WHERE commitment_id = ?`, id) : undefined
      if (!c) throw new FastpathError('NOTHING_TO_APPLY', 'release without a live commitment on the thread')
      await releaseCommitment(deps, ctx, c, `fast path: ${event.text}`)
      return
    }
    case 'commit': {
      const proposals = proposalsOnDesk(deps.ledger, ctx.deskId)
      for (const n of checkedOrdinals(detail.ordinals, proposals.length)) approve(deps, proposals[n - 1], event)
      return
    }
    case 'amend': {
      const id = String(detail.commitment_id ?? '')
      const ordinal = Number(detail.ordinal)
      const q = deps.ledger.read.get<{ status: string }>(`SELECT status FROM ${PHYSICAL.assumption} WHERE commitment_id = ? AND ordinal = ?`, id, ordinal)
      if (!q || q.status !== 'open') throw new FastpathError('NOTHING_TO_APPLY', `no open question ${id}#${ordinal}`)
      deps.ledger.open(tx => tx.run(`UPDATE ${PHYSICAL.assumption} SET status = 'answered', resolved_by = ?, updated_at = ? WHERE commitment_id = ? AND ordinal = ?`,
        event.event_id, tx.now, id, ordinal), { module: 'judgment' })
      const r = await amendTool(deps)({ ...ctx, audience: { ...ctx.audience, cls: 'owner_p2p' } }, { commitment_id: id, text: `老板回答 #${ordinal}：${event.text}` })
      if (!r.ok) throw new Error(`fastpath amend: ${r.code} ${r.message}`)
      return
    }
    case 'acknowledge':
      if (detail.rotate === true) { deps.rotateDesk?.(ctx.deskId); return }
      deps.say?.(ctx, { event_id: event.event_id, chat_id: chatOfDesk(ctx.deskId), reply_to: event.message_id, moment: 'ack', audience: 'requester', payload: 'react', text: ACK_REACTION })
      return
    case 'decline':
      deps.say?.(ctx, { event_id: event.event_id, chat_id: chatOfDesk(ctx.deskId), reply_to: event.message_id, moment: 'answer', audience: 'requester', payload: 'text', text: IDENTITY_NOTICE })
      return
    default:
      throw new FastpathError('NOTHING_TO_APPLY', `no host execution for ${String(decision.disposition)}`)
  }
}
