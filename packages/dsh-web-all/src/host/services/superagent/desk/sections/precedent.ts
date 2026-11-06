/**
 * Section 4: how work like this actually went (07 判例(同类)).
 *
 * Calibration first — the ratio a class really took against what was estimated —
 * because that is what changes an estimate next time. Old closed commitments are
 * the second half: same class, how long, did it hold.
 *
 * The candidate executors open the section because `commit` is decided in the same
 * breath: the host computes the candidates, the secretary picks one and writes why
 * (`08` 派给谁), and the profile ids are otherwise not discoverable from the desk.
 */

import type { DossierSection } from '../dossier.ts'
import { block } from './format.ts'

export const precedentSection: DossierSection = {
  name: 'precedent',
  label: '判例(同类)',
  order: 4,
  maxTokens: 500,
  truncateRank: 1,
  render(view, _now, _batch, ctx) {
    const lines: string[] = []
    const candidates = ctx.executorCandidates ?? []
    if (candidates.length > 0) lines.push(`可派执行体: ${candidates.join(' | ')}`)
    for (const workClass of view.workClasses) {
      const factor = typeof workClass.eta_factor === 'number' ? ` 系数${workClass.eta_factor.toFixed(1)}` : ''
      const executor = workClass.preferred_executor === null ? '' : ` | ${workClass.preferred_executor}`
      const misjudge = typeof workClass.misjudge_rate === 'number' ? ` | 误判${workClass.misjudge_rate}` : ''
      lines.push(`${workClass.class_id}: 近${workClass.samples}次${factor}${executor}${misjudge}`)
    }
    for (const closed of view.recentClosed) {
      lines.push(`${closed.commitment_id} ${closed.what} → ${closed.state}`)
    }
    return block('判例(同类)', lines)
  },
}
