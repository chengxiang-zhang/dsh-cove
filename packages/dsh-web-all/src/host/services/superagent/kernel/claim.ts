/**
 * Kernel claim (T12): every inbound event gets exactly one owner, in one ledger transaction.
 *
 * The owner write is a compare-and-set on `inbox_events.owner`; a second arrival
 * finds the column set and returns `already_claimed`, which is not an error (P3).
 * Who owns an event and how it is routed is decided by the injected ClaimPolicy;
 * the kernel only records the decision.
 */

import { PHYSICAL } from '../protocol/db.ts'
import { threadKey as makeThreadKey, type InboundEvent } from '../protocol/events.ts'
import type { Disposition, Owner, Route } from '../protocol/objects.ts'
import type { KernelTx, Ledger } from './ledger.ts'
import type { ClaimPolicy, ClaimSnapshot } from './ports.ts'

export type ClaimMode = 'responder' | 'shadow' | 'superagent'

export type ClaimResult =
  | { status: 'claimed'; owner: Owner; route: Route; disposition?: Disposition; deskId: string; threadKey: string }
  | { status: 'shadowed'; deskId: string; threadKey: string }
  | { status: 'already_claimed' }

export interface Claim {
  claim(event: InboundEvent, policy: ClaimPolicy, mode: ClaimMode): ClaimResult
  shadow(event: InboundEvent): void
  unowned(now: number, olderThanMs: number): string[]
  snapshot(event: InboundEvent): ClaimSnapshot
}

const OWNER_CAS = `UPDATE ${PHYSICAL.inbox_event} SET owner = ? WHERE event_id = ? AND owner IS NULL`

interface Keys { deskId: string; threadKey: string }

function keysOf(event: InboundEvent): Keys {
  return {
    deskId: `${event.chat.type}:${event.chat.id}`,
    threadKey: makeThreadKey(event.chat.type, event.chat.id, event.thread || event.message_id),
  }
}

const senderOf = (event: InboundEvent): string => event.sender.union_id ?? event.sender.open_id

type Reader = Pick<KernelTx, 'get' | 'all'>

function readSnapshot(r: Reader, keys: Keys): ClaimSnapshot {
  const live = r.get<{ commitment_id: string }>(`SELECT commitment_id FROM ${PHYSICAL.commitment}
    WHERE thread_key = ? AND parent_id IS NULL AND state IN ('proposed', 'open', 'at_risk') ORDER BY n LIMIT 1`, keys.threadKey)
  const sub = r.get<{ commitment_id: string; attempt_id: string }>(
    `SELECT commitment_id, attempt_id FROM ${PHYSICAL.subscription} WHERE thread_key = ?`, keys.threadKey)
  const question = r.get<{ commitment_id: string; ordinal: number }>(`SELECT a.commitment_id, a.ordinal FROM ${PHYSICAL.assumption} a
    JOIN ${PHYSICAL.commitment} c ON c.commitment_id = a.commitment_id
    WHERE c.desk_id = ? AND a.mode = 'asked' AND a.status = 'open' ORDER BY c.n LIMIT 1`, keys.deskId)
  const proposals = r.all<{ commitment_id: string }>(
    `SELECT commitment_id FROM ${PHYSICAL.commitment} WHERE desk_id = ? AND state = 'proposed' ORDER BY n`, keys.deskId)
  return {
    ...(live ? { liveCommitmentOnThread: live.commitment_id } : {}),
    ...(sub ? { liveSubscription: { commitment_id: sub.commitment_id, attempt_id: sub.attempt_id } } : {}),
    ...(question ? { openQuestionOnDesk: { commitment_id: question.commitment_id, ordinal: question.ordinal } } : {}),
    openProposalsOnDesk: proposals.map(p => p.commitment_id),
  }
}

