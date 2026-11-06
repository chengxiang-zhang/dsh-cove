import type { Profile } from './types.ts'

/**
 * One step up from durable-full: same tools, higher reasoning effort. provider/model
 * stay empty (global default) until a host-specific pairing is configured.
 */
export const DURABLE_FULL_STRONG: Profile = {
  id: 'durable-full-strong', effort: 'high', cost_tier: 3, lifetime: 'durable', tools: 'full', budget_tier: 'large', preset: 'superagent-executor',
}
