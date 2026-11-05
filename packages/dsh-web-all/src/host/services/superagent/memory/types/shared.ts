/**
 * Memory trigger, entry, and the pure helpers every extractor shares (05).
 *
 * The trigger is host-injected context, never a ledger row. `owner` comes from
 * configuration because extraction needs the owner principal even when he is
 * absent from the desk ("A 常问 X" is learned precisely when a colleague talks),
 * and `signals` are counts the host has already made from the journal, because an
 * extractor may not query the world model or read other modules' rows.
 *
 * Adding a field here changes that context, not the protocol: no table, no
 * enumeration, no tool.
 */

import type { InboundEvent } from '../../protocol/events.ts'
import type { Authority, CommitmentRow, MemoryKind } from '../../protocol/objects.ts'
import { resolveDefaultVisibility, type Audience } from '../visibility.ts'

/** A host-observed count an extractor turns into an inferred or observed entry. */
export interface MemorySignal {
  kind: 'repeated_correction' | 'repeated_topic'
  /** The party the signal is about (`party_id`). */
  about: string
  /** Topic text the signal counted. */
  topic: string
  count: number
  /** Display name for the body, when the host has one. */
  label?: string
  /** One representative sentence, used as the body when available. */
  sample?: string
}

export interface MemoryTrigger {
  kind: 'inbound' | 'executor_report' | 'tick'
  event?: InboundEvent
  /** The batch's texts, in arrival order. A quote must occur verbatim in one of them. */
  batchTexts: string[]
  sender: string
  /** The configured owner principal. */
  owner: string
  audience: Audience
  commitment?: CommitmentRow
  signals?: readonly MemorySignal[]
}

export interface MemoryEntry {
  kind: MemoryKind
  topic: string
  about?: string
  body: string
  authority: Authority
  /** Required for `owner-said` and `party-said`: the sentence as it was typed. */
  quote?: string
  supersedes?: string
  use: string[]
  say: string[]
  /**
   * In-process only. The protocol has no column for a stored hint (P4 closes the
   * table), so `remember` drops it and the dossier computes one with `derivedHint`.
   */
  hint?: string
}

export interface MemoryType {
  kind: MemoryKind
  /** Pure: reads the trigger, never the database, never writes. */
  extract(trigger: MemoryTrigger): MemoryEntry[]
  defaultVisibility(trigger: MemoryTrigger): { use: string[]; say: string[] }
}

/** Words that make a sentence an instruction the owner is giving right now. */
export const CONSTRAINT_WORDS: readonly string[] = ['别', '不要', '不准', '不许', '必须', '禁止', '一律', '只能']

/** Words that make a sentence a standing preference rather than a one-off remark. */
export const PREFERENCE_WORDS: readonly string[] = ['以后', '每次', '回复要', '别再', '下次', '尽量']

/** Words that make a sentence periodic; without one, a clock time is just a time. */
export const PERIODIC_WORDS: readonly string[] = ['每天', '每日', '每早', '每晚', '每周', '每月', '盯着', '长期']

/** Three same-direction occurrences is the threshold 05 gives for a host signal. */
export const REPEATED_THRESHOLD = 3

/** True when the batch is the owner's own words, the only source of `owner-said`. */
export function isOwnerSpeaking(trigger: MemoryTrigger): boolean {
  return trigger.sender === trigger.owner
}

const SENTENCE_BREAK = /(?<=[。！？；!?;\n])/u

/**
 * The batch split into sentences.
 *
 * A quote is a whole sentence, so the split keeps the terminator and trims only
 * the edges: the result stays a verbatim substring of the text it came from.
 */
export function sentencesOf(trigger: MemoryTrigger): string[] {
  const sentences: string[] = []
  for (const text of trigger.batchTexts) {
    for (const piece of text.split(SENTENCE_BREAK)) {
      const sentence = piece.trim()
      if (sentence.length > 0) sentences.push(sentence)
    }
  }
  return sentences
}

const TOPIC_NOISE = /[\s，。！？；：、,.!?;:"""''()（）【】[\]]/g

/**
 * Topic key: the kind plus a normalized prefix of the sentence, at most 24
 * characters.
 *
 * It exists so that restating the same rule lands on the same key and trips the
 * conflict check instead of silently adding a second active row. Merging two
 * differently-worded rules into one topic is a judgement call and stays with the
 * secretary, who passes `supersedes` explicitly.
 */
export function topicOf(kind: MemoryKind, sentence: string): string {
  const normalized = sentence.toLowerCase().replace(TOPIC_NOISE, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  return `${kind}:${normalized.length > 0 ? normalized.slice(0, 24) : 'untitled'}`
}

/**
 * A kind's default visibility, resolved against this trigger.
 *
 * `where` follows the audience class; the commitment audience of a precedent is
 * the audience present when the promise closed, which is the trigger's audience
 * because closure happens in that desk.
 */
export function visibilityOf(kind: MemoryKind, trigger: MemoryTrigger): { use: string[]; say: string[] } {
  return resolveDefaultVisibility(kind, {
    owner: trigger.owner,
    where: trigger.audience.cls === 'owner_p2p' ? 'p2p' : 'group',
    groupMembers: trigger.audience.principals,
    commitmentAudience: trigger.audience.principals,
  })
}