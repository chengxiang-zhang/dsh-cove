import { handoffInterruptedVerification, type InterruptedVerificationHandoff, partitionContracts, partitionHandoff, type ContractPartition, type PartitionApproval } from './contract-partition.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ManagedLedger } from './managed-ledger.ts'
import { assertJson, assertRefs, type Json, type Ref, type ManagedObject } from '../protocol/managed-work.ts'
import { refOf, type HostSpec, type ProjectSpec, type PolicySpec, type ProfileSpec, type WorkerSpec,
  type CommitmentSpec, type AssignmentSpec, type QuestionSpec, type ProfessionalDecision, type ContextEnvelope,
  type ContextConsumption, type OperationClaim, type OperationExecution } from '../protocol/coordination.ts'

type Payload =
  | { kind: 'retire_interrupted'; commitmentId: string; evidenceRefs: string[] }
  | { kind: 'resume_for_amendment'; commitment: Ref; evidenceRefs: string[] }
  | { kind: 'amend'; commitment: Ref; input: CommitmentSpec; evidenceRefs: string[] }
  | { kind: 'team_handoff'; commitment: Ref; assignments: AssignmentSpec[] }
  | { kind: 'verify_interrupted_handoff'; plan: InterruptedVerificationHandoff }
  | { kind: 'partition_contract'; plan: ContractPartition; approval: PartitionApproval }
  | { kind: 'operation_claim'; input: OperationClaim }
  | { kind: 'operation_bind'; operation: Ref; execution: OperationExecution }
  | { kind: 'operation_complete'; operation: Ref; result: Json; evidenceRefs: string[] }
  | { kind: 'renew_profile'; profile: Ref; evidenceRefs: string[]; expiresAt: number }
  | { kind: 'runtime_event'; id: string; event: string; payload: Json; scopeRefs: Ref[]; evidenceRefs: string[] }
  | { kind: 'host'; input: HostSpec } | { kind: 'project'; input: ProjectSpec }
  | { kind: 'policy'; input: PolicySpec } | { kind: 'profile'; input: ProfileSpec }
  | { kind: 'worker'; input: WorkerSpec } | { kind: 'accept'; source: Ref; input: CommitmentSpec }
  | { kind: 'native_binding'; worker: Ref; evidenceRef: string; resume?: boolean; priorDomainEvidenceRef?: string }
  | { kind: 'team'; commitment: Ref; assignments: AssignmentSpec[] }
  | { kind: 'question'; input: QuestionSpec }
  | { kind: 'native_question'; question: Ref; evidenceRef: string }
  | { kind: 'decision'; input: ProfessionalDecision }
  | { kind: 'context'; input: ContextEnvelope }
  | { kind: 'consumed'; input: ContextConsumption }
  | { kind: 'team_review'; commitmentId: string; reviewer: Ref; assignments: Ref[]; evidenceRefs: string[]; verdict: 'pass' | 'fail' | 'inconclusive' }
  | { kind: 'observation'; commitmentId: string; observerRef: string; sourceRefs: Ref[]; summary: string; extensions: ManagedObject['extensions'] }
export interface CoordinationCommand { token: object; source: Ref; payload: Payload }
const authorities = new WeakMap<object, { ledger: ManagedLedger; source: Ref }>()

export class OperationDomainBusy extends Error {
  constructor(readonly operation: Ref) { super('OPERATION_DOMAIN_UNRESOLVED'); this.name = 'OperationDomainBusy' }
}

/** Composition-only. Possession of a source id or JSON payload never grants this writer. */
export function createCoordinationWriter(ledger: ManagedLedger, source: Ref) {
  assertRefs([source]); const token = Object.freeze({}), frozenSource = structuredClone(source)
  authorities.set(token, { ledger, source: frozenSource })
  return (payload: Payload): Ref[] => ledger.coordination({ token, source: frozenSource, payload })
}
const json = (value: unknown): Json => { assertJson(value); return value }
const ref = (value: unknown): Ref => value as Ref
const refs = (value: unknown): Ref[] => value as Ref[]
/** The ledger validates domain-absence proofs; a retired writer need not have a rewritten receipt. */
export function nativeWriterCeased(ledger: Pick<ManagedLedger, 'retiredNativeDomain'>, action: ManagedObject | undefined): boolean {
  return !!action && action.kind === 'action' && (action.data.execution_spec as any)?.kind === 'dispatch' && ((action.data.receipt as any)?.stopped === true || !!ledger.retiredNativeDomain({ id: action.id, revision: action.revision }))
}
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
function texts(value: unknown, nonempty = true): asserts value is string[] {
  if (!Array.isArray(value) || (nonempty && !value.length) || value.some(v => !text(v)) || new Set(value).size !== value.length) throw new Error('COORDINATION_TEXT_REQUIRED')
}
function requireText(...values: unknown[]): void { if (values.some(v => !text(v))) throw new Error('COORDINATION_TEXT_REQUIRED') }
function uniqueRefs(value: Ref[]): Ref[] {
  const found = new Map<string, Ref>()
  for (const r of value) { const old = found.get(r.id); if (old && old.revision !== r.revision) throw new Error('COORDINATION_SCOPE_CONFLICT'); found.set(r.id, r) }
  return [...found.values()]
}

export function coordinationScopes(ledger: Pick<ManagedLedger, 'snapshot'>, commitmentId: string): Ref[] {
  const intake = ledger.snapshot().find(o => o.kind === 'coordination_intake' && o.data.commitment_id === commitmentId)
  if (!intake) throw new Error('MANAGED_INTAKE_REQUIRED')
  return [refOf(intake), ...intake.scope_revision_refs]
}

type CoordinationRead = Pick<ManagedLedger, 'get' | 'snapshot' | 'events' | 'eventEntries'> & { applicability(id: string): string }
const sameRef = (a: Ref, b: Ref) => a.id === b.id && a.revision === b.revision

/** Generic Worker objects are declarations; only the exact host-registered revision is a seat. */
export function registeredWorker(ledger: CoordinationRead, worker: Ref): ManagedObject {
  const object = ledger.get(worker.id)
  if (!object || object.kind !== 'worker' || object.revision !== worker.revision || ledger.applicability(worker.id) !== 'usable') throw new Error('COORDINATION_STALE_REFERENCE')
  const registered = ledger.eventEntries({ workerRegistration: worker }).length > 0
  if (!registered) throw new Error('WORKER_REGISTRATION_REQUIRED')
  const host = object.scope_revision_refs.find(r => r.id === object.data.host_binding_ref && ledger.get(r.id)?.kind === 'host_binding')
  const profiles = refs(object.data.capability_profile_refs)
  if (!host || !profiles?.length || profiles.some(r => ledger.get(r.id)?.kind !== 'capability_profile' || !object.scope_revision_refs.some(s => sameRef(r, s)))) throw new Error('WORKER_REGISTRATION_REQUIRED')
  const projects = object.scope_revision_refs.filter(r => ledger.get(r.id)?.kind === 'project')
  if (!projects.length || projects.some(r => !refs(ledger.get(r.id)!.data.host_refs).some(h => sameRef(h, host)))) throw new Error('PROJECT_HOST_MISMATCH')
  return object
}

