/**
 * The registered dossier sections, one line each (T11).
 *
 * Order and ceilings are configuration: a new section is one line here plus its
 * own file, and nothing in `dossier.ts` changes. `buildDossierSections` exists for
 * callers that compose an extra section without editing the shipped set.
 */

import type { DossierSection } from '../dossier.ts'
import { attentionSection } from './attention.ts'
import { batchSection } from './batch.ts'
import { openSection } from './open.ts'
import { precedentSection } from './precedent.ts'
import { saidSection } from './said.ts'
import { waitingSection } from './waiting.ts'

/** Shipped order: 在办 → 等老板 → 老板说过 → 判例 → 注意力 → 本批. */
export const DOSSIER_SECTIONS: readonly DossierSection[] = [
  openSection,
  waitingSection,
  saidSection,
  precedentSection,
  attentionSection,
  batchSection,
]

/** The shipped sections plus caller-supplied ones, sorted by `order` at render time. */
export function buildDossierSections(extra: readonly DossierSection[] = []): readonly DossierSection[] {
  return [...DOSSIER_SECTIONS, ...extra]
}

export { attentionSection, batchSection, openSection, precedentSection, saidSection, waitingSection }