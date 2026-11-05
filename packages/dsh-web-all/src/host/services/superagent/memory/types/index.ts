/**
 * The five memory types, registered in one place (05).
 *
 * One extractor per kind: it is a pure function of the trigger, never writes and
 * never reads the ledger, so adding a kind is one file plus one line here. The
 * registry order follows the protocol's `MEMORY_KINDS` so that a briefing reads
 * constraints before preferences before precedents.
 *
 * A throwing extractor loses only its own results: `extractAll` counts the
 * failure and keeps the rest (README extension-point table).
 */

import { constraintType } from './constraint.ts'
import { personType } from './person.ts'
import { preferenceType } from './preference.ts'
import { precedentType } from './precedent.ts'
import { standingType } from './standing.ts'
import type { MemoryEntry, MemoryTrigger, MemoryType } from './shared.ts'

export * from './shared.ts'
export { constraintType } from './constraint.ts'
export { personType } from './person.ts'
export { preferenceType } from './preference.ts'
export { precedentType } from './precedent.ts'
export { standingOf, standingType, type StandingSpec } from './standing.ts'

export const MEMORY_TYPES: readonly MemoryType[] = Object.freeze([
  constraintType, preferenceType, precedentType, personType, standingType,
])

/**
 * Runs every extractor over one trigger.
 *
 * The failure count is the readout the host increments per type; entries from the
 * types that worked are returned unchanged.
 */
export function extractAll(
  trigger: MemoryTrigger,
  types: readonly MemoryType[] = MEMORY_TYPES,
): { entries: MemoryEntry[]; failures: number } {
  const entries: MemoryEntry[] = []
  let failures = 0
  for (const type of types) {
    try {
      entries.push(...type.extract(trigger))
    } catch {
      failures += 1
    }
  }
  return { entries, failures }
}