/** Shadow intake row; a repeated arrival is a no-op. */
function writeShadow(tx: KernelTx, event: InboundEvent, keys: Keys): void {
  if (tx.get(`SELECT 1 FROM ${PHYSICAL.intake} WHERE event_id = ? AND shadow = 1`, event.event_id)) return
  tx.insertIntake({ event_id: event.event_id, shadow: 1, owner: 'responder', sender: senderOf(event), thread_key: keys.threadKey, desk_id: keys.deskId })
}

export function createClaim(ledger: Ledger): Claim {
  return {
    claim(event, policy, mode) {
      const keys = keysOf(event)
      return ledger.open<ClaimResult>(tx => {
        if (mode !== 'superagent') {
          if (tx.run(OWNER_CAS, 'responder', event.event_id).changes === 0) return { status: 'already_claimed' }
          if (mode === 'responder') return { status: 'claimed', owner: 'responder', route: 'judge', ...keys }
          writeShadow(tx, event, keys)
          return { status: 'shadowed', ...keys }
        }
        const decision = policy.decide(event, readSnapshot(tx, keys))
        if (tx.run(OWNER_CAS, decision.owner, event.event_id).changes === 0) return { status: 'already_claimed' }
        if (decision.owner === 'responder') return { status: 'claimed', owner: 'responder', route: decision.route, ...keys }

        tx.insertIntake({ event_id: event.event_id, shadow: 0, owner: 'superagent', sender: senderOf(event), thread_key: keys.threadKey, desk_id: keys.deskId })
        if (decision.route === 'judge') return { status: 'claimed', owner: 'superagent', route: 'judge', ...keys }

        if (decision.route === 'fastpath') {
          if (!decision.disposition) throw new Error(`claim: fastpath for ${event.event_id} needs a disposition`)
          // decline must carry reason and alternative (intake CHECK, R4); the policy's detail
          // supplies them, and a decline without them gets a fixed pair instead of a rollback.
          const detail = decision.detail ?? {}
          const reason = typeof detail.reason === 'string' ? detail.reason : undefined
          const alternative = typeof detail.alternative === 'string' ? detail.alternative : undefined
          tx.disposeIntake(event.event_id, 0, {
            disposition: decision.disposition,
            ...(reason !== undefined || decision.disposition === 'decline' ? { reason: reason ?? 'fastpath decline' } : {}),
            ...(alternative !== undefined || decision.disposition === 'decline' ? { alternative: alternative ?? 'identity_notice' } : {}),
          })
          return { status: 'claimed', owner: 'superagent', route: 'fastpath', disposition: decision.disposition, ...keys }
        }

        // passthrough (R3): input for the live subscription only; no commitment, attempt or turn.
        const sub = tx.get<{ commitment_id: string }>(`SELECT commitment_id FROM ${PHYSICAL.subscription} WHERE thread_key = ?`, keys.threadKey)
        if (!sub) throw new Error(`claim: passthrough for ${event.event_id} without a live subscription on ${keys.threadKey}`)
        tx.disposeIntake(event.event_id, 0, { disposition: 'passthrough' })
        tx.append(sub.commitment_id, { actor: senderOf(event), kind: 'passthrough', request_id: `pt:${event.event_id}`,
          body: { event_id: event.event_id, message_id: event.message_id, text: event.text } })
        tx.advanceSubscription(keys.threadKey)
        return { status: 'claimed', owner: 'superagent', route: 'passthrough', disposition: 'passthrough', ...keys }
      })
    },

    shadow(event) {
      ledger.open(tx => writeShadow(tx, event, keysOf(event)))
    },

    unowned(now, olderThanMs) {
      return ledger.read.all<{ event_id: string }>(
        `SELECT event_id FROM ${PHYSICAL.inbox_event} WHERE owner IS NULL AND received_at < ? ORDER BY received_at`, now - olderThanMs)
        .map(r => r.event_id)
    },

    snapshot(event) {
      return readSnapshot(ledger.read, keysOf(event))
    },
  }
}
