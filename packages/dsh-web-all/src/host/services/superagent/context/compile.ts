import type { ManagedLedger } from '../kernel/managed-ledger.ts'
import { assertRefs, type Ref, type ManagedObject } from '../protocol/managed-work.ts'
import { refOf, type ContextEnvelope, type ContextSource, type ContextRequest } from '../protocol/coordination.ts'
import { contextDigest, renderContext, CONTEXT_COMPILER_VERSION, CONTEXT_TEMPLATE_VERSION } from './envelope.ts'

export type { ContextRequest } from '../protocol/coordination.ts'
export interface ContextPage { ref: Ref; digest: string; text: string; offset: number; nextCursor?: string }
const sameRef = (a: Ref, b: Ref) => a.id === b.id && a.revision === b.revision
const sameAudience = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

/** Material source is a trusted, versioned host port; models only receive bounded pages. */
export function createContextCompiler(ledger: ManagedLedger, coordination: { semanticScopes(id: string): Ref[]; pendingQuestions(id: string): ManagedObject[] }, sourceOf: (ref: Ref) => ContextSource | undefined) {
  const current = (r: Ref, kind?: string) => {
    assertRefs([r]); const o = ledger.get(r.id)
    if (!o || o.revision !== r.revision || (kind && o.kind !== kind) || ledger.applicability(o.id) !== 'usable') throw new Error('CONTEXT_STALE_REFERENCE')
    return o
  }
  return Object.freeze({
    compile(request: ContextRequest): ContextEnvelope {
      const a = current(request.assignment, 'team_assignment'), worker = current(request.worker, 'worker')
      if (a.data.commitment_id !== request.commitmentId || !sameRef(a.data.worker_ref as unknown as Ref, request.worker)) throw new Error('CONTEXT_ASSIGNMENT_MISMATCH')
      if (request.audience.length !== 1 || request.audience[0] !== worker.id) throw new Error('CONTEXT_TARGET_AUDIENCE')
      if (!request.purpose.trim()) throw new Error('CONTEXT_PURPOSE_REQUIRED')
      const scopes = coordination.semanticScopes(request.commitmentId); scopes.forEach(r => current(r))
      const work = ledger.get(request.commitmentId)!
      const requirements = (work.data.requirement_refs as unknown as Ref[]).map(r => current(r, 'requirement'))
      const hardConstraints = [String(work.data.boundary), ...requirements.flatMap(o => o.data.constraints as string[])]
      const pendingQuestions = coordination.pendingQuestions(request.commitmentId).map(refOf)
      const sources: ContextSource[] = [], omitted: ContextEnvelope['omitted'] = []
      assertRefs(request.sourceRefs)
      for (const ref of request.sourceRefs) {
        const source = sourceOf(ref)
        if (!source || !sameRef(source.ref, ref) || source.digest !== contextDigest(source.text)) throw new Error('CONTEXT_SOURCE_MISSING')
        if (!request.audience.every(principal => source.visibleTo.includes(principal))) {
          if (source.mandatory) throw new Error('MANDATORY_CONTEXT_NOT_VISIBLE')
          omitted.push({ ref, reason: 'Not visible to actual recipients' }); continue
        }
        sources.push(structuredClone(source))
      }
      // Goals and criteria cannot be traded away to satisfy a token/window budget.
      const requiredFacts = requirements.map(o => ({ ref: refOf(o), intent: o.data.intent, observableResults: o.data.observable_results, criterionSources: o.data.criterion_sources }))
      const contract = current(work.data.acceptance_contract as unknown as Ref, 'acceptance_contract')
      const criteria = (contract.data.criterion_refs as unknown as Ref[]).map(ref => current(ref))
      const domainText = JSON.stringify({ acceptance: { ref: refOf(contract), intent: contract.data.intent, criteria: criteria.map(o => ({ ref: refOf(o), definition: o.data })) }, originalIntent: work.data.intent, requirements: requiredFacts,
        assignment: a.data, pendingQuestions: coordination.pendingQuestions(request.commitmentId).map(o => ({ ref: refOf(o), question: o.data.question, state: o.data.state, nativeState: o.data.native_state })) })
      sources.unshift({ ref: request.assignment, text: domainText, digest: contextDigest(domainText), visibleTo: [...request.audience], mandatory: true, purpose: 'Canonical goal, assignment and unresolved questions' })
      const envelope: Omit<ContextEnvelope, 'text' | 'digest'> = {
        assignment: request.assignment, commitmentId: request.commitmentId, worker: request.worker, audience: [...request.audience], purpose: request.purpose,
        semanticRefs: [...scopes, request.assignment], compilerVersion: CONTEXT_COMPILER_VERSION, templateVersion: CONTEXT_TEMPLATE_VERSION,
        sources, omitted, hardConstraints, pendingQuestions, failedMethods: [...request.failedMethods], nativeContextBlindSpots: [...request.nativeContextBlindSpots],
      }
      const text = renderContext(envelope)
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('REQUIRED_CONTEXT_TOO_LARGE')
      return { ...envelope, text, digest: contextDigest(text) }
    },
    readPage(context: Ref, sourceRef: Ref, audience: string[], cursor?: string, limit = 4000): ContextPage {
      const envelope = current(context, 'context_envelope').data.envelope as unknown as ContextEnvelope
      if (!sameAudience(envelope.audience, audience)) throw new Error('CONTEXT_AUDIENCE_MISMATCH')
      const declared = envelope.sources.find(s => sameRef(s.ref, sourceRef))
      if (!declared || !audience.every(p => declared.visibleTo.includes(p))) throw new Error('CONTEXT_SOURCE_NOT_VISIBLE')
      const live = sourceOf(sourceRef) ?? (declared.purpose === 'Canonical goal, assignment and unresolved questions' ? declared : undefined)
      if (!live || live.digest !== declared.digest || contextDigest(live.text) !== declared.digest || !audience.every(p => live.visibleTo.includes(p))) throw new Error('CONTEXT_SOURCE_CHANGED')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16384) throw new Error('CONTEXT_PAGE_LIMIT')
      let offset = 0
      if (cursor) {
        let value: { context: Ref; source: Ref; digest: string; audience: string[]; offset: number }
        try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { throw new Error('CONTEXT_CURSOR_INVALID') }
        if (!value || !value.context || !value.source || !sameRef(value.context, context) || !sameRef(value.source, sourceRef) || value.digest !== declared.digest || !Array.isArray(value.audience) || !sameAudience(value.audience, audience) || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > live.text.length) throw new Error('CONTEXT_CURSOR_INVALID')
        offset = value.offset
      }
      const text = live.text.slice(offset, offset + limit), next = offset + text.length
      return { ref: sourceRef, digest: declared.digest, text, offset,
        ...(next < live.text.length ? { nextCursor: Buffer.from(JSON.stringify({ context, source: sourceRef, digest: declared.digest, audience, offset: next })).toString('base64url') } : {}) }
    },
  })
}
