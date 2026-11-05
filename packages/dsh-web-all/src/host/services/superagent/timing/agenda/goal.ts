/**
 * Agenda source 4: the weekly goal round (09 目标推进).
 *
 * A goal asks for at most one round a week, and it stays quiet while it already
 * has proposals waiting for the owner: a proposal the owner has not answered yet
 * is not a reason to ask again. The kernel caps a goal's look time at seven days,
 * so `next_look_at` is the cadence.
 */

import type { Signal } from '../../kernel/ports.ts'
import type { AgendaSource } from './index.ts'

function hasPendingProposal(read: Parameters<AgendaSource['due']>[2], goalId: string): boolean {
  const row = read.get<{ c: number }>(
    `SELECT count(*) AS c FROM sa_commitment WHERE state = 'proposed' AND (parent_id = ? OR origin_ref = ?)`,
    goalId,
    goalId,
  )
  return (row?.c ?? 0) > 0
}

export const goal: AgendaSource = {
  name: 'goal',
  due(commitment, now, read) {
    if (commitment.kind !== 'goal') return null
    if (hasPendingProposal(read, commitment.commitment_id)) return null
    if (typeof commitment.next_look_at === 'number' && commitment.next_look_at > now) return null
    return { kind: 'goal', detail: { goal_id: commitment.commitment_id } } satisfies Signal
  },
}
