/**
 * The dossier: six sections in a fixed order, one budget, one alarm list (07 案卷, T11).
 *
 * The dossier is the head of this turn's user message: what is in flight, what the
 * owner owes an answer to, what the owner already said, how similar work went, how
 * much attention is left, and the events being decided. It is deliberately not a
 * system prompt — a system prompt has to be static or built from registered
 * variables, and the dossier changes every turn. Keeping it in the user message is
 * also what makes it auditable: the reader can diff two turns.
 *
 * Two rules are mechanical rather than advisory, because a prompt instruction would
 * not survive a model that ignores it:
 *
 * - The open section is never cut. Under budget pressure the sections give way in
 *   the order set by `truncateRank` (precedent, then what the owner said, then what
 *   the owner owes an answer to), and the open rows always render in full.
 * - More than eight open commitments is an alarm, not a truncation: the reader must
 *   see all of them and also see that there are too many.
 */

import type { InboundEvent } from '../protocol/events.ts'
import type { LedgerView, NowProjection } from './now.ts'
import { fullStamp } from './sections/format.ts'
import { DOSSIER_SECTIONS } from './sections/index.ts'

/** One rendered section of the dossier. */
export interface DossierSection {
  /** Stable name, used in `truncated` and in alarms. */
  name: string
  /** Column label as it appears in the text (07 布局). */
  label: string
  /** Fixed position in the dossier, ascending. */
  order: number
  /** Per-section ceiling in estimated tokens, applied before the shared budget. */
  maxTokens: number
  /** Never reduced: neither by the per-section ceiling nor by the budget pass. */
  neverTruncate?: boolean
  /**
   * Order in which sections give way under budget pressure, ascending. A section
   * without a rank does not yield at all.
   */
  truncateRank?: number
  render(view: LedgerView, now: NowProjection, batch: readonly InboundEvent[], ctx: DossierContext): string
}

/** Everything a section needs to know about this turn besides the ledger. */
export interface DossierContext {
  tz: string
  nowMs: number
  generation: number
  deskLabel: string
}

export interface Dossier {
  text: string
  tokens: number
  /** Section names whose content was reduced or dropped, in the order it happened. */
  truncated: string[]
  /** Mechanical facts the caller records beside the dossier. */
  alarms: string[]
}

/** Alarm code: more open commitments than the public core carries. */
export const ALARM_OPEN_OVER_8 = 'open_over_8'
/** Alarm code: the budget is still exceeded after every yielding section was cut. */
export const ALARM_OVER_BUDGET = 'over_budget'
/** Marker appended to a partially rendered section. */
export const TRUNCATION_MARKER = '…（已截断）'

/**
 * Token estimate for budget and readings only (T11 推断): one Chinese character
 * costs about half a token, so `ceil(chars / 2)`. Never used to bill anything.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}

/** Fixed section order: position first, registration order as the tie-break. */
export function orderSections(sections: readonly DossierSection[]): DossierSection[] {
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => (a.section.order - b.section.order) || (a.index - b.index))
    .map((entry) => entry.section)
}

/** Sections that give way under budget pressure, in the order they yield. */
export function truncatableSections(sections: readonly DossierSection[]): DossierSection[] {
  return sections
    .filter((section) => section.truncateRank !== undefined && section.neverTruncate !== true)
    .slice()
    .sort((a, b) => (a.truncateRank as number) - (b.truncateRank as number) || a.order - b.order)
}

function headerLine(ctx: DossierContext): string {
  return `[案卷 ${ctx.deskLabel} 第${ctx.generation}代 ${fullStamp(ctx.nowMs, ctx.tz)} ${ctx.tz}]`
}

/** Keeps the label line and as many whole lines as fit under `maxTokens`. */
function capSection(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  const lines = text.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const candidate = [...kept, line].join('\n')
    if (estimateTokens(candidate + '\n' + TRUNCATION_MARKER) > maxTokens) break
    kept.push(line)
  }
  if (kept.length === 0) kept.push(lines[0] ?? '')
  return [...kept, TRUNCATION_MARKER].join('\n')
}

/**
 * Compile the dossier for one turn.
 *
 * `sections` defaults to the registered set; a caller (or a test) may pass its own
 * ordered list, which is how a new section is added without editing this function.
 */
export function compileDossier(
  view: LedgerView,
  now: NowProjection,
  subBatch: readonly InboundEvent[],
  ctx: DossierContext,
  budgetTokens: number,
  sections: readonly DossierSection[] = DOSSIER_SECTIONS,
): Dossier {
  const ordered = orderSections(sections)
  const alarms: string[] = []
  const truncated: string[] = []
  const header = headerLine(ctx)

  const blocks: { name: string, text: string }[] = []
  for (const section of ordered) {
    let text: string
    try {
      text = section.render(view, now, subBatch, ctx)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      alarms.push(`section_error:${section.name}:${message}`)
      continue
    }
    if (typeof text !== 'string' || text.length === 0) continue
    if (section.neverTruncate !== true && estimateTokens(text) > section.maxTokens) {
      text = capSection(text, section.maxTokens)
      truncated.push(section.name)
    }
    blocks.push({ name: section.name, text })
  }

  const assemble = (): string => [header, ...blocks.map((block) => block.text)].join('\n')
  const yielding = truncatableSections(ordered)
  let dropped = 0
  while (estimateTokens(assemble()) > budgetTokens && dropped < yielding.length) {
    const victim = yielding[dropped]
    dropped += 1
    const index = blocks.findIndex((block) => block.name === victim.name)
    if (index >= 0) blocks.splice(index, 1)
    truncated.push(victim.name)
  }

  if (view.open.length > 8) alarms.push(ALARM_OPEN_OVER_8)
  const text = assemble()
  const tokens = estimateTokens(text)
  if (tokens > budgetTokens) alarms.push(ALARM_OVER_BUDGET)

  return { text, tokens, truncated, alarms }
}

/**
 * One turn decides one sender (07 本批, F33): batches keyed by conversation can
 * mix senders, so the split happens before the dossier is compiled and the arrival
 * order inside each group is preserved.
 */
export function splitBySender(batch: readonly InboundEvent[]): InboundEvent[][] {
  const groups: InboundEvent[][] = []
  const index = new Map<string, number>()
  for (const event of batch) {
    const key = event.sender.open_id
    const existing = index.get(key)
    if (existing === undefined) {
      index.set(key, groups.length)
      groups.push([event])
      continue
    }
    groups[existing].push(event)
  }
  return groups
}