/**
 * Words that promise something the secretary may not promise (R15).
 *
 * The owner's standing rule is that nobody gives away time, scope or outward
 * effect on the owner's behalf. That rule cannot live in a template: the wording
 * is generated, so the same sentence can promise in one phrasing and report in
 * another. It is therefore a mechanical scan over the rendered text, and a hit is
 * a refusal to send rather than advice.
 *
 * The three groups follow `09`: a time point, an expanded scope, or an outward
 * act. The scan is deliberately literal and therefore conservative - a phrase it
 * flags has to be rewritten even when the intent was innocent, which is what
 * "命中即拒发并要求改写" means.
 *
 * Pure module: no clock, no store, no channel.
 */

/** Time points: a deadline the secretary is not allowed to offer on its own. */
const TIME_POINTS = /明天|今晚|下周[一二三四五六日天]?|\d+\s*点|\d+\s*号|\d+\s*月\s*\d+\s*[日号]/gu

/** Scope expansion: absolute words that widen a commitment. */
const SCOPE_EXPANSION = /全部|所有|任何|保证|一定|彻底/gu

/** Outward effect: acts that reach past the owner's own desk. */
const OUTWARD = /上线|发布|对外|公开|外发/gu

const GROUPS: readonly RegExp[] = [TIME_POINTS, SCOPE_EXPANSION, OUTWARD]

/**
 * Find the promise words in a message.
 * @param text - the rendered message body.
 * @returns the matched words in the order they appear; empty when the message
 *   promises nothing.
 */
export function promiseHits(text: string): string[] {
  const hits: Array<{ index: number; word: string }> = []
  for (const group of GROUPS) {
    for (const match of text.matchAll(group)) {
      hits.push({ index: match.index ?? 0, word: match[0] })
    }
  }
  hits.sort((left, right) => left.index - right.index)
  return hits.map(hit => hit.word)
}