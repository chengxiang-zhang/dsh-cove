import type { Profile } from './types.ts'

/** Own working directory, full tools, accepts appended input; global default model. */
export const DURABLE_FULL: Profile = {
  id: 'durable-full', cost_tier: 2, lifetime: 'durable', tools: 'full', budget_tier: 'medium', preset: 'standard',
}
