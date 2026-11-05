/**
 * The check registry: one line per check, run read-only, findings only.
 *
 * A check that could repair would be a second recovery inside recovery, with its
 * own idea of what the ledger should say. Keeping the registry read-only means a
 * new check is a few lines and cannot quietly become a new writer.
 *
 * @module dsh-web-all/superagent/recovery/checks
 */

import type { Ledger } from '../../kernel/ledger.ts'
import { orphanedOpenCheck } from './orphaned-open.ts'
import { overdueLookCheck } from './overdue-look.ts'
import type { Finding, RecoveryCheck } from './types.ts'

export type { Finding, RecoveryCheck } from './types.ts'

export interface CheckRegistry {
  register(check: RecoveryCheck): () => void
  /** Every registered check, in registration order; one failing check does not stop the rest. */
  run(now: number): Promise<Finding[]>
}

/** The checks this build ships; one line each, per the module's extension point. */
export function defaultChecks(ledger: Ledger): RecoveryCheck[] {
  return [orphanedOpenCheck(ledger), overdueLookCheck(ledger)]
}

/**
 * Build a registry.
 * @param checks - the checks to start with.
 * @returns the registry.
 */
export function createChecks(checks: readonly RecoveryCheck[] = []): CheckRegistry {
  const registered: RecoveryCheck[] = [...checks]
  return {
    register(check) {
      registered.push(check)
      return () => {
        const at = registered.indexOf(check)
        if (at >= 0) registered.splice(at, 1)
      }
    },
    async run(now) {
      const findings: Finding[] = []
      for (const check of registered) {
        try {
          findings.push(...await check.check(now))
        } catch {
          // A broken check is a broken check, not a broken recovery: its failure is
          // not allowed to hide the findings of the ones after it.
        }
      }
      return findings
    },
  }
}