/**
 * Kernel outlet (T14): the single exit for everything a person sees (I4).
 *
 * `submit` grades and checks a proposal through the injected OutletPolicy (tier
 * and words come from the policy, never from the proposal) and queues one row
 * stamped with the current lease epoch. `flush` sends only rows of the current
 * epoch; rows of an older epoch are suppressed with an audit journal line.
 * Every send is claimed in the ledger before the sender is called (F19).
 */

import { PHYSICAL } from '../protocol/db.ts'
import type { OutboxRow, Tier } from '../protocol/objects.ts'
import type { Ledger } from './ledger.ts'
import { holds, type Lease } from './lease.ts'
import type { OutletPolicy, SenderPort, SpeechProposal } from './ports.ts'

export type OutletMode = 'responder' | 'shadow' | 'superagent'
export type SubmitCode = 'NO_LEASE' | 'REPLY_EXISTS' | 'SHADOW_NO_WRITE' | 'TOO_LONG' | 'MOMENT_FORBIDDEN' | 'DISCLOSE_BLOCKED' | 'PROMISE_BLOCKED'
export type SubmitResult = { ok: true; outboxId: string; tier: Tier; words: number } | { ok: false; code: SubmitCode; message: string }
export interface FlushResult { sent: number; failed: number; suppressed: number; retried: number }

export interface Outlet {
  submit(p: SpeechProposal, policy: OutletPolicy, mode: OutletMode): SubmitResult
  flush(now: number, sender: SenderPort): Promise<FlushResult>
  /** Consumes the "one message did not go out" note for a chat. */
  pendingNote(chatId: string): string | undefined
}

export const RETRY_BASE_MS = 30_000
export const RETRY_CAP_MS = 30 * 60_000
export const GIVE_UP_MS = 24 * 3_600_000
export const STUCK_UNTRIED_MS = 5 * 60_000
export const MAX_WORDS = 100
export const UNSENT_NOTE = '有一条消息没发出去。'
/** Journal stream for outlet audits of rows that carry no commitment. */
export const OUTLET_AUDIT_STREAM = 'outlet'

const O = PHYSICAL.outbox
const backoff = (attempts: number): number => Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_CAP_MS)

