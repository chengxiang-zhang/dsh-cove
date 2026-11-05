/**
 * The fast paths of the first judgment (08), written as a data table rather
 * than as branches. Each row is one rule; `decide` walks them by `order` and
 * the first rule that fires wins. Adding a fast path means adding a row here,
 * not editing the policy.
 *
 * The table order is the order in `08` "第一判断：归位":
 *
 *   1 stop        (08 row 1)   release, only when the thread has a live commitment
 *   2 rotate      (08 row 1b)  acknowledge + rotate (/new, 新会话; N14)
 *   3 ordinal→proposal (08 row 2) commit  (N26)
 *   4 ordinal→question (08 row 2) amend   (N26)
 *   5 greeting    (08 row 3)   acknowledge + react
 *   6 not-authorized (08 row 4) decline, fixed identity notice
 *   7 live-subscription (08 row 5) passthrough
 *   8 rest        (08 row 6)   judge
 *
 * Row 2 is split in two so both dispositions stay static data: whether an
 * ordinal answers a proposal or a question changes the disposition, and the
 * disposition must not be computed inside `decide`.
 */

import type { ClaimDecision, ClaimSnapshot } from '../kernel/ports.ts'
import type { InboundEvent } from '../protocol/events.ts'

/** Who the sender is, as far as the world model is concerned. */
export type SenderClass = 'owner' | 'colleague' | 'member' | 'external' | 'unknown'

/** A decision without the owner: `owner` is always `superagent` for judgment. */
export type RouteOutcome = Omit<ClaimDecision, 'owner'>

export interface RouteRule {
  order: number
  name: string
  /** The host-side test. Pure: it reads the event, the ledger snapshot and the class only. */
  when: (event: InboundEvent, snapshot: ClaimSnapshot, cls: SenderClass) => boolean
  /** Static outcome of the rule. */
  result: RouteOutcome
  /**
   * Per-event detail part. Only rules whose `detail` depends on the message or
   * the snapshot (ordinals, commitment ids) need it; the rest carry `detail` in
   * `result`. Kept separate so `result` stays a plain value a config table can
   * hold.
   */
  detail?: (event: InboundEvent, snapshot: ClaimSnapshot, cls: SenderClass) => Record<string, unknown> | undefined
}

/** Equality stops: matched after punctuation and case are stripped. */
export const STOP_WORDS = ['停', '停止', '算了', 'stop', '别做了', '先别做了', '不用了'] as const

/** `/new` becomes `new` once the slash is stripped (N14: acknowledge + rotate). */
export const ROTATE_WORDS = ['new', '新会话'] as const

/** Greetings are short and closed. No open question may be waiting when one lands. */
export const GREETINGS = ['hi', 'hello', '你好', '您好', '谢谢', '感谢', '收到', 'ok', '好的', '好'] as const

/** A greeting is at most this many characters after normalization. */
export const GREETING_MAX_CHARS = 4

/**
 * Markers that force a passthrough message into the model.
 *
 * Deliberately coarse (08: "判据检测故意粗"): a false positive costs one
 * judgment turn, a false negative would push a scope change into the executor
 * that is already working. Short markers such as 先 and 也 therefore match far
 * more often than a human would call a scope change.
 */
export const SCOPE_CHANGE_MARKERS = ['改', '换', '停', '别', '先', '顺便', '也', '还有', '再加', '改主意', '不是这个'] as const

/** Bare ordinals: `2`, `1、3`, `1,3`, `1 3`. */
export const ORDINAL_RE = /^\s*\d+(\s*[、,，]\s*\d+)*\s*$/

/** Unicode punctuation, which covers ASCII, CJK and fullwidth marks, slash included. */
const PUNCTUATION_RE = /\p{P}/gu

/**
 * Normalize text for equality matching.
 * @param text - raw message text.
 * @returns the text with ends trimmed, every punctuation mark and `/` removed and case folded.
 */
export function normalizeForMatch(text: string): string {
  return text.trim().replace(PUNCTUATION_RE, '').toLowerCase()
}

/**
 * Read the ordinals out of a message that already matched `ORDINAL_RE`.
 * @param text - raw message text.
 * @returns the numbers in the order they appear, duplicates dropped.
 */
