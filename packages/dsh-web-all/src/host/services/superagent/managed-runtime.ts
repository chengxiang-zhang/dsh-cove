import { DELIVERY_EVIDENCE_POLICY, partitionHandoff, verifyPartitionCandidate, type ContractPartition } from './kernel/contract-partition.ts'
import { loadManagedMaterials, type ManagedMaterial } from './executors/managed-materials.ts'
import { sealProjectInputs, verifyProjectSeal } from './executors/project-snapshot.ts'
import { runProjectVerification, type ProjectGate } from './executors/project-verification.ts'
import { verificationRuntimeDigest } from './executors/verification-run.ts'
import { planLocalGitDelivery } from './executors/delivery/local-git.ts'
import { git, gitBytes, file, treeEntries, manifestDigest } from './executors/delivery/git.ts'
import { resourceIds } from './protocol/execution.ts'
import { deliveryReportText } from './protocol/delivery.ts'
import { mkdirSync, realpathSync, readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync, renameSync, openSync, closeSync, fsyncSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { ManagedLedger } from './kernel/managed-ledger.ts'
import { createControlledKernel } from './kernel/actions.ts'
import { createCoordinationService } from './coordination/intake.ts'
import { createExtensionRegistry } from './protocol/extensions.ts'
import { maintenanceSchemas, createManagedPorts, createMaintenanceObserver, selectQualifiedEngine } from './coordination/advance.ts'
import { createManagedWorkspace } from './world/managed-workspace.ts'
import { launchManagedCodex, runManagedTurn, type ManagedEngineConfig } from './executors/managed-native.ts'
import { CodexCoordinatorRuntime } from './executors/engines/codex-coordinator.ts'
import { assertJson, type Json, type Ref, type ManagedObject } from './protocol/managed-work.ts'

import { createContextCompiler } from './context/compile.ts'
import { ControlledFileTools, nativeFileToolSchemas } from './executors/native/tools.ts'
import { createProposalInterpreter } from './coordination/interpreter.ts'
import { createVerificationService } from './verification/index.ts'
import { managedVerificationMethod, methodAssetDigest } from './executors/managed-verification-method.ts'
import type { ContextSource } from './protocol/coordination.ts'

const json = (value: unknown): Json => { assertJson(value); return value }

export interface ManagedRuntimeConfig {
  contractPartition?: ContractPartition
  readOnlyMaterials?: ManagedMaterial[]
  frameworkBaselineTransition?: { commitmentId: string; before: string; after: string; evidenceRefs: string[] }
  verification?: { methodId: string; qualification: { runtimeDigest: string; methodAssetsDigest: string; evidenceRefs: string[]; expiresAt: number } }
  projectVerification?: Omit<Parameters<typeof sealProjectInputs>[0], 'sourceRoot' | 'sourceFiles' | 'destination' | 'provenance'> & { authorizationVersion: string }
  initialMaterials?: string
  bootstrapResume?: { home: string; nativeSessionId: string }; parentPlan?: RuntimeProposal['intake']; root: string; projectRoot: string; publicFiles: string[]; implementationWritePaths: string[]; engine: Omit<ManagedEngineConfig, 'source'>
}
export const managedCoordinatorSchema: Json = {
  type: 'object', additionalProperties: false, required: ['proposals'], properties: { proposals: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['kind','role','instruction','reason','intake','questionId','answer'], properties: {
      kind: { type: 'string', enum: ['accept','dispatch','verify','answer','wait','look'] },
      role: { type: 'string', enum: ['coordinator','implementation','quality','none'] }, instruction: { type: 'string' }, reason: { type: 'string' }, questionId: { type: 'string' }, answer: { type: 'string' },
      intake: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['goal','results','constraints','criteria','deliveryCriteria','assignments'], properties: {
        goal: { type: 'string' }, results: { type: 'array', items: { type: 'string' } }, constraints: { type: 'array', items: { type: 'string' } }, criteria: { type: 'array', items: { type: 'string' } }, deliveryCriteria: { type: 'array', items: { type: 'string' } },
        assignments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['role','basis','deliverables','consumers','criteria'], properties: { role: { type: 'string', enum: ['coordinator','implementation','quality'] }, basis: { type: 'string' }, deliverables: { type: 'array', items: { type: 'string' } }, consumers: { type: 'array', items: { type: 'string', enum: ['coordinator','implementation','quality'] } }, criteria: { type: 'array', items: { type: 'integer' } } } } }
      } }] }
    }
  } } }
}
export interface RuntimeProposal { kind: 'accept'|'dispatch'|'verify'|'answer'|'wait'|'look'; role: string; instruction: string; reason: string; questionId: string; answer: string; intake: null | { goal: string; results: string[]; constraints: string[]; criteria: string[]; deliveryCriteria?: string[]; assignments: { role: string; basis: string; deliverables: string[]; consumers: string[]; criteria: number[] }[] } }
export function intakeReadiness(value: any): 'pass' | 'inconclusive' {
  if (value?.purpose !== 'intake' || !['ready','blocked'].includes(value.intake_readiness)) throw new Error('EXPLICIT_INTAKE_READINESS_REQUIRED')
  return value.intake_readiness === 'ready' ? 'pass' : 'inconclusive'
}

export function validateRuntimeProposals(value: unknown): { proposals: RuntimeProposal[] } {
  const v = value as { proposals: RuntimeProposal[] }
  if (!v || !Array.isArray(v.proposals) || !v.proposals.length || v.proposals.length > 10 || v.proposals.some(p => !['accept','dispatch','verify','answer','wait','look'].includes(p.kind) || typeof p.reason !== 'string')) throw new Error('MANAGED_PROPOSALS_INVALID')
  return v
}

/** The durable operation owns the exact native input/context, independent of secretary turns. */
export async function runManagedOperationTurn(ledger: ManagedLedger, coordination: ReturnType<typeof createCoordinationService>, operationId: string, slot: string, worker: Ref, context: Ref, session: Awaited<ReturnType<typeof launchManagedCodex>>, signal: AbortSignal) {
  const operation=ledger.get(operationId), envelope=ledger.get(context.id)?.data.envelope as unknown as import('./protocol/coordination.ts').ContextEnvelope
  if(!operation||operation.kind!=='coordination_operation'||operation.data.state!=='running'||!envelope) throw new Error('OPERATION_NOT_RUNNING')
  const requestId=operationId+':input:'+slot
  coordination.host.bindOperationExecution({id:operation.id,revision:operation.revision},{kind:'native',slot,worker,context,launch:session.launch.actionRef,stream:session.io.stream,nativeSessionId:session.engine.identity.native_session_id,requestId})
  return runManagedTurn(session,envelope.text,requestId,envelope.assignment.revision,signal)
}

/** Terminal publication is permitted only after the exact verifier result is durable. */
export function assertDeliveryProposalPersisted(ledger: ManagedLedger, operationId: string, receipt: DeliveryReceipt): void {
  const operation = ledger.get(operationId), proposal = ledger.get(operationId.replace(/:operation$/, ':result'))
  const matches = (value: unknown) => {
    const result = value as { status?: string; receipt?: DeliveryReceipt } | undefined
    return result?.status === 'delivered-local' && JSON.stringify(result.receipt) === JSON.stringify(receipt)
  }
  if (!operationId.endsWith(':operation') || operation?.kind !== 'coordination_operation' || operation.data.state !== 'completed' || (operation.data.proposal as any)?.kind !== 'verify' || !matches(operation.data.result) || proposal?.kind !== 'coordination_runtime_event' || proposal.data.event !== 'proposal_result' || !matches(proposal.data.payload)) throw Error('DELIVERY_PROPOSAL_NOT_DURABLE')
}

