import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ManagedLedger } from './managed-ledger.ts'
import {
  assertJson,
  assertRefs,
  type Json,
  type ManagedObject,
  type Ref
} from '../protocol/managed-work.ts'
import type {
  AssignmentInput,
  QualificationInput,
  CollectorObservation,
  CriterionResult,
  VerificationCaseBinding
} from '../protocol/verification.ts'

const authorities = new WeakSet<object>()
type Payload =
  | { kind: 'assignment'; input: AssignmentInput }
  | { kind: 'qualification'; input: QualificationInput; runtimeDigest: string }
  | { kind: 'candidate'; assignment: Ref; data: Record<string, Json> }
  | { kind: 'context'; candidate: Ref; qualification: Ref; data: Record<string, Json> }
  | { kind: 'evidence'; context: Ref; observation: CollectorObservation; digest: string }
  | { kind: 'begin_run'; context: Ref; action: Ref }
  | { kind: 'assess'; contract: Ref; candidate: Ref; evidence: Ref[] }
  | {
      kind: 'issue'
      candidate: Ref
      criterion: string
      source: string
      reproductionRefs: Ref[]
      impact: string
      responsible: string
      releaseCondition: string
    }
  | { kind: 'resolve'; issue: Ref; evaluation: Ref }
  | { kind: 'issue_progress'; issue: Ref; state: 'addressing' | 'awaiting_recheck' }
  | { kind: 'dismiss'; issue: Ref; evaluation: Ref; basis: string }
  | { kind: 'revoke'; qualification: Ref; reason: string; evidenceRefs: string[]; reviewer: string }
  | { kind: 'scan'; revocation: Ref; limit: number }
  | { kind: 'enter_delivery'; commitment: Ref; evaluation: Ref }
  | { kind: 'delivery'; evaluation: Ref; action: Ref }
export interface VerificationCommand {
  token: object
  source: Ref
  payload: Payload
}

/** Only trusted composition receives this writer; no model tool exposes it. */
export function createVerificationWriter(ledger: ManagedLedger, source: Ref) {
  assertRefs([source])
  const token = Object.freeze({})
  authorities.add(token)
  return (payload: Payload): Ref => ledger.verification({ token, source, payload })
}
const refOf = (o: ManagedObject): Ref => ({ id: o.id, revision: o.revision })
const ref = (v: Json | undefined): Ref => v as unknown as Ref
const refs = (v: Json | undefined): Ref[] => v as unknown as Ref[]
const json = (v: unknown): Json => {
  assertJson(v)
  return v
}

/** Derive the complete authority chain from canonical relationships, never caller claims. */
export function verificationScopes(
  ledger: Pick<ManagedLedger, 'get' | 'snapshot'>,
  commitmentId: string
): Ref[] {
  const binding = ledger
    .snapshot()
    .find((o) => o.kind === 'verification_binding' && o.data.commitment_id === commitmentId)
  if (!binding || !binding.data.evaluation_ref) return []
  const found = new Map<string, Ref>()
  const visit = (r: Ref) => {
    if (found.has(r.id)) return
    found.set(r.id, r)
    for (const parent of ledger.get(r.id)?.scope_revision_refs ?? []) visit(parent)
  }
  visit(refOf(binding))
  return [...found.values()]
}

