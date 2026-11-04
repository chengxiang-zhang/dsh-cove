/**
 * Lark inbox settings schema and host-side path/credential resolution.
 *
 * Credentials moved to the shared `feishu` namespace when the reply path landed:
 * one Feishu application now serves the inbound bot, the outbound run-finished
 * push and the answers the agent writes, and three namespaces disagreeing about
 * which application that is was the bug. The three credential fields below stay
 * in the schema and stay readable so an installation configured before the move
 * keeps its bot, but they are deprecated: the setup wizard writes the shared
 * namespace (`feishu`) and nothing here writes these back.
 *
 * `resolveAppSecret` is kept as an export because other code and tests of the
 * pre-move shape still call it; it now delegates the `env:NAME` form to the
 * shared secret reader, so both spellings behave identically.
 */

import { join } from 'node:path'
import { registerFamilyNamespace } from '../family-config.ts'
import { readSecret } from '../feishu/credentials.ts'
import z from 'schemastery'

export const LARK_INBOX_SETTINGS_NAMESPACE = 'lark-inbox'
export const DEFAULT_QUEUE_DIR = ''
/** Ambient secret variable of the pre-move shape; the shared domain also reads it. */
export const LARK_APP_SECRET_ENV = 'LARK_APP_SECRET'
export const LARK_DOMAINS = ['feishu', 'lark'] as const
/** How far the answer path may go; see `core/lark-inbox/reply-machine.ts`. */
export const REPLY_MODES = ['off', 'probe', 'self'] as const

/**
 * Standing instructions carried by the first prompt of a conversation.
 *
 * Written into the default rather than into the responder because an operator
 * changing this is changing what the bot is allowed to sound like, and that
 * belongs next to the setting that turns the capability on.
 */
export const DEFAULT_REPLY_PREAMBLE = [
  '你在通过飞书和一个人对话。从这里收到的内容来自飞书私聊，不是本机终端。',
  '直接输出你要发给对方的那段纯文本，不要解释你在做什么，不要用 Markdown 表格。',
  '你现在的工作目录是一个代码仓库：可以读、可以改、可以跑命令。仓库里有未提交的改动属于别人，不要提交或回退它。',
  '除非对方在这条消息里明确要求，不要执行 git push、不要重写历史、不要动 main 分支、不要推 tag。',
  '需要很长的分析时，先给结论，再给必要的过程。',
].join('\n')

/** Settings for answering a direct message with an agent turn. */
export interface AutoReplyConfig {
  mode: (typeof REPLY_MODES)[number]
  /** open ids allowed to trigger an answer; empty means "no allowlist". */
  openIds: string[]
  /** How long new messages keep joining the same batch before it is submitted. */
  debounceMs: number
  /** How long one turn may run before it is cancelled and closed as a timeout. */
  turnTimeoutMs: number
  /** Sweep cadence; also the coarseness of the deadline. */
  tickMs: number
  /** Working directory for the bot's sessions; empty means the host's own. */
  cwd: string
  preamble: string
  maxSendAttempts: number
  maxSubmitAttempts: number
  /** Whether to react to the message once its turn starts. */
  receipt: boolean
}

/**
 * Timing knobs, deliberately not settings.
 *
 * These are tuning constants, not policy: nobody operating a bot should have to
 * reason about a sweep cadence, and every one of them that appeared in the
 * settings page would also have to be rendered, translated and kept honest. What
 * does belong to an operator stays a field below - how far the path may go, who
 * may be answered, where it works, and how it speaks.
 */
