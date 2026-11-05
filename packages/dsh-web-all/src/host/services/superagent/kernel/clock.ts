/**
 * Kernel clock (T13): time pushes judgment, but only when the host sees something new.
 *
 * Every 60 seconds: take the due open commitments, ask the injected TickSignal
 * (host computation, no model). No signal -> push next_look_at back through
 * `Ledger.touch` and request nothing (the first guard against idle turns).
 * Signal -> one `deliberation(state='requested')` row and a TurnRequest. The
 * kernel never waits for the desk; a crashed turn is simply looked at again.
 */

import { PHYSICAL } from '../protocol/db.ts'
import { OPEN_STATES } from '../protocol/objects.ts'
import type { Ledger, TurnFinish } from './ledger.ts'
import type { Signal, TickSignal, TurnRequest } from './ports.ts'

/** Structural host clock: the kernel may not import host-ports (DEPS). */
export interface ClockHost {
  now(): number
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface Clock {
  tick(now: number, signal: TickSignal): { requested: TurnRequest[]; deferred: string[] }
  lastTickAt(): number | undefined
  start(host: ClockHost, signal: TickSignal, onRequest: (r: TurnRequest) => void): () => void
  /** Writes a finished turn's readings back (ops, tool_errors, tokens, end_reason). */
  finish(deliberationId: string, readings: TurnFinish): void
}

export const TICK_MS = 60_000
export const MIN_PUSH_MS = 300_000
const OPEN_LIST = OPEN_STATES.map(s => `'${s}'`).join(', ')

function safeSignal(signal: TickSignal, id: string, now: number): Signal | null {
  try {
    return signal.has(id, now)
  } catch {
    // A broken signal must not stall the round; treat it as "nothing new".
    return null
  }
}

export function createClock(ledger: Ledger): Clock {
  let last: number | undefined

  function tick(now: number, signal: TickSignal): { requested: TurnRequest[]; deferred: string[] } {
    const due = ledger.read.all<{ commitment_id: string; eta_at: number | null }>(
      `SELECT commitment_id, eta_at FROM ${PHYSICAL.commitment}
       WHERE state IN (${OPEN_LIST}) AND next_look_at <= ? ORDER BY next_look_at, n`, now)
    const requested: TurnRequest[] = []
    const deferred: string[] = []
    for (const { commitment_id: id, eta_at: eta } of due) {
      // One transaction per commitment: one bad row cannot roll back the round.
      try {
        if (safeSignal(signal, id, now) === null) {
          const remaining = Math.max(0, (eta ?? now) - now)
          ledger.open(tx => tx.touch(id, now + Math.max(MIN_PUSH_MS, remaining / 2)))
          continue
        }
        const requestId = `tick:${id}:${now}`
        const deliberationId = ledger.open(tx => tx.requestTurn({ trigger_kind: 'agenda', commitment_id: id, request_id: requestId }))
        if (deliberationId === undefined) deferred.push(id)
        else requested.push({ deliberation_id: deliberationId, request_id: requestId, commitment_id: id, trigger_kind: 'agenda' })
      } catch {
        deferred.push(id)
      }
    }
    last = now
    return { requested, deferred }
  }

  return {
    tick,
    lastTickAt: () => last,
    start(host, signal, onRequest) {
      const handle = host.setInterval(() => {
        let round: { requested: TurnRequest[] }
        try { round = tick(host.now(), signal) } catch { return }
        // Fire and forget: the kernel does not wait for, or fail with, the desk.
        for (const request of round.requested) {
          try { onRequest(request) } catch { /* the next round looks again */ }
        }
      }, TICK_MS)
      return () => host.clearInterval(handle)
    },
    finish(deliberationId, readings) {
      ledger.open(tx => tx.finishTurn(deliberationId, readings))
    },
  }
}
