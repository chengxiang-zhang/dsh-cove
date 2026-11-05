/**
 * The agenda: four sources, all hanging off commitments, and nothing else (09 议程来源).
 *
 * There is no fifth source. "The secretary remembers something worth saying" is
 * exactly the mechanism that produced nineteen empty turns in one day (F32), so
 * the only things that can open an agenda turn are: a commitment that came due, an
 * executor report, the brief clock, and a watch signal. Every source here reads the
 * ledger and returns a `Signal`; none of them sends anything, and none of them can
 * open a conversation that is not already attached to a commitment.
 *
 * Two mechanical properties the module keeps:
 *
 * - A self-heal signal has no moment at all (`agendaMoment` returns null). Stall and
 *   loop are system faults that the executor handles; turning them into an
 *   interrupt is how "it stopped working" becomes "it keeps pestering me".
 * - Agenda turns yield to live human traffic (09 全双工): when the desk has a human
 *   message in flight the agenda turn defers sixty seconds at a time, five times,
 *   and then runs.
 */

import type { LedgerReader } from '../../protocol/db.ts'
import { PHYSICAL } from '../../protocol/db.ts'
import type { CommitmentRow, OutboxMoment } from '../../protocol/objects.ts'
import type { Signal, TickSignal } from '../../kernel/ports.ts'
import { deliverWarning } from './deliver-warning.ts'
import { goal } from './goal.ts'
import { remind } from './remind.ts'
import { watch } from './watch.ts'

/** One agenda source: a pure question asked of one due commitment. */
export interface AgendaSource {
  name: string
  due(commitment: CommitmentRow, now: number, read: LedgerReader): Signal | null
}

/**
 * The closed enumeration of agenda sources (P4: enumerations are closed).
 *
 * The table is data: four names, nothing else. A fifth "the secretary thought of
 * something" source cannot be added by registering a file, because the name has
 * to appear here first, and an unknown name is an error at the call site rather
 * than a silently ignored source.
 */
export const AGENDA_SOURCE_NAMES = ['deliver-warning', 'watch', 'remind', 'goal'] as const
export type AgendaSourceName = (typeof AGENDA_SOURCE_NAMES)[number]

/** Registration order. Adding a source is one line here plus its own file plus an enum name. */
export const AGENDA_SOURCES: readonly AgendaSource[] = [deliverWarning, watch, remind, goal]

/** Raised when something names an agenda source that is not in the closed set. */
export class AgendaSourceError extends Error {
  readonly code = 'AGENDA_SOURCE_UNKNOWN'
  constructor(readonly source: unknown) {
    super(`AGENDA_SOURCE_UNKNOWN: ${String(source)} is not one of ${AGENDA_SOURCE_NAMES.join(', ')}`)
    this.name = 'AgendaSourceError'
  }
}

/** Parse one source name; anything outside the enumeration throws. */
export function parseAgendaSourceName(raw: unknown): AgendaSourceName {
  if (typeof raw !== 'string' || !(AGENDA_SOURCE_NAMES as readonly string[]).includes(raw)) {
    throw new AgendaSourceError(raw)
  }
  return raw as AgendaSourceName
}

/**
 * Resolve a requested set of sources.
 *
 * Used by configuration and by callers that enable a subset; an unknown name is a
 * configuration error the caller must see, never a quiet omission.
 */
export function selectAgendaSources(names: readonly unknown[]): readonly AgendaSource[] {
  return names.map((name) => {
    const resolved = parseAgendaSourceName(name)
    const source = AGENDA_SOURCES.find((candidate) => candidate.name === resolved)
    if (source === undefined) throw new AgendaSourceError(name)
    return source
  })
}

// Fail closed at module load: a source registered without an enumeration entry,
// or an enumeration entry with no source, is a wiring bug, not a runtime decision.
{
  const registered = AGENDA_SOURCES.map((source) => source.name)
  const declared = [...AGENDA_SOURCE_NAMES]
  const same = registered.length === declared.length && registered.every((name, index) => name === declared[index])
  if (!same) {
    throw new Error(`AGENDA_SOURCES must match AGENDA_SOURCE_NAMES exactly; got ${registered.join(', ')} vs ${declared.join(', ')}`)
  }
}

/** First signal any source produces for one commitment, or null. */
export function agendaSignal(
  read: LedgerReader,
  commitmentId: string,
  now: number,
  sources: readonly AgendaSource[] = AGENDA_SOURCES,
): Signal | null {
  const row = read.get<CommitmentRow>(
    `SELECT * FROM ${PHYSICAL.commitment} WHERE commitment_id = ?`,
    commitmentId,
  )
  if (row === undefined) return null
  for (const source of sources) {
    const signal = source.due(row, now, read)
    if (signal !== null) return signal
  }
  return null
}

/** The kernel's `TickSignal`: "does this due commitment have news?" */
export function createTickSignal(
  read: LedgerReader,
  sources: readonly AgendaSource[] = AGENDA_SOURCES,
): TickSignal {
  return { has: (commitmentId: string, now: number) => agendaSignal(read, commitmentId, now, sources) }
}

/**
 * The speech moment a signal may become, or null when it must not speak at all.
 *
 * Unknown kinds fall closed to null: a source added later has to claim its moment
 * explicitly instead of inheriting an interrupt.
 */
export function agendaMoment(signal: Signal): OutboxMoment | null {
  switch (signal.kind) {
    case 'late':
      return 'brief'
    case 'watch':
      return 'brief'
    case 'remind':
      return 'alert'
    case 'goal':
      return 'brief'
    // System faults are healed by the executor module and never become speech.
    case 'self_heal':
    case 'probe_failed':
      return null
    default:
      return null
  }
}

/** How long one agenda deferral lasts while the desk has live human traffic. */
export const AGENDA_DEFER_MS = 60_000
/** Deferrals before the agenda turn runs anyway (09: 最多 5 次). */
export const AGENDA_DEFER_MAX = 5

export interface AgendaDeferral { defer: boolean, nextDeferrals: number }

/**
 * Whether this agenda turn steps aside for a human message.
 *
 * The counter is carried by the caller so the decision stays pure: five deferrals,
 * then the agenda turn runs even if someone is still typing.
 */
export function agendaDeferral(input: { hasLiveHumanMessage: boolean, deferrals: number }): AgendaDeferral {
  if (!input.hasLiveHumanMessage || input.deferrals >= AGENDA_DEFER_MAX) {
    return { defer: false, nextDeferrals: input.deferrals }
  }
  return { defer: true, nextDeferrals: input.deferrals + 1 }
}

/** The `next_look_at` a deferred agenda turn writes before trying again. */
export function deferredLookAt(now: number): number {
  return now + AGENDA_DEFER_MS
}

export { deliverWarning } from './deliver-warning.ts'
export { goal } from './goal.ts'
export { remind } from './remind.ts'
export { watch } from './watch.ts'