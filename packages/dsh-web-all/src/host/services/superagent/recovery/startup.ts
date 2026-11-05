/**
 * Recovery's composition root and the one thing that must not be reordered: startup.
 *
 * The order is 11's and it is fixed, because each step is the precondition of the
 * next: the schema must exist before anything is read, identity (the lease) must
 * exist before anything speaks, the ledger must be reconciled before new triggers
 * may act on it, and only then does the composition root connect the channel's
 * admit hook and start the clock. Reversing the last two would let the first
 * message after a restart meet a ledger nobody has reconciled yet.
 *
 * Two things this module deliberately does not do:
 *
 * - It does not create tables. `openLedgerDb` (T04) owns the schema, and the
 *   channel's store must be open first; by the time this object exists, that step
 *   has run. `startup()` documents it rather than repeating it.
 * - It does not register the role resolver. `resolveRole` is a pure function over
 *   three sources the composition root already holds, so "registering" it means the
 *   root calls it where it routes session events; there is no registry to write.
 *
 * @module dsh-web-all/superagent/recovery/startup
 */

import type { Ledger } from '../kernel/ledger.ts'
import type { Lease } from '../kernel/lease.ts'
import type { Outlet } from '../kernel/outlet.ts'
import type { HostClock, HostLog, SessionControllerFace } from '../host-ports.ts'
import type { Executors } from '../executors/attempts.ts'
import type { Closure } from '../executors/closure.ts'
import type { Escalation } from '../executors/escalate.ts'
import type { Presence } from '../desk/presence.ts'
import { createDegrades, type DegradeRegistry } from './degrade.ts'
import { createLeaseKeeper } from './lease-keeper.ts'
import { createReconciler, type ReconcileResult } from './reconcile.ts'
import { createSecondVoice, type HistoryRow, type SecondVoiceResult } from './second-voice.ts'
import { propose } from './speak.ts'
import { createChecks, defaultChecks } from './checks/index.ts'

export type { DegradeRow, DegradeRegistry } from './degrade.ts'
export type { Finding, RecoveryCheck, CheckRegistry } from './checks/index.ts'
export type { HistoryRow, SecondVoiceReport, SecondVoiceResult } from './second-voice.ts'
export type { ReconcileResult, Reconciler } from './reconcile.ts'
export { RECONCILE_STALE_MS, ORPHAN_IDEM_PREFIX, sweepUnownedSessions } from './reconcile.ts'
export { SECOND_VOICE_DELAY_MS, SECOND_VOICE_WINDOW } from './second-voice.ts'
export { LEASE_HEARTBEAT_MS, LEASE_EXPIRY_MS } from '../kernel/lease.ts'
export { createLeaseKeeper } from './lease-keeper.ts'
export type { LeaseKeeper } from './lease-keeper.ts'
export { resolveRole } from './roles.ts'
export type { Role, RoleSources } from './roles.ts'

/** The four repair ports, narrowed to what recovery actually calls. */
export type RecoveryExecutors = Pick<Executors, 'dispatch' | 'cancel' | 'roleOf'>
export type RecoveryClosure = Pick<Closure, 'close'>
export type RecoveryEscalation = Pick<Escalation, 'escalate'>
export type RecoveryPresence = Pick<Presence, 'startupCheck' | 'rotate' | 'roleOf'>

export interface RecoveryDeps {
  ledger: Ledger
  lease: Lease
  /** This process's identity on the lease row. */
  holder: string
  clock: HostClock
  log: HostLog
  controller: () => SessionControllerFace
  executors: RecoveryExecutors
  closure: RecoveryClosure
  escalation: RecoveryEscalation
  presence: RecoveryPresence
  /** Message history reader; absent until P6 is verified (N17). */
  channelHistory?: (chatId: string, limit: number) => Promise<readonly HistoryRow[]>
  outlet: Outlet
}

/** What one startup produced: whether this process may speak, what was repaired, what is reduced. */
export interface StartupReport {
  leaseHeld: boolean
  reconciled: ReconcileResult
  /** The `degrade_id` of every condition this startup opened or found already open. */
  degraded: string[]
}

