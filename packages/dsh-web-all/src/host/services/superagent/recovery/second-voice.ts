/**
 * The second voice: notice when another instance is answering the same message.
 *
 * A lease cannot help here. It guards one database; the failure F34 recorded was a
 * second host, on another machine, running the same Feishu application - one
 * message, eight replies, for fifteen days. Prevention is operational (one
 * application, one machine's credentials), so this module only tries to find out
 * and to say so once, loudly.
 *
 * The reading: for one inbound reply, count how many messages this application
 * sent that answer it, and compare with the rows this database recorded as sent
 * for that event. More answers than rows means somebody else sent the extras.
 *
 * Attribution is strict. A history line only counts when it is ours *and* names
 * the original message as its reply target; a platform that does not report
 * reply targets yields zero, which is the quiet direction (no false interruptions).
 * P6 - whether this host may read message history at all - is unverified, so
 * "cannot read" is a first-class answer: it degrades to unavailable and says so
 * once at startup (N17), rather than interrupting the owner about a permission.
 *
 * @module dsh-web-all/superagent/recovery/second-voice
 */

import type { HistoryLine } from '../protocol/events.ts'
import type { Ledger } from '../kernel/ledger.ts'
import type { HostLog } from '../host-ports.ts'
import { PHYSICAL } from '../protocol/db.ts'
import type { RecoverySpeech } from './speak.ts'

/** How far back the probe reads. Enough to see a burst of duplicate answers. */
export const SECOND_VOICE_WINDOW = 20
/** The caller waits this long after an outbound reply before asking. */
export const SECOND_VOICE_DELAY_MS = 30_000

/** Alert body; it states the fact, the likely cause and the one action that fixes it. */
export const SECOND_VOICE_ALERT = '同一个飞书应用似乎在另一台机器上也在回复：这条消息出现了多余的回答。'
  + '请检查是否只有一台机器持有这个应用的凭据；在那之前我会照常回话，但可能重复。'

/** A history row as the channel reports it; `reply_to` is the platform's reply target. */
export type HistoryRow = HistoryLine

export interface SecondVoiceReport {
  detected: boolean
  expected: number
  observed: number
}

/** Unavailable is a result, not a failure: the caller records one degrade row and moves on. */
export type SecondVoiceResult = SecondVoiceReport | { unavailable: true }

export interface SecondVoiceDeps {
  ledger: Ledger
  /** Message history reader; absent until P6 is verified. */
  history?: (chatId: string, limit: number) => Promise<readonly HistoryRow[]>
  degrade(reason: string, scope: string): string
  /** Hand one line to the outlet; the caller wires this to `propose`. */
  queue(speech: RecoverySpeech): boolean
  log: HostLog
  /** Scope of the degrade row: the application identity, as far as this build knows it. */
  scope: string
}

export interface SecondVoice {
  /** Whether the probe can run at all; startup uses this to write the row once. */
  readonly available: boolean
  secondVoice(eventId: string): Promise<SecondVoiceResult>
}

const I = PHYSICAL.inbox_event
const O = PHYSICAL.outbox

/** Where one inbound happened, read from the queue row the channel wrote. */
function inboundOf(ledger: Ledger, eventId: string): { chatId: string; messageId: string } | undefined {
  const row = ledger.read.get<{ payload: string }>(`SELECT payload FROM ${I} WHERE event_id = ?`, eventId)
  if (row === undefined) return undefined
  try {
    const envelope = JSON.parse(row.payload) as { chatId?: unknown; messageId?: unknown }
    const chatId = typeof envelope.chatId === 'string' ? envelope.chatId : ''
    const messageId = typeof envelope.messageId === 'string' ? envelope.messageId : ''
    if (chatId === '' || messageId === '') return undefined
    return { chatId, messageId }
  } catch {
    return undefined
  }
}

/**
 * Build the probe.
 * @param deps - ledger, history reader, degrade and queue seams.
 * @returns the probe, plus whether it can run.
 */
export function createSecondVoice(deps: SecondVoiceDeps): SecondVoice {
  const secondVoice = async (eventId: string): Promise<SecondVoiceResult> => {
    if (deps.history === undefined) return { unavailable: true }
    const inbound = inboundOf(deps.ledger, eventId)
    if (inbound === undefined) {
      // Nothing to compare against: an event this database never stored cannot have
      // had a recorded reply, so any observation would be a guess.
      deps.log.warn(`superagent/recovery: second voice skipped, event ${eventId} is not in the inbox`)
      return { unavailable: true }
    }

    const sent = deps.ledger.read.get<{ k: number }>(
      `SELECT count(*) AS k FROM ${O} WHERE event_id = ? AND state = 'sent'`, eventId)?.k ?? 0

    let lines: readonly HistoryRow[]
    try {
      lines = await deps.history(inbound.chatId, SECOND_VOICE_WINDOW)
    } catch (error) {
      deps.log.warn(`superagent/recovery: second voice unavailable for ${inbound.chatId}: ${error instanceof Error ? error.message : String(error)}`)
      return { unavailable: true }
    }

    const observed = lines.filter(line => line.sender_is_self && line.reply_to === inbound.messageId).length
    if (observed <= sent) return { detected: false, expected: sent, observed }

    deps.degrade('second_voice', deps.scope)
    deps.queue({
      moment: 'alert',
      chatId: inbound.chatId,
      eventId,
      text: SECOND_VOICE_ALERT,
      idemKey: `second-voice:${eventId}`,
      audience: 'owner',
    })
    deps.log.error(`superagent/recovery: second voice detected on ${eventId}: observed ${observed} > recorded ${sent}`)
    return { detected: true, expected: sent, observed }
  }

  return { available: deps.history !== undefined, secondVoice }
}