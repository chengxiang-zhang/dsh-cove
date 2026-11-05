/**
 * The fast-path half of the first judgment (08): a pure `ClaimPolicy` that
 * decides where an inbound event belongs without calling a model.
 *
 * It reads three things only: the normalized event, the ledger facts the kernel
 * passes in (`ClaimSnapshot`), and the sender class from the world model. It
 * writes nothing: intakes, journals, despatch and speech all belong to the
 * caller, so this module stays a pure function and can be replayed.
 *
 * The rules themselves live in `route-rules.ts` as data. This file only walks
 * them.
 */

import type { ClaimDecision, ClaimPolicy, ClaimSnapshot } from '../kernel/ports.ts'
import type { InboundEvent } from '../protocol/events.ts'
import { ROUTE_RULES, type RouteRule, type SenderClass } from './route-rules.ts'

export interface RouteDeps {
  /** Identity class of the sender, resolved through the world model (G6). */
  senderClass: (event: InboundEvent) => SenderClass
}

/**
 * Build the fast-path policy.
 * @param deps - the host lookups the rules may need; only the sender class today.
 * @param rules - the rule table; defaults to `ROUTE_RULES`. Passing a shorter
 *   table is how a test proves the table is data and not a code branch.
 * @returns the policy the kernel calls once per inbound event.
 */
export function createRoutePolicy(deps: RouteDeps, rules: readonly RouteRule[] = ROUTE_RULES): ClaimPolicy {
  // Sorted once: `order` is authority order and a caller may hand us an
  // unordered table. Ties keep table order (Array.prototype.sort is stable).
  const ordered = [...rules].sort((left, right) => left.order - right.order)

  return {
    decide(event: InboundEvent, snapshot: ClaimSnapshot): ClaimDecision {
      const cls = deps.senderClass(event)
      for (const rule of ordered) {
        if (!rule.when(event, snapshot, cls)) continue
        const detail = rule.detail === undefined ? rule.result.detail : rule.detail(event, snapshot, cls)
        // Omitted rather than set to undefined so the decision round-trips
        // through JSON without carrying empty keys into the intake row.
        const decision: ClaimDecision = { owner: 'superagent', route: rule.result.route }
        if (rule.result.disposition !== undefined) decision.disposition = rule.result.disposition
        if (detail !== undefined) decision.detail = detail
        return decision
      }
      // A table without a catch-all row still has to answer: judge is the only
      // safe answer, because it means a model decides with the full dossier.
      return { owner: 'superagent', route: 'judge' }
    },
  }
}