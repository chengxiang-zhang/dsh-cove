/**
 * Section 6: the events this turn actually decides (07 本批).
 *
 * Every line names its sender and its thread. The prompt is text only, so the
 * sender cannot be recovered from the model side (F21): it has to be written
 * here, or the judge cannot tell the owner from a stranger.
 */

import type { DossierSection } from '../dossier.ts'
import { block } from './format.ts'

/** One inbound line: identity, thread, what it replies to, then the text. */
export function batchLine(event: { event_id: string, sender: { open_id: string }, thread: string, text: string }, quote?: string): string {
  return `[#${event.event_id} ${event.sender.open_id} 线程:${event.thread} 引用:${quote ?? '无'}] ${event.text}`
}

export const batchSection: DossierSection = {
  name: 'batch',
  label: '本批',
  order: 6,
  maxTokens: 2000,
  render(_view, _now, batch) {
    const lines = batch.map((event) => batchLine(event, (event as { quote?: string }).quote))
    return block('本批', lines)
  },
}
