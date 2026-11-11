import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, lstatSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ManagedLedger } from './managed-ledger.ts'
import type { Json, ManagedObject, Ref } from '../protocol/managed-work.ts'
import type { OperationExecution, ContextEnvelope } from '../protocol/coordination.ts'
export const DELIVERY_EVIDENCE_POLICY = 'exact-tree-all7-local-dev@1'
export interface ContractPartition {
  commitment: Ref; acceptance: Ref; delivery: Ref; assignments: Ref[]
  businessCriteria: Ref[]; deliveryCriteria: Ref[]; operations: Ref[]
  candidateRoot: string; candidate: { path: string; sha256: string; mode: '100644' | '100755' }[]
  evidenceRefs: string[]
}
export interface PartitionApproval { operation: Ref; evidenceRefs: string[] }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const refs = (value: unknown) => value as Ref[]
const ref = (o: ManagedObject): Ref => ({ id: o.id, revision: o.revision })
export function verifyPartitionCandidate(plan: Pick<ContractPartition, 'candidateRoot' | 'candidate'>): void {
  if (!plan.candidate.length || realpathSync(plan.candidateRoot) !== plan.candidateRoot) throw Error('PARTITION_CANDIDATE_REQUIRED')
  for (const entry of plan.candidate) {
    const path = join(plan.candidateRoot, entry.path), stat = lstatSync(path)
    if (!entry.path || relative(plan.candidateRoot, path).startsWith('..') || realpathSync(path) !== path || !stat.isFile() || createHash('sha256').update(readFileSync(path)).digest('hex') !== entry.sha256 || (stat.mode & 0o111 ? '100755' : '100644') !== entry.mode) throw Error('PARTITION_CANDIDATE_CHANGED')
  }
}
/** A prior unresolved operation is retained. Only its approved successor scope can take its domain. */
export function partitionHandoff(ledger: ManagedLedger, operation: ManagedObject, scopes: Ref[]) {
  return ledger.snapshot('coordination_runtime_event').find(o => {
    const p = o.data.payload as any
    return ['contract_partition','verify_interrupted_handoff'].includes(String(o.data.event)) && p?.operations?.some((r: Ref) => same(r, ref(operation))) && scopes.some(r => same(r, p.after.acceptance)) && ledger.get(p.after.acceptance.id)?.revision === p.after.acceptance.revision
  })
}
type Transaction = {
  ledger: ManagedLedger
  current(r: Ref, kind?: string): ManagedObject
  save(kind: string, data: Record<string, Json>, scopes: Ref[], id?: string, previous?: ManagedObject): ManagedObject
  nativeFact(evidence: string, worker: Ref): { command: any; spec: any; observation: any }
}
/** Called only inside the existing host-token coordination transaction. No generic object revision. */
export function partitionContracts(tx: Transaction, plan: ContractPartition, approval: PartitionApproval): ManagedObject[] {
  const { ledger, current, save, nativeFact } = tx
  const work = current(plan.commitment, 'commitment'), acceptance = current(plan.acceptance, 'acceptance_contract'), delivery = current(plan.delivery, 'delivery_contract')
  if (work.data.control_state !== 'autonomous' || ['fulfilled','released','withdrawn','broken'].includes(String(work.data.state)) || !same(work.data.acceptance_contract, plan.acceptance) || !same(work.data.delivery_contract, plan.delivery) || !plan.evidenceRefs.length) throw Error('PARTITION_SCOPE_REQUIRED')
  const beforeCriteria = refs(acceptance.data.criterion_refs), combined = [...plan.businessCriteria, ...plan.deliveryCriteria]
  if (!plan.businessCriteria.length || !plan.deliveryCriteria.length || new Set(combined.map(r => r.id)).size !== combined.length || combined.length !== beforeCriteria.length || beforeCriteria.some(r => !combined.some(x => same(x, r)))) throw Error('PARTITION_REQUIREMENT_LOSS')
  combined.forEach(r => current(r, 'requirement'))
  if (refs(delivery.data.criterion_refs ?? []).length) throw Error('PARTITION_ALREADY_ASSIGNED')
  const intake = ledger.snapshot('coordination_intake').find(o => o.data.commitment_id === work.id)!
  current(ref(intake)); const assignments = ledger.snapshot('team_assignment').filter(o => o.data.commitment_id === work.id)
  if (!same(assignments.map(ref), plan.assignments)) throw Error('PARTITION_ASSIGNMENT_CHANGED')
  assignments.forEach(o => current(ref(o)))
  verifyPartitionCandidate(plan)
  const launches = ledger.snapshot('action').filter(o => (o.data.execution_spec as any)?.kind === 'dispatch')
  if (!launches.length || launches.some(o => (o.data.receipt as any)?.stopped !== true)) throw Error('PARTITION_LIVE_WRITER')
  const qaOperation = current(approval.operation, 'coordination_operation'), qaExecution = (qaOperation.data.executions as unknown as OperationExecution[])[0]
  if (!same(qaOperation.data.proposal, { kind: 'contract_partition_review', plan }) || qaOperation.data.state !== 'completed' || !qaExecution || qaExecution.kind !== 'native' || (qaOperation.data.executions as Json[]).length !== 1) throw Error('PARTITION_QA_REQUIRED')
  const qaAssignment = assignments.find(o => o.data.role === 'quality' && same(o.data.worker_ref, qaExecution.worker))
  if (!qaAssignment || assignments.some(o => o.data.role === 'implementation' && same(o.data.worker_ref, qaExecution.worker))) throw Error('PARTITION_QA_INDEPENDENCE')
  const envelope = current(qaExecution.context, 'context_envelope').data.envelope as unknown as ContextEnvelope
  const input = JSON.stringify({ managed_input: { request_id: qaExecution.requestId, assignment_revision: envelope.assignment.revision, payload_digest: envelope.digest }, text: envelope.text })
  const approved = approval.evidenceRefs.some(evidence => {
    const fact = nativeFact(evidence, qaExecution.worker), o = fact.observation
    if (fact.command.actionRef.id !== qaExecution.launch.id || o.kind !== 'turn-page' || o.threadId !== qaExecution.nativeSessionId) return false
    return o.page?.data?.some((turn: any) => {
      if (turn.status !== 'completed' || !turn.items?.some((i: any) => i.type === 'userMessage' && i.content?.some((c: any) => c.text === input))) return false
      try { const answer = JSON.parse(turn.items.filter((i: any) => i.type === 'agentMessage').at(-1)?.text); return answer.approved === true && same(answer.businessCriteria, plan.businessCriteria) && same(answer.deliveryCriteria, plan.deliveryCriteria) && typeof answer.reason === 'string' && answer.reason.trim() } catch { return false }
    })
  })
  if (!approved) throw Error('PARTITION_QA_REQUIRED')
  const unresolved = ledger.snapshot('coordination_operation').filter(o => o.data.state !== 'completed' && !partitionHandoff(ledger, o, [plan.acceptance]))
  if (!same(unresolved.map(ref), plan.operations)) throw Error('PARTITION_UNCOLLECTED_OPERATION')
  for (const operation of unresolved) {
    const executions = operation.data.executions as unknown as OperationExecution[], slots = operation.data.execution_slots as string[]
    if (!slots.length || slots.length !== executions.length || slots.some(slot => !executions.some(e => e.slot === slot))) throw Error('PARTITION_UNCOLLECTED_SLOT')
    for (const execution of executions) {
      if (execution.kind !== 'native') throw Error('PARTITION_NON_NATIVE_UNRESOLVED')
      assertInterruptedNative(ledger, execution)
    }
  }
  // Preserve every original criterion and requirement object. Only responsibility references move.
  const a = save(acceptance.kind, { ...acceptance.data, criterion_refs: plan.businessCriteria as unknown as Json }, acceptance.scope_revision_refs.filter(r => !plan.deliveryCriteria.some(x => same(x, r))), undefined, acceptance)
  const d = save(delivery.kind, { ...delivery.data, criterion_refs: plan.deliveryCriteria as unknown as Json, evidence_policy: DELIVERY_EVIDENCE_POLICY }, [...delivery.scope_revision_refs, ...plan.deliveryCriteria], undefined, delivery)
  const replace = (scopes: Ref[]) => scopes.map(r => same(r, plan.acceptance) ? ref(a) : same(r, plan.delivery) ? ref(d) : r)
  const w = save(work.kind, { ...work.data, acceptance_contract: ref(a) as unknown as Json, delivery_contract: ref(d) as unknown as Json }, replace(work.scope_revision_refs), undefined, work)
  const i = save(intake.kind, { ...intake.data, contract_ref: ref(a) as unknown as Json, delivery_ref: ref(d) as unknown as Json }, replace(intake.scope_revision_refs), undefined, intake)
  const team = assignments.map(o => save(o.kind, { ...o.data, criterion_refs: refs(o.data.criterion_refs).filter(r => !plan.deliveryCriteria.some(x => same(x, r))) as unknown as Json }, replace(o.scope_revision_refs).map(r => same(r, ref(intake)) ? ref(i) : r), undefined, o))
  const event = save('coordination_runtime_event', { event: 'contract_partition', payload: { before: { commitment: plan.commitment, acceptance: plan.acceptance, delivery: plan.delivery, assignments: plan.assignments }, after: { commitment: ref(w), acceptance: ref(a), delivery: ref(d), assignments: team.map(ref) }, operations: plan.operations, candidate: plan.candidate, candidateRoot: plan.candidateRoot, businessCriteria: plan.businessCriteria, deliveryCriteria: plan.deliveryCriteria, approval, status: 'Interrupted executions retained; successor responsibility on the same native threads, not business completion' } as unknown as Json, evidence_refs: plan.evidenceRefs }, [], 'contract-partition:' + work.id + ':' + plan.acceptance.revision)
  return [w, a, d, i, ...team, event]
}