/** Only the trusted web-all host creates this runtime. JSON intake material cannot construct a grant. */
export function createManagedRuntime(config: ManagedRuntimeConfig) {
  mkdirSync(config.root, { recursive: true, mode: 0o700 })
  const method = managedVerificationMethod(config.verification?.methodId ?? 'codex-runTurn-replay@1')
  let initialParent: string | undefined
  try { initialParent = git(config.projectRoot, ['rev-parse', 'HEAD']) } catch { /* Read-only/non-Git projects can coordinate; Git delivery reports the explicit gap. */ }
  const root = realpathSync(config.root), source: Ref = { id: 'host-authenticated:' + randomUUID(), revision: 1 }
  const ledger = new ManagedLedger(join(root, 'managed.sqlite'), { extensions: createExtensionRegistry(maintenanceSchemas) })
  const coordination = createCoordinationService(ledger, source), kernel = createControlledKernel(ledger, source)
  const known = (id: string, create: () => Ref): Ref => { const old = ledger.get(id); return old ? { id, revision: old.revision } : create() }
  const host = known('host:local', () => coordination.host.registerHost({ id: 'host:local', authority: 'local-owner:' + process.getuid?.(), evidenceRefs: ['host-only-composition'] }))
  const project = known('project:current', () => coordination.host.registerProject({ id: 'project:current', intent: 'Authorized local maintenance', repositoryIdentity: realpathSync(config.projectRoot), hosts: [host], sourceRefs: [source] }))
  const profile = known('profile:codex-controlled', () => coordination.host.registerProfile({ id: 'profile:codex-controlled', capabilities: ['coordinator','implementation','quality'], evidenceRefs: ['P3b:actual-codex-controlled-read-write-check-ask', 'P3b:structured-coordinator'], limitations: ['No arbitrary shell', 'Verification methods must be host-qualified for their current source'], expiresAt: Date.now() + 30*60_000 }))
  const policy = known('policy:engineering', () => coordination.host.registerPolicy({ id: 'policy:engineering', roles: [{ name: 'coordinator', required: true, independentOf: [] }, { name: 'implementation', required: true, independentOf: [] }, { name: 'quality', required: true, independentOf: ['implementation'] }] }))
  const workers = new Map<string, Ref>(), workspaces = new Map<string, ReturnType<typeof createManagedWorkspace>>()
  for (const role of ['coordinator','implementation','quality','collector']) {
    const savedWorkspace = ledger.events().map((event: any) => event.controlled?.command).find((c: any) => c?.kind === 'workspace' && c.workspace.root === join(root, role))?.workspace
    const prepared = savedWorkspace ? { workspace: savedWorkspace, manifest: (role === 'collector' ? [] : config.publicFiles).map(path => ({ path, digest: createHash('sha256').update(readFileSync(join(savedWorkspace.root, path))).digest('hex') })) } : createManagedWorkspace(config.projectRoot, role === 'collector' ? [] : config.publicFiles, join(root, role), role === 'collector' ? 'collector' : 'engineering')
    if (!savedWorkspace) kernel.host.registerWorkspace(prepared.workspace); workspaces.set(role, prepared)
    if (role !== 'collector') workers.set(role, known('worker:'+role, () => coordination.host.registerWorker({ id: 'worker:' + role, host, profile, projects: [project], engineRef: 'codex', runtimeNamespace: role === 'coordinator' && config.bootstrapResume ? config.bootstrapResume.home : join(config.engine.stateRoot, role) })))
  }
  const supplemental = loadManagedMaterials(config.readOnlyMaterials)
  const native = new Map<string, Awaited<ReturnType<typeof launchManagedCodex>>>()
  const instructions = 'You are the accountable coordinating secretary across projects and professional agents. You have no business shell or tools. Produce only structured proposals; the host validates and executes them. Preserve the original user goal and constraints. Use independent quality before implementation. Technical questions stay inside the team. Never claim delivered or fulfilled while full project gates or delivery are missing. On intake propose one accept with requirement-derived criteria and all three responsibilities coordinator, implementation, quality. Criteria indexes are zero-based. Do not ask the user to relay technical matters.'
  const materials = new Map<string, ContextSource>()
  const compiler = createContextCompiler(ledger, coordination, ref => materials.get(ref.id))
  let work: Ref | undefined, contract: Ref | undefined, requirement: Ref | undefined, team: Ref[] = [], criteria: Ref[] = []
  const savedWork = ledger.snapshot('commitment').find(o => o.data.accountable === workers.get('coordinator')?.id)
  if (savedWork) { initialParent = undefined; work = { id: savedWork.id, revision: savedWork.revision }; requirement = (savedWork.data.requirement_refs as unknown as Ref[])[0]; contract = savedWork.data.acceptance_contract as unknown as Ref; team = ledger.snapshot('team_assignment').filter(o => o.data.commitment_id === work!.id).map(o => ({ id: o.id, revision: o.revision })); criteria = ledger.get(contract.id)!.data.criterion_refs as unknown as Ref[] }
  let delivered: { step: DeliveryStep; receipt: DeliveryReceipt; binding: DeliveryAcceptanceBinding; operationId: string } | undefined
  const deliveryBindings = new Map<string, DeliveryAcceptanceBinding>()
  const delivery = createManagedLocalDelivery({ ledger, source, storageRoot: join(root, 'delivery'), host: kernel.host, binding: step => { const binding = deliveryBindings.get(step.ref.id); if (!binding) throw new Error('DELIVERY_BINDING_MISSING'); return binding } })
  let originalText = '', qaResult: any, lastResult: Json = null
  const abort = new AbortController()
  const record = (event: string, payload: unknown, scopes: Ref[] = [project], evidence: string[] = []) => coordination.host.recordRuntimeEvent(event + ':' + randomUUID(), event, json(payload), scopes, evidence)
  const scope = (role: string) => [workers.get(role)!, ...coordination.semanticScopes(work!.id), ...team.filter(r => (ledger.get(r.id)!.data.worker_ref as any)?.id === workers.get(role)!.id)]
  const assignment = (role: string) => team.find(r => (ledger.get(r.id)!.data.worker_ref as any)?.id === workers.get(role)!.id)!
  const attach = (role: string, session: Awaited<ReturnType<typeof launchManagedCodex>>) => {
    const fact = kernel.host.nativeFacts(session.io.stream).find(f => (f.observation as any).kind === 'binding')!
    const existing = ledger.snapshot().some(o => o.kind === 'session_binding' && (o.data.worker_ref as any)?.id === workers.get(role)!.id)
    if (existing) coordination.host.resumeNativeSession(workers.get(role)!, fact.ref); else coordination.host.bindNativeSession(workers.get(role)!, fact.ref)
  }
  const contextFor = (role: string, instruction: string) => {
    instruction = JSON.stringify({ instruction, hostReadOnlyMaterials: supplemental, method: { id: method.id, description: method.description, instructions: method.instructions, responseSchema: method.qualitySchema(criteria), assets: method.assets }, hostExecution: 'During intake return purpose=intake and readiness; no candidate tests are claimed. After implementation the secretary proposes verify; host requests independent verification_design cases then runs the exact registered asynchronous method on baseline and candidate. Workers do not call a shell or invent a new tool. Fixed project gates and controlled local dev delivery follow only after business acceptance. Engineering gate/receipt obligations remain later prerequisites, never synthetic replay facts.' })
    const material = record('role_input', { role, instruction }, coordination.semanticScopes(work!.id))
    materials.set(material.id, { ref: material, text: instruction, digest: createHash('sha256').update(instruction).digest('hex'), visibleTo: [workers.get(role)!.id], mandatory: true, purpose: 'Current controlled professional instruction and observed evidence' })
    const envelope = compiler.compile({ commitmentId: work!.id, assignment: assignment(role), worker: workers.get(role)!, audience: [workers.get(role)!.id], purpose: role, sourceRefs: [material], failedMethods: [], nativeContextBlindSpots: ['Native automatic context loading is not fully observable'] })
    return { envelope, ref: coordination.host.recordContext(envelope) }
  }
  const consumed = (role: string, context: ReturnType<typeof contextFor>, input: { request_id: string }) => {
    const session = native.get(role)!, fact = kernel.host.nativeFacts(session.io.stream).filter(f => (f.observation as any).kind === 'input-consumed' && (f.observation as any).consumption.request_id === input.request_id).at(-1)
    if (!fact) throw new Error('ACTUAL_NATIVE_CONSUMPTION_REQUIRED')
    const proof = (fact.observation as any).consumption
    return coordination.host.recordConsumedContext({ context: context.ref, requestId: input.request_id, assignmentRevision: assignment(role).revision, payloadDigest: context.envelope.digest, worker: workers.get(role)!, nativeSessionId: session.engine.identity.native_session_id, turnId: proof.turn_id, processingStartedEventRef: proof.processing_started_event_ref, nativeEvidenceRef: fact.ref })
  }
  const roleInstructions = 'You are a professional worker in a controlled managed team. Use only registered managed read/write/check/ask. Never use shell, exec, browser, delegation, MCP or any other builtin. The input is a managed_input envelope; execute its text. Read actual source before judgments. check is only text equality, not tests. Technical uncertainty must use ask, never ask the user. Never claim whole-project tests or delivery happened without evidence.'
  async function getRole(role: string, schema?: Json) {
    const existing = native.get(role)
    if (existing) return existing
    const oldBinding = ledger.snapshot().find(o => o.kind === 'session_binding' && (o.data.worker_ref as any)?.id === workers.get(role)!.id)
    const resume = oldBinding ? { home: String(oldBinding.data.runtime_namespace), nativeSessionId: String(oldBinding.data.native_session_id) } : undefined
    const session = await launchManagedCodex(kernel, { ...config.engine, source, stateRoot: join(config.engine.stateRoot, role) }, workers.get(role)!, workspaces.get(role)!.workspace, scope(role), roleInstructions, nativeFileToolSchemas, schema ?? (role === 'quality' ? method.qualitySchema(criteria) : undefined), resume)
    native.set(role, session); attach(role, session)
    const helpers = new ControlledFileTools(kernel, session.launch, process.execPath, { writePaths: role === 'implementation' ? [...config.implementationWritePaths] : [] })
    session.engine.onRequest(request => { void (async () => {
      const p = request.params as any
      if (request.method !== 'item/tool/call') { await session.engine.respondNativeRequest(request.ref, { error: { code: -32000, message: 'Unqualified native tool refused' } }, session.launch); return }
      let reply: { success: boolean; text: string }
      if (p.tool === 'ask') {
        const evidence = kernel.host.nativeFacts(session.io.stream).filter(f => (f.observation as any).kind === 'request' && (f.observation as any).request.ref.id === request.ref.id).at(-1)!
        const question = coordination.host.recordQuestion({ commitmentId: work!.id, assignment: assignment(role), worker: workers.get(role)!, nativeRequestRef: request.ref.id, question: p.arguments.question, evidenceRefs: [evidence.ref], nativeEvidenceRef: evidence.ref, nextReviewAt: Date.now()+60000 })
        const answer = await askSecretary('Technical request from '+role+': '+p.arguments.question+'\nReturn exactly an answer proposal with questionId '+question.id+'. Resolve internally from current requirements. No user relay.')
        const decision = answer.proposals.find(p => p.kind === 'answer' && p.questionId === question.id)
        if (!decision?.answer) throw new Error('COORDINATOR_TECHNICAL_ANSWER_REQUIRED')
        const d = coordination.recordProfessionalDecision({ commitmentId: work!.id, question, reviewer: workers.get('coordinator')!, kind: 'technical_answer', conclusion: decision.answer, evidenceRefs: kernel.host.nativeFacts(native.get('coordinator')!.io.stream).slice(-4).map(f => f.ref), alternatives: [decision.reason], scopeRefs: coordination.semanticScopes(work!.id) })
        reply = { success: true, text: decision.answer }; record('technical_answer_sent', { question, decision: d }, scope(role))
      } else if (role === 'quality' && p.tool === 'write') reply = { success: false, text: 'INDEPENDENT_QUALITY_READ_ONLY' }
      else reply = await helpers.call(p.tool, p.arguments, request.ref.id)
      await session.engine.respondNativeRequest(request.ref, { result: { success: reply.success, contentItems: [{ type: 'inputText', text: reply.text }] } }, session.launch)
    })().catch(error => { record('native_request_unknown', { role, request: request.ref.id, error: String(error) }); }) })
    return session
  }
  const assertRoleDispatchReady = (role: string) => {
    if (!['implementation','quality'].includes(role)) throw new Error('ROLE_NOT_EXECUTABLE')
    if (!work) throw new Error('MANAGED_WORK_MISSING')
    if (role === 'implementation' && !coordination.dispatchReadiness(work.id).ready) throw new Error('QUALITY_INTAKE_REQUIRED')
  }
  async function runRole(role: string, instruction: string, operationId: string) {
    assertRoleDispatchReady(role)
    const session = await getRole(role), context = contextFor(role, instruction)
    const result = await runManagedOperationTurn(ledger,coordination,operationId,role,workers.get(role)!,context.ref,session,abort.signal)
    const proof = consumed(role, context, result.input)
    const evidence = record('professional_result', { operationId, role, answer: result.answer, nativeSessionId: session.engine.identity.native_session_id, turnId: result.receipt.consumption.turn_id }, scope(role), [proof.id])
    if (role === 'quality') {
      qaResult = JSON.parse(result.answer)
      if (qaResult.purpose === 'intake') coordination.host.recordTeamReview(work!.id, workers.get(role)!, team, [evidence.id, proof.id], intakeReadiness(qaResult))
    }
    return { status: 'observed', role, evidence, answer: result.answer } as unknown as Json
  }
  async function askSecretary(text: string) {
    const context = contextFor('coordinator', text), requestId = 'coordination:'+randomUUID()
    const batch = await ports.coordinator({ request_id: requestId, assignment_revision: assignment('coordinator').revision, text: context.envelope.text }, abort.signal)
    const proof = consumed('coordinator', context, { request_id: requestId })
    record('coordinator_proposals', batch as unknown as Json, scope('coordinator'), [proof.id])
    return batch
  }
  const assertVerificationReady = () => {
    if (!work || !contract || !requirement || !coordination.dispatchReadiness(work.id).ready) throw new Error('QUALITY_INTAKE_REQUIRED')
  }
  async function verifyCandidate(proposalInstruction: string, operationId: string): Promise<Json> {
    assertVerificationReady()
    if (!work || !contract || !requirement) throw new Error('MANAGED_WORK_MISSING')
    const implementation = workspaces.get('implementation')!.workspace.root, baseline = workspaces.get('coordinator')!.workspace.root
    // Quality receives the actual immutable candidate bytes in its own read-only role domain.
    const manifest = config.publicFiles.map(path => {
      const bytes = readFileSync(join(implementation, path)); writeFileSync(join(workspaces.get('quality')!.workspace.root,path),bytes)
      return {path,digest:createHash('sha256').update(bytes).digest('hex')}
    })
    await runRole('quality', JSON.stringify({ purpose: 'verification_design', candidateManifest: manifest, coordinatorInstruction: proposalInstruction, method: method.id, instruction: method.instructions, trustedMaterials: config.initialMaterials ?? '' }), operationId)
    if (!qaResult?.cases?.length) throw new Error('INDEPENDENT_CASES_REQUIRED')
    const service = createVerificationService(ledger,source,join(root,'verification'))
    const binding = (role:string) => ledger.snapshot('session_binding').find(o=>(o.data.worker_ref as any)?.id===workers.get(role)!.id)!
    const identity = (role:string) => { const b=binding(role); return JSON.stringify([b.data.host_ref,b.data.engine_ref,b.data.runtime_namespace,b.data.native_session_id]) }
    const qa = identity('quality'), generator=identity('implementation')
    const qualified = config.verification?.qualification
    if (!qualified || qualified.runtimeDigest !== verificationRuntimeDigest() || qualified.methodAssetsDigest !== methodAssetDigest(JSON.stringify(method.assets)) || qualified.expiresAt <= Date.now() || !qualified.evidenceRefs.length) throw new Error('CURRENT_VERIFICATION_QUALIFICATION_REQUIRED')
    const qualification=service.grantQualification({method:'json-equality@1',reviewer:qa,evidenceRefs:qualified.evidenceRefs,expiresAt:qualified.expiresAt})
    const assignmentRef=service.registerAssignment({commitmentId:work.id,contract,requirements:ledger.get(contract.id)!.data.requirement_refs as unknown as Ref[],generators:[generator],reviewer:qa})
    for (const state of ['ready','working'] as const) { const current=ledger.get(work.id)!; if ((state==='ready'&&current.data.state==='proposed')||(state==='working'&&current.data.state==='ready')) ledger.transact([{id:current.id,revision:current.revision}],[{kind:'transition',id:current.id,state,reason:'Actual independent intake approved and native implementation candidate observed'}]) }
    const run = async (from:string,label:string) => {
      const prepared=mkdtempSync(join(root,'replay-'+label+'-'))
      for(const path of config.publicFiles){mkdirSync(dirname(join(prepared,path)),{recursive:true});writeFileSync(join(prepared,path),readFileSync(join(from,path)),{flag:'wx',mode:0o400})}
      for (const [path, bytes] of Object.entries(method.assets)) { mkdirSync(dirname(join(prepared,path)), { recursive: true }); writeFileSync(join(prepared,path),bytes,{flag:'wx',mode:0o400}) }
      const candidate=service.collectCandidate(assignmentRef,{sourceRoot:prepared,entry:method.entry,exportName:method.exportName,environment:'node-local:'+method.id})
      const context=await service.sealVerificationContext({candidate,qualification,cases:qaResult.cases})
      const id='api-collect:'+randomUUID(), expiresAt=Date.now()+60000, launch=service.processLaunch(), workspace=workspaces.get('collector')!.workspace, scopes=[context,...coordination.semanticScopes(work!.id)]
      kernel.host.grantCapability({id:id+':cap',revision:1,scopeRefs:scopes,evidenceRefs:['P4a:isolated-offline-json'],expiresAt,externalTools:'blocked',revoked:false,launch})
      kernel.host.grantMandate({id:id+':mandate',revision:1,requester:'authenticated-host',subject:qa,target:context,workspaceId:workspace.id,resourceIds:workspace.resources,actions:['collect'],scopeRefs:scopes,expiresAt,revoked:false})
      const control=kernel.host.grantControl(context,qa,expiresAt)
      const action=kernel.actions.planAction({id,idempotencyKey:id,requester:'authenticated-host',subject:qa,target:context,epoch:control.epoch,mandateRef:{id:id+':mandate',revision:1},capabilityRef:{id:id+':cap',revision:1},kind:'collect',workspaceId:workspace.id,resourceIds:workspace.resources,scopeRefs:scopes,purpose:'collector',...launch,timeoutMs:3000})
      const operation=ledger.get(operationId)!
      coordination.host.bindOperationExecution({id:operation.id,revision:operation.revision},{kind:'controlled',slot:'collect:'+label,action:action.ref})
      kernel.actions.claimResources(action.ref,workspace.resources)
      const evidence=await service.run(context,{host:kernel.host,action:action.ref}),evaluation=service.assessCandidate(contract!,candidate,[evidence])
      record('independent_api_verification',{operationId,label,candidate,context,evidence,evaluation,verdict:ledger.get(evaluation.id)!.data.verdict},coordination.semanticScopes(work!.id),[evidence.id])
      return {candidate,context,evidence,evaluation,verdict:ledger.get(evaluation.id)!.data.verdict,results:ledger.get(evidence.id)!.data.results}
    }
    const old=await run(baseline,'baseline'),current=await run(implementation,'candidate')
    if (current.verdict !== 'pass') return json({ status: 'acceptance-failed', baseline: old, ...current, next: 'Original quality gives the exact failing cases/evidence to the original implementation session for repair; retain the candidate and baseline.' })
    return await verifyProjectAndDeliver(service, current, old, operationId)
  }
  async function verifyProjectAndDeliver(service: ReturnType<typeof createVerificationService>, apiResult: { candidate: Ref; evaluation: Ref; verdict: Json; results: Json | undefined }, baseline: unknown, operationId: string): Promise<Json> {
    const settings = config.projectVerification
    if (!settings || !initialParent) return json({ status: 'engineering-prerequisite-missing', ...apiResult, missing: !settings ? 'Host project verification configuration' : 'Local dev Git repository', baseline })
    const targetRoot = realpathSync(config.projectRoot), realGitDir = realpathSync(git(targetRoot, ['rev-parse', '--absolute-git-dir']))
    if (git(targetRoot, ['branch', '--show-current']) !== 'dev' || git(targetRoot, ['rev-parse', 'HEAD']) !== initialParent) throw new Error('DELIVERY_BASELINE_CHANGED')
    const parentTree = treeEntries(targetRoot, initialParent)
    // Relevant actual source inputs cannot be silently replaced by HEAD.
    for (const path of config.publicFiles) {
      const original = file(workspaces.get('coordinator')!.workspace.root, path), expected = parentTree.get(path)
      if (!original || !expected || original.blob !== expected.blob || original.mode !== expected.mode) throw new Error('SOURCE_INPUT_NOT_IN_DELIVERY_BASELINE:' + path)
    }
    const stage = mkdtempSync(join(root, 'final-tree-'))
    for (const entry of parentTree.values()) { const path = join(stage, entry.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, gitBytes(targetRoot, ['cat-file', 'blob', entry.blob]), { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 }) }
    const manifest = [] as DeliveryStep['manifest']
    for (const path of config.implementationWritePaths) {
      const actual = file(workspaces.get('implementation')!.workspace.root, path)
      if (!actual) throw new Error('DELIVERY_CANDIDATE_FILE_REQUIRED:' + path)
      const old = parentTree.get(path)
      if (old?.blob === actual.blob && old.mode === actual.mode) continue
      mkdirSync(dirname(join(stage, path)), { recursive: true }); writeFileSync(join(stage, path), actual.bytes); chmodSync(join(stage, path), actual.mode === '100755' ? 0o755 : 0o644)
      manifest.push({ path, blob: actual.blob, mode: actual.mode })
    }
    if (!manifest.length) return json({ status: 'no-source-change', ...apiResult, baseline, reason: 'No new local commit is justified; secretary must reconcile the requested outcome.' })
    const current = ledger.get(work!.id)!, deliveryContract = ledger.get((current.data.delivery_contract as unknown as Ref).id)!, stepRef = (deliveryContract.data.step_refs as unknown as Ref[])[0]!
    const storage = join(root, 'delivery'), gates: ProjectGate[] = ['test','typecheck','docs:check','build','test:scripts','runtime-deps:check','sync-shared:check']
    const gateRefs = gates.map(gate => ({ id: stepRef.id + ':gate:' + gate, revision: 1 }))
    const provisional = planLocalGitDelivery({ ref: stepRef, targetRoot, realGitDir, branch: 'dev', expectedParent: initialParent, candidateRoot: stage, manifest, deletions: [], authoredAt: Math.floor(Date.now()/1000), message: 'fix(managed): ' + String(current.data.intent).replace(/[\r\n]/g, ' ').slice(0, 180), acceptanceRef: { id: stepRef.id + ':acceptance', revision: 1 }, requiredGateRefs: gateRefs,
      action: { id: stepRef.id + ':action', idempotencyKey: stepRef.id, requester: 'authenticated-host', subject: 'host-local-delivery', target: { id: current.id, revision: current.revision }, epoch: 1, mandateRef: { id: stepRef.id + ':mandate', revision: 1 }, capabilityRef: { id: stepRef.id + ':cap', revision: 1 }, workspaceId: stepRef.id + ':workspace', resourceIds: resourceIds(realGitDir, 'dev'), scopeRefs: [], purpose: 'engineering', timeoutMs: 60000, processPolicy: 'single' } }, storage)
    const sealRoot = join(root, 'seal-' + randomUUID()), toolInputs = mkdtempSync(join(root, 'gate-tools-'))
    const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'"
    const tools = settings.tools.filter(t => !['pnpm','python3'].includes(t.name)).map(t => ({ ...t }))
    for (const [name, dependency, relativePath] of [['pnpm','pnpm','bin/pnpm.cjs'], ['python3','python','bin/python3']] as const) {
      if (!settings.dependencyRoots.some(r => r.name === dependency)) continue
      const path = join(toolInputs, name), executable = name === 'pnpm' ? quote(join(sealRoot, 'tools/node')) + ' ' : ''
      writeFileSync(path, '#!/bin/sh\nexec ' + executable + quote(join(sealRoot, 'dependencies', dependency, relativePath)) + ' "$@"\n', { mode: 0o500 }); tools.push({ name, path })
    }
    const seal = sealProjectInputs({ ...settings, tools, sourceRoot: stage, sourceFiles: [...treeEntries(targetRoot, provisional.finalTree).keys()], destination: sealRoot, provenance: { source: 'managed-final-tree:' + provisional.finalTree, revision: initialParent } })
    const gateWork = mkdtempSync(join(root, 'gate-work-')), collector = realpathSync(mkdtempSync(join(realpathSync('/tmp'), 'sa-c-')))
    chmodSync(collector, 0o700)
    record('project_collector_retained', { root: collector, responsibility: 'retained-until-qualified-cessation', tree: provisional.finalTree }, [project])
    const observations: DeliveryAcceptanceBinding['gates'] = []
    const live = () => !abort.signal.aborted && ledger.get(current.id)?.revision === current.revision && ledger.applicability(current.id) === 'usable' && verifyProjectSeal(seal) && git(targetRoot, ['rev-parse', 'HEAD']) === initialParent
    for (const [index, gate] of gates.entries()) {
      const observation = await runProjectVerification({ sealedCandidate: seal, workRoot: gateWork, collectorRoot: collector, gate, authorizationVersion: settings.authorizationVersion, signal: abort.signal, liveFence: live })
      const observationPath = join(observation.keeperRef.root, 'project-observation.json'), observationDigest = createHash('sha256').update(readFileSync(observationPath)).digest('hex')
      record('project_gate_observed', { gate, tree: provisional.finalTree, sourceDigest: seal.digest, observationPath, observationDigest, exit: observation.exit, complete: observation.complete, errors: observation.errors }, coordination.semanticScopes(work!.id), [observationPath])
      if (!observation.complete || observation.exit.code !== 0 || observation.errors.length || !observation.isolationCurrent) return json({ status: 'project-gate-failed', gate, ...apiResult, observationPath, observationDigest, baseline, instruction: 'Return exact gate evidence to original implementation/quality sessions; no Git publication occurred.' })
      observations.push({ ref: gateRefs[index]!, gate, observationPath, observationDigest })
    }
    const target = service.enterDelivery({ id: current.id, revision: current.revision }, apiResult.evaluation)
    work = target
    const workspace = { id: provisional.action.workspaceId, root: targetRoot, source: targetRoot, repositoryId: realGitDir, baseline: initialParent, branch: 'dev', resources: resourceIds(realGitDir, 'dev'), sourceStatus: 'exact-tree:' + provisional.finalTree, role: 'engineering' as const }
    kernel.host.registerWorkspace(workspace)
    const expiresAt = Date.now() + 60000, control = kernel.host.grantControl(target, 'host-local-delivery', expiresAt)
    const step = { ...provisional, action: { ...provisional.action, target, epoch: control.epoch, scopeRefs: service.requiredActionScopes(target.id) } }
    const binding: DeliveryAcceptanceBinding = { ref: step.acceptanceRef, candidate: apiResult.candidate, evaluation: apiResult.evaluation, seal, authorizationVersion: settings.authorizationVersion, gates: observations, method: { id: method.id, assetsDigest: methodAssetDigest(JSON.stringify(method.assets)) } }
    readDeliveryAcceptance(ledger, step, binding)
    deliveryBindings.set(step.ref.id, binding)
    const spec = prepareDeliveryStep(step)
    kernel.host.grantCapability({ id: spec.capabilityRef.id, revision: 1, expiresAt, scopeRefs: spec.scopeRefs, evidenceRefs: observations.map(g => g.observationDigest), externalTools: 'blocked', revoked: false, launch: { executable: spec.executable, args: spec.args, processPolicy: 'single' }, expectedDevTransition: spec.expectedDevTransition })
    kernel.host.grantMandate({ id: spec.mandateRef.id, revision: 1, requester: spec.requester, subject: spec.subject, target, workspaceId: workspace.id, resourceIds: workspace.resources, actions: ['deliver'], scopeRefs: spec.scopeRefs, expiresAt, revoked: false })
    const action = kernel.actions.planAction(spec); kernel.actions.claimResources(action.ref, workspace.resources)
    const receipt = await delivery.execute(step, action.ref)
    delivered = { step, receipt, binding, operationId }
    writeFileSync(join(root, 'delivery-result.json'), JSON.stringify({ step, receipt, binding }), { flag: 'wx', mode: 0o600 })
    return json({ status: 'delivered-local', ...apiResult, commitment: work, receipt, priorPlatformGoal: 'unchanged' })
  }
  const qualifications = ['coordinator','roles','context','executor','verifier','observer'].map(id => ({ plugin_id: 'builtin:'+id, version: '1.0.0', evidence_ref: id === 'verifier' ? 'P4a:independent-fix1-qualified-json-equality' : 'P5a:independent-canonical-and-ports-pass/P3:actual-native', expires_at: Date.now()+1800000 }))
  const ports = createManagedPorts<{ proposals: RuntimeProposal[] }>({
    coordinator: { run: (input, signal) => new CodexCoordinatorRuntime(native.get('coordinator')!.engine, validateRuntimeProposals).run(input, signal) },
    roles: { plan: coordination.planProfessionalTeam }, context: compiler,
    executor: { async operate(input) { const p = ledger.get(input.payloadRef.id)!.data.payload as any; lastResult = await runRole(p.role, p.instruction, p.operationId); return { status: 'requested', evidenceRefs: [(lastResult as any).evidence.id] } } },
    verifier: { methods: ['json-equality@1'], async request(input) { if (input.method !== 'json-equality@1') throw new Error('METHOD_NOT_QUALIFIED'); lastResult = await verifyCandidate(String((ledger.get(input.context.id)!.data.payload as any).instruction),String((ledger.get(input.context.id)!.data.payload as any).operationId)); return { status: 'requested', evidenceRefs: [(lastResult as any).evaluation.id] } } },
    observer: createMaintenanceObserver(ledger),
  }, () => ({ contract_version: '1.0.0', schema_versions: ['2'], permissions: ['propose','coordinate','read-context','controlled-execute','verify','observe'], extensions: ['maintenance/source@1'], isolated_modes: ['controlled'], now: Date.now(), qualifications }), undefined, validateRuntimeProposals)
  const completeOperation = (operationId: string, result: Json) => {
    const operation=ledger.get(operationId)!
    const evidence=(operation.data.executions as unknown as import('./protocol/coordination.ts').OperationExecution[]).flatMap(execution=>execution.kind==='native'?kernel.host.nativeFacts(execution.stream).filter(f=>(f.observation as any).kind==='turn-page').map(f=>f.ref):[])
    return coordination.host.completeOperation({id:operation.id,revision:operation.revision},result,evidence)
  }
  const reconcileOperations = () => ledger.snapshot('coordination_operation').filter(o=>o.data.state!=='completed').map(operation=>{
    try { const proof=completeOperation(operation.id,{status:'reconciled',operation:operation.id,basis:'Persisted exact native input completion or controlled receipts; not an acceptance verdict'}); return {operation:proof,status:'reconciled'} }
    catch { return {operation:{id:operation.id,revision:operation.revision},status:'unknown'} }
  })
  const interpreter = createProposalInterpreter(ledger, coordination, async (raw, key) => {
    const p = raw as unknown as RuntimeProposal
    if (p.kind === 'accept') {
      if (work || !p.intake || !p.intake.criteria.length) throw new Error('INTAKE_PROPOSAL_REQUIRED')
      const v = p.intake, parent = config.parentPlan, id = randomUUID()
      const makeRequirement = (id: string, intent: string, results: string[], constraints: string[]) => ({ id, kind: 'requirement', revision: 1, scope_revision_refs: [], extensions: {}, data: { intent, source_refs: [source], wish_refs: [], observable_results: results, constraints, criterion_sources: [source.id] } } as unknown as ManagedObject)
      requirement = { id: 'requirement:' + id, revision: 1 }; contract = { id: 'contract:' + id, revision: 1 }
      criteria = v.criteria.map((_, i) => ({ id: 'criterion:' + id + ':' + i, revision: 1 }))
      const deliveryCriteria = (v.deliveryCriteria ?? []).map((_, i) => ({ id: 'delivery-criterion:' + id + ':' + i, revision: 1 }))
      const deliveryRef = { id: 'delivery:' + id, revision: 1 }, stepRef = { id: 'delivery-step:' + id, revision: 1 }
      const objects = [makeRequirement(requirement.id, v.goal, v.results, v.constraints), ...v.criteria.map((text,i) => ({ ...makeRequirement(criteria[i]!.id, text, [text], []), scope_revision_refs: [requirement!] })), ...(v.deliveryCriteria ?? []).map((text,i) => ({ ...makeRequirement(deliveryCriteria[i]!.id, text, [text], []), scope_revision_refs: [requirement!] })), { id: contract.id, kind: 'acceptance_contract', revision: 1, data: { intent: v.goal, requirement_refs: [requirement], criterion_refs: criteria, source_refs: [source] }, scope_revision_refs: [requirement, ...criteria], extensions: {} }, { id: deliveryRef.id, kind: 'delivery_contract', revision: 1, data: { intent: 'Exact local dev delivery after independent business acceptance and full project gates', requirement_refs: [requirement], step_refs: [stepRef], source_refs: [source], criterion_refs: deliveryCriteria, evidence_policy: DELIVERY_EVIDENCE_POLICY }, scope_revision_refs: [requirement, ...deliveryCriteria], extensions: {} }] as unknown as ManagedObject[]
      ledger.transact([], objects.map(object => ({ kind: 'create', object })))
      if (parent) record('parent_goal_pending', { requirements: parent as unknown as Json, status: 'pending', reason: 'Separate prior platform outcome; this business delivery does not fulfill or discard it.' }, [project])
      work = coordination.acceptManagedIntent(source, { id: 'work:' + id, intent: v.goal, requirements: [requirement], acceptanceContract: contract, deliveryContract: deliveryRef, projects: [project], boundary: 'Only host-authorized paths; independent business acceptance plus exact-tree project gates before controlled local dev commit; no push or deployment', accountable: workers.get('coordinator')!.id, policy, nextReviewAt: Date.now()+60000 })
      team = ports.plan(work, v.assignments.map(a => ({ role: a.role, applicable: true, basis: a.basis, worker: workers.get(a.role) ?? null, deliverables: a.deliverables, consumers: a.consumers, criteria: a.criteria.map(i => criteria[i]!), dependencies: [], combinationBasis: '' })))
      const old = native.get('coordinator')!, identity = old.engine.identity, closed = await old.stop()
      if (closed.receipt?.stopped !== true) throw new Error('BOOTSTRAP_CESSATION_UNKNOWN')
      const next = await launchManagedCodex(kernel, { ...config.engine, source, stateRoot: old.home }, workers.get('coordinator')!, workspaces.get('coordinator')!.workspace, scope('coordinator'), instructions, [], managedCoordinatorSchema, { home: old.home, nativeSessionId: identity.native_session_id })
      native.set('coordinator', next); attach('coordinator', next)
      return json({ status: 'accepted', commitment: work, team, criteria, parentRequirementsPreserved: true })
    }
    if (p.kind === 'dispatch') {
      const payload = record('dispatch_instruction', { operationId:key, role: p.role, instruction: p.instruction }, coordination.semanticScopes(work!.id))
      await ports.operate({ operation: 'dispatch', target: workers.get(p.role)!, payloadRef: payload })
      completeOperation(key,lastResult)
      return lastResult
    }
    if (p.kind === 'look') return { status: 'observed', reconciledOperations:reconcileOperations() as unknown as Json, objects: ledger.snapshot().filter(o => !['action','coordination_runtime_event','context_envelope','context_input'].includes(o.kind)) as unknown as Json, runtimeEvents: ledger.snapshot('coordination_runtime_event').filter(o => ['proposal_unknown','independent_api_verification'].includes(String(o.data.event))).map(o => ({ ref: { id:o.id,revision:o.revision },event:o.data.event,payload:o.data.payload })).slice(-20) as unknown as Json }
    if (p.kind === 'wait') return { status: 'waiting', reason: p.reason, nextReviewAt: Date.now()+60000 }
    if (p.kind === 'verify') { const request=record('verification_instruction',{operationId:key,instruction:p.instruction},coordination.semanticScopes(work!.id)); await ports.verify({ method: 'json-equality@1', context: request }); completeOperation(key,lastResult); return lastResult }
    throw new Error('PROPOSAL_NOT_EXECUTABLE_IN_THIS_CONTEXT')
  }, { preflight(raw) { const p=raw as unknown as RuntimeProposal; if(p.kind==='dispatch') assertRoleDispatchReady(p.role); else if(p.kind==='verify') assertVerificationReady() }, executionSlots(raw) { const p=raw as unknown as RuntimeProposal; return p.kind==='dispatch'?[p.role]:p.kind==='verify'?['quality','collect:baseline','collect:candidate']:[] }, domains(raw) {
    const p=raw as unknown as RuntimeProposal
    const roles=p.kind==='dispatch'?[p.role]:p.kind==='verify'?['quality','collector']:[]
    if(!roles.length) return undefined
    return roles.flatMap(role=>{
      const workspace=workspaces.get(role)?.workspace
      if(!workspace||!['implementation','quality','collector'].includes(role)) throw new Error('ROLE_NOT_EXECUTABLE')
      return [...(workers.has(role)?['seat:'+workers.get(role)!.id]:[]),...workspace.resources.map(id=>'resource:'+id)]
    })
  } })
  const api = {
    ledger, coordination, kernel, root, source, project, policy, workers, workspaces, native, reconcileOperations,
    deliveryEvaluation: () => delivered && ledger.get(delivered.step.action.target.id)?.data.state === 'fulfilled' ? delivery.verifyDeliveryReceipt(delivered.step.ref, delivered.receipt) : { verdict: 'fail' as const, reason: 'No independently verified local delivery', receipt: null },
    resultReport: () => delivered && ledger.get(delivered.step.action.target.id)?.data.state === 'fulfilled' ? delivery.report(delivered.step.ref, delivered.receipt) : undefined,
    async bootstrap(text: string, signal: AbortSignal = new AbortController().signal) {
      originalText = text
      text = JSON.stringify({ userRequest: text, supportedVerificationMethod: { id: method.id, description: method.description }, sourceFiles: config.publicFiles, allowedWritePaths: config.implementationWritePaths, trustedMaterials: config.initialMaterials ?? '', engineeringPrerequisites: 'Put only business method assertions in criteria; put exact-tree gates, allowed-path local dev commit and truthful delivery in deliveryCriteria. Preserve all original results/constraints. Independent qualified business acceptance, all exact-tree project gates, controlled local dev commit. Prior M1 platform obligations remain separate pending work; do not treat them as this task criteria or silently fulfill them.' })
      const worker = workers.get('coordinator')!, home = config.bootstrapResume?.home ?? join(config.engine.stateRoot, 'coordinator')
      const session = await launchManagedCodex(kernel, { ...config.engine, source, stateRoot: home }, worker, workspaces.get('coordinator')!.workspace, [worker, project], instructions, [], managedCoordinatorSchema, config.bootstrapResume)
      native.set('coordinator', session)
      const requestId = 'bootstrap:' + randomUUID()
      coordination.host.recordRuntimeEvent(requestId, 'authenticated_intake', { text, projectRoot: config.projectRoot, manifest: workspaces.get('implementation')!.manifest }, [project], [source.id])
      const proposals = await ports.coordinator({ request_id: requestId, assignment_revision: 1, text }, signal)
      coordination.host.recordRuntimeEvent(requestId + ':proposals', 'coordinator_proposals', proposals as unknown as Json, [project], kernel.host.nativeFacts(session.io.stream).map(f => f.ref))
      return { requestId, proposals, identity: session.engine.identity }
    },
    async prepareContinuation() {
      if (!work || native.size) throw Error('MANAGED_CONTINUATION_NOT_QUIESCENT')
      const partition = config.contractPartition
      const unresolved = ledger.snapshot('coordination_operation').filter(o => o.data.state !== 'completed' && !partitionHandoff(ledger, o, contract ? [contract] : []))
      if (unresolved.length && (!partition || JSON.stringify(unresolved.map(o => ({ id: o.id, revision: o.revision }))) !== JSON.stringify(partition.operations))) throw Error('MANAGED_CONTINUATION_NOT_QUIESCENT')
      if (partition && (partition.commitment.id !== work.id || partition.candidateRoot !== workspaces.get('implementation')!.workspace.root || JSON.stringify(partition.candidate.map(x => x.path).sort()) !== JSON.stringify([...config.publicFiles].sort()))) throw Error('PARTITION_CANDIDATE_SCOPE')
      if (partition) verifyPartitionCandidate(partition)
      const launches = ledger.snapshot('action').filter(o => (o.data.execution_spec as any)?.kind === 'dispatch')
      if (!launches.length || launches.some(o => !(o.data.receipt as any)?.stopped)) throw Error('MANAGED_CONTINUATION_WRITER_UNKNOWN')
      const transition = config.frameworkBaselineTransition, head = git(config.projectRoot, ['rev-parse', 'HEAD'])
      const previous = ledger.snapshot('coordination_runtime_event').filter(o => o.data.event === 'framework_baseline_bound').at(-1)?.data.payload as any
      if (!transition || transition.commitmentId !== work.id || !transition.evidenceRefs.length || transition.after !== head || (previous && previous.after !== transition.before && previous.after !== transition.after)) throw Error('MANAGED_BASELINE_TRANSITION_REQUIRED')
      if (git(config.projectRoot, ['merge-base', transition.before, head]) !== transition.before) throw Error('MANAGED_BASELINE_NOT_DESCENDANT')
      for (const role of ['coordinator','implementation','quality']) {
        const prepared = workspaces.get(role)!
        if (prepared.workspace.sourceStatus !== 'explicit-public-input:' + createHash('sha256').update(JSON.stringify(prepared.manifest)).digest('hex')) throw Error('MANAGED_PUBLIC_INPUT_CHANGED')
      }
      for (const path of config.publicFiles) {
        const before = treeEntries(config.projectRoot, transition.before).get(path), after = treeEntries(config.projectRoot, head).get(path)
        if (!before || !after || before.blob !== after.blob || before.mode !== after.mode) throw Error('MANAGED_BASELINE_BUSINESS_CHANGED')
        for (const sourceRoot of [config.projectRoot, ...['coordinator','implementation','quality'].map(role => workspaces.get(role)!.workspace.root)]) { if (partition && sourceRoot === partition.candidateRoot) continue; const entry = file(sourceRoot, path); if (!entry || entry.blob !== before.blob || entry.mode !== before.mode) throw Error('MANAGED_CANDIDATE_NOT_UNCHANGED') }
      }
      record('framework_baseline_bound', { ...transition, materialDigest: supplemental.digest, stoppedLaunches: launches.map(o => ({ id: o.id, revision: o.revision })) }, [project], transition.evidenceRefs)
      coordination.host.renewProfileQualification(profile, transition.evidenceRefs, Date.now() + 30 * 60_000)
      if (partition && !ledger.get('contract-partition:' + work.id + ':' + partition.acceptance.revision)) {
        const refSchema = { type: 'object', additionalProperties: false, required: ['id','revision'], properties: { id: { type: 'string' }, revision: { type: 'integer' } } }
        const schema = json({ type: 'object', additionalProperties: false, required: ['approved','businessCriteria','deliveryCriteria','reason'], properties: { approved: { type: 'boolean' }, businessCriteria: { type: 'array', items: refSchema }, deliveryCriteria: { type: 'array', items: refSchema }, reason: { type: 'string' } } })
        const operationId = 'partition-approval:' + work.id + ':' + partition.acceptance.revision
        let operation = ledger.get(operationId)
        if (!operation) {
          const session = await getRole('quality', schema), context = contextFor('quality', JSON.stringify({ purpose: 'contract_partition_review', plan: partition, instruction: 'This turn must use the native mapping response schema approved/businessCriteria/deliveryCriteria/reason; method.responseSchema is for later business verification, not this decision. Independently approve or reject only this exact responsibility mapping. Preserve every original requirement and criterion verbatim. Business criteria remain fully checked by the registered method. Delivery criteria require actual same-tree all seven project gates plus controlled local dev receipt, never API synthetic coverage. Prior interrupted implementation remains incomplete; candidate is retained, old unanswered questions and unknown history remain. Do not claim candidate acceptance, tests or delivery. Return the exact businessCriteria/deliveryCriteria refs and approved/reason. Your prior C8 later-gate analysis may be reused, but verify these exact current refs.' }))
          const workspace = workspaces.get('quality')!.workspace
          coordination.host.claimOperation({ id: operationId, inputRef: 'host-contract-partition', proposal: json({ kind: 'contract_partition_review', plan: partition }), domainKeys: ['seat:' + workers.get('quality')!.id, ...workspace.resources.map(id => 'resource:' + id)], scopeRefs: scope('quality'), executionSlots: ['quality'] })
          const result = await runManagedOperationTurn(ledger, coordination, operationId, 'quality', workers.get('quality')!, context.ref, session, abort.signal)
          const proof = consumed('quality', context, result.input)
          record('professional_result', { operationId, role: 'quality', purpose: 'contract_partition_review', answer: result.answer, nativeSessionId: session.engine.identity.native_session_id, turnId: result.receipt.consumption.turn_id }, scope('quality'), [proof.id])
          completeOperation(operationId, json({ status: 'partition-reviewed', answer: result.answer }))
          operation = ledger.get(operationId)!
        }
        if (operation.data.state !== 'completed') throw Error('PARTITION_QA_OUTCOME_UNKNOWN')
        await api.stopNative()
        if (git(config.projectRoot, ['rev-parse', 'HEAD']) !== head) throw Error('MANAGED_BASELINE_CHANGED')
        verifyPartitionCandidate(partition)
        const proofRefs = operation.data.evidence_refs as string[]
        coordination.host.partitionContracts(partition, { operation: { id: operation.id, revision: operation.revision }, evidenceRefs: proofRefs })
        const current = ledger.get(work.id)!
        work = { id: current.id, revision: current.revision }; contract = current.data.acceptance_contract as unknown as Ref
        criteria = ledger.get(contract.id)!.data.criterion_refs as unknown as Ref[]
        team = ledger.snapshot('team_assignment').filter(o => o.data.commitment_id === work!.id).map(o => ({ id: o.id, revision: o.revision }))
      }
      initialParent = head
      return { head, materialDigest: supplemental.digest, ...(partition ? { contractPartition: 'contract-partition:' + work.id + ':' + partition.acceptance.revision } : {}) }
    },
    async resume(text: string) {
      if (!work) throw new Error('MANAGED_WORK_MISSING')
      if (!initialParent) throw Error('MANAGED_BASELINE_TRANSITION_REQUIRED')
      const binding = ledger.snapshot().find(o => o.kind === 'session_binding' && (o.data.worker_ref as any)?.id === workers.get('coordinator')!.id)!
      const session = await launchManagedCodex(kernel, { ...config.engine, source, stateRoot: String(binding.data.runtime_namespace) }, workers.get('coordinator')!, workspaces.get('coordinator')!.workspace, scope('coordinator'), instructions, [], managedCoordinatorSchema, { home: String(binding.data.runtime_namespace), nativeSessionId: String(binding.data.native_session_id) })
      native.set('coordinator', session); attach('coordinator', session)
      return { requestId: 'resume:'+randomUUID(), proposals: await askSecretary(JSON.stringify({ instruction: text, hostContractPartition: ledger.snapshot('coordination_runtime_event').filter(o => o.data.event === 'contract_partition').map(o => o.data.payload), continuationRule: 'Old interrupted operations and unanswered request records remain history, not success. Their old native RPC is terminated; address outstanding technical content in the new original-thread turns, never claim the old request was answered. After contract partition first request original quality to approve the new team mapping before implementation resumes its retained candidate.' })) }
    },
    async advance(batch: { requestId: string; proposals: { proposals: RuntimeProposal[] } }) {
      const outcomes: Json[] = []
      let current = batch
      for (let turn = 0; turn < 8; turn++) {
        let result: Json[], applied = false
        try { result = await interpreter.apply(current.requestId, current.proposals.proposals as unknown as Json[], work ? coordination.semanticScopes(work.id) : [project]); applied = true } catch (error) { result = [{ status: 'refused_or_unknown', reason: String(error), instruction: 'Inspect durable operation/native facts; correct proposals internally. Never bypass quality or automatically repeat unknown effects.' }] }
        outcomes.push(...result)
        if (delivered && applied) {
          assertDeliveryProposalPersisted(ledger, delivered.operationId, delivered.receipt)
          // Finish the proposal/operation while its semantic intake is still active;
          // terminal fulfillment is a separate host transaction after that result lands.
          work = delivery.fulfill(delivered.step, delivered.receipt)
          const text = delivery.report(delivered.step.ref, delivered.receipt)
          record('local_delivery_verified', { commitment: work, receipt: delivered.receipt, text }, [project], [delivered.receipt.commit])
          outcomes.push(json({ status: 'fulfilled-local', commitment: work, receipt: delivered.receipt, text, priorPlatformGoal: 'unchanged' }))
          break
        }
        if (current.proposals.proposals.some(p => p.kind === 'wait')) break
        const text = JSON.stringify({ observedResults: result, next: 'Advance the actual user business request. First dispatch independent quality to read the source and approve criteria; then implementation to perform real controlled edits. Criteria ids: '+criteria.map(r=>r.id).join(',')+'. The implementation must use ask if uncertain; technical matters stay internal. After candidate implementation request independent verify. After independent acceptance passes, the host runs the configured project gates and exact local dev delivery automatically. Only host receipt-backed reporting can claim completion; if a gate fails, use its actual evidence for original-thread repair.' })
        current = { requestId: 'advance:'+randomUUID(), proposals: await askSecretary(text) }
      }
      return outcomes
    },
    async stopNative(): Promise<Json[]> {
      const results: Json[] = []
      for (const [role, session] of native) { try { const result = await session.stop(); results.push({ role, result: result as unknown as Json }) } finally { session.cleanupCredentials(); native.delete(role) } }
      return results
    },
    async dispose() { const results = await api.stopNative(); ledger.close(); return results }
  }
  return api
}

