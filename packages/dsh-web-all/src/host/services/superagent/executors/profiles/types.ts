/**
 * Executor profile shape (10, T19). A profile is a class of executor, not one session.
 * Empty provider/model/effort means the global default model.
 */

import type { Lifetime } from '../../protocol/objects.ts'

export interface Profile {
  id: string
  provider?: string
  model?: string
  effort?: string
  cost_tier: 1 | 2 | 3
  lifetime: Lifetime
  tools: 'read' | 'full'
  budget_tier: 'small' | 'medium' | 'large'
  preset: 'superagent-executor'
}
