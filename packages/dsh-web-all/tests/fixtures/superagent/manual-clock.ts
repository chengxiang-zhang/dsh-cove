/**
 * Manual clock: implements HostClock with time that only moves on `advance`.
 * Interval callbacks fire in due order as time passes; a callback due exactly at
 * the new time fires.
 */

import type { HostClock } from '../../../src/host/services/superagent/host-ports.ts'

export interface ManualClock extends HostClock {
  advance(ms: number): void
  /** Number of live intervals. */
  pending(): number
}

interface Timer { id: number; fn: () => void; every: number; nextAt: number }

export function createManualClock(startMs = 0): ManualClock {
  let current = startMs
  let seq = 0
  const timers = new Map<number, Timer>()

  const nextDue = (until: number): Timer | undefined => {
    let best: Timer | undefined
    for (const t of timers.values()) {
      if (t.nextAt > until) continue
      if (best === undefined || t.nextAt < best.nextAt || (t.nextAt === best.nextAt && t.id < best.id)) best = t
    }
    return best
  }

  return {
    now: () => current,
    setInterval(fn, ms) {
      if (!(ms > 0)) throw new Error(`manual clock: interval must be positive, got ${ms}`)
      const id = ++seq
      timers.set(id, { id, fn, every: ms, nextAt: current + ms })
      return id
    },
    clearInterval(h) {
      if (typeof h === 'number') timers.delete(h)
    },
    advance(ms) {
      if (!(ms >= 0)) throw new Error(`manual clock: cannot advance by ${ms}`)
      const until = current + ms
      for (let t = nextDue(until); t !== undefined; t = nextDue(until)) {
        current = t.nextAt
        t.nextAt += t.every
        t.fn()
      }
      current = until
    },
    pending: () => timers.size,
  }
}
