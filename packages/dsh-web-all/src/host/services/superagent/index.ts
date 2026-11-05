/**
 * Superagent service domain: the composition root for the secretary's modules.
 *
 * The domain is one Cordis mount so the assembly keeps a single row per
 * capability while the inside is organized by module. At this stage it wires the
 * Feishu channel and nothing else, which is exactly the behaviour the former
 * standalone inbox domain had: the channel is where the inbound entry moved, not
 * a new entry.
 *
 * Modules are added here, never mounted beside it: a second mount name would
 * turn one capability into two service domains and break the single-entity
 * inventory the assembly and the parity manifest pin.
 */

import type { Context } from '@deepseek-ai/cordis'
import * as feishu from './channels/feishu/index.ts'

/**
 * Mount the superagent domain.
 * @param ctx - the host context the owning row runs in.
 * @returns the disposer that releases every module the domain mounted.
 */
export function register(ctx: Context): () => Promise<void> {
  return feishu.register(ctx)
}
