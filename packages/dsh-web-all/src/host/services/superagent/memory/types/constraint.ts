/**
 * Constraint: an instruction the owner gave, kept verbatim (05).
 *
 * The quote is the whole sentence and `remember` refuses the write unless that
 * sentence occurs in the batch, so an extractor can neither paraphrase an
 * instruction into existence nor upgrade its own guess to `owner-said`.
 */

import {
  CONSTRAINT_WORDS, isOwnerSpeaking, sentencesOf, topicOf, visibilityOf,
  type MemoryEntry, type MemoryTrigger, type MemoryType,
} from './shared.ts'

export const constraintType: MemoryType = {
  kind: 'constraint',
  extract(trigger: MemoryTrigger): MemoryEntry[] {
    if (!isOwnerSpeaking(trigger)) return []
    const entries: MemoryEntry[] = []
    for (const sentence of sentencesOf(trigger)) {
      if (!CONSTRAINT_WORDS.some((word) => sentence.includes(word))) continue
      entries.push({
        kind: 'constraint',
        topic: topicOf('constraint', sentence),
        body: sentence,
        authority: 'owner-said',
        quote: sentence,
        ...visibilityOf('constraint', trigger),
      })
    }
    return entries
  },
  defaultVisibility(trigger: MemoryTrigger): { use: string[]; say: string[] } {
    return visibilityOf('constraint', trigger)
  },
}