export function parseOrdinals(text: string): number[] {
  const seen: number[] = []
  for (const part of text.trim().split(/[、,，\s]+/)) {
    const value = Number(part)
    if (!Number.isInteger(value) || value < 1) continue
    if (!seen.includes(value)) seen.push(value)
  }
  return seen
}

/**
 * Whether the text carries a scope-change marker.
 * @param text - raw message text, not normalized: Chinese markers survive normalization anyway.
 * @returns true when any marker appears anywhere in the text.
 */
export function hasScopeChangeMarker(text: string): boolean {
  return SCOPE_CHANGE_MARKERS.some(marker => text.includes(marker))
}

/**
 * Whether the text is a greeting by the rules of row 3.
 * @param normalized - result of `normalizeForMatch`.
 * @param snapshot - ledger facts of the desk.
 */
export function isGreeting(normalized: string, snapshot: ClaimSnapshot): boolean {
  if (snapshot.openQuestionOnDesk !== undefined) return false
  if (normalized.length === 0 || normalized.length > GREETING_MAX_CHARS) return false
  return (GREETINGS as readonly string[]).includes(normalized)
}

const isStopWord = (text: string): boolean => (STOP_WORDS as readonly string[]).includes(normalizeForMatch(text))
const isRotateWord = (text: string): boolean => (ROTATE_WORDS as readonly string[]).includes(normalizeForMatch(text))
const isOrdinal = (text: string): boolean => ORDINAL_RE.test(text)

/**
 * The fast-path table. Order is authority order: the first matching row wins,
 * so stop words beat passthrough and a bare ordinal beats a greeting.
 */
export const ROUTE_RULES: readonly RouteRule[] = [
  {
    order: 1,
    name: 'stop-word',
    when: (event, snapshot) => snapshot.liveCommitmentOnThread !== undefined && isStopWord(event.text),
    result: { route: 'fastpath', disposition: 'release' },
    detail: (_event, snapshot) => ({ commitment_id: snapshot.liveCommitmentOnThread }),
  },
  {
    order: 2,
    name: 'rotate-word',
    when: event => isRotateWord(event.text),
    result: { route: 'fastpath', disposition: 'acknowledge' },
    detail: () => ({ rotate: true }),
  },
  {
    order: 3,
    name: 'ordinal-proposal',
    when: (event, snapshot) => isOrdinal(event.text) && snapshot.openProposalsOnDesk.length > 0,
    result: { route: 'fastpath', disposition: 'commit' },
    detail: event => ({ ordinals: parseOrdinals(event.text), target: 'proposal' }),
  },
  {
    order: 4,
    name: 'ordinal-question',
    when: (event, snapshot) => isOrdinal(event.text) && snapshot.openQuestionOnDesk !== undefined,
    result: { route: 'fastpath', disposition: 'amend' },
    detail: (event, snapshot) => ({
      ordinals: parseOrdinals(event.text),
      target: 'question',
      commitment_id: snapshot.openQuestionOnDesk?.commitment_id,
      ordinal: snapshot.openQuestionOnDesk?.ordinal,
    }),
  },
  {
    order: 5,
    name: 'greeting',
    when: (event, snapshot) => isGreeting(normalizeForMatch(event.text), snapshot),
    result: { route: 'fastpath', disposition: 'acknowledge' },
    detail: () => ({ react: true }),
  },
  {
    order: 6,
    name: 'not-authorized',
    when: (_event, _snapshot, cls) => cls === 'external' || cls === 'unknown',
    result: {
      route: 'fastpath',
      disposition: 'decline',
      // R4: either field missing makes the intake row invalid at the DDL level.
      detail: { reason: 'not_authorized', alternative: 'identity_notice' },
    },
  },
  {
    order: 7,
    name: 'live-subscription-passthrough',
    when: (event, snapshot) => snapshot.liveSubscription !== undefined && !hasScopeChangeMarker(event.text),
    result: { route: 'passthrough', disposition: 'passthrough' },
    detail: (_event, snapshot) => ({
      commitment_id: snapshot.liveSubscription?.commitment_id,
      attempt_id: snapshot.liveSubscription?.attempt_id,
    }),
  },
  {
    order: 8,
    name: 'rest',
    when: () => true,
    result: { route: 'judge' },
  },
]