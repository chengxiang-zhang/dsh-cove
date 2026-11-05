/**
 * Precedent: how a promise ended, why, and who may hear it (05).
 *
 * The host produces it at closure, so the trigger must carry the commitment and
 * the commitment must already be terminal; an open promise is not a precedent
 * yet. The body is the shape 05 fixed - `C-n：<what> → <conclusion>，因为 <reason>`
 * - so past decisions read the same way in a dossier and in a briefing.
 */

import { TERMINAL_STATES } from '../../protocol/objects.ts'
import type { CommitmentRow } from '../../protocol/objects.ts'
import {
  topicOf, visibilityOf, type MemoryEntry, type MemoryTrigger, type MemoryType,
} from './shared.ts'

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_STATES)

/** The reason a closure gave, falling back to the check line that was satisfied. */
function reasonOf(commitment: CommitmentRow): string {
  const raw = commitment.evidence_json
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { summary?: unknown }
      if (typeof parsed.summary === 'string' && parsed.summary.trim().length > 0) return parsed.summary.trim()
    } catch {
      // Unparseable evidence is a diagnostics problem, not a reason: fall through.
    }
  }
  return commitment.done_when
}

export const precedentType: MemoryType = {
  kind: 'precedent',
  extract(trigger: MemoryTrigger): MemoryEntry[] {
    const commitment = trigger.commitment
    if (commitment === undefined) return []
    if (!TERMINAL.has(commitment.state)) return []
    const body = `C-${commitment.n}：${commitment.what} → ${commitment.state}，因为 ${reasonOf(commitment)}`
    return [{
      kind: 'precedent',
      topic: topicOf('precedent', `C-${commitment.n}`),
      about: commitment.commitment_id,
      body,
      authority: 'config',
      ...visibilityOf('precedent', trigger),
    }]
  },
  defaultVisibility(trigger: MemoryTrigger): { use: string[]; say: string[] } {
    return visibilityOf('precedent', trigger)
  },
}