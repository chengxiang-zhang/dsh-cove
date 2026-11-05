/**
 * The Feishu implementation of the protocol's `Channel`: five methods, no judgement.
 *
 * The channel answers one question - "turn an external event into an inbound, and
 * put an outbound on the wire" - and it must not learn the others: it holds no
 * ledger handle, knows no commitment, and decides nothing about who deserves an
 * answer. The single decision it does relay is the admission hook: the kernel's
 * claim policy says whether this event is the secretary's, and the channel only
 * carries that verdict back to the caller that owns the responder.
 *
 * The admission rule, in one place:
 *
 * - no hook (before the composition root wires one) means the responder keeps
 *   the event, which is exactly the behaviour this host had before the channel;
 * - `responder` and `shadow` keep it: shadow mode is still the responder's answer,
 *   the secretary only records what it would have done;
 * - `superagent` and `already_claimed` do not, because the secretary owns the
 *   reply and a second answer is the eight-replies failure (F34);
 * - a hook that throws keeps the responder and logs a warning, because a message
 *   that nobody owns is worse than one answered twice.
 *
 * `deliver` is where those four rules meet the real event stream. The composition
 * root calls it once per appended envelope with its own kick, so the rule cannot
 * drift from the path that actually answers.
 *
 * @module dsh-web-all/superagent/channels/feishu/channel
 */

import type { Channel, ChatType, HistoryLine, InboundEvent } from '../../protocol/events.ts'
import type { LarkInboxEnvelope } from '../../../../../core/lark-inbox/queue.ts'
import type { InboxStore } from './inbox-store.ts'
import { toInboundEvent, unionIdOf } from './inbound.ts'
import { deliverText, type ChannelSendPort } from './send.ts'
import { deliverReaction, type ChannelReactPort } from './react.ts'
import { resolveAudience, type ChannelMember } from './audience.ts'

export type { ChannelMember }
export type { ChannelSendPort, ChannelSendResult } from './send.ts'
export type { ChannelReactPort } from './react.ts'

/** Who answers one admitted event; mirrors the kernel's `Owner` enum. */
export type AdmitResult = 'responder' | 'shadow' | 'superagent' | 'already_claimed'

/** The one hook the composition root injects; absent means "the responder answers". */
export interface FeishuChannelHooks {
  admit?: (event: InboundEvent) => AdmitResult
}

/** Why `history` cannot answer; the caller degrades instead of guessing. */
export class ChannelHistoryError extends Error {
  readonly code: 'HISTORY_UNAVAILABLE'
  constructor(detail: string) {
    super(`HISTORY_UNAVAILABLE: ${detail}`)
    this.name = 'ChannelHistoryError'
    this.code = 'HISTORY_UNAVAILABLE'
  }
}

/**
 * Whether the existing responder stays responsible for one admitted event.
 * @param result - the admission verdict.
 * @returns true when the responder must be kicked.
 */
export function admitKeepsResponder(result: AdmitResult): boolean {
  return result === 'responder' || result === 'shadow'
}

/** Everything the channel reads from the rest of the host. */
export interface FeishuChannelDeps {
  /**
   * The inbox store the channel's queue lives in.
   *
   * Nothing in the five methods reads it: the store is where the event came from
   * and where the answer's delivery state is recorded by the responder. It is
   * threaded here because the composition root must hand that same handle to the
   * claim path that lands with the kernel (T27), and a second `InboxStore.open`
   * on one SQLite file would be the double-consumer failure the store documents.
   */
  store: () => InboxStore | undefined
  /** Outbound text port; absent when no application is configured. */
  sender: () => ChannelSendPort | undefined
  /** Reaction port; absent when no application is configured. */
  reactor: () => ChannelReactPort | undefined
  /** Group member snapshot, as the platform reports it. */
  members: (chatId: string) => Promise<readonly ChannelMember[]>
  /** Message history reader; absent until the scope for it is granted (N17). */
  historyReader?: (chatId: string, limit: number) => Promise<HistoryLine[]>
  /** The configured owner's `union_id`s. */
  ownerUnionIds: () => readonly string[]
  /** Admission hook; absent until the composition root wires the claim policy. */
  hooks?: FeishuChannelHooks
  /** Warning sink; the channel never throws out of `deliver`. */
  log?: { warn(message: string): void }
}

