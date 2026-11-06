import type { Profile } from './types.ts'

/** Fresh session, read-only tools, 10-minute wall cap; also the probe executor. */
export const ONESHOT_READ: Profile = {
  id: 'oneshot-read', cost_tier: 1, lifetime: 'oneshot', tools: 'read', budget_tier: 'small', preset: 'superagent-executor',
}
