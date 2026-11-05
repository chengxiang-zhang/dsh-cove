/**
 * Escalation: three choices, in this order (10 "升级：三选一，按序").
 *
 * 1. same executor again — the reason is transient (interrupted, error, stall,
 *    stop-loss, a fixable technical block) and fewer than two attempts were used;
 * 2. one tier higher — a loop, a provider-side max-tokens stop, a self-reported
 *    failure, or already retried once;
 * 3. broken — three attempts used, or no higher tier exists. Deliver "cannot do
 *    it + what was tried + two directions with a default", and never ask "continue
 *    or stop" (R13: a question is for product decisions only).
 *
 * Nothing here produces an interrupt: stalling and looping are system faults and
 * self-heal silently (G9). The escalation only writes the ledger, the pending
 * attempt and one `cannot` proposal for the outlet to decide about.
 *
 * One column cannot be written from here: `commitment.executor_switched` is not in
 * the ledger's patchable set (Lead ruling), and the ledger computes it from the
 * attempt history when the commitment closes. So an upgrade records the switch in
 * the journal and lets that computation carry it into the column.
 */

import type { KernelTx, Ledger } from '../kernel/ledger.ts'
import type { SpeechProposal } from '../kernel/ports.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { AttemptRow, CommitmentRow } from '../protocol/objects.ts'
import { recordPendingAttempt } from './attempts.ts'
import type { ProfileRegistry } from './profiles/index.ts'

const A = PHYSICAL.attempt
const C = PHYSICAL.commitment

/** Three attempts is the ceiling (10 "尝试数 = 3"). */
export const MAX_ATTEMPTS = 3

export type EscalationReason = 'stall' | 'loop' | 'failed' | 'max-tokens' | 'interrupted' | 'error' | 'budget' | 'blocked_technical'
export type EscalationAction = 'retry' | 'upgrade' | 'broken' | 'ask'

export interface EscalationResult {
  action: EscalationAction
  /** The new pending attempt for `retry` and `upgrade`; the caller dispatches it. */
  attemptId?: string
}

/** A genuine product question (口径/范围/取舍) with the default the owner can ignore. */
export interface ProductQuestion {
  question: string
  fallback: string
}

export interface EscalationDeps {
  ledger: Ledger
  profiles: ProfileRegistry
  clock: { now(): number }
  /** `cannot` is an outlet proposal; escalation never sends anything itself. */
  speak?: (proposal: SpeechProposal) => void
  /** One asked assumption for a product question; judgment owns `sa_assumption`. */
  ask?: (commitmentId: string, question: string, fallback: string) => void
}

export interface Escalation {
  escalate(commitmentId: string, reason: EscalationReason, product?: ProductQuestion): EscalationResult
}

/** Transient faults retry in the same tier first. */
const TRANSIENT: ReadonlySet<EscalationReason> = new Set(['interrupted', 'error', 'stall', 'budget', 'blocked_technical'])
/** Faults a retry does not fix: the tier or the session limit is the problem. */
const STRUCTURAL: ReadonlySet<EscalationReason> = new Set(['loop', 'max-tokens', 'failed'])

/** Which of the three choices the reason and the attempt history point at. */
export function nextEscalation(reason: EscalationReason, attemptsUsed: number, hasHigher: boolean): 'retry' | 'upgrade' | 'broken' {
  if (attemptsUsed >= MAX_ATTEMPTS) return 'broken'
  if (STRUCTURAL.has(reason)) return hasHigher ? 'upgrade' : 'broken'
  if (TRANSIENT.has(reason)) return attemptsUsed < 2 ? 'retry' : (hasHigher ? 'upgrade' : 'broken')
  return 'broken'
}

function chatOf(commitment: CommitmentRow): string {
  const desk = commitment.desk_id ?? ''
  return desk.includes(':') ? desk.slice(desk.indexOf(':') + 1) : desk
}

