/**
 * How loudly a message arrives: four tiers, decided by the host (09).
 *
 * The model writes content; it never chooses the tier, because the choice is a
 * promise about the recipient's attention and only the host knows what has
 * already interrupted the owner today, whether the message answers a message that
 * just arrived, or whether the clock says 23:00. `09` caps interrupts at three a
 * day, folds the overflow into the brief, and protects the quiet window unless the
 * risk is irreversible - so a message that wants to interrupt can end up as
 * either `brief` (folded, delivered later) or `interrupt`, and that difference is
 * the whole point of this module.
 *
 * Progress, retries, recovery and internal checks never reach this decision:
 * callers do not propose them as moments, and a moment this table does not know
 * resolves to `silent` rather than to the loudest branch.
 *
 * Pure module: the clock is passed in, nothing is read or written.
 */

import type { OutboxMoment, Tier } from '../protocol/objects.ts'

/** The quiet window, in the owner's local time (`09`, F28). */
export interface QuietHours {
  from: string
  to: string
}

/** Default quiet window, carried here so the composition root has one source. */
export const DEFAULT_QUIET: QuietHours = { from: '22:00', to: '08:00' }

/** Everything the tier decision is allowed to see. */
export interface AttentionContext {
  moment: OutboxMoment
  /** The ball is with the owner and a clock is running (a stop-loss, a deadline, a 24h risk). */
  ballToOwnerWithClock: boolean
  /** The risk cannot be undone once it happens. */
  irreversible: boolean
  /** This message answers inbound traffic that just arrived. */
  isReplyToInbound: boolean
  /** Interrupts already spent today. */
  interruptsToday: number
  /** The daily interrupt allowance (`09`: three). */
  quotaPerDay: number
  /** Local wall clock, `HH:MM`. */
  localHHMM: string
  /** Quiet window in force. */
  quiet: QuietHours
}

/** The tier and whether the message was folded into the brief. */
export interface TierDecision {
  tier: Tier
  folded: boolean
}

/** Moments that are one-to-one answers to a message that just arrived. */
const REPLY_MOMENTS: readonly OutboxMoment[] = ['ack', 'answer', 'pushback', 'ask', 'deliver']

const CLOCK = /^(\d{1,2}):(\d{2})$/u

/**
 * Minutes since local midnight, or `NaN` when the clock is unreadable.
 * @param hhmm - `HH:MM`.
 * @returns minutes since midnight.
 */
export function minuteOfDay(hhmm: string): number {
  const parsed = CLOCK.exec(hhmm)
  if (parsed === null) return Number.NaN
  const hours = Number(parsed[1])
  const minutes = Number(parsed[2])
  if (hours > 23 || minutes > 59) return Number.NaN
  return hours * 60 + minutes
}

/**
 * Is the clock inside the quiet window?
 *
 * A window may wrap past midnight (22:00 to 08:00); an unreadable clock is not
 * treated as quiet, because a silent failure there would delay real news.
 * @param hhmm - local wall clock, `HH:MM`.
 * @param quiet - the window in force.
 * @returns true inside the window.
 */
export function inQuietHours(hhmm: string, quiet: QuietHours): boolean {
  const now = minuteOfDay(hhmm)
  const from = minuteOfDay(quiet.from)
  const to = minuteOfDay(quiet.to)
  if (Number.isNaN(now) || Number.isNaN(from) || Number.isNaN(to) || from === to) return false
  return from < to ? now >= from && now < to : now >= from || now < to
}

/**
 * Decide the tier for one message.
 *
 * Order matters and follows `09`: a reply to a message that just arrived stays a
 * reply; an alert, or a question the owner is waiting on with a clock running,
 * wants an interrupt; the quota and the quiet window can fold that interrupt into
 * the brief, but an irreversible risk never folds; the daily brief is the brief;
 * everything else is silent.
 * @param ctx - what the host knows about this message and this day.
 * @returns the tier and whether the message was folded into the brief.
 */
export function tier(ctx: AttentionContext): TierDecision {
  if (REPLY_MOMENTS.includes(ctx.moment) && ctx.isReplyToInbound) {
    return { tier: 'reply', folded: false }
  }
  const wantsInterrupt = ctx.moment === 'alert'
    || ((ctx.moment === 'ask' || ctx.moment === 'cannot') && ctx.ballToOwnerWithClock)
  if (wantsInterrupt) {
    // An irreversible risk is the one thing that beats both the quota and the
    // quiet window: a missed rollback cannot be sent later.
    if (ctx.irreversible) return { tier: 'interrupt', folded: false }
    const overQuota = ctx.interruptsToday >= ctx.quotaPerDay
    if (overQuota || inQuietHours(ctx.localHHMM, ctx.quiet)) return { tier: 'brief', folded: true }
    return { tier: 'interrupt', folded: false }
  }
  if (ctx.moment === 'brief') return { tier: 'brief', folded: false }
  return { tier: 'silent', folded: false }
}