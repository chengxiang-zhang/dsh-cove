/**
 * Preference: what the owner wants done the same way next time (05).
 *
 * Two sources. The owner's own words give an `owner-said` entry with the sentence
 * as its quote. A host signal of three same-direction corrections gives an
 * `inferred` draft: the extractors never write, so the draft reaches the brief as
 * a question and only a confirming caller can make it live.
 */

import {
  PREFERENCE_WORDS, REPEATED_THRESHOLD, isOwnerSpeaking, sentencesOf, topicOf, visibilityOf,
  type MemoryEntry, type MemoryTrigger, type MemoryType,
} from './shared.ts'

export const preferenceType: MemoryType = {
  kind: 'preference',
  extract(trigger: MemoryTrigger): MemoryEntry[] {
    const entries: MemoryEntry[] = []
    if (isOwnerSpeaking(trigger)) {
      for (const sentence of sentencesOf(trigger)) {
        if (!PREFERENCE_WORDS.some((word) => sentence.includes(word))) continue
        entries.push({
          kind: 'preference',
          topic: topicOf('preference', sentence),
          body: sentence,
          authority: 'owner-said',
          quote: sentence,
          ...visibilityOf('preference', trigger),
        })
      }
    }
    for (const signal of trigger.signals ?? []) {
      if (signal.kind !== 'repeated_correction' || signal.count < REPEATED_THRESHOLD) continue
      entries.push({
        kind: 'preference',
        topic: topicOf('preference', signal.topic),
        about: signal.about,
        body: signal.sample ?? signal.topic,
        authority: 'inferred',
        ...visibilityOf('preference', trigger),
        hint: '按最近一次纠正的说法来，不要转述原话',
      })
    }
    return entries
  },
  defaultVisibility(trigger: MemoryTrigger): { use: string[]; say: string[] } {
    return visibilityOf('preference', trigger)
  },
}