export function createEscalation(deps: EscalationDeps): Escalation {
  const { ledger, profiles } = deps
  const write = <T>(fn: (tx: KernelTx) => T): T => ledger.open(fn, { module: 'executors' })

  const attemptsOf = (commitmentId: string): AttemptRow[] => ledger.read.all<AttemptRow>(
    `SELECT * FROM ${A} WHERE commitment_id = ? ORDER BY n`, commitmentId)

  function triedSoFar(attempts: readonly AttemptRow[]): string[] {
    return attempts.map(a => `a${a.n} ${a.executor} ${a.end_reason ?? 'open'}${a.cancel_origin ? `/${a.cancel_origin}` : ''}`)
  }

  function cannot(commitment: CommitmentRow, tried: readonly string[]): void {
    deps.speak?.({
      commitment_id: commitment.commitment_id,
      chat_id: chatOf(commitment),
      moment: 'cannot',
      audience: 'requester',
      payload: 'text',
      text: `${commitment.commitment_id} cannot be done for now. Tried: ${tried.join('; ')}. `
        + 'Two directions: narrow the scope to what already works, or wait for the next tier. Default: narrow the scope.',
      idem_key: `cannot:${commitment.commitment_id}`,
    })
  }

  function startAttempt(commitment: CommitmentRow, profileId: string, why: string): AttemptRow {
    const profile = profiles.get(profileId)
    if (profile === undefined) throw new Error(`escalation: unknown executor profile ${profileId}`)
    return write(tx => recordPendingAttempt(tx, commitment.commitment_id, profile, why))
  }

  return {
    escalate(commitmentId: string, reason: EscalationReason, product?: ProductQuestion): EscalationResult {
      const commitment = ledger.read.get<CommitmentRow>(`SELECT * FROM ${C} WHERE commitment_id = ?`, commitmentId)
      if (commitment === undefined) throw new Error(`escalation: unknown commitment ${commitmentId}`)
      const attempts = attemptsOf(commitmentId)
      const last = attempts.at(-1)
      const current = last?.executor ?? ''
      const higher = profiles.higher(current)

      const choice = nextEscalation(reason, attempts.length, higher !== undefined)

      if (choice === 'broken') {
        const tried = triedSoFar(attempts)
        write(tx => {
          tx.append(commitmentId, { actor: 'executors', kind: 'state', body: { escalated: 'broken', reason, tried } })
          return tx.transition(commitmentId, 'broken', { ball: 'me' })
        })
        // 10: after broken, a genuine product question may still go to the owner.
        if (product !== undefined) deps.ask?.(commitmentId, product.question, product.fallback)
        cannot(commitment, tried)
        return { action: 'broken' }
      }

      if (product !== undefined) {
        // Asking is not one of the three choices: it means the owner has to decide
        // something the executor cannot, so no attempt is spent.
        deps.ask?.(commitmentId, product.question, product.fallback)
        write(tx => tx.append(commitmentId, { actor: 'executors', kind: 'state', body: { escalated: 'ask', reason, question: product.question } }))
        return { action: 'ask' }
      }

      if (choice === 'retry') {
        const attempt = startAttempt(commitment, current, `retry after ${reason}`)
        write(tx => tx.append(commitmentId, { actor: 'executors', kind: 'state', body: { escalated: 'retry', reason, attempt: attempt.attempt_id } }))
        return { action: 'retry', attemptId: attempt.attempt_id }
      }

      const next = profiles.higher(current)
      if (next === undefined) throw new Error(`escalation: no higher tier than ${current}`)
      const attempt = startAttempt(commitment, next.id, `upgrade after ${reason}`)
      write(tx => tx.append(commitmentId, {
        actor: 'executors',
        kind: 'state',
        // `executor_switched` cannot be patched (Lead ruling); the ledger derives the
        // column from the attempt history when the commitment closes. The journal
        // carries the moment itself.
        body: { escalated: 'upgrade', reason, from: current, to: next.id, attempt: attempt.attempt_id, executor_switched: true },
      }))
      return { action: 'upgrade', attemptId: attempt.attempt_id }
    },
  }
}