/**
 * Words that claim the work is finished (13 验收, 09 措辞).
 *
 * A completion claim is not a promise: it asserts a result. The secretary may only
 * say it about a commitment the host has actually verified, so the scan runs over the
 * text it is about to send and a hit on an unfulfilled commitment is a refusal, not
 * advice. The scan is deliberately literal, like `promise-scan`: a flagged sentence is
 * rewritten even when the intent was innocent.
 *
 * Pure module: no clock, no store, no channel.
 */

/** Result claims in either language. */
const COMPLETION = /已完成|已经完成|完成了|已验收|验收通过|测试通过|全部通过|已经修好|已修复|已上线|已发布|all tests passed|tests? (?:are )?green|completed|finished|shipped/giu

/** Find the completion claims in a message. */
export function completionHits(text: string): string[] {
  const hits = new Set<string>()
  for (const match of text.matchAll(COMPLETION)) hits.add(match[0])
  return [...hits]
}