export const REPLY_DEBOUNCE_MS = 1500
export const REPLY_TICK_MS = 2000
export const REPLY_TURN_TIMEOUT_MS = 180_000
export const REPLY_MAX_ATTEMPTS = 3

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
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(false),
  // Deprecated, kept for reading an installation configured before the shared
  // `feishu` namespace existed. The wizard no longer writes these.
  appId: z.string().default(''),
  appSecret: z.string().role('secret').default(''),
  domain: z.union(LARK_DOMAINS).default('feishu'),
  requireMentionInGroup: z.boolean().default(true),
  allowedOpenIds: z.array(z.string()).default([]),
  dropAppMessages: z.boolean().default(true),
  queueDir: z.string().default(DEFAULT_QUEUE_DIR),
  maxAttempts: z.number().step(1).min(1).default(5),
  staleTimeoutMs: z.number().step(1).min(1).default(300_000),
  // Off by default: nothing about the answer path may start speaking to a person
  // until an operator has said who may be answered.
  autoReplyMode: z.union(REPLY_MODES).default('off'),
  autoReplyOpenIds: z.array(z.string()).default([]),
  autoReplyCwd: z.string().default(''),
  autoReplyPreamble: z.string().default(DEFAULT_REPLY_PREAMBLE),
  // Finished rows are housekeeping, not history: the JSONL shards keep what the
  // platform actually sent, so the index can forget. Zero disables pruning for an
  // installation that wants the index as its archive.
  retentionDays: z.number().step(1).min(0).default(30),
  // Off by default: a reaction is visible to everyone in the conversation, and
  // whether the bot should mark itself as reading is the operator's call.
  autoReplyReceipt: z.boolean().default(false),
}) as unknown as z<LarkInboxConfig>

/**
 * Project the settings document onto the shape the answer path consumes.
 *
 * One place does this translation, so the responder never reads the settings
 * schema and the schema never has to grow a field the responder does not know.
 * @param config - the live `lark-inbox` namespace value.
 * @returns the answer-path configuration.
 */
export function autoReplyConfig(config: Required<LarkInboxConfig>): AutoReplyConfig {
  const resolvedMode = REPLY_MODES.includes(config.autoReplyMode) ? config.autoReplyMode : 'off'
  return {
    mode: resolvedMode,
    openIds: config.autoReplyOpenIds.map(id => id.trim()).filter(id => id !== ''),
    debounceMs: REPLY_DEBOUNCE_MS,
    turnTimeoutMs: REPLY_TURN_TIMEOUT_MS,
    tickMs: REPLY_TICK_MS,
    cwd: config.autoReplyCwd.trim(),
    preamble: config.autoReplyPreamble,
    maxSendAttempts: REPLY_MAX_ATTEMPTS,
    maxSubmitAttempts: REPLY_MAX_ATTEMPTS,
    receipt: config.autoReplyReceipt === true,
  }
}

registerFamilyNamespace(LARK_INBOX_SETTINGS_NAMESPACE, Config)

/**
 * Resolve the legacy per-namespace secret.
 *
 * Kept for the pre-move shape and its callers; the shared reader decides what an
 * `env:NAME` reference means so both spellings cannot drift.
 * @param config - the `lark-inbox` namespace value.
 * @param env - the environment to read ambient variables from.
 * @returns the secret.
 * @throws when no secret can be resolved, because a bot without one cannot connect.
 */
export function resolveAppSecret(config: LarkInboxConfig | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const raw = (config?.appSecret ?? '').trim()
  const secret = raw === '' ? '' : readSecret(raw, env, 'dsh-lark-inbox')
  if (secret !== '') return secret
  const ambient = env[LARK_APP_SECRET_ENV]
  if (ambient !== undefined && ambient !== '') return ambient
  throw new Error('dsh-lark-inbox: 未配置 appSecret；请改用「飞书」设置页填写应用凭据、或填写 env:VARNAME 引用环境变量、或导出 LARK_APP_SECRET 环境变量')
}

export function resolveQueueDir(config: LarkInboxConfig | undefined, dshHomeDir: string): string {
  const raw = config?.queueDir ?? DEFAULT_QUEUE_DIR
  return raw.trim() === '' ? join(dshHomeDir, 'lark-inbox') : raw
}

export function effectiveConfig(config: LarkInboxConfig | undefined): Required<LarkInboxConfig> {
  return Config(config ?? {}) as Required<LarkInboxConfig>
}