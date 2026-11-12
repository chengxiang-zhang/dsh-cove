/**
 * Kernel clock (T13): time pushes judgment, but only when the host sees something new.
 *
 * Every 60 seconds: take the due open commitments, ask the injected TickSignal
 * (host computation, no model). No signal -> push next_look_at back through
 * `Ledger.touch` and request nothing (the first guard against idle turns).
 * Signal -> one `deliberation(state='requested')` row and a TurnRequest. The
 * kernel never waits for the desk; a crashed turn is simply looked at again.
 */

import { PHYSICAL, type OwnerModule } from '../protocol/db.ts'
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
/** Journal note key the clock writes when it requests a `late` warning turn: the "already warned" mark. */
export const LATE_WARNED_KEY = 'late_warned'
/** Turn endings that count as progress by themselves; any other ending leaves a still-due commitment looked at again. */
const PROGRESSED_END_REASONS: ReadonlySet<string> = new Set(['completed', 'forked'])
const OPEN_LIST = OPEN_STATES.map(s => `'${s}'`).join(', ')

function safeSignal(signal: TickSignal, id: string, now: number): Signal | null {
  try {
    return signal.has(id, now)
  } catch {
    // A broken signal must not stall the round; treat it as "nothing new".
    return null
  }
}

/** The next look for a commitment nothing new happened to: at least MIN_PUSH_MS, or half the time left to its ETA. */
function pushedLook(now: number, eta: number | null): number {
  const remaining = Math.max(0, (eta ?? now) - now)
  return now + Math.max(MIN_PUSH_MS, remaining / 2)
}

/**
 * Finishes a turn and, when it ended without progress, pushes its commitment's look.
 *
 * A turn that errors, is blocked or times out leaves the commitment exactly as due as
 * before; without a push the next 60-second round requests the same turn again and
 * the failure repeats once a minute (the agenda storm). A turn that moved the
 * commitment (a transition or a patched look) already left it not due, and a
 * completed turn is not touched, so only the still-due failure case is pushed.
 * Every owner that closes an agenda turn goes through here, whichever module it is.
 */
export function finishTurnAndPush(ledger: Ledger, module: OwnerModule, deliberationId: string, readings: TurnFinish): void {
  ledger.open((tx) => {
    tx.finishTurn(deliberationId, readings)
    if (PROGRESSED_END_REASONS.has(readings.end_reason)) return
    const id = tx.get<{ commitment_id: string | null }>(
      `SELECT commitment_id FROM ${PHYSICAL.deliberation} WHERE deliberation_id = ?`, deliberationId)?.commitment_id
    if (id === null || id === undefined) return
    const row = tx.get<{ eta_at: number | null; next_look_at: number | null }>(
      `SELECT eta_at, next_look_at FROM ${PHYSICAL.commitment} WHERE commitment_id = ? AND state IN (${OPEN_LIST})`, id)
    if (row === undefined || row.next_look_at === null || row.next_look_at > tx.now) return
    tx.touch(id, pushedLook(tx.now, row.eta_at))
  }, { module })
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
        const fired = safeSignal(signal, id, now)
        if (fired === null) {
          ledger.open(tx => tx.touch(id, pushedLook(now, eta)), { module: 'kernel' })
          continue
        }
        const requestId = `tick:${id}:${now}`
        const deliberationId = ledger.open((tx) => {
          const requested = tx.requestTurn({ trigger_kind: 'agenda', commitment_id: id, request_id: requestId })
          // The warning is requested once: the mark is written with the request, not with the turn's outcome.
          if (requested !== undefined && fired.kind === 'late') {
            tx.append(id, { actor: 'host', kind: 'note', body: { [LATE_WARNED_KEY]: true, detail: fired.detail } })
          }
          return requested
        }, { module: 'kernel' })
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
      finishTurnAndPush(ledger, 'kernel', deliberationId, readings)
    },
  }
}
