/**
 * The one way recovery is allowed to speak: a proposal handed to the outlet.
 *
 * 11 is explicit that recovery does not send anything. It writes a proposal and
 * the kernel's outlet decides whether it may go out, on which tier, and whether
 * this process even holds the lease. Two shapes are used:
 *
 * - `alert`: an irreversible-risk finding (a second instance answering the same
 *   message). This is the one moment that may break silence, so it goes out as
 *   `interrupt`.
 * - `brief`: the "a restart lost one, and I redid it" line. Quiet by design; it
 *   belongs in the brief, not in a notification.
 *
 * The tier decision lives here rather than in the outlet because the outlet is
 * generic and this module is the one that knows what its own moments mean.
 *
 * @module dsh-web-all/superagent/recovery/speak
 */

import type { OutboxMoment, Tier } from '../protocol/objects.ts'
import type { Outlet } from '../kernel/outlet.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { Ledger } from '../kernel/ledger.ts'
import type { HostLog } from '../host-ports.ts'
import type { OutletPolicy, OutletVerdict, SpeechProposal } from '../kernel/ports.ts'

/** Same ceiling the outlet enforces; a proposal over it is refused, not truncated. */
export const MAX_WORDS = 100

const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' })

/**
 * N19 word count: word-like segments, with a run of digits counting once.
 *
 * A deliberate duplicate of `surface/words.ts`: the dependency fence keeps this
 * module out of `surface`, and a shared counter that lived in either would invert
 * a direction 11 fixes. The count decides one thing here - whether a proposal fits
 * the outlet's ceiling - so the duplication is bounded to that line.
 * @param text - the body to measure.
 * @returns the word count.
 */
export function countWords(text: string): number {
  let words = 0
  // A run of digits is one word-like segment already, which is exactly N19's
  // "数字串计 1"; counting segments is the whole rule.
  for (const segment of SEGMENTER.segment(text)) if (segment.isWordLike) words += 1
  return words
}

/** The tier one of recovery's own moments goes out on. */
export function tierOf(moment: OutboxMoment): Tier {
  if (moment === 'alert') return 'interrupt'
  if (moment === 'brief') return 'brief'
  return 'reply'
}

/**
 * The policy for recovery's own proposals.
 *
 * It does not judge wording, because everything this module can say is either a
 * mechanical fact about the ledger or an alert: there is nothing here to veto.
 */
export const RECOVERY_POLICY: OutletPolicy = {
  check(proposal: SpeechProposal): OutletVerdict {
    return { ok: true, tier: tierOf(proposal.moment), text: proposal.text, words: countWords(proposal.text) }
  },
}

/** What recovery wants to say, before the outlet has an opinion. */
export interface RecoverySpeech {
  moment: OutboxMoment
  chatId: string
  text: string
  /** Stable per subject: a second attempt at the same line must be a no-op. */
  idemKey: string
  eventId?: string
  commitmentId?: string
  audience?: 'requester' | 'owner'
}

export interface SpeakDeps {
  ledger: Ledger
  outlet: Outlet
  log: HostLog
}

/**
 * Propose one line, idempotently.
 *
 * The outlet's own idempotency is the outbox primary key, which is derived from
 * the idem key; a duplicate insert throws rather than deduplicating. So the
 * existence check happens here, before the proposal, and a repeated call is a
 * silent no-op. A refused proposal (no lease, shadow mode, too long) is logged and
 * dropped: recovery must never fail because it could not speak.
 * @param deps - ledger, outlet and log.
 * @param speech - the line to propose.
 * @returns true when a row was written by this call.
 */
export function propose(deps: SpeakDeps, speech: RecoverySpeech): boolean {
  const key = speech.idemKey.slice(0, 50)
  const seen = deps.ledger.read.get(`SELECT 1 FROM ${PHYSICAL.outbox} WHERE idem_key = ?`, key)
  if (seen !== undefined) return false
  const proposal: SpeechProposal = {
    chat_id: speech.chatId,
    moment: speech.moment,
    audience: speech.audience ?? 'owner',
    payload: 'text',
    text: speech.text,
    idem_key: key,
    ...(speech.eventId === undefined ? {} : { event_id: speech.eventId }),
    ...(speech.commitmentId === undefined ? {} : { commitment_id: speech.commitmentId }),
  }
  const result = deps.outlet.submit(proposal, RECOVERY_POLICY, 'superagent')
  if (result.ok) return true
  deps.log.warn(`superagent/recovery: proposal ${key} was refused: ${result.code} ${result.message}`)
  return false
}