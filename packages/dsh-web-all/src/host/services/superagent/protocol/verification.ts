import type { Json, Ref } from './managed-work.ts'

export type Verdict = 'pass' | 'fail' | 'inconclusive'
export interface VerificationCase {
  criterion: string
  input: Json
  expected: Json
}
export interface VerificationCaseBinding {
  criterion: string
  digest: string
}
export interface ReviewContextInput {
  issue: Ref
  purpose: 'resolve' | 'dismiss'
  coverageBasis: string
}
export interface AssignmentInput {
  commitmentId: string
  contract: Ref
  requirements: Ref[]
  generators: string[]
  reviewer: string
}
export interface QualificationInput {
  method: 'json-equality@1'
  reviewer: string
  evidenceRefs: string[]
  expiresAt: number
}
export interface CandidateInput {
  sourceRoot: string
  entry: string
  exportName: string
  environment: string
}
export interface CriterionResult {
  criterion: string
  verdict: Verdict
  reason: string
}
export interface CollectorObservation {
  run_id: string
  collector_pid: number
  candidate_pid: number | null
  exit_code: number | null
  stdout: string
  stderr: string
  stdout_base64: string
  stderr_base64: string
  complete: boolean
  integrity: boolean
  results: CriterionResult[]
}
export const VERIFICATION_KINDS = [
  'verification_assignment',
  'candidate',
  'verification_context',
  'verification_evidence',
  'qualification',
  'evaluation',
  'review_issue',
  'verification_binding',
  'verification_delivery',
  'qualification_revocation',
  'qualification_impact',
  'verification_run'
] as const

/** Canonical verification objects can only be written through the typed host port. */
export function validateVerificationData(kind: string, data: Record<string, Json>): void {
  const fields: Record<string, string[]> = {
    verification_assignment: [
      'commitment_id',
      'contract_ref',
      'requirement_refs',
      'generators',
      'reviewer'
    ],
    candidate: [
      'assignment_ref',
      'root',
      'digest',
      'entry',
      'export_name',
      'environment',
      'manifest'
    ],
    verification_context: [
      'candidate_ref',
      'qualification_ref',
      'run_id',
      'asset_root',
      'asset_digest',
      'criteria',
      'method',
      'collector_version',
      'runtime_digest',
      'preparer_pid',
      'case_bindings',
      'review_binding'
    ],
    verification_evidence: [
      'context_ref',
      'run_id',
      'collector_pid',
      'candidate_pid',
      'exit_code',
      'stdout',
      'stderr',
      'stdout_base64',
      'stderr_base64',
      'complete',
      'integrity',
      'results',
      'raw_digest'
    ],
    qualification: [
      'method',
      'reviewer',
      'evidence_refs',
      'expires_at',
      'revoked',
      'revocation_ref',
      'runtime_digest'
    ],
    evaluation: [
      'contract_ref',
      'candidate_ref',
      'context_refs',
      'evidence_refs',
      'reviewer',
      'results',
      'verdict',
      'commitment_id'
    ],
    review_issue: [
      'candidate_ref',
      'contract_ref',
      'criterion',
      'source',
      'reproduction_refs',
      'impact',
      'responsible',
      'reviewer',
      'release_condition',
      'recheck_cases',
      'execution_identity',
      'state',
      'resolution_ref',
      'resolution_basis'
    ],
    verification_binding: ['commitment_id', 'candidate_ref', 'evaluation_ref'],
    verification_delivery: ['evaluation_ref', 'action_ref', 'commitment_id'],
    qualification_revocation: [
      'qualification_ref',
      'reason',
      'evidence_refs',
      'reviewer',
      'cursor',
      'complete'
    ],
    qualification_impact: ['revocation_ref', 'evaluation_ref', 'delivery_refs', 'state'],
    verification_run: ['context_ref', 'action_ref']
  }
  const expected = fields[kind]
  if (
    !expected ||
    expected.some((k) => !(k in data)) ||
    Object.keys(data).some((k) => !expected.includes(k))
  )
    throw new Error('INVALID_VERIFICATION_FIELDS')
}
