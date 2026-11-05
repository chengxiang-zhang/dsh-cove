/**
 * Standing: a periodic or watching instruction the owner repeats (05).
 *
 * A standing memory is the secretary's own note of the sentence; the promise
 * itself is not memory's business. `standingOf` returns the metadata the
 * composition root turns into a `remind` or `watch` proposal through the ledger,
 * and it is exported separately so that proposal can be made without writing a
 * memory first.
 */

import {
  PERIODIC_WORDS, isOwnerSpeaking, sentencesOf, topicOf, visibilityOf,
  type MemoryEntry, type MemoryTrigger, type MemoryType,
} from './shared.ts'

/** What a periodic sentence asks the host to propose. */
export interface StandingSpec {
  kind: 'remind' | 'watch' | 'goal'
  /** `HH:MM`, when the sentence names a time of day. */
  at?: string
  /** What to watch, when the sentence names an object. */
  target?: string
}

const CLOCK = /(\d{1,2})\s*[:：]\s*(\d{2})/
const WATCH = /盯(?:着|住|一下)?\s*([A-Za-z0-9._-][A-Za-z0-9._-]{1,})/

/**
 * The proposal a periodic sentence implies, or null when it is not periodic.
 *
 * A clock time wins over a watch target: a sentence that names both asks for a
 * reminder at that time, and the desk may still propose the watch from the same
 * sentence. `goal` is never inferred here - a goal needs a host decision.
 */
export function standingOf(sentence: string): StandingSpec | null {
  const clock = CLOCK.exec(sentence)
  if (clock !== null) {
    const hour = clock[1].padStart(2, '0')
    return { kind: 'remind', at: `${hour}:${clock[2]}` }
  }
  const watch = WATCH.exec(sentence)
  if (watch !== null) return { kind: 'watch', target: watch[1] }
  return null
}

export const standingType: MemoryType = {
  kind: 'standing',
  extract(trigger: MemoryTrigger): MemoryEntry[] {
    if (!isOwnerSpeaking(trigger)) return []
    const entries: MemoryEntry[] = []
    for (const sentence of sentencesOf(trigger)) {
      if (!PERIODIC_WORDS.some((word) => sentence.includes(word))) continue
      if (standingOf(sentence) === null) continue
      entries.push({
        kind: 'standing',
        topic: topicOf('standing', sentence),
        body: sentence,
        authority: 'owner-said',
        quote: sentence,
        ...visibilityOf('standing', trigger),
      })
    }
    return entries
  },
  defaultVisibility(trigger: MemoryTrigger): { use: string[]; say: string[] } {
    return visibilityOf('standing', trigger)
  },
}