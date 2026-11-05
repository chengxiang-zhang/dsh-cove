/**
 * Asynchronous dispatch after commit (10 three stages): the commit transaction and
 * the ack happen in the turn; creating the session happens after, off the turn.
 * The dispatcher keeps the in-flight promises so the composition root and tests can
 * wait for them; a failed dispatch is already handled inside the executors
 * (self-heal, queue, broken), so nothing here throws.
 */

import type { Executors } from '../executors/attempts.ts'

/** Structural log: judgment may not import host-ports (DEPS); a HostLog satisfies it. */
export interface DispatchLog { warn(message: string): void; error(message: string): void }

export interface Dispatcher {
  dispatch(commitmentId: string): void
  /** Resolves when every dispatch started so far has finished. */
  settle(): Promise<void>
}

export function createDispatcher(executors: Pick<Executors, 'dispatch'>, log: DispatchLog): Dispatcher {
  const inflight = new Set<Promise<unknown>>()
  return {
    dispatch(commitmentId) {
      const p = executors.dispatch(commitmentId)
        .then(r => { if ('failed' in r) log.warn(`judgment: dispatch of ${commitmentId}: ${r.failed}`) })
        .catch(error => log.error(`judgment: dispatch of ${commitmentId} threw: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { inflight.delete(p) })
      inflight.add(p)
    },
    async settle() {
      while (inflight.size) await Promise.all([...inflight])
    },
  }
}
