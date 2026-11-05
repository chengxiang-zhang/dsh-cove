/**
 * `Channel.react`: the acknowledgement that is the whole answer.
 *
 * The capability already exists for the receipt the responder adds when a turn
 * starts, and its shape is a boolean because a reaction is best-effort: the
 * vendor may refuse one, or the application may not have the permission. The
 * protocol's `react` returns nothing, so a reaction that did not land has to be
 * reported as a rejection rather than swallowed; the caller decides between a
 * sentence and silence, and a channel that returned success for a refused
 * reaction would let it choose silence by accident.
 *
 * @module dsh-web-all/superagent/channels/feishu/react
 */

/** The reaction surface a channel needs; boolean means "the platform accepted it". */
export interface ChannelReactPort {
  react(messageId: string, emojiType: string): Promise<boolean>
}

/** Why a reaction did not land; stable for the caller's choice of fallback. */
export class ChannelReactError extends Error {
  readonly code: 'REACT_UNAVAILABLE' | 'REACTION_FAILED'
  constructor(code: 'REACT_UNAVAILABLE' | 'REACTION_FAILED', detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'ChannelReactError'
    this.code = code
  }
}

/**
 * Add one reaction to one message.
 * @param port - the reaction surface, when one is configured.
 * @param messageId - the message to react to.
 * @param emoji - the platform's emoji key, e.g. `SMILE`.
 * @returns nothing; the call's outcome is the absence of a rejection.
 * @throws {ChannelReactError} when nothing can react, or the platform refused.
 */
export async function deliverReaction(
  port: ChannelReactPort | undefined,
  messageId: string,
  emoji: string,
): Promise<void> {
  if (port === undefined) throw new ChannelReactError('REACT_UNAVAILABLE', 'no Feishu application is configured')
  if (messageId.trim() === '') throw new ChannelReactError('REACTION_FAILED', 'refusing to react without a message id')
  const landed = await port.react(messageId, emoji)
  if (!landed) throw new ChannelReactError('REACTION_FAILED', `the platform did not accept ${emoji} on ${messageId}`)
}