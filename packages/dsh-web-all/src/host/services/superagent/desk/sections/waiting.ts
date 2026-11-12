/**
 * Section 2: what the owner must answer, and what happens if they do not (07 等老板).
 *
 * Every line carries a default. A question without a default turns "no answer"
 * into a stall, which is the failure this section exists to prevent.
 */

import type { DossierSection } from '../dossier.ts'
import { block, stamp } from './format.ts'

/**
 * "Do it" is only the default for the owner's own work: the ball is on the owner and
 * the owner is also the creditor. A colleague's request or a proposal the desk made
 * waits for approval, and silence from the owner is not approval.
 */
function ownersOwn(row: { creditor: string; ball: string }): boolean {
  return row.creditor === row.ball
}

export const waitingSection: DossierSection = {
  name: 'waiting',
  label: '等老板',
  order: 2,
  maxTokens: 600,
  truncateRank: 3,
  render(view, _now, _batch, ctx) {
    const lines = view.waiting.map((row) => {
      const question = typeof row.question === 'string' && row.question.length > 0 ? row.question : row.what
      const askedAt = row.updated_at === null || row.updated_at === undefined ? '' : `问于 ${stamp(row.updated_at, ctx.tz)}；`
      const fallback = typeof row.default === 'string' && row.default.length > 0 ? `默认:${row.default}` : `默认:${ownersOwn(row) ? '做' : '等老板批准'}`
      const prepared = typeof row.prepared === 'string' && row.prepared.length > 0 ? `；${row.prepared}` : ''
      return `${row.commitment_id} ${question}（${askedAt}${fallback}${prepared}）`
    })
    return block('等老板', lines)
  },
}
