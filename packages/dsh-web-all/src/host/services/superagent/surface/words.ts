/**
 * How many words a message has: one definition for every reader (N19).
 *
 * Chinese has no natural word boundary, so a syllable count and a segmenter count
 * differ by a factor of two on the same sentence, and the `words <= 100` rule in
 * `02` would mean different things in the outlet and in the acceptance check. The
 * freeze therefore names one function: the number of `isWordLike` segments that
 * `Intl.Segmenter('zh', { granularity: 'word' })` returns, with a run of digits
 * counting once. English goes through the same call, so a mixed sentence is not
 * counted twice by two different rules.
 *
 * Pure module: no clock, no store, no channel.
 */

/** The word ceiling in `02`: a longer message is a template bug, not a long one. */
export const MAX_WORDS = 100

const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' })

const DIGITS = /^\d+$/u

/**
 * Count the words in a message.
 *
 * Punctuation and whitespace are not words. A contiguous run of digits counts
 * once, even when the segmenter splits it (a number is one fact, not a list).
 * @param text - the rendered message body.
 * @returns the word count the `words` column and the outlet check both use.
 */
export function countWords(text: string): number {
  let words = 0
  let digitsEnd = -1
  for (const part of SEGMENTER.segment(text)) {
    if (!part.isWordLike) {
      digitsEnd = -1
      continue
    }
    const end = part.index + part.segment.length
    if (DIGITS.test(part.segment)) {
      // Adjacent digit segments are one number; a digit segment after other words
      // starts a new one.
      if (part.index !== digitsEnd) words += 1
      digitsEnd = end
      continue
    }
    digitsEnd = -1
    words += 1
  }
  return words
}

/**
 * Is the message within the shared ceiling?
 * @param text - the rendered message body.
 * @returns true when the message may be sent as far as length is concerned.
 */
export function withinWordBudget(text: string): boolean {
  return countWords(text) <= MAX_WORDS
}