export interface InterruptedVerificationHandoff {
  commitment: Ref; acceptance: Ref; delivery: Ref; assignments: Ref[]; operation: Ref
  candidateRoot: string; candidate: ContractPartition['candidate']; evidenceRefs: string[]
  completedDesignRefusal?: { qualityResult: Ref; hostRefusal: Ref }
}
function assertStoppedNative(ledger: ManagedLedger, execution: Extract<OperationExecution, { kind: 'native' }>) {
  const old = ledger.get(execution.launch.id)!, binding = ledger.snapshot('session_binding').find(o => same(o.data.worker_ref, execution.worker))
  if (!old || (old.data.receipt as any)?.stopped !== true || binding?.data.native_session_id !== execution.nativeSessionId || !ledger.eventEntries({ nativeStream: 'execution:' + execution.launch.id, nativeKind: 'process_exit' }).some(({ body }: any) => body.controlled?.command?.observation?.kind === 'process_exit' && same(body.controlled.command.actionRef, execution.launch) && same(body.controlled.command.observation.launchRef, execution.launch) && same(body.controlled.command.observation.receipt, old.data.receipt))) throw Error('PARTITION_WRITER_UNKNOWN')
}
function assertInterruptedNative(ledger: ManagedLedger, execution: Extract<OperationExecution, { kind: 'native' }>) {
  assertStoppedNative(ledger, execution)
  const context = ledger.get(execution.context.id)?.data.envelope as unknown as ContextEnvelope
  const text = JSON.stringify({ managed_input: { request_id: execution.requestId, assignment_revision: context.assignment.revision, payload_digest: context.digest }, text: context.text })
  const terminal = ledger.eventEntries({nativeKind:'turn-page',nativeThreadId:execution.nativeSessionId}).some(({ body }: any) => {
    const c = body.controlled?.command, observation = c?.observation
    if (c?.kind !== 'native' || observation?.kind !== 'turn-page' || observation.threadId !== execution.nativeSessionId) return false
    const observedAction = ledger.get(c.actionRef?.id), target = (observedAction?.data.execution_spec as any)?.target
    return same(target, execution.worker) && observation.page?.data?.some((t: any) => ['interrupted','failed'].includes(t.status) && t.items?.some((i: any) => i.type === 'userMessage' && i.content?.some((v: any) => v.text === text)))
  })
  if (!terminal) throw Error('PARTITION_NATIVE_OUTCOME_UNKNOWN')
}
/** A completed design refusal is not a completed verification operation. */
function assertDesignRefusal(tx: Transaction, plan: InterruptedVerificationHandoff, execution: Extract<OperationExecution, { kind: 'native' }>): number {
  const {ledger,current}=tx, proof=plan.completedDesignRefusal!
  const result=current(proof.qualityResult,'coordination_runtime_event'), refusal=current(proof.hostRefusal,'coordination_runtime_event')
  const payload=result.data.payload as any, denial=refusal.data.payload as any
  let answer: any
  try { answer=JSON.parse(payload.answer) } catch { throw Error('VERIFY_DESIGN_REFUSAL_PROOF_REQUIRED') }
  if(result.data.event!=='professional_result'||refusal.data.event!=='proposal_unknown'||payload.operationId!==plan.operation.id||payload.role!=='quality'||typeof payload.turnId!=='string'||!payload.turnId||payload.nativeSessionId!==execution.nativeSessionId||denial.operation!==plan.operation.id||denial.reason!=='Error: CRITERION_COVERAGE_REQUIRED'||answer.purpose!=='verification_design'||answer.intake_readiness!=='blocked'||answer.verdict!=='inconclusive') throw Error('VERIFY_DESIGN_REFUSAL_PROOF_REQUIRED')
  const claims=ledger.eventEntries({operationClaim:plan.operation.id})
  if(claims.length!==1) throw Error('VERIFY_DESIGN_REFUSAL_PROOF_REQUIRED')
  const claim=claims[0]!, resultEvent=ledger.eventEntries({runtimeEvent:'professional_result',afterSequence:claim.sequence}).find(({body}:any)=>same(body.refs,[proof.qualityResult])), refusalEvent=ledger.eventEntries({runtimeEvent:'proposal_unknown',afterSequence:claim.sequence}).find(({body}:any)=>same(body.refs,[proof.hostRefusal]))
  if(!resultEvent||!refusalEvent||refusalEvent.sequence<=resultEvent.sequence) throw Error('VERIFY_DESIGN_REFUSAL_PROOF_REQUIRED')
  const envelope=current(execution.context,'context_envelope').data.envelope as unknown as ContextEnvelope
  const text=JSON.stringify({managed_input:{request_id:execution.requestId,assignment_revision:envelope.assignment.revision,payload_digest:envelope.digest},text:envelope.text})
  const consumed=ledger.eventEntries({nativeStream:execution.stream,nativeKind:'input-consumed',afterSequence:claim.sequence}).some(({sequence,body}:any)=>{
    const c=body.controlled.command,p=c.observation.consumption
    return sequence<resultEvent.sequence&&same(c.actionRef,execution.launch)&&p.request_id===execution.requestId&&p.assignment_revision===envelope.assignment.revision&&p.payload_digest===envelope.digest&&p.session_identity?.native_session_id===execution.nativeSessionId&&p.turn_id===payload.turnId
  })
  const terminal=ledger.eventEntries({nativeStream:execution.stream,nativeTurnId:payload.turnId,afterSequence:claim.sequence}).some(({sequence,body}:any)=>{
    const c=body.controlled.command,o=c.observation
    return sequence<resultEvent.sequence&&same(c.actionRef,execution.launch)&&o.threadId===execution.nativeSessionId&&o.page.data.some((t:any)=>t.id===payload.turnId&&t.status==='completed'&&t.items?.some((i:any)=>i.type==='userMessage'&&i.content?.some((v:any)=>v.text===text))&&t.items.filter((i:any)=>i.type==='agentMessage').at(-1)?.text===payload.answer)
  })
  if(!consumed||!terminal) throw Error('VERIFY_DESIGN_REFUSAL_PROOF_REQUIRED')
  assertStoppedNative(ledger,execution)
  return claim.sequence
}
/** Fixed verify plan only: one interrupted QA input, and two collectors that were never issued. */
export function handoffInterruptedVerification(tx: Transaction, plan: InterruptedVerificationHandoff): ManagedObject[] {
  const { ledger, current, save } = tx
  const work = current(plan.commitment, 'commitment'), acceptance = current(plan.acceptance, 'acceptance_contract')
  current(plan.delivery, 'delivery_contract')
  if (work.data.control_state !== 'autonomous' || !['proposed','ready','working',...(plan.completedDesignRefusal?['verifying']:[])].includes(String(work.data.state)) || !same(work.data.acceptance_contract, plan.acceptance) || !same(work.data.delivery_contract, plan.delivery) || !plan.evidenceRefs.length) throw Error('VERIFY_HANDOFF_SCOPE_REQUIRED')
  const assignments = ledger.snapshot('team_assignment').filter(o => o.data.commitment_id === work.id)
  if (!same(assignments.map(ref), plan.assignments)) throw Error('PARTITION_ASSIGNMENT_CHANGED')
  assignments.forEach(o => current(ref(o)))
  verifyPartitionCandidate(plan)
  const operation = current(plan.operation, 'coordination_operation'), executions = operation.data.executions as unknown as OperationExecution[]
  if (operation.data.state !== 'running' || (operation.data.proposal as any)?.kind !== 'verify' || !same(operation.data.execution_slots, ['quality','collect:baseline','collect:candidate']) || executions.length !== 1 || executions[0]?.kind !== 'native' || executions[0].slot !== 'quality' || !refs(operation.data.semantic_refs).some(r => same(r, ref(acceptance)))) throw Error('VERIFY_HANDOFF_PLAN_REQUIRED')
  refs(operation.data.semantic_refs).forEach(r => current(r))
  const execution = executions[0]
  if (!assignments.some(o => o.data.role === 'quality' && same(o.data.worker_ref, execution.worker))) throw Error('VERIFY_HANDOFF_QUALITY_REQUIRED')
  const launches = ledger.snapshot('action').filter(o => (o.data.execution_spec as any)?.kind === 'dispatch')
  if (launches.some(o => (o.data.receipt as any)?.stopped !== true && !(plan.completedDesignRefusal && ledger.retiredNativeDomain(ref(o))))) throw Error('PARTITION_LIVE_WRITER')
  // No collector may have been planned outside this operation's binding. Such effects need their own reconciliation.
  const collectorWorkspaces = ledger.eventEntries({workspaceRole:'collector'}).flatMap(({body:event}: any) => { const c = event.controlled?.command; return c?.kind === 'workspace' && c.workspace.role === 'collector' ? [c.workspace] : [] })
  if (!collectorWorkspaces.some(w => w.resources.every((id: string) => (operation.data.domain_keys as string[]).includes('resource:' + id)))) throw Error('VERIFY_HANDOFF_COLLECTOR_DOMAIN_REQUIRED')
  const claimSequence=plan.completedDesignRefusal?assertDesignRefusal(tx,plan,execution):undefined
  const collectorSpecs=claimSequence===undefined?ledger.snapshot('action').map(o=>o.data.execution_spec):ledger.eventEntries({controlledPlanKind:'collect',afterSequence:claimSequence}).map(({body}:any)=>body.controlled.spec)
  const collectorActions = collectorSpecs.filter((spec:any) => {
    // Native thread/list RPC also uses collect, but targets a worker in its engineering workspace.
    // Any action addressing the verifier domain is conservatively an issued collector, even if its launch is malformed.
    return spec?.kind === 'collect' && refs(spec.scopeRefs ?? []).some(r => same(r, plan.acceptance)) && (ledger.get(spec.target?.id)?.kind === 'verification_context' || spec.purpose === 'collector' || collectorWorkspaces.some(w => w.id === spec.workspaceId || w.resources.some((id: string) => spec.resourceIds?.includes(id))))
  })
  if (collectorActions.length) throw Error('VERIFY_HANDOFF_COLLECTOR_ALREADY_ISSUED')
  if(!plan.completedDesignRefusal) assertInterruptedNative(ledger, execution)
  return [save('coordination_runtime_event', { event: 'verify_interrupted_handoff', payload: { after: { commitment: plan.commitment, acceptance: plan.acceptance, delivery: plan.delivery, assignments: plan.assignments }, operations: [plan.operation], candidateRoot: plan.candidateRoot, candidate: plan.candidate, unissuedSlots: ['collect:baseline','collect:candidate'], native: execution, ...(plan.completedDesignRefusal?{completedDesignRefusal:plan.completedDesignRefusal,claimSequence}:{}), status: plan.completedDesignRefusal?'QA design completed but coverage rejected before collectors; both slots never issued; original obligations pass to same-thread successor; no business completion':'QA interrupted and stopped; collectors never issued; same-thread successor required; no business completion' } as unknown as Json, evidence_refs: plan.evidenceRefs }, [], 'verify-handoff:' + operation.id + ':' + operation.revision)]
}
