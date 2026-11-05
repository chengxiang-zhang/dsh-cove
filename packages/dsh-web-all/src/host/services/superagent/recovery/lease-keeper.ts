/**
 * The lease keeper: one heartbeat every 15 seconds, and what happens when it stops landing.
 *
 * Same-database safety is a single row and an epoch (I4). The heartbeat is what
 * keeps that row ours; the moment it fails, every send this process makes is
 * refused by the outlet's `NO_LEASE` check, which is the "judge but do not speak"
 * degradation. So the keeper's only job is to notice and to write it down: a
 * process that lost the lease but never logged it looks healthy in `status` while
 * being voiceless.
 *
 * It also tries to take the lease back. The previous holder may have died, and the
 * expiry window is exactly the interval in which re-acquiring is correct; waiting
 * for an operator to restart this process would leave the host mute for as long as
 * nobody notices.
 *
 * @module dsh-web-all/superagent/recovery/lease-keeper
 */

import type { HostClock, HostLog } from '../host-ports.ts'
import { LEASE_HEARTBEAT_MS, type Lease } from '../kernel/lease.ts'

export interface LeaseKeeperDeps {
  lease: Lease
  holder: string
  clock: HostClock
  log: HostLog
  /** Called once when the lease is lost (not once per failed heartbeat). */
  onLost(): void
  /** Called once when it is held again after a loss. */
  onRecovered?(): void
}

export interface LeaseKeeper {
  /** Beat once; the seam tests drive directly. */
  beat(): boolean
  start(): void
  stop(): void
}

/**
 * Build the keeper. It holds no state that matters: `lost` exists only so the
 * degradation is announced on the transition rather than on every failed beat.
 * @param deps - lease, identity, clock, log and the two transition callbacks.
 * @returns the keeper.
 */
export function createLeaseKeeper(deps: LeaseKeeperDeps): LeaseKeeper {
  let handle: unknown
  let lost = false

  const beat = (): boolean => {
    const now = deps.clock.now()
    let held = deps.lease.heartbeat(deps.holder, now)
    if (!held) {
      // The holder may be gone. Taking the lease back is what "the other process
      // died before its lease expired" is supposed to look like.
      held = deps.lease.acquire(deps.holder, now).held
    }
    if (held) {
      if (lost) {
        lost = false
        deps.onRecovered?.()
      }
      return true
    }
    if (!lost) {
      lost = true
      deps.log.warn(`superagent/recovery: outlet lease lost by ${deps.holder}`)
      deps.onLost()
    }
    return false
  }

  return {
    beat,
    start() {
      if (handle !== undefined) return
      handle = deps.clock.setInterval(() => { beat() }, LEASE_HEARTBEAT_MS)
    },
    stop() {
      if (handle === undefined) return
      deps.clock.clearInterval(handle)
      handle = undefined
    },
  }
}