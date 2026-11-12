/**
 * Notice that the kernel clock stopped ticking, and wind it back up.
 *
 * The lease keeper (`lease-keeper.ts`) proves this process is alive and holds the
 * voice; the kernel clock (`kernel/clock.ts`) is a separate interval that drives
 * every agenda turn. A reload that reseats the keeper but drops the clock handle
 * leaves a process that still heartbeats - healthy in `status` - while no commitment
 * is ever looked at again. The symptom is silent: nothing errors, the agenda simply
 * stops.
 *
 * The check is deliberately narrow, in the spirit of the responder watchdog: it only
 * repairs when this process holds the lease (a process that lost the voice must not
 * fight to restart timers it no longer owns) and when the clock has gone two tick
 * windows without advancing. A single repair reruns the timer wiring; a cooldown
 * keeps a clock that cannot be restarted from looping on the repair every round.
 *
 * @module dsh-web-all/superagent/recovery/clock-watchdog
 */

/** How many tick windows the clock may miss before the watchdog repairs it. */
export const CLOCK_STALL_FACTOR = 2

/** What the watchdog may observe and do. */
export interface ClockWatchdogDeps {
  /** Whether the domain is live (admission open). */
  open(): boolean
  /** Whether this process holds the outlet lease at `now` (the keeper's heartbeat lands). */
  leaseHeld(now: number): boolean
  /** The kernel clock's last tick time, or undefined before it has ticked once. */
  lastTickAt(): number | undefined
  /** Rerun the timer wiring (clock + reconcile + keeper). */
  repair(): void
  log: { warn(message: string): void }
  /** The clock's tick period; the stall threshold is `CLOCK_STALL_FACTOR` of it. */
  tickMs: number
}

/** Observable behaviour of the watchdog. */
export interface ClockWatchdog {
  /**
   * Check once, repairing a stalled clock when needed.
   * @param now - current epoch milliseconds.
   * @returns what this check did.
   */
  check(now: number): 'idle' | 'repaired' | 'skipped'
}

/**
 * Build a clock watchdog.
 * @param deps - what to observe and how to repair.
 * @returns the watchdog.
 */
export function createClockWatchdog(deps: ClockWatchdogDeps): ClockWatchdog {
  const stallMs = CLOCK_STALL_FACTOR * deps.tickMs
  let lastAttempt = Number.NEGATIVE_INFINITY

  return {
    check(now) {
      // Only the live, lease-holding process repairs its own clock.
      if (!deps.open() || !deps.leaseHeld(now)) return 'idle'
      const last = deps.lastTickAt()
      // Never ticked yet means the clock only just started; that is not a stall.
      if (last === undefined || now - last < stallMs) return 'idle'
      if (now - lastAttempt < stallMs) return 'skipped'
      lastAttempt = now
      // Loud on purpose: a stalled clock means a reload dropped the agenda timer.
      deps.log.warn(`superagent/recovery: kernel clock stalled ${now - last}ms (last tick at ${last}); restarting timers`)
      try {
        deps.repair()
      } catch (error) {
        deps.log.warn(`superagent/recovery: clock restart failed: ${error instanceof Error ? error.message : String(error)}`)
        return 'skipped'
      }
      return 'repaired'
    },
  }
}