export interface Recovery {
  startup(): Promise<StartupReport>
  reconcile(now: number): Promise<ReconcileResult>
  selfCheck(deskId: string): Promise<'ok' | 'fail-closed'>
  secondVoice(eventId: string): Promise<SecondVoiceResult>
  degrade(reason: string, scope: string): string
  recover(reason: string, scope: string): void
  /**
   * Stop the heartbeat interval.
   *
   * The seventh method, and the one addition to 11's six: `startup` starts a 15
   * second interval, and a domain that is unloaded (a settings change, a rebuild)
   * must not leave that interval running - the orphaned keeper would keep
   * renewing a lease its process no longer serves, which is the exact shape of
   * the "HMR transactions cannot be nested" incident this domain exists to avoid.
   */
  dispose(): void
}

/**
 * Build the recovery module.
 * @param deps - the ledger, the lease, the repair ports and the speaking outlet.
 * @returns the six methods 11's contract names, plus nothing else.
 */
export function createRecovery(deps: RecoveryDeps): Recovery {
  const { ledger, lease, holder, clock, log } = deps
  const degrades: DegradeRegistry = createDegrades(ledger)
  const checks = createChecks(defaultChecks(ledger))

  const speak = (speech: Parameters<typeof propose>[1]): boolean => propose({ ledger, outlet: deps.outlet, log }, speech)

  const reconciler = createReconciler({
    ledger,
    controller: deps.controller,
    executors: deps.executors,
    closure: deps.closure,
    escalation: deps.escalation,
    presence: deps.presence,
    log,
    speak,
  })

  const voice = createSecondVoice({
    ledger,
    degrade: degrades.degrade,
    queue: speak,
    log,
    scope: holder,
    ...(deps.channelHistory === undefined ? {} : { history: deps.channelHistory }),
  })

  const keeper = createLeaseKeeper({
    lease,
    holder,
    clock,
    log,
    onLost: () => { degrades.degrade('lease_lost', 'outlet') },
    onRecovered: () => { degrades.recover('lease_lost', 'outlet') },
  })


  return {
    async startup(): Promise<StartupReport> {
      const now = clock.now()
      const degraded: string[] = []
      // Step 1 (schema) and step 3 (role resolver) bracket this call by construction;
      // see the module comment. Steps 2, 4 and the self-check are below, in order.
      const acquired = lease.acquire(holder, now)
      if (!acquired.held) {
        // Judging without speaking is the shadow equivalence: the outlet refuses every
        // send this process attempts, and `status` names the holder.
        degraded.push(degrades.degrade('lease_not_held', 'outlet'))
        log.warn(`superagent/recovery: outlet lease is held by ${acquired.holder} (epoch ${acquired.epoch}); judging only, not speaking`)
      }

      const reconciled = await reconciler.reconcile(now)

      const checked = await deps.presence.startupCheck()
      for (const deskId of checked.disabled) {
        degraded.push(degrades.degrade('toolface_mismatch', `desk:${deskId}`))
        log.warn(`superagent/recovery: desk ${deskId} failed its toolface self-check; it stays disabled`)
      }

      if (!voice.available) {
        // P6 is unverified, so "cannot read" is a documented reduction rather than a
        // failure to report to the owner (N17): one row, no interruption, no retry.
        degraded.push(degrades.degrade('second_voice_unavailable', holder))
        log.info('superagent/recovery: message history is not readable; the second-voice probe is unavailable')
      }

      for (const finding of await checks.run(now)) {
        log.warn(`superagent/recovery: ${finding.code} on ${finding.subject} ${JSON.stringify(finding.detail)}`)
      }

      keeper.start()
      return { leaseHeld: acquired.held, reconciled, degraded }
    },

    async reconcile(now: number): Promise<ReconcileResult> {
      return await reconciler.reconcile(now)
    },

    async selfCheck(deskId: string): Promise<'ok' | 'fail-closed'> {
      // Delegates to the desk module's own check (T20): the toolface rule has one home.
      const checked = await deps.presence.startupCheck()
      return checked.enabled.includes(deskId) ? 'ok' : 'fail-closed'
    },

    async secondVoice(eventId: string): Promise<SecondVoiceResult> {
      return await voice.secondVoice(eventId)
    },

    degrade(reason: string, scope: string): string {
      return degrades.degrade(reason, scope)
    },

    recover(reason: string, scope: string): void {
      degrades.recover(reason, scope)
    },

    dispose(): void {
      keeper.stop()
    },
  }

}