import type { ActionRecord } from './kernel/actions.ts'
import { prepareDeliveryStep } from './coordination/delivery.ts'
import type { DeliveryStep } from './protocol/delivery.ts'
import { inspectDeliveryReceipt } from './verification/delivery.ts'
import type { DeliveryReceipt } from './protocol/delivery.ts'
import { createLocalGitDelivery } from './executors/delivery/local-git.ts'
import { readDeliveryAcceptance, type DeliveryAcceptanceBinding } from './verification/delivery-acceptance.ts'
import { createDeliveryFulfillment } from './kernel/delivery-ledger.ts'

/** Host composition port; the secretary is given neither this factory nor its bindings. */
export function createManagedLocalDelivery(input: {
  ledger: ManagedLedger; source: Ref; storageRoot: string
  host: ReturnType<typeof createControlledKernel>['host']
  binding(step: DeliveryStep): DeliveryAcceptanceBinding
}) {
  const port = createLocalGitDelivery({ storageRoot: input.storageRoot, verifyReceipt: inspectDeliveryReceipt,
    readAcceptance: step => readDeliveryAcceptance(input.ledger, step, input.binding(step), true),
    fence: ref => { const result = input.host.fenceDispatch(ref); if (result.kind !== 'envelope') throw new Error('DELIVERY_EXECUTION_FENCED'); return result },
  })
  const fulfill = createDeliveryFulfillment(input.ledger, input.source, (step, receipt) => {
    const acceptance = readDeliveryAcceptance(input.ledger, step, input.binding(step), true)
    const evaluation = inspectDeliveryReceipt(step, receipt)
    if (evaluation.verdict !== 'pass') throw new Error('DELIVERY_NOT_VERIFIED:' + evaluation.reason)
    return acceptance
  })
  return Object.freeze({
    prepareDeliveryStep,
    async execute(step: DeliveryStep, action: Ref): Promise<DeliveryReceipt> {
      readDeliveryAcceptance(input.ledger, step, input.binding(step), true)
      const existing = input.ledger.get(action.id)
      if (existing?.data.state === 'confirmed' && JSON.stringify(existing.data.execution_spec) === JSON.stringify(prepareDeliveryStep(step))) {
        const prior = port.reconcile(step.ref).receipt
        if (!prior || port.verifyDeliveryReceipt(step.ref, prior).verdict !== 'pass') throw new Error('DELIVERY_RECONCILIATION_FAILED')
        return { ...prior, actionRef: { id: existing.id, revision: existing.revision } }
      }
      const envelope = existing?.data.state === 'sent'
        ? input.host.fenceDispatch({ id: existing.id, revision: existing.revision })
        : input.host.beginDispatch(action)
      if (envelope.kind !== 'envelope') throw new Error('DELIVERY_EXECUTION_FENCED')
      // An exception after publication deliberately leaves the action sent: recovery
      // reconciles the journal/Git state, never converts a lost receipt to failure.
      const receipt = await port.executeLocalGitDelivery(step, envelope)
      const evaluation = port.verifyDeliveryReceipt(step.ref, receipt)
      if (evaluation.verdict !== 'pass') throw new Error('DELIVERY_NOT_VERIFIED:' + evaluation.reason)
      const confirmed = input.host.reconcileAction(envelope.actionRef, { status: 'confirmed', stopped: true, evidenceRefs: ['local-git:' + receipt.commit + ':' + receipt.tree] }) as ActionRecord
      return { ...receipt, actionRef: confirmed.ref }
    },
    verifyDeliveryReceipt: port.verifyDeliveryReceipt,
    report(step: Ref, receipt: DeliveryReceipt) {
      const evaluation = port.verifyDeliveryReceipt(step, receipt)
      if (evaluation.verdict !== 'pass') throw new Error('DELIVERY_REPORT_NOT_VERIFIED:' + evaluation.reason)
      return deliveryReportText(evaluation.receipt!)
    },
    reconcile: port.reconcile,
    fulfill(step: DeliveryStep, receipt: DeliveryReceipt) { return fulfill(step, receipt) },
  })
}