/** The protocol channel plus the entry the composition root drives. */
export interface FeishuChannel extends Channel {
  /**
   * Admit one appended envelope and hand the verdict to the caller's kick.
   * @param envelope - the envelope the queue just stored.
   * @param kick - starts the responder on this envelope.
   * @returns the inbound event, or undefined when the envelope could not be read.
   */
  deliver(envelope: LarkInboxEnvelope, kick: () => void): InboundEvent | undefined
  /** The store handle the composition root passed in, for the claim path. */
  inbox(): InboxStore | undefined
}

/** What the channel remembers about a conversation it has delivered for. */
interface ChatMemory {
  chatType: ChatType
  senderUnionId?: string
}

/**
 * Build the Feishu channel.
 * @param deps - ports, hook and warning sink.
 * @returns the five protocol methods plus `deliver`.
 */
export function createFeishuChannel(deps: FeishuChannelDeps): FeishuChannel {
  const handlers = new Set<(event: InboundEvent) => void>()
  const chats = new Map<string, ChatMemory>()
  const warn = (message: string): void => {
    try {
      deps.log?.warn(message)
    } catch {
      // Observability must never be the reason an event goes unanswered.
    }
  }

  const admitOf = (event: InboundEvent): AdmitResult => {
    const admit = deps.hooks?.admit
    if (admit === undefined) return 'responder'
    try {
      return admit(event)
    } catch (error) {
      warn(`superagent/channels/feishu: admit threw on ${event.event_id}, the responder keeps the event: ${error instanceof Error ? error.message : String(error)}`)
      return 'responder'
    }
  }

  return {
    inbound(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },

    async send(chatId, text, replyTo, idemKey) {
      return await deliverText(deps.sender(), chatId, text, replyTo, idemKey)
    },

    async react(messageId, emoji) {
      await deliverReaction(deps.reactor(), messageId, emoji)
    },

    async audience(chatId) {
      const known = chats.get(chatId)
      return await resolveAudience(
        { members: deps.members, ownerUnionIds: deps.ownerUnionIds },
        {
          chatId,
          // A chat this process has not delivered for is treated as a group: for
          // a direct chat the audience would be one person the channel cannot
          // name, and asking the platform is the narrower failure.
          chatType: known?.chatType ?? 'group',
          ...(known?.senderUnionId === undefined ? {} : { senderUnionId: known.senderUnionId }),
        },
      )
    },

    async history(chatId, limit) {
      if (deps.historyReader === undefined) {
        throw new ChannelHistoryError(`no history reader is configured for ${chatId} (limit ${String(limit)})`)
      }
      return await deps.historyReader(chatId, limit)
    },

    deliver(envelope, kick) {
      let event: InboundEvent
      try {
        event = toInboundEvent(envelope, Date.now())
      } catch (error) {
        warn(`superagent/channels/feishu: ${error instanceof Error ? error.message : String(error)}; the responder keeps the event`)
        kick()
        return undefined
      }

      if (admitKeepsResponder(admitOf(event))) kick()

      const senderUnionId = unionIdOf(envelope.raw)
      const remembered = chats.get(event.chat.id)?.senderUnionId
      const keepUnionId = senderUnionId ?? remembered
      chats.set(event.chat.id, keepUnionId === undefined
        ? { chatType: event.chat.type }
        : { chatType: event.chat.type, senderUnionId: keepUnionId })

      // Subscribers hear every admitted event, whoever answers it: the kernel
      // writes `intake` for the ones it did not take, and a subscription that
      // only saw its own claims could not tell "nobody spoke" from "not mine".
      for (const handler of [...handlers]) {
        try {
          handler(event)
        } catch (error) {
          warn(`superagent/channels/feishu: inbound subscriber threw on ${event.event_id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return event
    },

    inbox() {
      return deps.store()
    },
  }
}