export function verificationTransaction(
  db: DatabaseSync,
  ledger: ManagedLedger,
  command: VerificationCommand
): Ref {
  if (!command || !authorities.has(command.token)) throw new Error('VERIFICATION_HOST_REQUIRED')
  assertRefs([command.source])
  assertJson(command.payload)
  db.exec('BEGIN IMMEDIATE')
  try {
    const p = command.payload
    const changed: ManagedObject[] = []
    const current = (r: Ref, kind?: string): ManagedObject => {
      assertRefs([r])
      const o = ledger.get(r.id)
      if (
        !o ||
        o.revision !== r.revision ||
        (kind && o.kind !== kind) ||
        ledger.applicability(o.id) !== 'usable'
      )
        throw new Error('VERIFICATION_STALE_REFERENCE')
      return o
    }
    const save = (
      kind: string,
      data: Record<string, Json>,
      scopes: Ref[],
      previous?: ManagedObject
    ): ManagedObject => {
      const o: ManagedObject = {
        id: previous?.id ?? `${kind}:${randomUUID()}`,
        kind,
        revision: (previous?.revision ?? 0) + 1,
        data,
        scope_revision_refs: scopes,
        extensions: {}
      }
      ledger.validate(o)
      if (previous)
        db.prepare('UPDATE sa_managed_object SET revision=?,body_json=? WHERE id=?').run(
          o.revision,
          JSON.stringify(o),
          o.id
        )
      else
        db.prepare('INSERT INTO sa_managed_object VALUES(?,?,?,?,0)').run(
          o.id,
          o.kind,
          o.revision,
          JSON.stringify(o)
        )
      changed.push(o)
      return o
    }
    const assignmentOf = (candidate: ManagedObject) =>
      current(ref(candidate.data.assignment_ref), 'verification_assignment')
    const caseBindings = (value: Json | undefined): VerificationCaseBinding[] => {
      if (
        !Array.isArray(value) ||
        !value.length ||
        value.some((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return true
          return (
            Object.keys(item).some((key) => !['criterion', 'digest'].includes(key)) ||
            typeof item.criterion !== 'string' ||
            !item.criterion.trim() ||
            typeof item.digest !== 'string' ||
            !/^[a-f0-9]{64}$/.test(item.digest)
          )
        })
      )
        throw new Error('REVIEW_CASE_BINDINGS_REQUIRED')
      return value as unknown as VerificationCaseBinding[]
    }
    const executionIdentity = (candidate: ManagedObject, runtime: Json | undefined) => ({
      entry: candidate.data.entry!,
      export_name: candidate.data.export_name!,
      environment: candidate.data.environment!,
      runtime_digest: runtime!
    })
    const assertExecutionIdentity = (
      issue: ManagedObject,
      candidate: ManagedObject,
      runtime?: Json
    ) => {
      const identity = issue.data.execution_identity as Record<string, Json> | undefined
      if (
        !identity ||
        ['entry', 'export_name', 'environment'].some(
          (key) => identity[key] !== candidate.data[key]
        ) ||
        (runtime !== undefined && identity.runtime_digest !== runtime)
      )
        throw new Error('REVIEW_EXECUTION_IDENTITY_REQUIRED')
    }
    const checkReviewContext = (
      data: Record<string, Json>,
      candidate: ManagedObject
    ): ManagedObject | undefined => {
      if (data.review_binding === null) return undefined
      const binding = data.review_binding as Record<string, Json> | undefined
      if (
        !binding ||
        typeof binding !== 'object' ||
        Array.isArray(binding) ||
        Object.keys(binding).some(
          (key) => !['issue_ref', 'purpose', 'release_condition', 'coverage_basis'].includes(key)
        ) ||
        !['resolve', 'dismiss'].includes(String(binding.purpose)) ||
        typeof binding.coverage_basis !== 'string' ||
        !binding.coverage_basis.trim()
      )
        throw new Error('ISSUE_RECHECK_BINDING_REQUIRED')
      const issue = current(ref(binding.issue_ref), 'review_issue')
      if (
        (binding.purpose === 'resolve' && issue.data.state !== 'awaiting_recheck') ||
        ['resolved', 'dismissed'].includes(String(issue.data.state)) ||
        binding.release_condition !== issue.data.release_condition
      )
        throw new Error('ISSUE_RECHECK_BINDING_REQUIRED')
      const assignment = assignmentOf(candidate)
      if (JSON.stringify(assignment.data.contract_ref) !== JSON.stringify(issue.data.contract_ref))
        throw new Error('CONTRACT_MISMATCH')
      assertExecutionIdentity(issue, candidate, data.runtime_digest)
      const required = caseBindings(issue.data.recheck_cases),
        actual = caseBindings(data.case_bindings)
      if (
        required.some(
          (test) =>
            !actual.some((item) => item.criterion === test.criterion && item.digest === test.digest)
        )
      )
        throw new Error('ISSUE_RECHECK_COVERAGE_REQUIRED')
      if (binding.purpose === 'dismiss') {
        const original = ledger.get(ref(issue.data.candidate_ref).id)
        if (
          original?.data.digest !== candidate.data.digest ||
          assignment.data.reviewer === issue.data.reviewer ||
          assignment.data.reviewer === issue.data.responsible
        )
          throw new Error('INDEPENDENT_DISMISSAL_REQUIRED')
      }
      return issue
    }
    const bind = (commitmentId: string, candidate: Ref, evaluation: Ref | null) => {
      const old = ledger
        .snapshot()
        .find((o) => o.kind === 'verification_binding' && o.data.commitment_id === commitmentId)
      save(
        'verification_binding',
        {
          commitment_id: commitmentId,
          candidate_ref: json(candidate),
          evaluation_ref: json(evaluation)
        },
        [candidate, ...(evaluation ? [evaluation] : [])],
        old
      )
    }
    const passing = (evaluation: Ref) => {
      const e = current(evaluation, 'evaluation')
      if (e.data.verdict !== 'pass') throw new Error('VERIFICATION_NOT_PASS')
      const issues = ledger
        .snapshot()
        .filter(
          (o) =>
            o.kind === 'review_issue' &&
            JSON.stringify(o.data.contract_ref) === JSON.stringify(e.data.contract_ref) &&
            !['resolved', 'dismissed'].includes(String(o.data.state))
        )
      if (issues.length) throw new Error('REVIEW_ISSUE_OPEN')
      const binding = ledger
        .snapshot()
        .find(
          (o) => o.kind === 'verification_binding' && o.data.commitment_id === e.data.commitment_id
        )
      if (!binding || JSON.stringify(binding.data.evaluation_ref) !== JSON.stringify(evaluation))
        throw new Error('EVALUATION_NOT_CURRENT')
      return e
    }
    let result: ManagedObject
    if (p.kind === 'assignment') {
      const i = p.input,
        c = ledger.get(i.commitmentId),
        contract = current(i.contract, 'acceptance_contract')
      assertRefs(i.requirements)
      if (
        !c ||
        c.kind !== 'commitment' ||
        JSON.stringify(c.data.acceptance_contract) !== JSON.stringify(i.contract) ||
        JSON.stringify(contract.data.requirement_refs) !== JSON.stringify(i.requirements) ||
        !i.generators.length ||
        i.generators.some((x) => !x.trim()) ||
        !i.reviewer.trim() ||
        i.generators.includes(i.reviewer)
      )
        throw new Error('VERIFICATION_INDEPENDENCE_REQUIRED')
      for (const r of i.requirements) current(r, 'requirement')
      result = save(
        'verification_assignment',
        {
          commitment_id: i.commitmentId,
          contract_ref: json(i.contract),
          requirement_refs: json(i.requirements),
          generators: i.generators,
          reviewer: i.reviewer
        },
        [i.contract, ...i.requirements, ...c.scope_revision_refs]
      )
    } else if (p.kind === 'qualification') {
      const i = p.input
      if (
        i.method !== 'json-equality@1' ||
        !i.reviewer.trim() ||
        !i.evidenceRefs.length ||
        i.evidenceRefs.some((x) => !x.trim()) ||
        i.expiresAt <= Date.now()
      )
        throw new Error('QUALIFICATION_EVIDENCE_REQUIRED')
      result = save(
        'qualification',
        {
          method: i.method,
          reviewer: i.reviewer,
          evidence_refs: i.evidenceRefs,
          expires_at: i.expiresAt,
          revoked: false,
          revocation_ref: null,
          runtime_digest: p.runtimeDigest
        },
        []
      )
    } else if (p.kind === 'candidate') {
      const a = current(p.assignment, 'verification_assignment')
      const commitment = ledger.get(String(a.data.commitment_id))
      if (!commitment || !['working', 'verifying'].includes(String(commitment.data.state)))
        throw new Error('CANDIDATE_PHASE_REQUIRED')
      result = save('candidate', { ...p.data, assignment_ref: json(p.assignment) }, [p.assignment])
      bind(String(a.data.commitment_id), refOf(result), null)
      if (commitment.data.state === 'working')
        save(
          'commitment',
          { ...commitment.data, state: 'verifying' },
          commitment.scope_revision_refs,
          commitment
        )
    } else if (p.kind === 'context') {
      const c = current(p.candidate, 'candidate'),
        a = assignmentOf(c),
        q = current(p.qualification, 'qualification')
      if (
        q.data.reviewer !== a.data.reviewer ||
        Number(q.data.expires_at) <= Date.now() ||
        q.data.runtime_digest !== p.data.runtime_digest
      )
        throw new Error('QUALIFICATION_NOT_APPLICABLE')
      const contract = current(ref(a.data.contract_ref), 'acceptance_contract')
      const criteria = refs(contract.data.criterion_refs).map((r) => r.id)
      if (!criteria.length || JSON.stringify(p.data.criteria) !== JSON.stringify(criteria))
        throw new Error('CRITERION_COVERAGE_REQUIRED')
      caseBindings(p.data.case_bindings)
      checkReviewContext(p.data, c)
      result = save(
        'verification_context',
        {
          ...p.data,
          candidate_ref: json(p.candidate),
          qualification_ref: json(p.qualification),
          method: q.data.method!
        },
        [p.candidate, p.qualification]
      )
    } else if (p.kind === 'begin_run') {
      const context = current(p.context, 'verification_context')
      checkReviewContext(context.data, current(ref(context.data.candidate_ref), 'candidate'))
      const action = current(p.action, 'action')
      if (
        action.data.state !== 'sent' ||
        action.data.action_kind !== 'collect' ||
        !action.scope_revision_refs.some(
          (r) => r.id === p.context.id && r.revision === p.context.revision
        )
      )
        throw new Error('VERIFICATION_ACTION_REQUIRED')
      if (
        ledger
          .snapshot()
          .some((o) => o.kind === 'verification_run' && ref(o.data.context_ref).id === p.context.id)
      )
        throw new Error('VERIFICATION_RUN_ALREADY_CLAIMED')
      result = save(
        'verification_run',
        { context_ref: json(p.context), action_ref: json(p.action) },
        [p.context]
      )
    } else if (p.kind === 'evidence') {
      // Preserve the actual observation after a semantic revocation; applicability
      // follows stale scopes and can never turn this historical evidence into pass.
      const ctx = ledger.get(p.context.id)
      if (!ctx || ctx.kind !== 'verification_context' || ctx.revision !== p.context.revision)
        throw new Error('CONTEXT_IDENTITY_CHANGED')
      if (
        p.observation.run_id !== ctx.data.run_id ||
        p.observation.collector_pid === process.pid ||
        !ledger
          .snapshot()
          .some((o) => o.kind === 'verification_run' && ref(o.data.context_ref).id === p.context.id)
      )
        throw new Error('EXTERNAL_COLLECTOR_REQUIRED')
      if (
        ledger
          .snapshot()
          .some(
            (o) => o.kind === 'verification_evidence' && ref(o.data.context_ref).id === p.context.id
          )
      )
        throw new Error('EVIDENCE_ALREADY_RECORDED')
      result = save(
        'verification_evidence',
        {
          ...(json(p.observation) as Record<string, Json>),
          context_ref: json(p.context),
          raw_digest: p.digest
        },
        [p.context]
      )
    } else if (p.kind === 'assess') {
      const c = current(p.candidate, 'candidate'),
        a = assignmentOf(c),
        contract = current(p.contract, 'acceptance_contract')
      if (JSON.stringify(a.data.contract_ref) !== JSON.stringify(p.contract))
        throw new Error('CONTRACT_MISMATCH')
      const evidence = p.evidence.map((r) => current(r, 'verification_evidence'))
      const contexts = evidence.map((e) => current(ref(e.data.context_ref), 'verification_context'))
      if (
        contexts.some(
          (ctx) => JSON.stringify(ctx.data.candidate_ref) !== JSON.stringify(p.candidate)
        )
      )
        throw new Error('CANDIDATE_MISMATCH')
      for (const context of contexts) checkReviewContext(context.data, c)
      const results: CriterionResult[] = refs(contract.data.criterion_refs).map((criterion) => {
        const intact = evidence.every((e) => e.data.complete === true && e.data.integrity === true)
        const rows = evidence
          .flatMap((e) => (intact ? (e.data.results as unknown as CriterionResult[]) : []))
          .filter((row) => row.criterion === criterion.id)
        const verdict = rows.some((r) => r.verdict === 'fail')
          ? 'fail'
          : rows.length && rows.every((r) => r.verdict === 'pass')
            ? 'pass'
            : 'inconclusive'
        return {
          criterion: criterion.id,
          verdict,
          reason: rows.length
            ? rows.map((r) => r.reason).join('; ')
            : 'Independent evidence missing or incomplete'
        }
      })
      const verdict = results.some((r) => r.verdict === 'fail')
        ? 'fail'
        : results.length && results.every((r) => r.verdict === 'pass')
          ? 'pass'
          : 'inconclusive'
      result = save(
        'evaluation',
        {
          contract_ref: json(p.contract),
          candidate_ref: json(p.candidate),
          context_refs: json(contexts.map(refOf)),
          evidence_refs: json(p.evidence),
          reviewer: a.data.reviewer!,
          results: json(results),
          verdict,
          commitment_id: a.data.commitment_id!
        },
        [p.contract, p.candidate, ...p.evidence]
      )
      bind(String(a.data.commitment_id), p.candidate, refOf(result))
    } else if (p.kind === 'issue') {
      const c = current(p.candidate, 'candidate'),
        a = assignmentOf(c)
      if (
        ![p.criterion, p.source, p.impact, p.responsible, p.releaseCondition].every((s) =>
          s.trim()
        ) ||
        !p.reproductionRefs.length
      )
        throw new Error('REVIEW_BASIS_REQUIRED')
      const contract = current(ref(a.data.contract_ref), 'acceptance_contract')
      if (!refs(contract.data.criterion_refs).some((r) => r.id === p.criterion))
        throw new Error('REVIEW_CRITERION_REQUIRED')
      const observations = p.reproductionRefs.map((r) => current(r, 'verification_evidence'))
      const contexts = observations.map((e) =>
        current(ref(e.data.context_ref), 'verification_context')
      )
      const recheckCases: VerificationCaseBinding[] = []
      for (const context of contexts) {
        if (
          JSON.stringify(context.data.candidate_ref) !== JSON.stringify(p.candidate) ||
          context.data.runtime_digest !== contexts[0]!.data.runtime_digest
        )
          throw new Error('REVIEW_EXECUTION_IDENTITY_REQUIRED')
        const cases = caseBindings(context.data.case_bindings).filter(
          (test) => test.criterion === p.criterion
        )
        if (!cases.length) throw new Error('REVIEW_CASE_BINDINGS_REQUIRED')
        for (const test of cases)
          if (!recheckCases.some((item) => item.digest === test.digest)) recheckCases.push(test)
      }
      result = save(
        'review_issue',
        {
          candidate_ref: json(p.candidate),
          contract_ref: a.data.contract_ref!,
          criterion: p.criterion,
          source: p.source,
          reproduction_refs: json(p.reproductionRefs),
          impact: p.impact,
          responsible: p.responsible,
          reviewer: a.data.reviewer!,
          release_condition: p.releaseCondition,
          recheck_cases: json(recheckCases),
          execution_identity: executionIdentity(c, contexts[0]!.data.runtime_digest),
          state: 'open',
          resolution_ref: null,
          resolution_basis: null
        },
        []
      )
    } else if (p.kind === 'issue_progress') {
      const issue = current(p.issue, 'review_issue')
      if (
        !(
          (issue.data.state === 'open' && p.state === 'addressing') ||
          (issue.data.state === 'addressing' && p.state === 'awaiting_recheck')
        )
      )
        throw new Error('REVIEW_TRANSITION')
      result = save('review_issue', { ...issue.data, state: p.state }, [], issue)
    } else if (p.kind === 'resolve' || p.kind === 'dismiss') {
      const issue = current(p.issue, 'review_issue'),
        e = current(p.evaluation, 'evaluation')
      const tested = current(ref(e.data.candidate_ref), 'candidate')
      assertExecutionIdentity(issue, tested)
      const binding = ledger
        .snapshot()
        .find(
          (o) => o.kind === 'verification_binding' && o.data.commitment_id === e.data.commitment_id
        )
      if (
        e.data.verdict !== 'pass' ||
        e.data.reviewer === issue.data.responsible ||
        JSON.stringify(e.data.contract_ref) !== JSON.stringify(issue.data.contract_ref) ||
        JSON.stringify(binding?.data.evaluation_ref) !== JSON.stringify(p.evaluation) ||
        !(e.data.results as unknown as CriterionResult[]).some(
          (r) => r.criterion === issue.data.criterion && r.verdict === 'pass'
        )
      )
        throw new Error('INDEPENDENT_RECHECK_REQUIRED')
      if (p.kind === 'resolve' && issue.data.state !== 'awaiting_recheck')
        throw new Error('REVIEW_TRANSITION')
      if (p.kind === 'dismiss') {
        const original = ledger.get(ref(issue.data.candidate_ref).id),
          tested = current(ref(e.data.candidate_ref), 'candidate')
        if (
          !p.basis.trim() ||
          e.data.reviewer === issue.data.reviewer ||
          original?.data.digest !== tested.data.digest ||
          original?.data.environment !== tested.data.environment ||
          ['resolved', 'dismissed'].includes(String(issue.data.state))
        )
          throw new Error('INDEPENDENT_DISMISSAL_REQUIRED')
      }
      const contexts = refs(e.data.context_refs).map((r) => current(r, 'verification_context'))
      const matching = contexts.filter((context) => {
        const binding = context.data.review_binding as Record<string, Json> | null
        return (
          binding &&
          JSON.stringify(binding.issue_ref) === JSON.stringify(p.issue) &&
          binding.purpose === p.kind
        )
      })
      if (!matching.length) throw new Error('ISSUE_RECHECK_BINDING_REQUIRED')
      for (const context of matching) checkReviewContext(context.data, tested)
      result = save(
        'review_issue',
        {
          ...issue.data,
          state: p.kind === 'dismiss' ? 'dismissed' : 'resolved',
          resolution_ref: json(p.evaluation),
          resolution_basis: p.kind === 'dismiss' ? p.basis : 'Current independent criterion recheck'
        },
        [],
        issue
      )
    } else if (p.kind === 'revoke') {
      const q = current(p.qualification, 'qualification')
      if (
        !p.reason.trim() ||
        !p.reviewer.trim() ||
        !p.evidenceRefs.length ||
        p.evidenceRefs.some((x) => !x.trim())
      )
        throw new Error('REVOCATION_BASIS_REQUIRED')
      result = save(
        'qualification_revocation',
        {
          qualification_ref: json(p.qualification),
          reason: p.reason,
          evidence_refs: p.evidenceRefs,
          reviewer: p.reviewer,
          cursor: '',
          complete: false
        },
        []
      )
      save(
        'qualification',
        { ...q.data, revoked: true, revocation_ref: json(refOf(result)) },
        [],
        q
      )
    } else if (p.kind === 'scan') {
      const revocation = current(p.revocation, 'qualification_revocation')
      if (!Number.isSafeInteger(p.limit) || p.limit < 1 || p.limit > 100)
        throw new Error('INVALID_SCAN_LIMIT')
      const all = ledger.snapshot(),
        qualification = ref(revocation.data.qualification_ref)
      const depends = (o: ManagedObject, seen = new Set<string>()): boolean => {
        if (seen.has(o.id)) return false
        seen.add(o.id)
        return o.scope_revision_refs.some(
          (r) => r.id === qualification.id || (ledger.get(r.id) && depends(ledger.get(r.id)!, seen))
        )
      }
      const remaining = all
        .filter(
          (o) => o.kind === 'evaluation' && o.id > String(revocation.data.cursor) && depends(o)
        )
        .sort((a, b) => a.id.localeCompare(b.id))
      const page = remaining.slice(0, p.limit)
      for (const e of page) {
        if (
          !all.some(
            (o) =>
              o.kind === 'qualification_impact' &&
              ref(o.data.evaluation_ref).id === e.id &&
              ref(o.data.revocation_ref).id === revocation.id
          )
        )
          save(
            'qualification_impact',
            {
              revocation_ref: json(refOf(revocation)),
              evaluation_ref: json(refOf(e)),
              delivery_refs: json(
                all
                  .filter(
                    (o) =>
                      o.kind === 'verification_delivery' && ref(o.data.evaluation_ref).id === e.id
                  )
                  .map(refOf)
              ),
              state: 'recheck_required'
            },
            []
          )
      }
      result = save(
        'qualification_revocation',
        {
          ...revocation.data,
          cursor: page.at(-1)?.id ?? revocation.data.cursor!,
          complete: remaining.length <= p.limit
        },
        [],
        revocation
      )
    } else if (p.kind === 'enter_delivery') {
      const e = passing(p.evaluation),
        c = current(p.commitment, 'commitment')
      if (e.data.commitment_id !== c.id || c.data.state !== 'verifying')
        throw new Error('DELIVERY_PHASE_REQUIRED')
      result = save('commitment', { ...c.data, state: 'delivering' }, c.scope_revision_refs, c)
    } else {
      const e = passing(p.evaluation),
        action = current(p.action, 'action')
      const spec = action.data.execution_spec as Record<string, Json>
      const receipt = action.data.receipt as Record<string, Json> | undefined
      if (
        spec?.kind !== 'deliver' ||
        (spec.target as Record<string, Json>)?.id !== e.data.commitment_id ||
        action.data.state !== 'confirmed' ||
        receipt?.stopped !== true
      )
        throw new Error('DELIVERY_RECEIPT_REQUIRED')
      result = save(
        'verification_delivery',
        {
          evaluation_ref: json(p.evaluation),
          action_ref: json(p.action),
          commitment_id: e.data.commitment_id!
        },
        [p.evaluation]
      )
    }
    const sequence =
      Number(db.prepare('SELECT sequence FROM sa_managed_meta WHERE singleton=1').get()!.sequence) +
      1
    db.prepare('UPDATE sa_managed_meta SET sequence=? WHERE singleton=1').run(sequence)
    db.prepare('INSERT INTO sa_managed_event VALUES(?,?)').run(
      sequence,
      JSON.stringify({ verification: p.kind, source: command.source, objects: changed })
    )
    db.exec('COMMIT')
    return refOf(result)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
