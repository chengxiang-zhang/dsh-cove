/**
 * Disclosure: what must not be said out loud, and what takes its place (05).
 *
 * A memory that may be used for judging but not said in front of this audience
 * reaches the dossier only as a derived hint: a conclusion shape such as
 * "reply short", never the stored sentence and never the source quote.
 *
 * The literal fallback is the last mechanical gate before an outbound message.
 * It compares the draft body against every unsayable memory and reports the ids
 * that must block the send (DISCLOSE_BLOCKED). It cannot catch a semantic
 * paraphrase; that is what "hints instead of text" buys us, and the weekly
 * sampling readout covers the rest.
 *
 * Pure functions: no clock, no database, no network, no module state.
 */

import type { MemoryRow } from '../protocol/objects.ts'

/** Longest common substring, in characters, that counts as a literal leak. */
export const DISCLOSURE_MIN_LCS = 12

/** Hint used when the extractor stored none of its own. */
export const DERIVED_HINT_FALLBACK = '（有一条相关约束，按它判断，不要转述）'

/** The two text fields of a memory that carry secrets, plus its id. */
export type UnsayableMemory = Pick<MemoryRow, 'memory_id' | 'body' | 'source_quote'>

/**
 * A memory row as the hint reader sees it. `body_json`, when the memory table
 * carries one, holds the extractor's structured body; only its `hint` field is
 * read here.
 */
export type HintCarrier = MemoryRow & { body_json?: string | null }

const EMAIL_TOKEN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
/** Canary markers exist because 05 reads leaks back with `LIKE '%CANARY-%'`. */
const CANARY_TOKEN = /CANARY-[A-Za-z0-9]+/g
/** A run of four or more digits covers phone numbers, including grouped spellings. */
const DIGIT_RUN_TOKEN = /\d{4,}/g

function scan(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(new RegExp(pattern.source, 'g'))].map((match) => match[0])
}

/**
 * Distinctive tokens of a memory text: emails, canary markers and digit runs of
 * four or more. Case is folded at comparison time, so tokens are returned as-is.
 */
export function disclosureTokens(source: string): string[] {
  const found = [...scan(source, EMAIL_TOKEN), ...scan(source, CANARY_TOKEN), ...scan(source, DIGIT_RUN_TOKEN)]
  const tokens: string[] = []
  for (const candidate of found) {
    if (!tokens.includes(candidate)) tokens.push(candidate)
  }
  return tokens
}

function sharesBigram(a: string, b: string): boolean {
  const seen = new Set<string>()
  for (let i = 0; i + 1 < a.length; i += 1) seen.add(a.slice(i, i + 2))
  for (let i = 0; i + 1 < b.length; i += 1) {
    if (seen.has(b.slice(i, i + 2))) return true
  }
  return false
}

/**
 * Length of the longest contiguous run shared by both strings.
 *
 * `stopAt` is a threshold, not a target: when it is positive the function may
 * return any value below it without computing the exact length, which lets a
 * caller ask "does this reach twelve" in O(n + m) for a draft that shares
 * nothing with the memory.
 */
export function longestCommonSubstring(a: string, b: string, stopAt = 0): number {
  if (a.length === 0 || b.length === 0) return 0
  if (stopAt > 0 && (a.length < stopAt || b.length < stopAt)) return 0
  if (stopAt >= 2 && !sharesBigram(a, b)) return 0
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  const width = short.length
  let previous = new Array<number>(width).fill(0)
  let current = new Array<number>(width).fill(0)
  let best = 0
  for (let i = 0; i < long.length; i += 1) {
    for (let j = 0; j < width; j += 1) {
      if (long[i] === short[j]) {
        const run = j === 0 ? 1 : previous[j - 1] + 1
        current[j] = run
        if (run > best) {
          best = run
          if (stopAt > 0 && best >= stopAt) return best
        }
      } else {
        current[j] = 0
      }
    }
    const swap = previous
    previous = current
    current = swap
  }
  return best
}

/** True when `quote` occurs verbatim in one of the trigger texts (05 "逐字命中本批消息"). */
export function quoteInTrigger(quote: string, triggerTexts: readonly string[]): boolean {
  if (quote.length === 0) return false
  return triggerTexts.some((text) => text.includes(quote))
}

function leaks(text: string, memory: UnsayableMemory): boolean {
  const folded = text.toLowerCase()
  for (const source of [memory.body, memory.source_quote]) {
    if (typeof source !== 'string' || source.length === 0) continue
    if (longestCommonSubstring(text, source, DISCLOSURE_MIN_LCS) >= DISCLOSURE_MIN_LCS) return true
    for (const token of disclosureTokens(source)) {
      if (folded.includes(token.toLowerCase())) return true
    }
  }
  return false
}

/**
 * Ids of the unsayable memories whose text the draft repeats, in input order.
 *
 * A hit is either a contiguous run of `DISCLOSURE_MIN_LCS` characters or more,
 * or a distinctive token (email, canary marker, digit run of four or more). The
 * digit rule covers phone numbers: a source written with separators yields its
 * four-digit groups as tokens, so both spellings meet. A source written without
 * separators does not cover a grouped draft, which is a known narrow gap: the
 * owner's number is stored as it was typed, and the gates would rather over-hold
 * than guess a normalization.
 */
export function disclosures(text: string, unsayable: readonly UnsayableMemory[]): string[] {
  if (text.length === 0) return []
  const hits: string[] = []
  for (const memory of unsayable) {
    if (hits.includes(memory.memory_id)) continue
    if (leaks(text, memory)) hits.push(memory.memory_id)
  }
  return hits
}

function readStoredHint(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const hint = (parsed as { hint?: unknown }).hint
  if (typeof hint !== 'string') return null
  const trimmed = hint.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * The dossier line that stands in for a memory this audience may use but not hear.
 *
 * It returns the extractor's stored hint, and nothing when that hint is missing,
 * empty or itself a quote of the body or the source quote; the fixed fallback is
 * deliberately shape-only, so a group dossier can say "a constraint applies here"
 * without revealing what the owner said in private.
 */
export function derivedHint(memory: HintCarrier): string {
  const stored = readStoredHint(memory.body_json)
  if (stored === null) return DERIVED_HINT_FALLBACK
  const leaksOwnText = leaks(stored, {
    memory_id: memory.memory_id,
    body: memory.body,
    source_quote: memory.source_quote,
  })
  return leaksOwnText ? DERIVED_HINT_FALLBACK : stored
}