/**
 * The three normalized events the kernel understands, and the channel contract.
 *
 * A channel only does five things: produce inbound events, send, react, report
 * the audience of a chat and read back history. It does not know commitments,
 * does not write the ledger and does not judge.
 */

import type { EndReason } from './objects.ts'
import type { ReportInput } from './tools.ts'

export type ChatType = 'p2p' | 'group'

export interface InboundEvent {
  event_id: string
  chat: { id: string; type: ChatType }
  sender: { open_id: string; union_id?: string }
  thread: string
  text: string
  message_id: string
  received_at: number
}

export interface ExecutorReportEvent { attempt_id: string; report: ReportInput; turn_end_reason?: EndReason }

export interface TickEvent { now: number; due: string[] }

export interface HistoryLine { message_id: string; sender_is_self: boolean; reply_to?: string; at: number }

export interface Channel {
  /** Subscribes to inbound events; returns the unsubscribe function. */
  inbound(handler: (event: InboundEvent) => void): () => void
  send(chatId: string, text: string, replyTo: string | undefined, idemKey: string): Promise<{ messageId: string }>
  react(messageId: string, emoji: string): Promise<void>
  audience(chatId: string): Promise<{ party_ids: string[]; has_owner: boolean }>
  history(chatId: string, limit: number): Promise<HistoryLine[]>
}

/** Thread identity: `<chatType>:<chatId>:<rootMessageId>`. */
export function threadKey(chatType: ChatType, chatId: string, rootMessageId: string): string {
  if (chatType !== 'p2p' && chatType !== 'group') throw new Error(`threadKey: unknown chat type ${String(chatType)}`)
  if (chatId === '' || rootMessageId === '') throw new Error('threadKey: chatId and rootMessageId must be non-empty')
  return `${chatType}:${chatId}:${rootMessageId}`
}