export interface ManagedHostConfig { bootstrapFile: string }
interface HostProjects {
  root: string
  defaultProject: string
  projects: Record<string, Omit<ManagedRuntimeConfig, 'root' | 'engine'> & { engine: Omit<ManagedEngineConfig, 'source' | 'stateRoot'> }>
}
export interface ManagedAdmissionRequest { requestId: string; project?: string; text: string; origin: { kind: 'feishu' | 'trusted-host'; chatId?: string; messageId?: string; eventId?: string } }
/** Persist before returning to a synchronous channel hook; each input has one owner and one queued execution. */
export function createManagedAdmission(config: ManagedHostConfig, onResult: (request: ManagedAdmissionRequest, result: { state: string; reason?: string; evaluate: () => import('./protocol/delivery.ts').DeliveryEvaluation }) => void) {
  const stat = statSync(config.bootstrapFile)
  if (!stat.isFile() || stat.mode & 0o022 || (process.getuid?.() !== 0 && stat.uid !== process.getuid?.())) throw new Error('MANAGED_HOST_BOOTSTRAP_TRUST_REQUIRED')
  const raw = JSON.parse(readFileSync(config.bootstrapFile, 'utf8')) as HostProjects
  if (!raw.root || !raw.defaultProject || !raw.projects?.[raw.defaultProject]) throw new Error('MANAGED_HOST_PROJECT_REQUIRED')
  mkdirSync(raw.root, { recursive: true, mode: 0o700 })
  const root = realpathSync(raw.root), requestsRoot = join(root, 'requests'); mkdirSync(requestsRoot, { recursive: true, mode: 0o700 })
  const running = new Map<string, ReturnType<typeof createManagedRuntime>>()
  let queue = Promise.resolve(), disposed = false
  const pathOf = (id: string) => join(requestsRoot, createHash('sha256').update(id).digest('hex') + '.json')
  const persist = (path: string, record: unknown) => { const tmp = path + '.next'; writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 }); const fd = openSync(tmp, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }; renameSync(tmp, path) }
  const api = {
    projects: () => Object.entries(raw.projects).map(([id, project]) => ({ id, default: id === raw.defaultProject, verificationMethod: project.verification?.methodId ?? null })),
    read(requestId: string) { return JSON.parse(readFileSync(pathOf(requestId), 'utf8')) as { request: ManagedAdmissionRequest; state: string; result?: unknown; error?: string } },
    enqueue(request: ManagedAdmissionRequest) {
      if (disposed || !request.requestId || !request.text.trim() || request.text.length > 64000) throw new Error('MANAGED_INTAKE_INVALID')
      const project = request.project ?? raw.defaultProject, settings = raw.projects[project]
      if (!Object.hasOwn(raw.projects, project) || !settings) throw new Error('MANAGED_PROJECT_NOT_CONFIGURED')
      const input = { ...request, project }, path = pathOf(input.requestId), key = createHash('sha256').update(input.requestId).digest('hex')
      if (existsSync(path)) { const old = api.read(input.requestId); if (JSON.stringify(old.request) !== JSON.stringify(input)) throw new Error('MANAGED_ADMISSION_CONFLICT'); return { requestId: input.requestId, state: old.state, duplicate: true } }
      // Exclusive creation and fsync happen before the native queue is touched.
      const fd = openSync(path, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify({ request: input, state: 'queued', admittedAt: Date.now() })); fsyncSync(fd) } finally { closeSync(fd) }
      queue = queue.then(async () => {
        if (disposed) return
        const jobRoot = join(root, 'jobs', key); mkdirSync(dirname(jobRoot), { recursive: true, mode: 0o700 })
        const runtime = createManagedRuntime({ ...settings, root: jobRoot, engine: { ...settings.engine, stateRoot: join(jobRoot, 'native') } })
        running.set(input.requestId, runtime)
        persist(path, { request: input, state: 'running', runtimeRoot: jobRoot, startedAt: Date.now() })
        try {
          const intake = await runtime.bootstrap(input.text), result = await runtime.advance(intake), evaluation = runtime.deliveryEvaluation()
          const state = evaluation.verdict === 'pass' ? 'fulfilled-local' : 'needs-attention'
          persist(path, { request: input, state, runtimeRoot: jobRoot, result, report: runtime.resultReport() ?? null, endedAt: Date.now() })
          onResult(input, { state, evaluate: runtime.deliveryEvaluation })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          persist(path, { request: input, state: 'needs-attention', runtimeRoot: jobRoot, error: reason, endedAt: Date.now() })
          onResult(input, { state: 'needs-attention', reason, evaluate: runtime.deliveryEvaluation })
        } finally {
          await runtime.stopNative()
          // Retain bounded read-only evidence for delayed outlet checks; closed older
          // entries remain durable on disk and cannot authorize an unverified send.
          while (running.size > 32) { const oldest = running.entries().next().value!; running.delete(oldest[0]); await oldest[1].dispose() }
        }
      }).catch(error => { const reason = error instanceof Error ? error.message : String(error); persist(path, { request: input, state: 'needs-attention', error: reason }); onResult(input, { state: 'needs-attention', reason, evaluate: () => ({ verdict: 'fail', reason, receipt: null }) }) })
      return { requestId: input.requestId, state: 'queued', duplicate: false }
    },
    continue(requestId: string, continuationId: string, text: string) {
      if (disposed || !continuationId || !text.trim() || text.length > 64000) throw Error('MANAGED_CONTINUATION_INVALID')
      const path = pathOf(requestId), prior = api.read(requestId) as any
      const settings = raw.projects[prior.request.project]
      if (!settings) throw Error('MANAGED_PROJECT_NOT_CONFIGURED')
      const materialDigest = loadManagedMaterials(settings.readOnlyMaterials).digest
      const continuations = prior.continuations ?? [], old = continuations.find((item: any) => item.id === continuationId)
      if (old) { if (old.text !== text || old.materialDigest !== materialDigest) throw Error('MANAGED_CONTINUATION_CONFLICT'); return { requestId, continuationId, state: prior.state, duplicate: true } }
      if (prior.state !== 'needs-attention' || !prior.runtimeRoot) throw Error('MANAGED_CONTINUATION_NOT_READY')
      const item = { id: continuationId, text, materialDigest, state: 'queued', admittedAt: Date.now() }
      const version = { ...prior, state: 'queued', continuations: [...continuations, item], priorOutcome: { state: prior.state, result: prior.result, error: prior.error, endedAt: prior.endedAt } }
      persist(path, version)
      queue = queue.then(async () => {
        if (disposed) return
        let runtime = running.get(requestId)
        try {
          if (!runtime) { runtime = createManagedRuntime({ ...settings, root: prior.runtimeRoot, engine: { ...settings.engine, stateRoot: join(prior.runtimeRoot, 'native') } }); running.set(requestId, runtime) }
          const baseline = await runtime.prepareContinuation()
          persist(path, { ...version, state: 'running', continuationStartedAt: Date.now(), baseline })
          runtime.coordination.host.recordRuntimeEvent('host-continuation:' + continuationId, 'authenticated_continuation', { requestId, continuationId, text, materialDigest, baseline }, [runtime.project], [runtime.source.id])
          const batch = await runtime.resume(text), result = await runtime.advance(batch), evaluation = runtime.deliveryEvaluation()
          const state = evaluation.verdict === 'pass' ? 'fulfilled-local' : 'needs-attention'
          persist(path, { ...version, state, result, report: runtime.resultReport() ?? null, endedAt: Date.now(), continuations: [...continuations, { ...item, state: 'completed' }] })
          onResult(prior.request, { state, evaluate: runtime.deliveryEvaluation })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          persist(path, { ...version, state: 'needs-attention', error: reason, endedAt: Date.now(), continuations: [...continuations, { ...item, state: 'failed', error: reason }] })
          onResult(prior.request, { state: 'needs-attention', reason, evaluate: runtime?.deliveryEvaluation ?? (() => ({ verdict: 'fail', reason, receipt: null })) })
        } finally { await runtime?.stopNative() }
      })
      return { requestId, continuationId, state: 'queued', duplicate: false }
    },
    async settle() { await queue },
    async dispose() { disposed = true; for (const runtime of running.values()) await runtime.dispose(); running.clear() },
  }
  // Historical running admissions remain visible, never silently relaunched with new effect identities.
  for (const name of readdirSync(requestsRoot)) if (name.endsWith('.json')) { const path = join(requestsRoot, name), record = JSON.parse(readFileSync(path, 'utf8')); if (record.state === 'running' || record.state === 'queued') persist(path, { ...record, state: 'needs-reconciliation', reason: 'Previous host admission retained; inspect its native operation history before resuming.' }) }
  return api
}
