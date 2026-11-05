/**
 * Person: who asks about what, learned by watching rather than by being told (05).
 *
 * The count is the host's, not the extractor's: a pure function cannot remember
 * how many times it has seen a topic, and an extractor that kept state would be a
 * second ledger. `observed` authority and `say = []` mean the fact is usable by
 * the owner for judging and is never spoken to anyone.
 */

import {
  REPEATED_THRESHOLD, topicOf, visibilityOf,
  type MemoryEntry, type MemoryTrigger, type MemoryType,
} from './shared.ts'

export const personType: MemoryType = {
  kind: 'person',
  extract(trigger: MemoryTrigger): MemoryEntry[] {
    const entries: MemoryEntry[] = []
    for (const signal of trigger.signals ?? []) {
      if (signal.kind !== 'repeated_topic' || signal.count < REPEATED_THRESHOLD) continue
      const who = signal.label ?? signal.about
      entries.push({
        kind: 'person',
        topic: topicOf('person', signal.topic),
        about: signal.about,
        body: `${who} 常问 ${signal.topic}`,
        authority: 'observed',
        ...visibilityOf('person', trigger),
      })
    }
    return entries
  },
  defaultVisibility(trigger: MemoryTrigger): { use: string[]; say: string[] } {
    return visibilityOf('person', trigger)
  },
}