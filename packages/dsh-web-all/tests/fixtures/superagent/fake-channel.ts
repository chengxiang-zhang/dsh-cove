/**
 * Fake channel: implements the protocol Channel in memory.
 * `push` produces an inbound event; `sent` and `reacted` record outbound calls.
 * The same idemKey sent twice returns the same messageId, mirroring the Feishu
 * uuid idempotency. Send failure can be injected.
 */

import type { Channel, HistoryLine, InboundEvent } from '../../../src/host/services/superagent/protocol/events.ts'

export interface SentLine { chatId: string; text: string; replyTo?: string; idemKey: string; messageId: string; at: number }
export interface ReactedLine { messageId: string; emoji: string }

export interface FakeChannel extends Channel {
  readonly sent: readonly SentLine[]
  readonly reacted: readonly ReactedLine[]
  push(event: InboundEvent): void
  failSend(error: Error | undefined): void
  setAudience(chatId: string, audience: { party_ids: string[]; has_owner: boolean }): void
}

export function createFakeChannel(now: () => number = () => 0): FakeChannel {
  const sent: SentLine[] = []
  const reacted: ReactedLine[] = []
  const handlers = new Set<(event: InboundEvent) => void>()
  const byIdem = new Map<string, string>()
  const audiences = new Map<string, { party_ids: string[]; has_owner: boolean }>()
  let sendError: Error | undefined
  let seq = 0

  return {
    sent,
    reacted,
    inbound(handler) {
      handlers.add(handler)
      return () => { handlers.delete(handler) }
    },
    async send(chatId, text, replyTo, idemKey) {
      const existing = byIdem.get(idemKey)
      if (existing !== undefined) return { messageId: existing }
      if (sendError !== undefined) throw sendError
      const messageId = `om_fake_${++seq}`
      byIdem.set(idemKey, messageId)
      sent.push({ chatId, text, replyTo, idemKey, messageId, at: now() })
      return { messageId }
    },
    async react(messageId, emoji) {
      reacted.push({ messageId, emoji })
    },
    async audience(chatId) {
      const a = audiences.get(chatId) ?? { party_ids: [], has_owner: false }
      return { party_ids: [...a.party_ids], has_owner: a.has_owner }
    },
    async history(chatId, limit): Promise<HistoryLine[]> {
      return sent
        .filter((line) => line.chatId === chatId)
        .slice(-Math.max(0, limit))
        .map((line) => ({ message_id: line.messageId, sender_is_self: true, reply_to: line.replyTo, at: line.at }))
    },
    push(event) {
      for (const handler of [...handlers]) handler(event)
    },
    failSend(error) { sendError = error },
    setAudience(chatId, audience) { audiences.set(chatId, { party_ids: [...audience.party_ids], has_owner: audience.has_owner }) },
  }
}
