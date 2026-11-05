/**
 * Section 3: what the owner already said, so it never has to be said twice (07 老板说过).
 *
 * At most eight rows, newest first, each carrying the words and the date they
 * were said. The quote is the point: a constraint remembered without its sentence
 * cannot be quoted back when it is challenged.
 */

import type { DossierSection } from '../dossier.ts'
import { block, stamp } from './format.ts'

/** Hard cap from 07: at most eight remembered statements enter a dossier. */
export const SAID_MAX = 8

export const saidSection: DossierSection = {
  name: 'said',
  label: '老板说过',
  order: 3,
  maxTokens: 700,
  truncateRank: 2,
  render(view, _now, _batch, ctx) {
    const rows = view.memories
      .filter((row) => row.state === 'active' && (row.authority === 'owner-said' || row.authority === 'config'))
      .slice()
      .sort((a, b) => {
        const left = a.updated_at ?? a.created_at
        const right = b.updated_at ?? b.created_at
        if (left !== right) return right - left
        return a.memory_id < b.memory_id ? -1 : a.memory_id > b.memory_id ? 1 : 0
      })
      .slice(0, SAID_MAX)
    const lines = rows.map((row) => {
      const source = row.authority === 'config' ? '配置' : '原话'
      const quote = row.source_quote === null || row.source_quote === undefined || row.source_quote.length === 0
        ? row.body
        : row.source_quote
      return `${row.memory_id} 「${quote}」(${stamp(row.created_at, ctx.tz)} ${source})`
    })
    return block('老板说过', lines)
  },
}