export function createOutlet(ledger: Ledger, lease: Lease, holder: string, revalidate?: (row: OutboxRow) => boolean): Outlet {
  const notes = new Map<string, string>()
  const fail = (code: SubmitCode, message: string): SubmitResult => ({ ok: false, code, message })

  function submit(p: SpeechProposal, policy: OutletPolicy, mode: OutletMode): SubmitResult {
    if (mode !== 'superagent') return fail('SHADOW_NO_WRITE', `outlet is read-only in ${mode} mode`)
    const now = ledger.nowMs()
    const current = lease.current()
    if (!holds(current, holder, now)) return fail('NO_LEASE', `${holder} does not hold the outlet lease`)
    const verdict = policy.check(p, now)
    if (!verdict.ok) return fail(verdict.code, verdict.message)
    const words = p.payload === 'react' ? 0 : verdict.words
    if (words > MAX_WORDS) return fail('TOO_LONG', `${words} words > ${MAX_WORDS}`)
    if (verdict.tier === 'reply' && p.payload === 'text' && p.event_id
      && ledger.read.get(`SELECT 1 FROM ${O} WHERE event_id = ? AND tier = 'reply' AND payload = 'text'`, p.event_id)) {
      return fail('REPLY_EXISTS', `event ${p.event_id} already has a reply`)
    }
    const note = p.payload === 'text' ? pendingNote(p.chat_id) : undefined
    let row: OutboxRow
    try {
      row = ledger.open(tx => tx.recordOutbox({
      idem_key: p.idem_key, chat_id: p.chat_id, reply_to: p.reply_to ?? null, event_id: p.event_id ?? null,
      commitment_id: p.commitment_id ?? null, payload: p.payload, body: note ? `${verdict.text}\n${note}` : verdict.text,
      moment: p.moment, tier: verdict.tier, audience: p.audience, words, expects_reply: p.expects_reply ? 1 : 0,
      lease_epoch: current.epoch,
    }), { module: 'kernel' })
    } catch (error) {
      // R1 A10: two concurrent submits both pass the read above; the second meets the
      // unique reply index and gets the protocol code, not a raw constraint error.
      if ((error as { code?: unknown }).code === 'REPLY_EXISTS') return fail('REPLY_EXISTS', `event ${p.event_id ?? '?'} already has a reply`)
      throw error
    }
    return { ok: true, outboxId: row.outbox_id, tier: row.tier, words: row.words }
  }

  function pendingNote(chatId: string): string | undefined {
    const note = notes.get(chatId)
    notes.delete(chatId)
    return note
  }

  /** Housekeeping in one transaction: stale epochs suppressed, never-tried rows and expired retries failed. */
  function sweep(now: number, epoch: number, result: FlushResult): void {
    ledger.open(tx => {
      const queued = tx.all<OutboxRow>(`SELECT * FROM ${O} WHERE state = 'queued' ORDER BY created_at, outbox_id`)
      for (const row of queued) {
        if (row.lease_epoch !== epoch) {
          tx.run(`UPDATE ${O} SET state = 'suppressed', error = ?, updated_at = ? WHERE outbox_id = ?`, `stale epoch ${row.lease_epoch} < ${epoch}`, now, row.outbox_id)
          tx.append(row.commitment_id ?? OUTLET_AUDIT_STREAM, { actor: 'outlet', kind: 'note',
            body: { audit: 'suppressed_stale_epoch', outbox_id: row.outbox_id, row_epoch: row.lease_epoch, epoch } })
          result.suppressed += 1
          continue
        }
        const stuck = row.attempts === 0 && row.created_at + STUCK_UNTRIED_MS < now
        const expired = row.attempts > 0 && row.created_at + GIVE_UP_MS <= now
        if (stuck || expired) {
          tx.run(`UPDATE ${O} SET state = 'failed', error = coalesce(error, ?), updated_at = ? WHERE outbox_id = ?`,
            stuck ? 'never attempted within 5 minutes' : 'gave up after 24 hours', now, row.outbox_id)
          notes.set(row.chat_id, UNSENT_NOTE)
          result.failed += 1
        }
      }
    }, { module: 'kernel' })
  }

  /** Claim-before-send: attempts + 1 and a provisional retry time are durable before the sender runs. */
  function claimSend(id: string, now: number, epoch: number): OutboxRow | undefined {
    return ledger.open(tx => {
      const row = tx.get<OutboxRow>(`SELECT * FROM ${O} WHERE outbox_id = ? AND state = 'queued' AND lease_epoch = ?`, id, epoch)
      if (!row || !holds(lease.current(), holder, now) || lease.current()?.epoch !== epoch) return undefined
      tx.run(`UPDATE ${O} SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ? WHERE outbox_id = ?`, now + RETRY_BASE_MS, now, id)
      return { ...row, attempts: row.attempts + 1 }
    }, { module: 'kernel' })
  }

  async function flush(now: number, sender: SenderPort): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, failed: 0, suppressed: 0, retried: 0 }
    const current = lease.current()
    if (!holds(current, holder, now)) return result
    sweep(now, current.epoch, result)
    const due = ledger.read.all<{ outbox_id: string }>(`SELECT outbox_id FROM ${O} WHERE state = 'queued' AND lease_epoch = ?
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at, outbox_id`, current.epoch, now)
    for (const { outbox_id: id } of due) {
      const queued = ledger.read.get<OutboxRow>(`SELECT * FROM ${O} WHERE outbox_id = ?`, id)
      if (queued && revalidate && !revalidate(queued)) {
        ledger.open(tx => tx.run(`UPDATE ${O} SET state='suppressed',error='outlet evidence changed',updated_at=? WHERE outbox_id=? AND state='queued'`, now, id), { module: 'kernel' })
        result.suppressed += 1
        continue
      }
      const row = claimSend(id, now, current.epoch)
      if (!row) continue
      if (row.attempts > 1) result.retried += 1
      try {
        const messageId = row.payload === 'react'
          ? (await sender.react(row.reply_to ?? '', row.body), row.reply_to)
          : (await sender.send(row.chat_id, row.body, row.idem_key, row.reply_to ?? undefined)).messageId
        ledger.open(tx => tx.run(`UPDATE ${O} SET state = 'sent', message_id = ?, sent_at = ?, error = NULL, updated_at = ? WHERE outbox_id = ?`,
          messageId ?? null, now, now, id), { module: 'kernel' })
        result.sent += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ledger.open(tx => tx.run(`UPDATE ${O} SET next_attempt_at = ?, error = ?, updated_at = ? WHERE outbox_id = ?`,
          now + backoff(row.attempts), message.slice(0, 500), now, id), { module: 'kernel' })
      }
    }
    return result
  }

  return { submit, flush, pendingNote }
}
