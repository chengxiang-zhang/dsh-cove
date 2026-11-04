/**
 * Pure inbound admission rules for Feishu/Lark events.
 *
 * The group-message rule is the one that used to be wrong: "the event mentions
 * somebody" is not "the event mentions this bot", and in a busy group the
 * difference is every message that names a colleague. Admission therefore needs
 * the bot's own open id, which the host learns from the platform on startup. If
 * that identity never arrives, a group message cannot be proven to address us
 * while the mention rule is on, so it is refused rather than guessed at
 * (fail-closed). Direct messages are unaffected because they are addressed to the
 * bot by construction, and a deployment that turned the mention rule off does not
 * depend on the identity at all.
 */

/** Admission configuration, projected from the live settings document. */
export interface GatingConfig {
  requireMentionInGroup: boolean
  allowedOpenIds: readonly string[]
  dropAppMessages: boolean
}

export type GateRejection =
  | 'app-message'
  | 'group-without-bot-identity'
  | 'group-without-mention'
  | 'sender-not-allowed'

export type GateVerdict =
  | { accept: true }
  | { accept: false; reason: GateRejection }

/** Everything one event contributes to the admission decision. */
export interface GateInput {
  chatType?: string
  senderType?: string
  senderOpenId?: string
  /**
   * Whether the message mentions this bot, as decided by the gateway against
   * the bot's own open id. A gateway that could not learn its identity reports
   * false, never "somebody was mentioned".
   */
  mentionBot?: boolean
  /**
   * The bot's own open id. Empty or undefined means the host never learned it,
   * which makes any group message unprovable.
   */
  botOpenId?: string
}

/** Apply the authoritative pre-merge gate order. */
export function gateEvent(input: GateInput, config: GatingConfig): GateVerdict {
  if (config.dropAppMessages && input.senderType === 'app') {
    return { accept: false, reason: 'app-message' }
  }
  if (input.chatType === 'group' && config.requireMentionInGroup) {
    // The identity is only consulted when the rule that needs it applies: a
    // deployment that accepts every group message must not stop ingesting them
    // because an unrelated REST call for the bot's own id failed.
    const botOpenId = (input.botOpenId ?? '').trim()
    if (botOpenId === '') return { accept: false, reason: 'group-without-bot-identity' }
    if (input.mentionBot !== true) return { accept: false, reason: 'group-without-mention' }
  }
  if (config.allowedOpenIds.length > 0) {
    const senderOpenId = input.senderOpenId
    if (!senderOpenId || !config.allowedOpenIds.includes(senderOpenId)) {
      return { accept: false, reason: 'sender-not-allowed' }
    }
  }
  return { accept: true }
}

/**
 * Decide whether a message's mentions include this bot.
 *
 * @param mentionOpenIds - open ids carried by the event's `mentions[].id.open_id`.
 * @param botOpenId - the bot's own open id, or empty/undefined when unknown.
 * @returns true only when the bot's id is known and present in the mentions.
 */
export function mentionsBot(mentionOpenIds: readonly string[], botOpenId: string | undefined): boolean {
  const bot = (botOpenId ?? '').trim()
  if (bot === '') return false
  return mentionOpenIds.some(id => id.trim() === bot)
}