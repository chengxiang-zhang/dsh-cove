/**
 * `Channel.audience`: who is in the conversation right now.
 *
 * The caller needs two answers from one call, because it uses them together: who
 * could read what is about to be said, and whether the owner is among them. A
 * reveal authorised for the owner in a group of five is a different act from the
 * same sentence in a direct chat, and a channel that returned only a count would
 * push that judgement back to whoever calls it.
 *
 * `party_ids` are `union_id`s: 02 makes the person key the cross-application id
 * from the raw event (F17), and `open_id` is scoped to one application, so it
 * can never stand in for a person. A member whose event carried no `union_id` is
 * therefore left out of `party_ids` rather than represented by a weaker key -
 * that is the "weak identity counts as somebody else" branch in SPIKES S3, and
 * it fails towards the narrowest audience, which is the safe side.
 *
 * In a direct chat the audience is the one person; a member snapshot there would
 * be a second network call that can fail, for an answer the conversation already
 * implies.
 *
 * @module dsh-web-all/superagent/channels/feishu/audience
 */

import type { ChatType } from '../../protocol/events.ts'

/** One conversation member as the platform reports them. */
export interface ChannelMember {
  union_id?: string
  open_id: string
}

/** Who is present, and whether the owner is one of them. */
export interface AudienceSnapshot {
  party_ids: string[]
  has_owner: boolean
}

/** The two questions the cache cannot answer; both are supplied by the composition root. */
export interface AudienceDeps {
  /** Group member snapshot; rejects when the platform cannot answer. */
  members(chatId: string): Promise<readonly ChannelMember[]>
  /** The configured owner's `union_id`s; empty when none is configured. */
  ownerUnionIds(): readonly string[]
}

/**
 * Resolve one conversation's audience.
 * @param deps - member snapshot and owner identity.
 * @param input - the conversation and, for a direct chat, the person in it.
 * @returns the present `union_id`s and whether the owner is among them.
 * @throws when a group's member snapshot cannot be read; the caller then treats the audience as unknown.
 */
export async function resolveAudience(
  deps: AudienceDeps,
  input: { chatId: string; chatType: ChatType; senderUnionId?: string },
): Promise<AudienceSnapshot> {
  const ids: string[] = []
  if (input.chatType === 'p2p') {
    const only = (input.senderUnionId ?? '').trim()
    if (only !== '') ids.push(only)
  } else {
    for (const member of await deps.members(input.chatId)) {
      const unionId = (member.union_id ?? '').trim()
      if (unionId !== '' && !ids.includes(unionId)) ids.push(unionId)
    }
  }
  const owners = deps.ownerUnionIds().map(owner => owner.trim())
  return { party_ids: ids, has_owner: ids.some(id => owners.includes(id)) }
}