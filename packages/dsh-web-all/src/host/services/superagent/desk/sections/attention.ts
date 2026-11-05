/**
 * Section 5: how much of the owner's attention is already spent (07 注意力).
 *
 * The judge reads this to decide whether a sentence is worth interrupting for.
 * The numbers are host counters, never model estimates.
 */

import type { DossierSection } from '../dossier.ts'
import { block, clock } from './format.ts'

export const attentionSection: DossierSection = {
  name: 'attention',
  label: '注意力',
  order: 5,
  maxTokens: 200,
  render(view, _now, _batch, ctx) {
    const attention = view.attention
    const lastSpoke = typeof attention.ownerLastSpokeAt === 'number'
      ? ` | 老板上次说话 ${clock(attention.ownerLastSpokeAt, ctx.tz)}`
      : ''
    return block('注意力', [
      `今日打断 ${attention.interruptsToday}/${attention.quota} | 静默 ${attention.quiet}${lastSpoke}`,
    ])
  },
}
