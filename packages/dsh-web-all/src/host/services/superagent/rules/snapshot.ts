/**
 * Rule snapshot (T17): the last rule set that passed validation.
 *
 * The registry republishes a snapshot only after the whole table validates
 * (`06` failure mode "规则表读失败 → 用内存中最后一份快照"). Callers that read a
 * snapshot while the table is broken must keep judging with the previous one
 * instead of an empty rule set: an empty set silently turns every gate into its
 * default, which is exactly the failure that must not be silent.
 *
 * Rows are copied and frozen on adoption so a later mutation of the source rows
 * cannot change a snapshot somebody is already judging with.
 */

import type { RuleRow } from '../protocol/objects.ts'

export interface RuleSnapshot {
  current(): readonly RuleRow[]
  adopt(rows: readonly RuleRow[]): void
  clear(): void
}

export function createRuleSnapshot(): RuleSnapshot {
  let rows: readonly RuleRow[] = Object.freeze([])
  return {
    current: () => rows,
    adopt(next) {
      rows = Object.freeze(next.map((row) => Object.freeze({ ...row })))
    },
    clear() {
      rows = Object.freeze([])
    },
  }
}