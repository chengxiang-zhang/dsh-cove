/** Pure inbound admission rules for Feishu/Lark events. */

export interface GatingConfig {
  requireMentionInGroup: boolean
  allowedOpenIds: readonly string[]
  dropAppMessages: boolean
}

export type GateVerdict =
  | { accept: true }
  | { accept: false; reason: 'app-message' | 'group-without-mention' | 'sender-not-allowed' }

export interface GateInput {
  chatType?: string
  senderType?: string
  senderOpenId?: string
  mentionBot?: boolean
}

/** Apply the authoritative pre-merge gate order. */
export function gateEvent(input: GateInput, config: GatingConfig): GateVerdict {
  if (config.dropAppMessages && input.senderType === 'app') {
    return { accept: false, reason: 'app-message' }
  }
  if (input.chatType === 'group' && config.requireMentionInGroup && !input.mentionBot) {
    return { accept: false, reason: 'group-without-mention' }
  }
  if (config.allowedOpenIds.length > 0) {
    const senderOpenId = input.senderOpenId
    if (!senderOpenId || !config.allowedOpenIds.includes(senderOpenId)) {
      return { accept: false, reason: 'sender-not-allowed' }
    }
  }
  return { accept: true }
}
