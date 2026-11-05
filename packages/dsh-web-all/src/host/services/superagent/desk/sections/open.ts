/**
 * Section 1: what is in flight and whose ball it is (07 案卷 在办(球权)).
 *
 * This section is never truncated: a dossier that hides an open commitment is
 * worse than a long one, because the judge would answer as if the work did not
 * exist. Over eight rows is a signal, not a cut — the alarm travels beside the
 * text and every row still renders.
 */

import type { DossierSection } from '../dossier.ts'
import { block, clock } from './format.ts'

export const openSection: DossierSection = {
  name: 'open',
  label: '在办(球权)',
  order: 1,
  maxTokens: 1500,
  neverTruncate: true,
  render(view, _now, _batch, ctx) {
    const lines = view.open.map((row) => {
      const look = row.next_look_at === null ? '' : ` | 下次看${clock(row.next_look_at, ctx.tz)}`
      const due = row.due_at === null || row.due_at === undefined ? '' : ` | 到期${clock(row.due_at, ctx.tz)}`
      const state = row.state === 'open' ? '' : ` | ${row.state}`
      return `${row.commitment_id} ${row.what} | 球:${row.ball}${state}${look}${due}`
    })
    return block('在办(球权)', lines)
  },
}
