/**
 * Profile registry. Adding an executor = one file in this directory + one line in PROFILES.
 * `higher` walks to the next cost tier with the same lifetime and tool surface.
 */

import { DURABLE_FULL_STRONG } from './durable-full-strong.ts'
import { DURABLE_FULL } from './durable-full.ts'
import { ONESHOT_READ } from './oneshot-read.ts'
import type { Profile } from './types.ts'

export type { Profile } from './types.ts'

export const PROFILES: readonly Profile[] = Object.freeze([
  ONESHOT_READ,
  DURABLE_FULL,
  DURABLE_FULL_STRONG,
])

export interface ProfileRegistry {
  get(id: string): Profile | undefined
  all(): Profile[]
  higher(id: string): Profile | undefined
}

export function createProfileRegistry(profiles: readonly Profile[] = PROFILES): ProfileRegistry {
  const byId = new Map(profiles.map(p => [p.id, p]))
  if (byId.size !== profiles.length) throw new Error('executor profiles: duplicate id')
  return {
    get: id => byId.get(id),
    all: () => [...profiles],
    higher(id) {
      const base = byId.get(id)
      if (!base) return undefined
      return profiles
        .filter(p => p.lifetime === base.lifetime && p.tools === base.tools && p.cost_tier > base.cost_tier)
        .sort((a, b) => a.cost_tier - b.cost_tier)[0]
    },
  }
}
