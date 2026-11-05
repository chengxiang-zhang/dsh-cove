/**
 * What a recovery check may return.
 *
 * A check is a read-only question about the ledger and the sessions, asked every
 * round or at startup. It reports findings; it never repairs. Repair stays in the
 * modules that own the rows (kernel for the ledger, executors for attempts), which
 * is what keeps "recovery only writes the degrade table and calls repairs" true.
 *
 * @module dsh-web-all/superagent/recovery/checks/types
 */

/** One thing a check noticed. */
export interface Finding {
  /** Stable machine code, e.g. `orphaned_without_close`. */
  code: string
  /** What it is about: a commitment id, a desk id, a session id. */
  subject: string
  /** Numbers an operator can act on. */
  detail: Record<string, unknown>
  /** `warn` for something an operator should read, `alert` for something that must not persist. */
  severity: 'info' | 'warn' | 'alert'
}

/** A registered check. One file per check, one line in the registry. */
export interface RecoveryCheck {
  name: string
  check(now: number): Promise<Finding[]>
}