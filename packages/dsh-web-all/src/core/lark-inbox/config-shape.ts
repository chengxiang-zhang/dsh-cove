/**
 * The `lark-inbox` settings namespace and the shape of the document in it.
 *
 * Two capabilities read this document and neither may own it: the Feishu channel
 * answers inbound messages with it, and the notify domain reads the legacy
 * credential fields from it as a fallback for an installation configured before
 * the shared `feishu` namespace existed. A platform domain importing a channel's
 * private config module would make the outbound push depend on the inbound
 * entry, so the namespace constant and the document shape live here instead and
 * both sides import this module.
 *
 * Only the shape lives here. The schemastery schema, the defaults and every
 * derivation over the values stay with the channel, because they describe what
 * that entry does rather than what the document is.
 *
 * @module dsh-web-all/core/lark-inbox/config-shape
 */

/** Settings namespace of the inbound Feishu entry; user-visible and stable. */
export const LARK_INBOX_SETTINGS_NAMESPACE = 'lark-inbox'

/** How far the answer path may go; see `core/lark-inbox/reply-machine.ts`. */
export const REPLY_MODES = ['off', 'probe', 'self'] as const
/** Whether an arriving message may join the running turn; see `steerDecision`. */
export const STEER_MODES = ['off', 'shadow', 'on'] as const
/** Whether the conversation itself decides how to answer; see `mayAcknowledgeOnly`. */
export const ROUTER_MODES = ['off', 'on'] as const

/** The `lark-inbox` settings document. */
export interface LarkInboxConfig {
  enabled?: boolean
  announceToAgent?: boolean
  /** @deprecated read-only legacy field; the wizard writes the `feishu` namespace instead. */
  appId?: string
  /** @deprecated read-only legacy field; the wizard writes the `feishu` namespace instead. */
  appSecret?: string
  /** @deprecated read-only legacy field; the wizard writes the `feishu` namespace instead. */
  domain?: 'feishu' | 'lark'
  requireMentionInGroup?: boolean
  allowedOpenIds?: string[]
  dropAppMessages?: boolean
  queueDir?: string
  maxAttempts?: number
  staleTimeoutMs?: number
  /** How far the answer path may go: `off`, `probe` (record, never send) or `self`. */
  autoReplyMode?: (typeof REPLY_MODES)[number]
  /** open ids that may be answered; empty means "anyone who can message the bot". */
  autoReplyOpenIds?: string[]
  /** Working directory for the bot's sessions; empty means the host's own. */
  autoReplyCwd?: string
  /** Standing instructions carried by the first prompt of a conversation. */
  autoReplyPreamble?: string
  /** Days to keep finished queue rows and reply jobs; 0 keeps them forever. */
  retentionDays?: number
  /** React to the message when its turn starts, so the sender sees it was read. */
  autoReplyReceipt?: boolean
  /** Let the bot speak first about long runs the person did not ask it about. */
  proactiveNotice?: boolean
  /**
   * Whether a message arriving while a turn runs may join that turn: `off` waits
   * for the next turn, `shadow` only writes down what it would have done, `on`
   * folds it in.
   */
  autoReplySteer?: (typeof STEER_MODES)[number]
  /**
   * Whether an answer may be an acknowledgement instead of prose, and whether the
   * conversation is told so. See `ROUTER_PREAMBLE_LINES` and `mayAcknowledgeOnly`.
   */
  autoReplyRouter?: (typeof ROUTER_MODES)[number]
}
