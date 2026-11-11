import type { Json, Ref, ManagedObject } from './managed-work.ts'

export interface HostSpec { id: string; authority: string; evidenceRefs: string[] }
export interface ProjectSpec { id: string; intent: string; repositoryIdentity: string; hosts: Ref[]; sourceRefs: Ref[] }
export interface PolicySpec { id: string; roles: { name: string; required: boolean; independentOf: string[] }[] }
export interface ProfileSpec { id: string; capabilities: string[]; evidenceRefs: string[]; expiresAt: number; limitations: string[] }
export interface WorkerSpec { id: string; host: Ref; profile: Ref; projects: Ref[]; engineRef: string; runtimeNamespace: string }
export interface CommitmentSpec {
  id: string; intent: string; requirements: Ref[]; acceptanceContract: Ref; deliveryContract: Ref
  projects: Ref[]; boundary: string; accountable: string; policy: Ref; nextReviewAt: number
}
export interface AssignmentSpec {
  role: string; applicable: boolean; basis: string; worker: Ref | null
  deliverables: string[]; consumers: string[]; criteria: Ref[]; dependencies: string[]; combinationBasis: string
}
export interface QuestionSpec {
  commitmentId: string; assignment: Ref; worker: Ref; nativeRequestRef: string; question: string
  evidenceRefs: string[]; nextReviewAt: number; nativeEvidenceRef: string
}
export interface ProfessionalDecision {
  commitmentId: string; question: Ref; reviewer: Ref; kind: 'technical_answer' | 'engineering_refinement'
  conclusion: string; evidenceRefs: string[]; alternatives: string[]; scopeRefs: Ref[]
}
export interface ContextSource {
  ref: Ref; text: string; digest: string; visibleTo: string[]; mandatory: boolean; purpose: string
}
export interface ContextRequest {
  commitmentId: string; assignment: Ref; worker: Ref; audience: string[]; purpose: string
  sourceRefs: Ref[]; failedMethods: string[]; nativeContextBlindSpots: string[]
}
export interface ContextEnvelope {
  assignment: Ref; commitmentId: string; worker: Ref; audience: string[]; purpose: string; semanticRefs: Ref[]
  compilerVersion: string; templateVersion: string; sources: ContextSource[]
  omitted: { ref: Ref; reason: string }[]; hardConstraints: string[]; pendingQuestions: Ref[]
  failedMethods: string[]; nativeContextBlindSpots: string[]; text: string; digest: string
}
export interface ContextConsumption {
  context: Ref; requestId: string; assignmentRevision: number; payloadDigest: string
  worker: Ref; nativeSessionId: string; turnId: string; processingStartedEventRef: string; nativeEvidenceRef: string
}

export interface OperationClaim {
  id: string; inputRef: string; proposal: Json; domainKeys: string[]; scopeRefs: Ref[]; executionSlots: string[]
}
export type OperationExecution =
  | { kind: 'native'; slot: string; worker: Ref; context: Ref; launch: Ref; stream: string; nativeSessionId: string; requestId: string }
  | { kind: 'controlled'; slot: string; action: Ref }

export const COORDINATION_KINDS = ['host_binding', 'project', 'professional_policy', 'capability_profile', 'session_binding',
  'profile_qualification', 'coordination_intake', 'team_assignment', 'semantic_question', 'professional_decision', 'context_envelope', 'context_input',
  'coordination_operation', 'team_review', 'coordination_observation', 'coordination_runtime_event'] as const

/** Exact durable field sets; semantic cross-object checks belong to the typed transaction. */
export function validateCoordinationData(kind: string, data: Record<string, Json>): void {
  const fields: Record<string, string[]> = {
    coordination_operation: ['input_ref','proposal','domain_keys','semantic_refs','execution_slots','state','executions','result','evidence_refs'],
    coordination_runtime_event: ['event', 'payload', 'evidence_refs'],
    host_binding: ['authority', 'evidence_refs'],
    project: ['intent', 'repository_identity', 'host_refs', 'source_refs'],
    professional_policy: ['roles'],
    capability_profile: ['capabilities', 'evidence_refs', 'expires_at', 'limitations'],
    session_binding: ['worker_ref', 'host_ref', 'profile_ref', 'project_refs', 'engine_ref', 'runtime_namespace', 'native_session_id', 'native_binding_ref', 'native_evidence_ref', 'launch_ref', 'stream'],
    coordination_intake: ['commitment_id', 'source_ref', 'policy_ref', 'requirement_refs', 'contract_ref', 'delivery_ref', 'project_refs'],
    team_assignment: ['commitment_id', 'policy_ref', 'role', 'applicable', 'basis', 'worker_ref', 'binding_ref', 'deliverables', 'consumers', 'criterion_refs', 'dependencies', 'combination_basis', 'state'],
    profile_qualification: ['profile_ref','evidence_refs','expires_at'],
    semantic_question: ['commitment_id', 'assignment_ref', 'worker_ref', 'native_request_ref', 'question', 'evidence_refs', 'next_review_at', 'native_state', 'native_reason', 'state', 'decision_ref', 'response_ref', 'native_evidence_ref'],
    professional_decision: ['commitment_id', 'question_ref', 'reviewer_ref', 'kind', 'conclusion', 'evidence_refs', 'alternatives'],
    context_envelope: ['envelope'],
    context_input: ['context_ref', 'request_id', 'assignment_revision', 'payload_digest', 'worker_ref', 'native_session_id', 'turn_id', 'processing_started_event_ref', 'native_evidence_ref'],
    team_review: ['commitment_id', 'reviewer_ref', 'assignment_refs', 'contract_ref', 'evidence_refs', 'verdict'],
    coordination_observation: ['commitment_id', 'observer_ref', 'source_refs', 'summary'],
  }
  const expected = fields[kind]
  if (!expected || expected.some(k => !(k in data)) || Object.keys(data).some(k => !expected.includes(k))) throw new Error('INVALID_COORDINATION_FIELDS')
}
export const refOf = (object: ManagedObject): Ref => ({ id: object.id, revision: object.revision })