/** Live side-effect fence. Only this launch's explicit assignments supply ancestry;
 * unrelated assignments on a reused seat must not poison an otherwise scoped launch. */
export function managedLaunchScope(ledger: CoordinationRead, worker: Ref, scope: Ref[], requireAssignment = false): void {
  const assignments = ledger.snapshot('team_assignment').filter(o => o.kind === 'team_assignment' && o.data.applicable && ref(o.data.worker_ref)?.id === worker.id)
  if (!assignments.length && !requireAssignment) return
  registeredWorker(ledger, worker)
  const selected = assignments.filter(o => scope.some(r => r.id === o.id))
  if (!selected.length) throw new Error('MANAGED_LAUNCH_SCOPE_REQUIRED')
  for (const a of selected) {
    if (!sameRef(ref(a.data.worker_ref), worker) || ledger.applicability(a.id) !== 'usable' || [refOf(a), ...a.scope_revision_refs].some(r => !scope.some(s => sameRef(r, s)))) throw new Error('MANAGED_LAUNCH_SCOPE_REQUIRED')
  }
}

export function coordinationTransaction(db: DatabaseSync, ledger: ManagedLedger, command: CoordinationCommand): Ref[] {
  const authority = command && authorities.get(command.token)
  if (!authority || authority.ledger !== ledger || authority.source.id !== command.source.id || authority.source.revision !== command.source.revision) throw new Error('COORDINATION_HOST_REQUIRED')
  assertJson(command.payload as unknown)
  db.exec('BEGIN IMMEDIATE')
  try {
    const changed: ManagedObject[] = []
    const current = (r: Ref, kind?: string): ManagedObject => {
      assertRefs([r]); const o = ledger.get(r.id)
      if (!o || o.revision !== r.revision || (kind && o.kind !== kind) || ledger.applicability(o.id) !== 'usable') throw new Error('COORDINATION_STALE_REFERENCE')
      if (o.kind === 'capability_profile' && ledger.profileExpiresAt(o) <= Date.now()) throw new Error('PROFILE_EXPIRED')
      return o
    }
    const scopesFor = (id: string): Ref[] => {
      const scopes = coordinationScopes(ledger, id); scopes.forEach(r => current(r)); return scopes
    }
    const commitment = (id: string) => {
      const o = ledger.get(id)
      if (!o || o.kind !== 'commitment' || ['released', 'withdrawn', 'broken', 'fulfilled'].includes(String(o.data.state))) throw new Error('COMMITMENT_INACTIVE')
      if (o.data.control_state !== 'autonomous') throw new Error('CONTROL_LOST')
      return o
    }
    const save = (kind: string, data: Record<string, Json>, scopes: Ref[], id?: string, previous?: ManagedObject, extensions: ManagedObject['extensions'] = {}): ManagedObject => {
      const o: ManagedObject = { id: id ?? previous?.id ?? `${kind}:${randomUUID()}`, kind, revision: (previous?.revision ?? 0) + 1,
        data, scope_revision_refs: uniqueRefs(scopes), extensions }
      requireText(o.id); o.scope_revision_refs.forEach(r => { if (r.id === o.id) throw new Error('COORDINATION_SELF_SCOPE'); current(r) })
      ledger.validate(o)
      if (previous) {
        if (previous.kind !== kind || previous.id !== o.id) throw new Error('COORDINATION_KIND_CHANGED')
        db.prepare('UPDATE sa_managed_object SET revision=?,body_json=? WHERE id=?').run(o.revision, JSON.stringify(o), o.id)
      } else db.prepare('INSERT INTO sa_managed_object VALUES(?,?,?,?,0)').run(o.id, kind, o.revision, JSON.stringify(o))
      changed.push(o); return o
    }
    const bindingFor = (worker: Ref, assignment?: Ref) => {
      registeredWorker(ledger, worker)
      const binding = ledger.snapshot().find(o => o.kind === 'session_binding' && ref(o.data.worker_ref).id === worker.id)
      if (!binding) throw new Error('WORKER_BINDING_REQUIRED')
      current(refOf(binding)); current(ref(binding.data.profile_ref), 'capability_profile')
      const launch = ledger.get(ref(binding.data.launch_ref).id)
      const scope = (launch?.data.execution_spec as any)?.scopeRefs ?? []
      managedLaunchScope(ledger, worker, scope, true)
      if (assignment && !scope.some((r: Ref) => sameRef(r, assignment))) throw new Error('CONTEXT_ASSIGNMENT_MISMATCH')
      return binding
    }
    const nativeFact = (evidenceRef: string, worker: Ref) => {
      if (!/^native-event:[1-9]\d*$/.test(evidenceRef)) throw new Error('NATIVE_EVIDENCE_REQUIRED')
      const sequence = Number(evidenceRef.slice('native-event:'.length))
      const row = db.prepare('SELECT body_json FROM sa_managed_event WHERE sequence=?').get(sequence)
      const event = row ? JSON.parse(String(row.body_json)) : undefined
      const command = event?.controlled?.kind === 'host' ? event.controlled.command : undefined
      const action = command?.kind === 'native' ? ledger.get(command.actionRef?.id) : undefined
      const spec = action?.data.execution_spec as Record<string, Json> | undefined
      if (!action || action.kind !== 'action' || spec?.kind !== 'dispatch' || !spec.target || ref(spec.target).id !== worker.id || ref(spec.target).revision !== worker.revision) throw new Error('NATIVE_EVIDENCE_TARGET_MISMATCH')
      return { command, spec, observation: command.observation as Record<string, any> }
    }
    const p = command.payload
    let result: ManagedObject[] = []
    if (p.kind === 'verify_interrupted_handoff') {
      result = handoffInterruptedVerification({ ledger, current, save, nativeFact }, p.plan)
    } else if (p.kind === 'partition_contract') {
      result = partitionContracts({ ledger, current, save, nativeFact }, p.plan, p.approval)
    } else if (p.kind === 'operation_claim') {
      const input=p.input; requireText(input.id,input.inputRef); texts(input.domainKeys); texts(input.executionSlots,false); assertRefs(input.scopeRefs)
      input.scopeRefs.forEach(r=>current(r))
      const existing=ledger.get(input.id)
      if(existing) { if(existing.kind!=='coordination_operation'||JSON.stringify(existing.data.proposal)!==JSON.stringify(input.proposal)) throw new Error('OPERATION_IDENTITY_CONFLICT'); throw new OperationDomainBusy(refOf(existing)) }
      const conflict=ledger.snapshot('coordination_operation').find(o=>!['completed','superseded'].includes(String(o.data.state)) && !partitionHandoff(ledger, o, input.scopeRefs) && (o.data.domain_keys as string[]).some(key=>input.domainKeys.includes(key)))
      if(conflict) throw new OperationDomainBusy(refOf(conflict))
      result=[save('coordination_operation',{input_ref:input.inputRef,proposal:input.proposal,domain_keys:input.domainKeys,semantic_refs:json(input.scopeRefs),execution_slots:input.executionSlots,state:'running',executions:[],result:null,evidence_refs:[]},[],input.id)]
    } else if (p.kind === 'operation_bind') {
      const operation=current(p.operation,'coordination_operation'), execution=p.execution
      if(operation.data.state!=='running') throw new Error('OPERATION_NOT_RUNNING')
      refs(operation.data.semantic_refs).forEach(r=>current(r))
      requireText(execution.slot); if(!(operation.data.execution_slots as string[]).includes(execution.slot)) throw new Error('OPERATION_EXECUTION_SLOT_REQUIRED'); const all=operation.data.executions as unknown as OperationExecution[]
      const previous=all.find(e=>e.slot===execution.slot)
      if(previous) { if(JSON.stringify(previous)!==JSON.stringify(execution)) throw new Error('OPERATION_EXECUTION_CONFLICT'); result=[operation] }
      else {
        const domains=operation.data.domain_keys as string[]
        for (const prior of ledger.snapshot('coordination_operation')) {
          if (prior.id === operation.id || ['completed','superseded'].includes(String(prior.data.state)) || !(prior.data.domain_keys as string[]).some(key => domains.includes(key))) continue
          const handoff = partitionHandoff(ledger, prior, refs(operation.data.semantic_refs))
          if (!handoff) throw Error('OPERATION_DOMAIN_UNRESOLVED')
          if(execution.kind==='controlled' && (handoff.data.payload as any)?.readonlyQualityInterruption===true && (operation.data.proposal as any)?.kind==='verify' && ['collect:baseline','collect:candidate'].includes(execution.slot)){
            const action=current(execution.action,'action'),spec=action.data.execution_spec as any
            if(spec.kind!=='collect'||!Array.isArray(spec.resourceIds)||spec.resourceIds.some((id:string)=>(prior.data.domain_keys as string[]).includes('resource:'+id)))throw Error('READONLY_QA_COLLECTOR_DOMAIN_REQUIRED')
            continue
          }
          if (execution.kind === 'controlled' && handoff.data.event === 'verify_interrupted_handoff' && (operation.data.proposal as any)?.kind === 'verify' && ((handoff.data.payload as any).unissuedSlots as string[]).includes(execution.slot)) {
            const action = current(execution.action, 'action')
            if ((action.data.execution_spec as any)?.kind !== 'collect') throw Error('VERIFY_HANDOFF_COLLECTOR_REQUIRED')
            continue
          }
          const inherited = (prior.data.executions as unknown as OperationExecution[]).find(e => e.kind === 'native' && execution.kind === 'native' && sameRef(e.worker, execution.worker))
          if (execution.kind !== 'native' || !inherited || inherited.kind !== 'native' || inherited.nativeSessionId !== execution.nativeSessionId) throw Error('PARTITION_SAME_NATIVE_THREAD_REQUIRED')
        }
        const launch=execution.kind==='native'?current(execution.launch,'action'):current(execution.action,'action')
        const spec=launch.data.execution_spec as any
        if(execution.kind==='controlled' && (launch.data.state!=='planned'||launch.data.receipt)) throw new Error('OPERATION_ACTION_ALREADY_STARTED')
        if(!spec || !Array.isArray(spec.resourceIds) || !spec.resourceIds.length || spec.resourceIds.some((id:string)=>!domains.includes('resource:'+id))) throw new Error('OPERATION_RESOURCE_MISMATCH')
        if(execution.kind==='native') {
          const context=current(execution.context,'context_envelope').data.envelope as unknown as ContextEnvelope
          const binding=bindingFor(execution.worker,context.assignment)
          if(!domains.includes('seat:'+execution.worker.id)||!sameRef(context.worker,execution.worker)||execution.requestId!==operation.id+':input:'+execution.slot||!sameRef(ref(binding.data.launch_ref),execution.launch)||execution.stream!==binding.data.stream||execution.nativeSessionId!==binding.data.native_session_id) throw new Error('OPERATION_NATIVE_BINDING_MISMATCH')
        }
        result=[save(operation.kind,{...operation.data,executions:json([...all,execution])},[],undefined,operation)]
      }
    } else if (p.kind === 'operation_complete') {
      const operation=current(p.operation,'coordination_operation'), executions=operation.data.executions as unknown as OperationExecution[]
      texts(p.evidenceRefs,false)
      if(operation.data.state!=='running'||!executions.length||!(operation.data.execution_slots as string[]).length||(operation.data.execution_slots as string[]).some(slot=>!executions.some(e=>e.slot===slot))) throw new Error('OPERATION_COMPLETION_PROOF_REQUIRED')
      for(const execution of executions) {
        if(execution.kind==='controlled') {
          const action=ledger.get(execution.action.id), receipt=action?.data.receipt as any
          if(!action||action.kind!=='action'||action.revision<execution.action.revision||!receipt||receipt.stopped!==true||!['confirmed','failed'].includes(receipt.status)) throw new Error('OPERATION_CONTROLLED_OUTCOME_UNKNOWN')
        } else {
          const context=ledger.get(execution.context.id), envelope=context?.data.envelope as unknown as ContextEnvelope
          if(!context||context.revision!==execution.context.revision||!envelope) throw new Error('OPERATION_CONTEXT_MISMATCH')
          const text=JSON.stringify({managed_input:{request_id:execution.requestId,assignment_revision:envelope.assignment.revision,payload_digest:envelope.digest},text:envelope.text})
          const intent=ledger.eventEntries({nativeStream:execution.stream,nativeKind:'input-intent'}).some(({body}:any)=>{const c=body.controlled?.command,i=c?.observation?.input;return c?.actionRef?.id===execution.launch.id && c.observation.kind==='input-intent' && i?.request_id===execution.requestId && i.assignment_revision===envelope.assignment.revision && i.payload_digest===envelope.digest && i.text===envelope.text})
          const completed=intent&&p.evidenceRefs.some(evidence=>{
            const fact=nativeFact(evidence,execution.worker), observation=fact.observation
            if(observation.kind!=='turn-page'||observation.threadId!==execution.nativeSessionId||!Array.isArray(observation.page?.data)) return false
            return observation.page.data.some((turn:any)=>turn.status==='completed' && typeof turn.startedAt==='number' && turn.items?.some((item:any)=>item.type==='userMessage'&&item.content?.some((c:any)=>c.type==='text'&&c.text===text)))
          })
          if(!completed) throw new Error('OPERATION_NATIVE_OUTCOME_UNKNOWN')
        }
      }
      result=[save(operation.kind,{...operation.data,state:'completed',result:p.result,evidence_refs:p.evidenceRefs},[],undefined,operation)]
    } else if (p.kind === 'runtime_event') {
      requireText(p.id, p.event); assertRefs(p.scopeRefs); texts(p.evidenceRefs, false)
      if (Buffer.byteLength(JSON.stringify(p.payload)) > 1048576) throw new Error('RUNTIME_RECORD_TOO_LARGE')
      const old = ledger.get(p.id), data = { event: p.event, payload: p.payload, evidence_refs: p.evidenceRefs }
      if (old) { if (old.kind !== 'coordination_runtime_event' || JSON.stringify(old.data) !== JSON.stringify(data)) throw new Error('RUNTIME_EVENT_CONFLICT'); result = [old] }
      else result = [save('coordination_runtime_event', data, p.scopeRefs, p.id)]
    } else if (p.kind === 'host') {
      requireText(p.input.id, p.input.authority); texts(p.input.evidenceRefs)
      result = [save('host_binding', { authority: p.input.authority, evidence_refs: p.input.evidenceRefs }, [], p.input.id)]
    } else if (p.kind === 'project') {
      const s = p.input; requireText(s.id, s.intent, s.repositoryIdentity); assertRefs(s.sourceRefs); assertRefs(s.hosts)
      if (!s.hosts.length || !s.sourceRefs.length) throw new Error('PROJECT_SCOPE_REQUIRED')
      s.hosts.forEach(r => current(r, 'host_binding'))
      result = [save('project', { intent: s.intent, repository_identity: s.repositoryIdentity, host_refs: json(s.hosts), source_refs: json(s.sourceRefs) }, s.hosts, s.id)]
    } else if (p.kind === 'policy') {
      const s = p.input; requireText(s.id)
      if (!Array.isArray(s.roles) || !s.roles.length || new Set(s.roles.map(r => r.name)).size !== s.roles.length) throw new Error('INVALID_PROFESSIONAL_POLICY')
      for (const r of s.roles) { requireText(r.name); texts(r.independentOf, false); if (typeof r.required !== 'boolean' || r.independentOf.some(other => other === r.name || !s.roles.some(v => v.name === other))) throw new Error('INVALID_PROFESSIONAL_POLICY') }
      result = [save('professional_policy', { roles: json(s.roles) }, [], s.id)]
    } else if (p.kind === 'profile') {
      const s = p.input; requireText(s.id); texts(s.capabilities); texts(s.evidenceRefs); texts(s.limitations, false)
      if (!Number.isSafeInteger(s.expiresAt) || s.expiresAt <= Date.now()) throw new Error('PROFILE_EXPIRED')
      result = [save('capability_profile', { capabilities: s.capabilities, evidence_refs: s.evidenceRefs, expires_at: s.expiresAt, limitations: s.limitations }, [], s.id)]
    } else if (p.kind === 'renew_profile') {
      assertRefs([p.profile]); texts(p.evidenceRefs)
      const profile = ledger.get(p.profile.id)
      if (!profile || profile.kind !== 'capability_profile' || profile.revision !== p.profile.revision || profile.data.revoked === true || !Number.isSafeInteger(p.expiresAt) || p.expiresAt <= Date.now() || p.expiresAt > Date.now()+1800000) throw new Error('PROFILE_RENEWAL_DENIED')
      if (!ledger.eventEntries({profileRegistration:p.profile}).length) throw new Error('PROFILE_HOST_REGISTRATION_REQUIRED')
      const id='profile-qualification:'+profile.id+'@'+profile.revision, previous=ledger.get(id)
      result=[save('profile_qualification',{profile_ref:json(p.profile),evidence_refs:p.evidenceRefs,expires_at:p.expiresAt},[],id,previous)]
    } else if (p.kind === 'worker') {
      const s = p.input; requireText(s.id, s.engineRef, s.runtimeNamespace)
      current(s.host, 'host_binding'); current(s.profile, 'capability_profile'); assertRefs(s.projects)
      if (!s.projects.length) throw new Error('PROJECT_SCOPE_REQUIRED')
      for (const r of s.projects) { const project = current(r, 'project'); if (!refs(project.data.host_refs).some(h => h.id === s.host.id && h.revision === s.host.revision)) throw new Error('PROJECT_HOST_MISMATCH') }
      const worker = save('worker', { intent: 'Professional seat', capability_profile_refs: json([s.profile]), engine_ref: s.engineRef, host_binding_ref: s.host.id, runtime_namespace: s.runtimeNamespace, epoch: 1 }, [s.host, s.profile, ...s.projects], s.id)
      result = [worker]
    } else if (p.kind === 'native_binding') {
      const worker = registeredWorker(ledger, p.worker), fact = nativeFact(p.evidenceRef, p.worker), binding = fact.observation.binding, identity = binding?.identity
      if (fact.observation.kind !== 'binding' || !identity || identity.host_ref !== worker.data.host_binding_ref || identity.engine_ref !== worker.data.engine_ref || identity.runtime_namespace !== worker.data.runtime_namespace || !text(identity.native_session_id) || !binding.ref || binding.launchRef?.id !== fact.command.actionRef.id) throw new Error('NATIVE_BINDING_MISMATCH')
      assertRefs([binding.ref, binding.launchRef])
      managedLaunchScope(ledger, p.worker, refs(fact.spec?.scopeRefs), true)
      const host = current(worker.scope_revision_refs.find(r => ledger.get(r.id)?.kind === 'host_binding')!, 'host_binding')
      const projects = worker.scope_revision_refs.filter(r => ledger.get(r.id)?.kind === 'project')
      const profile = current(refs(worker.data.capability_profile_refs)[0]!, 'capability_profile')
      const previous = ledger.snapshot().find(o => o.kind === 'session_binding' && ref(o.data.worker_ref).id === worker.id)
      if (previous) {
        if (!p.resume || !sameRef(ref(previous.data.worker_ref), p.worker) || previous.data.native_session_id !== identity.native_session_id || previous.data.engine_ref !== identity.engine_ref || previous.data.runtime_namespace !== identity.runtime_namespace || ref(previous.data.host_ref).id !== host.id) throw new Error('EXPLICIT_HANDOFF_REQUIRED')
        const oldLaunch = ledger.get(ref(previous.data.launch_ref).id)
        if (!oldLaunch || oldLaunch.id === binding.launchRef.id) throw new Error('OLD_NATIVE_WRITER_CESSATION_REQUIRED')
        if ((oldLaunch.data.receipt as any)?.stopped !== true) {
          if (!p.priorDomainEvidenceRef) throw new Error('OLD_NATIVE_WRITER_CESSATION_REQUIRED')
          const proof = nativeFact(p.priorDomainEvidenceRef,p.worker), observation = proof.observation, oldSpec = oldLaunch.data.execution_spec as any
          if (observation.kind !== 'domain_absence' || proof.command.stream !== 'execution:'+oldLaunch.id || !sameRef(proof.command.actionRef,refOf(oldLaunch)) || !sameRef(observation.launchRef,refOf(oldLaunch)) || observation.executionDigest !== createHash('sha256').update(JSON.stringify(oldSpec)).digest('hex') || observation.runtimeRoot !== identity.runtime_namespace || observation.processPolicy !== 'single' || oldSpec.processPolicy !== 'single' || oldSpec.workspaceId !== fact.spec.workspaceId || Number(fact.spec.epoch) <= Number(oldSpec.epoch) || !Number.isSafeInteger(observation.observedAt) || observation.observedAt > Date.now() || Date.now()-observation.observedAt > 60000 || Number(p.priorDomainEvidenceRef.slice(13)) >= Number(p.evidenceRef.slice(13))) throw new Error('OLD_NATIVE_WRITER_CESSATION_REQUIRED')
        }
      } else if (p.resume) throw new Error('WORKER_BINDING_REQUIRED')
      if (ledger.snapshot().some(o => o.kind === 'session_binding' && o.id !== previous?.id && ref(o.data.host_ref).id === host.id && o.data.engine_ref === identity.engine_ref && o.data.runtime_namespace === identity.runtime_namespace && o.data.native_session_id === identity.native_session_id)) throw new Error('EXPLICIT_HANDOFF_REQUIRED')
      result = [save('session_binding', { worker_ref: json(p.worker), host_ref: json(refOf(host)), profile_ref: json(refOf(profile)), project_refs: json(projects), engine_ref: identity.engine_ref, runtime_namespace: identity.runtime_namespace, native_session_id: identity.native_session_id, native_binding_ref: json(binding.ref), native_evidence_ref: p.evidenceRef, launch_ref: json(binding.launchRef), stream: fact.command.stream }, [p.worker], undefined, previous)]
    } else if (p.kind === 'retire_interrupted') {
      commitment(p.commitmentId); texts(p.evidenceRefs)
      const intake = coordinationScopes(ledger, p.commitmentId)[0]!
      for (const operation of ledger.snapshot('coordination_operation').filter(o => o.data.state === 'running' && refs(o.data.semantic_refs).some(r => r.id === intake.id))) {
        const executions = operation.data.executions as unknown as OperationExecution[]
        for (const execution of executions) {
          const actionRef = execution.kind === 'native' ? execution.launch : execution.action
          const action = ledger.get(actionRef.id)
          const stopped = (action?.data.receipt as any)?.stopped === true || (execution.kind === 'native' && !!ledger.retiredNativeDomain(actionRef))
          if (!action || !stopped || (execution.kind === 'controlled' && (action.data.execution_spec as any)?.kind !== 'collect')) throw Error('INTERRUPTED_EFFECT_UNRESOLVED')
        }
        result.push(save(operation.kind, { ...operation.data, state: 'superseded', result: { status: 'interrupted', reason: 'Cessation observed; retained artifacts require fresh diagnosis and validation, not a successful old result' }, evidence_refs: p.evidenceRefs }, [], undefined, operation))
      }
    } else if (p.kind === 'resume_for_amendment') {
      const work = current(p.commitment, 'commitment'); texts(p.evidenceRefs)
      if (work.data.control_state !== 'paused' || ['fulfilled','released','withdrawn','broken'].includes(String(work.data.state))) throw Error('AMENDMENT_SCOPE_REQUIRED')
      const workers = ledger.snapshot('team_assignment').filter(o => o.data.commitment_id === work.id).map(o => ref(o.data.worker_ref)?.id)
      if (ledger.snapshot('action').some(o => workers.includes((o.data.execution_spec as any)?.target?.id) && (o.data.execution_spec as any)?.kind === 'dispatch' && !nativeWriterCeased(ledger, o))) throw Error('OLD_NATIVE_WRITER_CESSATION_REQUIRED')
      const { previous_control_state, pause_reason, control_evidence_refs, ...data } = work.data
      result = [save(work.kind, { ...data, control_state: 'autonomous' }, work.scope_revision_refs, undefined, work)]
    } else if (p.kind === 'accept' || p.kind === 'amend') {
      const s = p.input
      const previous = p.kind === 'amend' ? current(p.commitment, 'commitment') : undefined
      if (p.kind === 'accept' && (p.source.id !== command.source.id || p.source.revision !== command.source.revision)) throw new Error('INTAKE_SOURCE_NOT_AUTHENTICATED')
      if (previous) {
        if (previous.id !== s.id || previous.data.control_state !== 'paused' || ['fulfilled','released','withdrawn','broken','delivering'].includes(String(previous.data.state)) || previous.data.boundary !== s.boundary || previous.data.accountable !== s.accountable || JSON.stringify(previous.data.project_refs) !== JSON.stringify(s.projects)) throw Error('AMENDMENT_SCOPE_REQUIRED')
        if (p.kind !== 'amend') throw Error('AMENDMENT_SCOPE_REQUIRED')
        texts(p.evidenceRefs)
        const workers = ledger.snapshot('team_assignment').filter(o => o.data.commitment_id === previous.id).map(o => ref(o.data.worker_ref)?.id).filter(Boolean)
        if (ledger.snapshot('action').some(o => workers.includes((o.data.execution_spec as any)?.target?.id) && (o.data.execution_spec as any)?.kind === 'dispatch' && !nativeWriterCeased(ledger, o))) throw Error('OLD_NATIVE_WRITER_CESSATION_REQUIRED')
        // Cessation retires an interrupted computation, never certifies its result.
        // Its artifacts stay in the original workspace and require fresh independent validation.
        for (const operation of ledger.snapshot('coordination_operation').filter(o => o.data.state === 'running' && refs(o.data.semantic_refs).some(r => r.id === coordinationScopes(ledger, previous.id)[0]!.id))) {
          for (const execution of operation.data.executions as unknown as OperationExecution[]) {
            const action = ledger.get(execution.kind === 'native' ? execution.launch.id : execution.action.id)
            if (!action || ((action.data.receipt as any)?.stopped !== true && !(execution.kind === 'native' && nativeWriterCeased(ledger, action))) || (execution.kind === 'controlled' && (action.data.execution_spec as any)?.kind !== 'collect')) throw Error('OPERATION_CONTROLLED_OUTCOME_UNKNOWN')
          }
          save(operation.kind, { ...operation.data, state: 'superseded', result: { status: 'superseded', reason: 'Authenticated amendment after writer cessation; no acceptance verdict' }, evidence_refs: p.evidenceRefs }, [], undefined, operation)
        }
      }
      requireText(s.id, s.intent, s.boundary, s.accountable); assertRefs(s.requirements); assertRefs(s.projects)
      if (!s.requirements.length || !s.projects.length || !Number.isSafeInteger(s.nextReviewAt) || s.nextReviewAt <= Date.now()) throw new Error('INTAKE_SCOPE_REQUIRED')
      s.requirements.forEach(r => current(r, 'requirement')); s.projects.forEach(r => current(r, 'project')); current(s.policy, 'professional_policy')
      for (const [r, kind] of [[s.acceptanceContract, 'acceptance_contract'], [s.deliveryContract, 'delivery_contract']] as const) {
        const contract = current(r, kind)
        if (JSON.stringify(refs(contract.data.requirement_refs)) !== JSON.stringify(s.requirements)) throw new Error('CONTRACT_REQUIREMENTS_MISMATCH')
      }
      const scopes = [...s.requirements, s.acceptanceContract, s.deliveryContract, ...s.projects, s.policy]
      const authenticatedSource = p.kind === 'accept' ? p.source : command.source
      const work = save('commitment', { intent: s.intent, work_kind: 'task', type_ref: 'core/task@2', wish_refs: [], requirement_refs: json(s.requirements), source_refs: json([authenticatedSource]), project_refs: json(s.projects), requirement_revision: Number(previous?.data.requirement_revision ?? 0) + 1, acceptance_contract: json(s.acceptanceContract), delivery_contract: json(s.deliveryContract), boundary: s.boundary, accountable: s.accountable, next_review_at: s.nextReviewAt, state: 'proposed', control_state: 'autonomous' }, scopes, s.id, previous)
      const oldIntake = previous ? ledger.snapshot('coordination_intake').find(o => o.data.commitment_id === previous.id) : undefined
      save('coordination_intake', { commitment_id: work.id, source_ref: json(authenticatedSource), policy_ref: json(s.policy), requirement_refs: json(s.requirements), contract_ref: json(s.acceptanceContract), delivery_ref: json(s.deliveryContract), project_refs: json(s.projects) }, scopes, undefined, oldIntake)
      result = [work]
    } else if (p.kind === 'team' || p.kind === 'team_handoff') {
      const work = current(p.commitment, 'commitment'); commitment(work.id)
      const scopes = scopesFor(work.id), intake = current(scopes[0]!, 'coordination_intake'), policy = current(ref(intake.data.policy_ref), 'professional_policy')
      const roles = policy.data.roles as unknown as PolicySpec['roles'], specs = p.assignments
      if (!Array.isArray(specs) || specs.length !== roles.length || new Set(specs.map(a => a.role)).size !== roles.length || roles.some(r => !specs.some(a => a.role === r.name))) throw new Error('RESPONSIBILITY_COVERAGE')
      for (const s of specs) {
        requireText(s.role, s.basis); texts(s.deliverables, false); texts(s.consumers, false); texts(s.dependencies, false); assertRefs(s.criteria)
        if (typeof s.applicable !== 'boolean' || typeof s.combinationBasis !== 'string') throw new Error('INVALID_ASSIGNMENT')
        const role = roles.find(r => r.name === s.role)!
        if (!s.applicable) { if (role.required || s.worker !== null || s.deliverables.length || s.criteria.length) throw new Error('REQUIRED_RESPONSIBILITY'); continue }
        if (!s.worker || !s.deliverables.length || !s.consumers.length || !s.criteria.length) throw new Error('ASSIGNMENT_DELIVERY_MAP_REQUIRED')
        if ([...s.dependencies, ...s.consumers].some(r => !specs.some(a => a.role === r && a.applicable))) throw new Error('ASSIGNMENT_CONSUMER_MISSING')
        const worker = registeredWorker(ledger, s.worker), profile = current(refs(worker.data.capability_profile_refs)[0]!, 'capability_profile')
        const binding = ledger.snapshot().find(o => o.kind === 'session_binding' && ref(o.data.worker_ref).id === s.worker!.id)
        // A new assignment cannot adopt an already-running launch lacking its exact ref.
        if (binding && (p.kind !== 'team_handoff' || !nativeWriterCeased(ledger, ledger.get(ref(binding.data.launch_ref).id)))) throw new Error('EXPLICIT_HANDOFF_REQUIRED')
        if (!(profile.data.capabilities as string[]).includes(s.role)) throw new Error('ROLE_CAPABILITY_MISSING')
        if (refs(intake.data.project_refs).some(r => !worker.scope_revision_refs.some(b => b.id === r.id && b.revision === r.revision))) throw new Error('WORKER_PROJECT_MISMATCH')
        const criteria = refs(current(ref(intake.data.contract_ref)).data.criterion_refs)
        if (s.criteria.some(c => !criteria.some(r => r.id === c.id && r.revision === c.revision))) throw new Error('CRITERION_MAP_MISMATCH')
        if (role.independentOf.some(other => specs.some(a => a.role === other && a.applicable && a.worker?.id === s.worker!.id))) throw new Error('INDEPENDENCE_CONFLICT')
        if (specs.filter(a => a.applicable && a.worker?.id === s.worker!.id).length > 1 && !s.combinationBasis.trim()) throw new Error('COMBINATION_BASIS_REQUIRED')
      }
      const visited = new Set<string>(), active = new Set<string>()
      const requiredCriteria = refs(current(ref(intake.data.contract_ref)).data.criterion_refs)
      if (!requiredCriteria.length || requiredCriteria.some(r => !specs.some(s => s.applicable && s.criteria.some(c => c.id === r.id && c.revision === r.revision)))) throw new Error('TEAM_CRITERIA_COVERAGE_REQUIRED')
      const visit = (role: string) => { if (active.has(role)) throw new Error('ASSIGNMENT_DEPENDENCY_CYCLE'); if (visited.has(role)) return; active.add(role); for (const d of specs.find(a => a.role === role)!.dependencies) visit(d); active.delete(role); visited.add(role) }
      specs.forEach(s => visit(s.role))
      for (const s of specs) {
        const previous = ledger.snapshot().find(o => o.kind === 'team_assignment' && o.data.commitment_id === work.id && o.data.role === s.role)
        if (previous && (p.kind !== 'team_handoff' || ledger.applicability(previous.id) === 'usable' || JSON.stringify(previous.data.worker_ref) !== JSON.stringify(s.worker))) throw new Error('EXPLICIT_HANDOFF_REQUIRED')
        result.push(save('team_assignment', { commitment_id: work.id, policy_ref: json(refOf(policy)), role: s.role, applicable: s.applicable, basis: s.basis, worker_ref: json(s.worker), binding_ref: null, deliverables: s.deliverables, consumers: s.consumers, criterion_refs: json(s.criteria), dependencies: s.dependencies, combination_basis: s.combinationBasis, state: s.applicable ? 'planned' : 'closed' }, [...scopes, ...(s.worker ? [s.worker] : [])], undefined, previous))
      }
    } else if (p.kind === 'question') {
      const s = p.input; commitment(s.commitmentId); const scopes = scopesFor(s.commitmentId), assignment = current(s.assignment, 'team_assignment')
      if (assignment.data.commitment_id !== s.commitmentId || ref(assignment.data.worker_ref)?.id !== s.worker.id) throw new Error('QUESTION_ASSIGNMENT_MISMATCH')
      const binding = bindingFor(s.worker), fact = nativeFact(s.nativeEvidenceRef, s.worker), native = fact.observation.request
      requireText(s.question, s.nativeRequestRef); texts(s.evidenceRefs)
      if (fact.command.stream !== binding.data.stream || fact.observation.kind !== 'request' || native?.ref?.id !== s.nativeRequestRef || native.threadId !== binding.data.native_session_id || native.state !== 'pending' || native.params?.arguments?.question !== s.question || native.params?.tool !== 'ask') throw new Error('NATIVE_QUESTION_MISMATCH')
      if (!Number.isSafeInteger(s.nextReviewAt) || s.nextReviewAt <= Date.now()) throw new Error('QUESTION_REVIEW_REQUIRED')
      const old = ledger.snapshot().find(o => o.kind === 'semantic_question' && o.data.native_request_ref === s.nativeRequestRef && ref(o.data.worker_ref).id === s.worker.id)
      if (old) { if (old.data.question !== s.question || old.data.commitment_id !== s.commitmentId) throw new Error('QUESTION_IDENTITY_CONFLICT'); result = [old] }
      else result = [save('semantic_question', { commitment_id: s.commitmentId, assignment_ref: json(s.assignment), worker_ref: json(s.worker), native_request_ref: s.nativeRequestRef, question: s.question, evidence_refs: s.evidenceRefs, next_review_at: s.nextReviewAt, native_state: 'pending', native_reason: '', state: 'pending', decision_ref: null, response_ref: null, native_evidence_ref: s.nativeEvidenceRef }, [...scopes, s.assignment])]
    } else if (p.kind === 'native_question') {
      const q = current(p.question, 'semantic_question'), fact = nativeFact(p.evidenceRef, ref(q.data.worker_ref)), native = fact.observation.request
      const binding = bindingFor(ref(q.data.worker_ref))
      if (fact.command.stream !== binding.data.stream || fact.observation.kind !== 'request' || native?.ref?.id !== q.data.native_request_ref || native.threadId !== binding.data.native_session_id || !['pending', 'cleared', 'unknown'].includes(native.state)) throw new Error('INVALID_NATIVE_QUESTION_STATE')
      result = [save(q.kind, { ...q.data, native_state: native.state, native_reason: native.reason ?? '', native_evidence_ref: p.evidenceRef }, q.scope_revision_refs, undefined, q)]
    } else if (p.kind === 'decision') {
      const s = p.input
      if (!['technical_answer', 'engineering_refinement'].includes(s.kind)) throw new Error('PROFESSIONAL_DECISION_KIND')
      commitment(s.commitmentId); const scopes = scopesFor(s.commitmentId), q = current(s.question, 'semantic_question')
      bindingFor(s.reviewer); requireText(s.conclusion); texts(s.evidenceRefs); texts(s.alternatives); assertRefs(s.scopeRefs)
      if (q.data.commitment_id !== s.commitmentId || q.data.state === 'answered') throw new Error('QUESTION_NOT_PENDING')
      if (!ledger.snapshot().some(o => o.kind === 'team_assignment' && o.data.commitment_id === s.commitmentId && o.data.applicable && ref(o.data.worker_ref).id === s.reviewer.id && ledger.applicability(o.id) === 'usable')) throw new Error('DECISION_REVIEWER_NOT_ASSIGNED')
      for (const r of s.scopeRefs) current(r)
      if (!scopes.some(r => s.scopeRefs.some(s => s.id === r.id && s.revision === r.revision) && ledger.get(r.id)?.kind === 'acceptance_contract')) throw new Error('DECISION_CONTRACT_REQUIRED')
      result = [save('professional_decision', { commitment_id: s.commitmentId, question_ref: json(s.question), reviewer_ref: json(s.reviewer), kind: s.kind, conclusion: s.conclusion, evidence_refs: s.evidenceRefs, alternatives: s.alternatives }, [...scopes, s.reviewer, ...s.scopeRefs])]
    } else if (p.kind === 'context') {
      const s = p.input; commitment(s.commitmentId); const scopes = scopesFor(s.commitmentId); bindingFor(s.worker, s.assignment)
      const assignment = current(s.assignment, 'team_assignment')
      if (assignment.data.commitment_id !== s.commitmentId || !sameRef(ref(assignment.data.worker_ref), s.worker) || !s.semanticRefs.some(r => sameRef(r, s.assignment))) throw new Error('CONTEXT_ASSIGNMENT_MISMATCH')
      assertRefs(s.semanticRefs); texts(s.audience); texts(s.hardConstraints); texts(s.failedMethods, false); texts(s.nativeContextBlindSpots, false); requireText(s.purpose, s.compilerVersion, s.templateVersion, s.text)
      if (s.digest !== createHash('sha256').update(s.text).digest('hex') || scopes.some(r => !s.semanticRefs.some(v => v.id === r.id && v.revision === r.revision))) throw new Error('CONTEXT_SCOPE_INCOMPLETE')
      result = [save('context_envelope', { envelope: json(s) }, [...s.semanticRefs, s.worker])]
    } else if (p.kind === 'consumed') {
      const s = p.input, ctx = current(s.context, 'context_envelope'), envelope = ctx.data.envelope as unknown as ContextEnvelope, binding = bindingFor(s.worker, envelope.assignment)
      const assignment = current(envelope.assignment, 'team_assignment')
      commitment(envelope.commitmentId)
      if (assignment.data.commitment_id !== envelope.commitmentId || !sameRef(ref(assignment.data.worker_ref), envelope.worker) || !envelope.semanticRefs.some(r => sameRef(r, envelope.assignment)) || s.assignmentRevision !== envelope.assignment.revision) throw new Error('CONTEXT_ASSIGNMENT_MISMATCH')
      requireText(s.requestId, s.turnId, s.processingStartedEventRef)
      if (s.worker.id !== envelope.worker.id || s.worker.revision !== envelope.worker.revision || binding.data.native_session_id !== s.nativeSessionId || s.payloadDigest !== envelope.digest || !Number.isSafeInteger(s.assignmentRevision) || s.assignmentRevision < 1) throw new Error('CONTEXT_CONSUMPTION_MISMATCH')
      const fact = nativeFact(s.nativeEvidenceRef, s.worker), proof = fact.observation.consumption
      if (fact.command.actionRef.id !== ref(binding.data.launch_ref).id || fact.command.stream !== binding.data.stream || fact.observation.kind !== 'input-consumed' || !proof || proof.request_id !== s.requestId || proof.assignment_revision !== s.assignmentRevision || proof.payload_digest !== s.payloadDigest || proof.turn_id !== s.turnId || proof.processing_started_event_ref !== s.processingStartedEventRef || proof.session_identity?.host_ref !== ref(binding.data.host_ref).id || proof.session_identity?.engine_ref !== binding.data.engine_ref || proof.session_identity?.runtime_namespace !== binding.data.runtime_namespace || proof.session_identity?.native_session_id !== s.nativeSessionId) throw new Error('NATIVE_CONSUMPTION_PROOF_REQUIRED')
      const intentFound = ledger.eventEntries({nativeStream:String(binding.data.stream),nativeKind:'input-intent'}).some(({body:e}: any) => { const c = e?.controlled?.kind === 'host' ? e.controlled.command : undefined, i = c?.observation?.input; return c?.kind === 'native' && c.stream === binding.data.stream && c.actionRef?.id === ref(binding.data.launch_ref).id && c.observation?.kind === 'input-intent' && i?.request_id === s.requestId && i.assignment_revision === s.assignmentRevision && i.payload_digest === s.payloadDigest && i.text === envelope.text })
      if (!intentFound) throw new Error('NATIVE_INPUT_PAYLOAD_REQUIRED')
      const old = ledger.snapshot().find(o => o.kind === 'context_input' && o.data.request_id === s.requestId && ref(o.data.worker_ref).id === s.worker.id)
      const data = { context_ref: json(s.context), request_id: s.requestId, assignment_revision: s.assignmentRevision, payload_digest: s.payloadDigest, worker_ref: json(s.worker), native_session_id: s.nativeSessionId, turn_id: s.turnId, processing_started_event_ref: s.processingStartedEventRef, native_evidence_ref: s.nativeEvidenceRef }
      if (old) { if (JSON.stringify(old.data) !== JSON.stringify(data)) throw new Error('INPUT_IDENTITY_CONFLICT'); result = [old] }
      else result = [save('context_input', data, [s.context, s.worker])]
    } else if (p.kind === 'team_review') {
      commitment(p.commitmentId); const scopes = scopesFor(p.commitmentId), intake = current(scopes[0]!)
      bindingFor(p.reviewer); texts(p.evidenceRefs)
      if (!['pass', 'fail', 'inconclusive'].includes(p.verdict)) throw new Error('INVALID_VERDICT')
      const all = ledger.snapshot('team_assignment').filter(o => o.kind === 'team_assignment' && o.data.commitment_id === p.commitmentId)
      if (!all.length || all.length !== p.assignments.length || all.some(o => !p.assignments.some(r => r.id === o.id && r.revision === o.revision))) throw new Error('TEAM_REVIEW_COVERAGE')
      p.assignments.forEach(r => current(r, 'team_assignment'))
      // The policy, not a model-supplied role title, declares independent review responsibility.
      const policy = current(ref(intake.data.policy_ref), 'professional_policy'), roles = policy.data.roles as unknown as PolicySpec['roles']
      const reviews = all.filter(o => o.data.applicable && ref(o.data.worker_ref).id === p.reviewer.id && roles.some(r => r.name === o.data.role && r.independentOf.length))
      if (!reviews.length) throw new Error('INDEPENDENT_REVIEWER_REQUIRED')
      const previous = ledger.snapshot().find(o => o.kind === 'team_review' && o.data.commitment_id === p.commitmentId)
      result = [save('team_review', { commitment_id: p.commitmentId, reviewer_ref: json(p.reviewer), assignment_refs: json(p.assignments), contract_ref: intake.data.contract_ref!, evidence_refs: p.evidenceRefs, verdict: p.verdict }, [...scopes, ...p.assignments, p.reviewer], undefined, previous)]
    } else if (p.kind === 'observation') {
      commitment(p.commitmentId); requireText(p.observerRef, p.summary); assertRefs(p.sourceRefs)
      result = [save('coordination_observation', { commitment_id: p.commitmentId, observer_ref: p.observerRef, source_refs: json(p.sourceRefs), summary: p.summary }, [...scopesFor(p.commitmentId), ...p.sourceRefs], undefined, undefined, p.extensions)]
    } else throw new Error('COORDINATION_COMMAND_UNKNOWN')
    const sequence = Number(db.prepare('SELECT sequence FROM sa_managed_meta WHERE singleton=1').get()!.sequence) + 1
    db.prepare('UPDATE sa_managed_meta SET sequence=? WHERE singleton=1').run(sequence)
    db.prepare('INSERT INTO sa_managed_event VALUES(?,?)').run(sequence, JSON.stringify({ coordination: { source: command.source, payload: p }, refs: changed.map(refOf) }))
    db.exec('COMMIT'); return result.map(refOf)
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
