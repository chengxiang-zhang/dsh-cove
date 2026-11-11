import type { ManagedLedger } from '../kernel/managed-ledger.ts'
import { createCoordinationWriter, coordinationScopes } from '../kernel/coordination-ledger.ts'
import type { Ref, ManagedObject, Json } from '../protocol/managed-work.ts'
import type { HostSpec, ProjectSpec, PolicySpec, ProfileSpec, WorkerSpec, CommitmentSpec, AssignmentSpec,
  QuestionSpec, ProfessionalDecision, ContextEnvelope, ContextConsumption, OperationClaim, OperationExecution } from '../protocol/coordination.ts'

/** Receives an authenticated source from composition, never from model/input metadata. */
export function createCoordinationService(ledger: ManagedLedger, source: Ref) {
  const write = createCoordinationWriter(ledger, source)
  return Object.freeze({
    host: Object.freeze({
      claimOperation: (input: OperationClaim) => write({ kind: 'operation_claim', input })[0]!,
      bindOperationExecution: (operation: Ref, execution: OperationExecution) => write({ kind: 'operation_bind', operation, execution })[0]!,
      completeOperation: (operation: Ref, result: Json, evidenceRefs: string[]) => write({ kind: 'operation_complete', operation, result, evidenceRefs })[0]!,
      recordRuntimeEvent: (id: string, event: string, payload: Json, scopeRefs: Ref[], evidenceRefs: string[] = []) => write({ kind: 'runtime_event', id, event, payload, scopeRefs, evidenceRefs })[0]!,
      registerHost: (input: HostSpec) => write({ kind: 'host', input })[0]!,
      registerProject: (input: ProjectSpec) => write({ kind: 'project', input })[0]!,
      registerPolicy: (input: PolicySpec) => write({ kind: 'policy', input })[0]!,
      registerProfile: (input: ProfileSpec) => write({ kind: 'profile', input })[0]!,
      registerWorker: (input: WorkerSpec) => write({ kind: 'worker', input })[0]!,
      resumeNativeSession: (worker: Ref, evidenceRef: string) => write({ kind: 'native_binding', worker, evidenceRef, resume: true })[0]!,
      bindNativeSession: (worker: Ref, evidenceRef: string) => write({ kind: 'native_binding', worker, evidenceRef })[0]!,
      renewProfileQualification: (profile: Ref, evidenceRefs: string[], expiresAt: number) => write({ kind: 'renew_profile', profile, evidenceRefs, expiresAt })[0]!,
      recordQuestion: (input: QuestionSpec) => write({ kind: 'question', input })[0]!,
      observeQuestionRequest: (question: Ref, evidenceRef: string) => write({ kind: 'native_question', question, evidenceRef })[0]!,
      recordContext: (input: ContextEnvelope) => write({ kind: 'context', input })[0]!,
      recordConsumedContext: (input: ContextConsumption) => write({ kind: 'consumed', input })[0]!,
      recordTeamReview: (commitmentId: string, reviewer: Ref, assignments: Ref[], evidenceRefs: string[], verdict: 'pass' | 'fail' | 'inconclusive') => write({ kind: 'team_review', commitmentId, reviewer, assignments, evidenceRefs, verdict })[0]!,
      recordObservation: (commitmentId: string, observerRef: string, sourceRefs: Ref[], summary: string, extensions: ManagedObject['extensions']) => write({ kind: 'observation', commitmentId, observerRef, sourceRefs, summary, extensions })[0]!,
    }),
    acceptManagedIntent: (authenticatedSource: Ref, input: CommitmentSpec) => write({ kind: 'accept', source: authenticatedSource, input })[0]!,
    planProfessionalTeam: (commitment: Ref, assignments: AssignmentSpec[]) => write({ kind: 'team', commitment, assignments }),
    recordProfessionalDecision: (input: ProfessionalDecision) => write({ kind: 'decision', input })[0]!,
    semanticScopes: (commitmentId: string) => coordinationScopes(ledger, commitmentId),
    pendingQuestions: (commitmentId: string) => ledger.snapshot().filter(o => o.kind === 'semantic_question' && o.data.commitment_id === commitmentId && o.data.state !== 'answered'),
    dispatchReadiness(commitmentId: string): { ready: boolean; code: string } {
      const work = ledger.get(commitmentId)
      if (!work || work.data.control_state !== 'autonomous' || ['released', 'withdrawn', 'broken', 'fulfilled'].includes(String(work.data.state))) return { ready: false, code: 'CONTROL_LOST' }
      const scopes = coordinationScopes(ledger, commitmentId)
      if (scopes.some(r => ledger.get(r.id)?.revision !== r.revision || ledger.applicability(r.id) !== 'usable')) return { ready: false, code: 'STALE_REVISION' }
      const review = ledger.snapshot().filter(o => o.kind === 'team_review' && o.data.commitment_id === commitmentId).at(-1)
      if (!review || review.data.verdict !== 'pass' || ledger.applicability(review.id) !== 'usable') return { ready: false, code: 'QUALITY_INTAKE_REQUIRED' }
      return { ready: true, code: 'READY' }
    },
  })
}
export type CoordinationService = ReturnType<typeof createCoordinationService>
