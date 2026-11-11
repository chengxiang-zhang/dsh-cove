/**
 * The outlet's pre-send checks, in one place (09, 02, R15, R16).
 *
 * Nothing in this tree sends: every message is a proposal handed to the kernel,
 * which asks this policy whether the proposal may go out and at which tier. The
 * policy is where the mechanical rules live, because they must not depend on the
 * model remembering them:
 *
 *   1. the moment has to be true for this turn (moment.ts);
 *   2. the message has to fit the shared word ceiling (words.ts, N19);
 *   3. a promise word is refused unless this conversation is authorized to promise
 *      (promise-scan.ts, R15);
 *   4. a memory that must not be said out loud is refused (R7, disclosures are
 *      injected by the composition root - the memory module is not reachable from
 *      here);
 *   5. the first message to a conversation that is not the owner's opens with who
 *      is speaking (R16), and the identity sentence counts toward the ceiling: an
 *      over-long message is refused, never truncated, because a truncated promise
 *      or reading is worse than a late one;
 *   6. the tier is computed last, from the host's view of the day (attention.ts).
 *
 * Pure module: the clock and every fact arrive as arguments, and no store or
 * channel is imported.
 */

import type { OutletPolicy, OutletVerdict, SpeechProposal } from '../kernel/ports.ts'
import type { AttentionContext } from './attention.ts'
import { tier } from './attention.ts'
import type { MomentFacts } from '../surface/moment.ts'
import { momentAllowed } from '../surface/moment.ts'
import { promiseHits } from '../surface/promise-scan.ts'
import { renderWorkReport } from '../surface/templates.ts'
import { MAX_WORDS, countWords } from '../surface/words.ts'

/** The facts and lookups the policy needs, injected by the composition root. */
export interface OutletPolicyDeps {
  /** Resolve work by conversation as well as explicit id, so omitting an id cannot bypass the report boundary. */
  workReport?(proposal: SpeechProposal): { state: string; commitmentId?: string; facts?: import('../surface/templates.ts').WorkReportFacts; delivery?: import('../protocol/delivery.ts').DeliveryEvaluation } | undefined
  /** Everything the tier decision may see for this proposal. */
  attentionCtx(proposal: SpeechProposal, now: number): AttentionContext
  /** What the turn actually did, for the moment check. */
  momentFacts(proposal: SpeechProposal): MomentFacts
  /** Memory that must not be said in this conversation, if the text leaks it. */
  disclosures(text: string, chatId: string): string[]
  /** Whether this conversation is authorized to hear a promise (R15). */
  mayPromise(chatId: string): boolean
  /** Whether this conversation still owes the identity sentence (R16). */
  identityNeeded(chatId: string): boolean
  /** The owner's form of address, as this conversation knows it. */
  ownerLabel(chatId: string): string
}

/**
 * The opening sentence for a conversation that is not the owner's (R16).
 * @param ownerLabel - the owner's form of address.
 * @returns the sentence to prepend.
 */
export function identityPrefix(ownerLabel: string): string {
  return `我是${ownerLabel}的代理，`
}

/**
 * Build the outlet policy the kernel calls.
 * @param deps - injected facts and lookups.
 * @returns the policy; `check` never throws for a rejected message, it returns a code.
 */
export function createOutletPolicy(deps: OutletPolicyDeps): OutletPolicy {
  return {
    check(input: SpeechProposal, now: number): OutletVerdict {
      const report = deps.workReport?.(input)
      const proposal = report && input.payload === 'text'
        ? { ...input, text: renderWorkReport(input.moment, report.state, report.delivery, report.commitmentId, report.facts) } : input
      if (!momentAllowed(proposal.moment, deps.momentFacts(input))) {
        return { ok: false, code: 'MOMENT_FORBIDDEN', message: `moment ${proposal.moment} does not match this turn` }
      }
      const words = countWords(proposal.text)
      if (words > MAX_WORDS) {
        return { ok: false, code: 'TOO_LONG', message: `${String(words)} words, over ${String(MAX_WORDS)}` }
      }
      const promises = promiseHits(proposal.text)
      if (promises.length > 0 && !deps.mayPromise(proposal.chat_id)) {
        return { ok: false, code: 'PROMISE_BLOCKED', message: `promise words: ${promises.join(', ')}` }
      }
      const leaks = deps.disclosures(proposal.text, proposal.chat_id)
      if (leaks.length > 0) {
        return { ok: false, code: 'DISCLOSE_BLOCKED', message: `cannot say: ${leaks.join(', ')}` }
      }
      let text = proposal.text
      let total = words
      if (deps.identityNeeded(proposal.chat_id)) {
        // The prefix is part of the message, so it is part of the count. Refusing
        // here is deliberate: shortening a delivery would drop the evidence.
        text = `${identityPrefix(deps.ownerLabel(proposal.chat_id))}${text}`
        total = countWords(text)
        if (total > MAX_WORDS) {
          return {
            ok: false,
            code: 'TOO_LONG',
            message: `identity sentence pushed the message to ${String(total)} words, over ${String(MAX_WORDS)}`,
          }
        }
      }
      const decision = tier(deps.attentionCtx(proposal, now))
      return { ok: true, tier: decision.tier, text, words: total }
    },
  }
}