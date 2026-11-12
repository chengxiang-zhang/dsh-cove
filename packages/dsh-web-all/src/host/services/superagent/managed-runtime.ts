import { isDeepStrictEqual } from 'node:util'
import { OwnerInputGate } from './kernel/owner-input.ts'
import { createAdmissions, type AdmissionRequest, type AdmissionRuntime } from './kernel/admissions.ts'
import { deliverTechnicalReply } from './executors/native/technical-reply.ts'
import { NativeTurnQueue, NativeRequestScope, closeExactSession } from './executors/native/turn-lifecycle.ts'
import { currentApiMaterial } from './context/api-material.ts'
import { coordinationObjectView } from './coordination/look.ts'
import { DELIVERY_EVIDENCE_POLICY, partitionHandoff, verifyPartitionCandidate, type ContractPartition, type InterruptedVerificationHandoff } from './kernel/contract-partition.ts'
import { loadManagedMaterials, type ManagedMaterial } from './executors/managed-materials.ts'
import { sealProjectInputs, verifyProjectSeal } from './executors/project-snapshot.ts'
import { runProjectVerification, type ProjectGate } from './executors/project-verification.ts'
import { calibrateManagedMethod, managedLoadedIdentity } from './managed-readiness.ts'
import { verificationRuntimeDigest } from './executors/verification-run.ts'
import { planLocalGitDelivery } from './executors/delivery/local-git.ts'
import { git, gitBytes, file, treeEntries, manifestDigest } from './executors/delivery/git.ts'
import { resourceIds } from './protocol/execution.ts'
import { deliveryReportText } from './protocol/delivery.ts'
import { mkdirSync, rmSync, realpathSync, readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync, renameSync, openSync, closeSync, fsyncSync, statSync, readdirSync } from 'node:fs'
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
import { managedVerificationMethod, methodAssetDigest, parseModuleVerificationCases } from './executors/managed-verification-method.ts'
import type { ContextSource } from './protocol/coordination.ts'

const json = (value: unknown): Json => { assertJson(value); return value }

export interface ManagedRuntimeConfig {
  interruptedVerificationHandoff?: InterruptedVerificationHandoff
  contractPartition?: ContractPartition
  readOnlyMaterials?: ManagedMaterial[]
  frameworkBaselineTransition?: { commitmentId: string; before: string; after: string; evidenceRefs: string[] }
  verification?: { methodId: string; settings?: import('./executors/managed-verification-method.ts').ManagedVerificationMethodSettings; qualification: { runtimeDigest: string; methodAssetsDigest: string; evidenceRefs: string[]; expiresAt: number } }
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
/** Owner routing is a read-only protocol, separate from executable business proposals. */
export const ownerClassificationSchema: Json = {
  type: 'object', additionalProperties: false, required: ['proposals'], properties: { proposals: {
    type: 'array', minItems: 1, maxItems: 1, items: { type: 'object', additionalProperties: false,
      required: ['kind', 'role', 'answer', 'reason'], properties: {
        kind: { type: 'string', enum: ['answer'] }, role: { type: 'string', enum: ['discussion', 'amendment'] },
        answer: { type: 'string', minLength: 1 }, reason: { type: 'string' },
      },
    },
  } },
}
export interface RuntimeProposal { kind: 'accept'|'dispatch'|'verify'|'answer'|'wait'|'look'; role: string; instruction: string; reason: string; questionId: string; answer: string; intake: null | { goal: string; results: string[]; constraints: string[]; criteria: string[]; deliveryCriteria?: string[]; assignments: { role: string; basis: string; deliverables: string[]; consumers: string[]; criteria: number[] }[] } }
export const preserveManagedDeliveryCriteria = (previous: string[], added: string[] = []) => [...new Set([...previous, ...added])]
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
export function assertDeliveryProposalPersisted(ledger: ManagedLedger, operationId: string, receipt: DeliveryReceipt, step?: DeliveryStep): void {
  const operation = ledger.get(operationId), proposal = ledger.get(operationId.replace(/:operation$/, ':result'))
  const matches = (value: unknown) => {
    const result = value as { status?: string; receipt?: DeliveryReceipt } | undefined
    return result?.status === 'delivered-local' && JSON.stringify(result.receipt) === JSON.stringify(receipt)
  }
  if(!operationId.endsWith(':operation') || operation?.kind!=='coordination_operation' || (operation.data.proposal as any)?.kind!=='verify')throw Error('DELIVERY_PROPOSAL_NOT_DURABLE')
  const attachment=ledger.get(operationId+':delivery-completion'), p=attachment?.data.payload as any
  const attached=operation?.data.state==='completed' && (operation.data.result as any)?.status==='reconciled' && attachment?.kind==='coordination_runtime_event' && attachment.data.event==='published_delivery_completion' && p?.operationRef?.id===operation.id && p.operationRef.revision===operation.revision && p.operationSHA===createHash('sha256').update(JSON.stringify(operation)).digest('hex') && JSON.stringify(p.receipt)===JSON.stringify(receipt) && JSON.stringify(p.step?.ref)===JSON.stringify(receipt.stepRef) && p.step?.plannedCommit===receipt.commit && p.step?.finalTree===receipt.tree && matches(p.result) && !!step && JSON.stringify(p.step)===JSON.stringify(step)
  if(attached)return
  if (!operationId.endsWith(':operation') || operation?.kind !== 'coordination_operation' || operation.data.state !== 'completed' || (operation.data.proposal as any)?.kind !== 'verify' || !matches(operation.data.result) || proposal?.kind !== 'coordination_runtime_event' || proposal.data.event !== 'proposal_result' || !matches(proposal.data.payload)) throw Error('DELIVERY_PROPOSAL_NOT_DURABLE')
}

export async function releaseManagedSession(ledger: Pick<ManagedLedger, 'get'>, session: Pick<Awaited<ReturnType<typeof launchManagedCodex>>, 'launch' | 'stop' | 'cleanupCredentials'>) {
  const current = () => ledger.get(session.launch.actionRef.id)
  try {
    if ((current()?.data.receipt as any)?.stopped !== true) await session.stop()
    const deadline = Date.now() + 1000
    while ((current()?.data.receipt as any)?.stopped !== true && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    if ((current()?.data.receipt as any)?.stopped !== true) throw Error('NATIVE_CESSATION_UNKNOWN')
    return current()!.data.receipt!
  } finally { session.cleanupCredentials() }
}

export function latestFrameworkBaseline(ledger: ManagedLedger): any {
  const event = ledger.eventEntries({ runtimeEvent: 'framework_baseline_bound', latest: true })[0]?.body as any
  return event?.coordination.payload.payload
}

/** The normal publication boundary: receipt persisted, proposal completion still pending. */
export function persistManagedDeliveryResult(root: string, result: { step: DeliveryStep; receipt: DeliveryReceipt; binding: DeliveryAcceptanceBinding }) {
  const { step, receipt, binding } = result
  writeFileSync(join(root, 'delivery-result.json'), JSON.stringify({ step, receipt, binding }), { flag: 'wx', mode: 0o600 })
}

/** Only the trusted web-all host creates this runtime. JSON intake material cannot construct a grant. */
export function createManagedRuntime(config: ManagedRuntimeConfig) {
  mkdirSync(config.root, { recursive: true, mode: 0o700 })
  const method = managedVerificationMethod(config.verification?.methodId ?? 'codex-runTurn-replay@1', config.verification?.settings)
  if (config.verification?.settings && !config.publicFiles.includes(config.verification.settings.entryPath)) throw Error('VERIFICATION_MODULE_NOT_PUBLIC')
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
    const savedWorkspace = (ledger.eventEntries({ workspaceRoot: join(root, role) })[0]?.body as any)?.controlled.command.workspace
    const prepared = savedWorkspace ? { workspace: savedWorkspace, manifest: (role === 'collector' ? [] : config.publicFiles).map(path => ({ path, digest: createHash('sha256').update(gitBytes(savedWorkspace.root, ['show', savedWorkspace.baseline + ':' + path])).digest('hex') })) } : createManagedWorkspace(config.projectRoot, role === 'collector' ? [] : config.publicFiles, join(root, role), role === 'collector' ? 'collector' : 'engineering')
    if (!savedWorkspace) kernel.host.registerWorkspace(prepared.workspace); workspaces.set(role, prepared)
    if (role !== 'collector') workers.set(role, known('worker:'+role, () => coordination.host.registerWorker({ id: 'worker:' + role, host, profile, projects: [project], engineRef: 'codex', runtimeNamespace: role === 'coordinator' && config.bootstrapResume ? config.bootstrapResume.home : join(config.engine.stateRoot, role) })))
  }
  const supplemental = loadManagedMaterials(config.readOnlyMaterials)
  const native = new Map<string, Awaited<ReturnType<typeof launchManagedCodex>>>()
  type NativeSession = Awaited<ReturnType<typeof launchManagedCodex>>
  const coordinatorTurns = new NativeTurnQueue(), coordinatorInputs = new Map<string, NativeSession>()
  const requestScopes = new Map<NativeSession, { requests: NativeRequestScope; detach: () => void }>()
  const instructions = 'You are the accountable coordinating secretary across projects and professional agents. You have no business shell or tools. Produce only structured proposals; the host validates and executes them. Preserve the original user goal and constraints. Use independent quality before implementation. Technical questions stay inside the team. Never claim delivered or fulfilled while full project gates or delivery are missing. On intake propose one accept with requirement-derived criteria and all three responsibilities coordinator, implementation, quality. Criteria indexes are zero-based. Do not ask the user to relay technical matters.'
  const materials = new Map<string, ContextSource>()
  const compiler = createContextCompiler(ledger, coordination, ref => materials.get(ref.id))
  let work: Ref | undefined, contract: Ref | undefined, requirement: Ref | undefined, team: Ref[] = [], criteria: Ref[] = []
  const savedWork = ledger.snapshot('commitment').find(o => o.data.accountable === workers.get('coordinator')?.id)
  if (savedWork) { initialParent = undefined; work = { id: savedWork.id, revision: savedWork.revision }; requirement = (savedWork.data.requirement_refs as unknown as Ref[])[0]; contract = savedWork.data.acceptance_contract as unknown as Ref; team = ledger.snapshot('team_assignment').filter(o => o.data.commitment_id === work!.id).map(o => ({ id: o.id, revision: o.revision })); criteria = ledger.get(contract.id)!.data.criterion_refs as unknown as Ref[] }
  let delivered: { step: DeliveryStep; receipt: DeliveryReceipt; binding: DeliveryAcceptanceBinding; operationId: string } | undefined
  const deliveryBindings = new Map<string, DeliveryAcceptanceBinding>()
  const delivery = createManagedLocalDelivery({ ledger, source, storageRoot: join(root, 'delivery'), host: kernel.host, beforeFulfill: (step,receipt) => { if(!delivered)throw Error('DELIVERY_PROPOSAL_NOT_DURABLE');assertDeliveryProposalPersisted(ledger,delivered.operationId,receipt,step) }, binding: step => { const binding = deliveryBindings.get(step.ref.id); if (!binding) throw new Error('DELIVERY_BINDING_MISSING'); return binding } })
  let originalText = '', qaResult: any, lastResult: Json = null
  let abort = new AbortController(), amending = false, amendmentSuspended = false
  const ownerInput = new OwnerInputGate()
  const classificationAbort = new AbortController()
  let pendingAmendmentId: string | undefined
  const record = (event: string, payload: unknown, scopes: Ref[] = [project], evidence: string[] = []) => coordination.host.recordRuntimeEvent(event + ':' + randomUUID(), event, json(payload), scopes, evidence)
  const baselineEvent = ledger.eventEntries({ runtimeEvent: 'job_baseline', latest: true })[0]?.body as any
  if (savedWork) {
    initialParent = baselineEvent?.coordination.payload.payload.parent ?? undefined
    const intake = ledger.eventEntries({ runtimeEvent: 'authenticated_intake', latest: true })[0]?.body as any
    try { originalText = JSON.parse(intake?.coordination.payload.payload.text).userRequest ?? '' } catch { /* Historical inputs remain in the ledger. */ }
  } else if (!baselineEvent) record('job_baseline', { parent: initialParent ?? null }, [project])
  const pendingEvent = (ledger.eventEntries({ runtimeEvent: 'authenticated_amendment', latest: true })[0]?.body as any)?.coordination.payload
  const appliedEvent = (ledger.eventEntries({ runtimeEvent: 'amendment_applied', latest: true })[0]?.body as any)?.coordination.payload
  if (pendingEvent && appliedEvent?.payload?.inputId !== pendingEvent.id) { pendingAmendmentId = pendingEvent.id; amending = true }
  const stopped = ledger.eventEntries({ runtimeEvent: 'owner_interrupted', latest: true })[0]
  const pendingSequence = ledger.eventEntries({ runtimeEvent: 'authenticated_amendment', latest: true })[0]?.sequence ?? 0
  if (amending && stopped && stopped.sequence > pendingSequence) amendmentSuspended = true
  const scope = (role: string) => [workers.get(role)!, ...coordination.semanticScopes(work!.id), ...team.filter(r => (ledger.get(r.id)!.data.worker_ref as any)?.id === workers.get(role)!.id)]
  const assignment = (role: string) => team.find(r => (ledger.get(r.id)!.data.worker_ref as any)?.id === workers.get(role)!.id)!
  const attach = (role: string, session: Awaited<ReturnType<typeof launchManagedCodex>>, priorDomainEvidenceRef?: string) => {
    const fact = kernel.host.nativeFacts(session.io.stream, 'binding').find(f => (f.observation as any).kind === 'binding')!
    const existing = ledger.snapshot().some(o => o.kind === 'session_binding' && (o.data.worker_ref as any)?.id === workers.get(role)!.id)
    const binding = ledger.snapshot('session_binding').find(o => (o.data.worker_ref as any)?.id === workers.get(role)!.id)
    const retired = binding && ledger.retiredNativeDomain(binding.data.launch_ref as unknown as Ref)
    if (existing) coordination.host.resumeNativeSession(workers.get(role)!, fact.ref, priorDomainEvidenceRef ?? retired); else coordination.host.bindNativeSession(workers.get(role)!, fact.ref)
  }
  const contextFor = (role: string, instruction: string) => {
    instruction = JSON.stringify({ instruction, hostReadOnlyMaterials: supplemental, method: { id: method.id, description: method.description, instructions: method.instructions, responseSchema: method.qualitySchema(criteria), assets: method.assets }, hostExecution: 'During intake return purpose=intake and readiness; no candidate tests are claimed. After implementation the secretary proposes verify; host requests independent verification_design cases then runs the exact registered asynchronous method on baseline and candidate. Workers do not call a shell or invent a new tool. Fixed project gates and controlled local dev delivery follow only after business acceptance. Engineering gate/receipt obligations remain later prerequisites, never synthetic replay facts. If canonical-api-evidence contains frozenCases, the full cases are already inline: return the exact original criterion/input/expected values in verification_design, preserving order, without inventing a filesystem path or digest-only tool. The host freezes the current candidate bytes/modes/allowed-path mapping and binds current method qualification after your design; prior API evidence remains historical, never a new-candidate pass.' })
    const material = record('role_input', { role, instruction }, coordination.semanticScopes(work!.id))
    materials.set(material.id, { ref: material, text: instruction, digest: createHash('sha256').update(instruction).digest('hex'), visibleTo: [workers.get(role)!.id], mandatory: true, purpose: 'Current controlled professional instruction and observed evidence' })
    const sourceRefs = [material], apiEvidence = currentApiMaterial(ledger, {id:work!.id,revision:ledger.get(work!.id)!.revision}, join(root,'verification'))
    if (apiEvidence) {
      const apiSource = record('api_evidence_material', { role, digest: apiEvidence.digest, text: apiEvidence.text }, coordination.semanticScopes(work!.id))
      materials.set(apiSource.id, {ref:apiSource,text:apiEvidence.text,digest:apiEvidence.digest,visibleTo:[workers.get(role)!.id],mandatory:true,purpose:'Latest recorded API operation evidence and sealed cases; recorded candidate only'})
      sourceRefs.push(apiSource)
    }
    const envelope = compiler.compile({ commitmentId: work!.id, assignment: assignment(role), worker: workers.get(role)!, audience: [workers.get(role)!.id], purpose: role, sourceRefs, failedMethods: [], nativeContextBlindSpots: ['Native automatic context loading is not fully observable'] })
    return { envelope, ref: coordination.host.recordContext(envelope) }
  }
  const consumed = (role: string, context: ReturnType<typeof contextFor>, input: { request_id: string }, session: NativeSession) => {
    const fact = kernel.host.nativeFacts(session.io.stream, 'input-consumed').filter(f => (f.observation as any).kind === 'input-consumed' && (f.observation as any).consumption.request_id === input.request_id).at(-1)
    if (!fact) throw new Error('ACTUAL_NATIVE_CONSUMPTION_REQUIRED')
    const proof = (fact.observation as any).consumption
    return coordination.host.recordConsumedContext({ context: context.ref, requestId: input.request_id, assignmentRevision: assignment(role).revision, payloadDigest: context.envelope.digest, worker: workers.get(role)!, nativeSessionId: session.engine.identity.native_session_id, turnId: proof.turn_id, processingStartedEventRef: proof.processing_started_event_ref, nativeEvidenceRef: fact.ref })
  }
  const closeRole = async (role: string, session = native.get(role)) => {
    if (!session) return null
    const callbacks = requestScopes.get(session)
    if (callbacks) { await callbacks.requests.finish(callbacks.detach); requestScopes.delete(session) }
    return closeExactSession(native, role, session, owned => releaseManagedSession(ledger, owned))
  }
  const liveRole = (role: string) => {
    const session = native.get(role); if (!session) return undefined
    const action = ledger.get(session.launch.actionRef.id)!
    if ((action.data.receipt as any)?.stopped === true) { session.cleanupCredentials(); native.delete(role); return undefined }
    if (action.data.state !== 'sent') throw Error('NATIVE_CESSATION_UNKNOWN')
    return session
  }
  async function getCoordinator() {
    const existing = liveRole('coordinator'); if (existing) return existing
    const binding = ledger.snapshot('session_binding').find(o => (o.data.worker_ref as any)?.id === workers.get('coordinator')!.id)
    if (!binding) throw Error('COORDINATOR_ORIGINAL_THREAD_REQUIRED')
    const session = await launchManagedCodex(kernel, { ...config.engine, source, stateRoot: String(binding.data.runtime_namespace) }, workers.get('coordinator')!, workspaces.get('coordinator')!.workspace, scope('coordinator'), instructions, [], managedCoordinatorSchema, { home: String(binding.data.runtime_namespace), nativeSessionId: String(binding.data.native_session_id) })
    native.set('coordinator', session); attach('coordinator', session)
    return session
  }
  async function getOwnerClassifier() {
    const role = 'owner-classifier', home = join(config.engine.stateRoot, role)
    const worker = known('worker:' + role, () => coordination.host.registerWorker({ id: 'worker:' + role, host, profile, projects: [project], engineRef: 'codex', runtimeNamespace: home }))
    const existing = liveRole(role); if (existing) return existing
    const prior = ledger.eventEntries({ nativeKind: 'binding' }).map(({ body }: any) => body?.controlled?.command)
      .filter(command => (ledger.get(command?.actionRef?.id)?.data.execution_spec as any)?.target?.id === worker.id).at(-1)
    const identity = prior?.observation?.binding?.identity
    if (identity && identity.runtime_namespace !== home) throw Error('CLASSIFIER_IDENTITY_MISMATCH')
    for (const action of ledger.snapshot('action').filter(o => (o.data.execution_spec as any)?.kind === 'dispatch' && (o.data.execution_spec as any)?.target?.id === worker.id)) {
      if ((action.data.receipt as any)?.stopped === true || ledger.retiredNativeDomain({ id: action.id, revision: action.revision })) continue
      kernel.host.observeNativeDomainAbsence({ id: action.id, revision: action.revision })
    }
    const workspaceRoot = join(root, role)
    const saved = (ledger.eventEntries({ workspaceRoot })[0]?.body as any)?.controlled.command.workspace
    const workspace = saved ?? createManagedWorkspace(config.projectRoot, [], workspaceRoot, 'engineering').workspace
    if (!saved) kernel.host.registerWorkspace(workspace)
    const session = await launchManagedCodex(kernel, { ...config.engine, source, stateRoot: home }, worker, workspace, [worker, project],
      'Classify authenticated owner messages only. No business tools or execution. Return exactly one discussion or amendment answer; never accept, dispatch, verify or resume work.', [], ownerClassificationSchema,
      identity ? { home, nativeSessionId: identity.native_session_id } : undefined)
    native.set(role, session)
    return session
  }
  const roleInstructions = 'You are a professional worker in a controlled managed team. Use only registered managed read/write/check/ask. Never use shell, exec, browser, delegation, MCP or any other builtin. The input is a managed_input envelope; execute its text. Read actual source before judgments. check is only text equality, not tests. Technical uncertainty must use ask, never ask the user. Never claim whole-project tests or delivery happened without evidence.'
  async function getRole(role: string, schema?: Json) {
    const existing = liveRole(role)
    if (existing) return existing
    const oldBinding = ledger.snapshot().find(o => o.kind === 'session_binding' && (o.data.worker_ref as any)?.id === workers.get(role)!.id)
    let priorDomainEvidenceRef: string | undefined
    if (oldBinding) {
      const oldAction = ledger.get((oldBinding.data.launch_ref as unknown as Ref).id)!
      if ((oldAction.data.receipt as any)?.stopped !== true) {
        if (String(oldBinding.data.runtime_namespace) !== join(config.engine.stateRoot, role)) throw Error('NATIVE_CESSATION_UNKNOWN')
        priorDomainEvidenceRef = ledger.retiredNativeDomain({id:oldAction.id,revision:oldAction.revision}) ?? kernel.host.observeNativeDomainAbsence({id:oldAction.id,revision:oldAction.revision}).nativeRef
        rmSync(join(String(oldBinding.data.runtime_namespace),'auth.json'),{force:true})
      }
    }
    const resume = oldBinding ? { home: String(oldBinding.data.runtime_namespace), nativeSessionId: String(oldBinding.data.native_session_id) } : undefined
    const session = await launchManagedCodex(kernel, { ...config.engine, source, stateRoot: join(config.engine.stateRoot, role) }, workers.get(role)!, workspaces.get(role)!.workspace, scope(role), roleInstructions, nativeFileToolSchemas, schema ?? (role === 'quality' ? method.qualitySchema(criteria) : undefined), resume)
    native.set(role, session); attach(role, session, priorDomainEvidenceRef)
    const helpers = new ControlledFileTools(kernel, session.launch, process.execPath, { writePaths: role === 'implementation' ? [...config.implementationWritePaths] : [] })
    const requests = new NativeRequestScope()
    const detach = session.engine.onRequest(request => { requests.accept(async () => { try {
      const p = request.params as any
      if (request.method !== 'item/tool/call') { await session.engine.respondNativeRequest(request.ref, { error: { code: -32000, message: 'Unqualified native tool refused' } }, session.launch); return }
      let reply: { success: boolean; text: string }
      if (p.tool === 'ask') {
        await deliverTechnicalReply(async () => {
        const evidence = kernel.host.nativeFacts(session.io.stream, 'request').filter(f => (f.observation as any).kind === 'request' && (f.observation as any).request.ref.id === request.ref.id).at(-1)!
        const question = coordination.host.recordQuestion({ commitmentId: work!.id, assignment: assignment(role), worker: workers.get(role)!, nativeRequestRef: request.ref.id, question: p.arguments.question, evidenceRefs: [evidence.ref], nativeEvidenceRef: evidence.ref, nextReviewAt: Date.now()+60000 })
        const answer = await askSecretary('Technical request from '+role+': '+p.arguments.question+'\nReturn exactly an answer proposal with questionId '+question.id+'. Resolve internally from current requirements. No user relay.')
        const decision = answer.proposals.find(p => p.kind === 'answer' && p.questionId === question.id)
        if (!decision?.answer) throw new Error('COORDINATOR_TECHNICAL_ANSWER_REQUIRED')
        const d = coordination.recordProfessionalDecision({ commitmentId: work!.id, question, reviewer: workers.get('coordinator')!, kind: 'technical_answer', conclusion: decision.answer, evidenceRefs: answer.nativeEvidenceRefs, alternatives: [decision.reason], scopeRefs: coordination.semanticScopes(work!.id) })
        record('technical_answer_sent', { question, decision: d }, scope(role)); return { success: true, text: decision.answer }
        }, reply => session.engine.respondNativeRequest(request.ref, { result: { success: reply.success, contentItems: [{type:'inputText',text:reply.text}] } }, session.launch), error => { record('technical_answer_failed', {role,request:request.ref.id,error:String(error),workerResponseAttempted:false}, scope(role)) })
        return
      } else if (role === 'quality' && p.tool === 'write') reply = { success: false, text: 'INDEPENDENT_QUALITY_READ_ONLY' }
      else reply = await helpers.call(p.tool, p.arguments, request.ref.id)
      await session.engine.respondNativeRequest(request.ref, { result: { success: reply.success, contentItems: [{ type: 'inputText', text: reply.text }] } }, session.launch)
    } catch (error) { record('native_request_unknown', { role, request: request.ref.id, error: String(error) }); } }) })
    requestScopes.set(session, { requests, detach })
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
    try {
    const result = await runManagedOperationTurn(ledger,coordination,operationId,role,workers.get(role)!,context.ref,session,abort.signal)
    const proof = consumed(role, context, result.input, session)
    const evidence = record('professional_result', { operationId, role, answer: result.answer, nativeSessionId: session.engine.identity.native_session_id, turnId: result.receipt.consumption.turn_id }, scope(role), [proof.id])
    if (role === 'quality') {
      qaResult = JSON.parse(result.answer)
      if (method.id === 'javascript-module@1' && qaResult.purpose === 'verification_design') qaResult.cases = parseModuleVerificationCases(qaResult.cases)
      if (qaResult.purpose === 'intake') coordination.host.recordTeamReview(work!.id, workers.get(role)!, team, [evidence.id, proof.id], intakeReadiness(qaResult))
    }
    return { status: 'observed', role, evidence, answer: result.answer } as unknown as Json
    } finally { await closeRole(role, session) }
  }
  async function askSecretary(text: string, signal: AbortSignal = abort.signal, classification = false) {
    return coordinatorTurns.run(async () => {
    if (signal.aborted) throw Error('COORDINATOR_CANCELLED')
    const session = classification ? await getOwnerClassifier() : await getCoordinator()
    try {
    const context = classification ? undefined : contextFor('coordinator', text), requestId = 'coordination:'+randomUUID()
    coordinatorInputs.set(requestId, session)
    let batch: { proposals: RuntimeProposal[] }
    try { batch = await ports.coordinator({ request_id: requestId, assignment_revision: context ? assignment('coordinator').revision : 1, text: context?.envelope.text ?? text }, signal) }
    finally { coordinatorInputs.delete(requestId) }
    const proof = context && consumed('coordinator', context, { request_id: requestId }, session)
    record(classification ? 'owner_message_classification' : 'coordinator_proposals', batch as unknown as Json, classification ? [project] : scope('coordinator'), proof ? [proof.id] : kernel.host.nativeFactRefs(session.io.stream))
    const nativeEvidenceRefs = kernel.host.nativeFactRefs(session.io.stream).slice(-4)
    return { ...batch, nativeEvidenceRefs }
    } finally { await closeRole(classification ? 'owner-classifier' : 'coordinator', session) }
    })
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
    if (amending) throw Error('OWNER_INPUT_PENDING')
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
    const live = () => !abort.signal.aborted && !amending && ledger.get(current.id)?.revision === current.revision && ledger.applicability(current.id) === 'usable' && verifyProjectSeal(seal) && git(targetRoot, ['rev-parse', 'HEAD']) === initialParent
    for (const [index, gate] of gates.entries()) {
      const observation = await runProjectVerification({ sealedCandidate: seal, workRoot: gateWork, collectorRoot: collector, gate, authorizationVersion: settings.authorizationVersion, signal: abort.signal, liveFence: live })
      const observationPath = join(observation.keeperRef.root, 'project-observation.json'), observationDigest = createHash('sha256').update(readFileSync(observationPath)).digest('hex')
      record('project_gate_observed', { gate, tree: provisional.finalTree, sourceDigest: seal.digest, observationPath, observationDigest, exit: observation.exit, complete: observation.complete, errors: observation.errors }, coordination.semanticScopes(work!.id), [observationPath])
      if (!observation.complete || observation.exit.code !== 0 || observation.errors.length || !observation.isolationCurrent) return json({ status: 'project-gate-failed', gate, ...apiResult, observationPath, observationDigest, baseline, instruction: 'Return exact gate evidence to original implementation/quality sessions; no Git publication occurred.' })
      observations.push({ ref: gateRefs[index]!, gate, observationPath, observationDigest })
    }
    await ownerInput.beforeDelivery()
    if (!live()) throw Error('DELIVERY_EXECUTION_FENCED')
    const target = service.enterDelivery({ id: current.id, revision: current.revision }, apiResult.evaluation)
    work = target
    const workspace = { id: provisional.action.workspaceId, root: targetRoot, source: targetRoot, repositoryId: realGitDir, baseline: initialParent, branch: 'dev', resources: resourceIds(realGitDir, 'dev'), sourceStatus: 'exact-tree:' + provisional.finalTree, role: 'engineering' as const }
    kernel.host.registerWorkspace(workspace)
    const expiresAt = Date.now() + 60000, control = kernel.host.grantControl(target, 'host-local-delivery', expiresAt)
    const step = { ...provisional, action: { ...provisional.action, target, epoch: control.epoch, scopeRefs: service.requiredActionScopes(target.id) } }
    const binding: DeliveryAcceptanceBinding = { ref: step.acceptanceRef, candidate: apiResult.candidate, evaluation: apiResult.evaluation, seal, authorizationVersion: settings.authorizationVersion, gates: observations, method: { id: method.id, ...(config.verification?.settings ? { settings: config.verification.settings } : {}), assetsDigest: methodAssetDigest(JSON.stringify(method.assets)) } }
    readDeliveryAcceptance(ledger, step, binding)
    deliveryBindings.set(step.ref.id, binding)
    writeFileSync(join(root,'delivery-intent.json'),JSON.stringify({step,binding,apiResult,baseline,operationId}),{flag:'wx',mode:0o600})
    const spec = prepareDeliveryStep(step)
    kernel.host.grantCapability({ id: spec.capabilityRef.id, revision: 1, expiresAt, scopeRefs: spec.scopeRefs, evidenceRefs: observations.map(g => g.observationDigest), externalTools: 'blocked', revoked: false, launch: { executable: spec.executable, args: spec.args, processPolicy: 'single' }, expectedDevTransition: spec.expectedDevTransition })
    kernel.host.grantMandate({ id: spec.mandateRef.id, revision: 1, requester: spec.requester, subject: spec.subject, target, workspaceId: workspace.id, resourceIds: workspace.resources, actions: ['deliver'], scopeRefs: spec.scopeRefs, expiresAt, revoked: false })
    const action = kernel.actions.planAction(spec); kernel.actions.claimResources(action.ref, workspace.resources)
    const receipt = await delivery.execute(step, action.ref)
    delivered = { step, receipt, binding, operationId }
    persistManagedDeliveryResult(root, delivered)
    return json({ status: 'delivered-local', ...apiResult, commitment: work, receipt, priorPlatformGoal: 'unchanged' })
  }
  const qualifications = ['coordinator','roles','context','executor','verifier','observer'].map(id => ({ plugin_id: 'builtin:'+id, version: '1.0.0', evidence_ref: id === 'verifier' ? 'P4a:independent-fix1-qualified-json-equality' : 'P5a:independent-canonical-and-ports-pass/P3:actual-native', expires_at: Date.now()+1800000 }))
  const ports = createManagedPorts<{ proposals: RuntimeProposal[] }>({
    coordinator: { run: (input, signal) => {
      const session = coordinatorInputs.get(input.request_id)
      if (!session) throw Error('COORDINATOR_INPUT_SESSION_REQUIRED')
      return new CodexCoordinatorRuntime(session.engine, validateRuntimeProposals).run(input, signal)
    } },
    roles: { plan: coordination.planProfessionalTeam }, context: compiler,
    executor: { async operate(input) { const p = ledger.get(input.payloadRef.id)!.data.payload as any; lastResult = await runRole(p.role, p.instruction, p.operationId); return { status: 'requested', evidenceRefs: [(lastResult as any).evidence.id] } } },
    verifier: { methods: ['json-equality@1'], async request(input) { if (input.method !== 'json-equality@1') throw new Error('METHOD_NOT_QUALIFIED'); lastResult = await verifyCandidate(String((ledger.get(input.context.id)!.data.payload as any).instruction),String((ledger.get(input.context.id)!.data.payload as any).operationId)); return { status: 'requested', evidenceRefs: [(lastResult as any).evaluation.id] } } },
    observer: createMaintenanceObserver(ledger),
  }, () => ({ contract_version: '1.0.0', schema_versions: ['2'], permissions: ['propose','coordinate','read-context','controlled-execute','verify','observe'], extensions: ['maintenance/source@1'], isolated_modes: ['controlled'], now: Date.now(), qualifications }), undefined, validateRuntimeProposals)
  const completeOperation = (operationId: string, result: Json) => {
    const operation=ledger.get(operationId)!
    const evidence=(operation.data.executions as unknown as import('./protocol/coordination.ts').OperationExecution[]).flatMap(execution=>execution.kind==='native'?kernel.host.nativeFactRefs(execution.stream, 'turn-page'):[])
    return coordination.host.completeOperation({id:operation.id,revision:operation.revision},result,evidence)
  }
  const reconcileOperations = () => ledger.snapshot('coordination_operation').filter(o=>o.data.state!=='completed').map(operation=>{
    try { const proof=completeOperation(operation.id,{status:'reconciled',operation:operation.id,basis:'Persisted exact native input completion or controlled receipts; not an acceptance verdict'}); return {operation:proof,status:'reconciled'} }
    catch { return {operation:{id:operation.id,revision:operation.revision},status:'unknown'} }
  })
  const interpreter = createProposalInterpreter(ledger, coordination, async (raw, key) => {
    const p = raw as unknown as RuntimeProposal
    if (p.kind === 'accept') {
      if ((work && !amending) || !p.intake || !p.intake.criteria.length) throw new Error('INTAKE_PROPOSAL_REQUIRED')
      const v = p.intake, parent = config.parentPlan, id = randomUUID()
      const priorWork = work && ledger.get(work.id)
      if (priorWork) {
        const previousRequirement = ledger.get(requirement!.id)!, previousContract = ledger.get(contract!.id)!
        const oldDelivery = ledger.get((priorWork.data.delivery_contract as unknown as Ref).id)!
        v.deliveryCriteria = preserveManagedDeliveryCriteria(((oldDelivery.data.criterion_refs ?? []) as unknown as Ref[]).map(r => String(ledger.get(r.id)!.data.intent)), v.deliveryCriteria)
        v.results = [...new Set([...(previousRequirement.data.observable_results as string[]), ...v.results])]
        v.constraints = [...new Set([...(previousRequirement.data.constraints as string[]), ...v.constraints])]
        for (const ref of previousContract.data.criterion_refs as unknown as Ref[]) {
          const text = String(ledger.get(ref.id)!.data.intent)
          if (!v.criteria.includes(text)) { const index = v.criteria.length; v.criteria.push(text); for (const a of v.assignments) a.criteria.push(index) }
        }
        await api.stopNative()
        const current = ledger.get(priorWork.id)!
        if (current.data.control_state !== 'paused') ledger.transact([{ id: current.id, revision: current.revision }], [{ kind: 'control', id: current.id, control_state: 'paused', reason: 'Authenticated amendment replaces candidate contract', evidence_refs: [source.id] }])
      }
      const makeRequirement = (id: string, intent: string, results: string[], constraints: string[]) => ({ id, kind: 'requirement', revision: 1, scope_revision_refs: [], extensions: {}, data: { intent, source_refs: [source], wish_refs: [], observable_results: results, constraints, criterion_sources: [source.id] } } as unknown as ManagedObject)
      requirement = { id: 'requirement:' + id, revision: 1 }; contract = { id: 'contract:' + id, revision: 1 }
      criteria = v.criteria.map((_, i) => ({ id: 'criterion:' + id + ':' + i, revision: 1 }))
      const deliveryCriteria = (v.deliveryCriteria ?? []).map((_, i) => ({ id: 'delivery-criterion:' + id + ':' + i, revision: 1 }))
      const deliveryRef = { id: 'delivery:' + id, revision: 1 }, stepRef = { id: 'delivery-step:' + id, revision: 1 }
      const objects = [makeRequirement(requirement.id, v.goal, v.results, v.constraints), ...v.criteria.map((text,i) => ({ ...makeRequirement(criteria[i]!.id, text, [text], []), scope_revision_refs: [requirement!] })), ...(v.deliveryCriteria ?? []).map((text,i) => ({ ...makeRequirement(deliveryCriteria[i]!.id, text, [text], []), scope_revision_refs: [requirement!] })), { id: contract.id, kind: 'acceptance_contract', revision: 1, data: { intent: v.goal, requirement_refs: [requirement], criterion_refs: criteria, source_refs: [source] }, scope_revision_refs: [requirement, ...criteria], extensions: {} }, { id: deliveryRef.id, kind: 'delivery_contract', revision: 1, data: { intent: 'Exact local dev delivery after independent business acceptance and full project gates', requirement_refs: [requirement], step_refs: [stepRef], source_refs: [source], criterion_refs: deliveryCriteria, evidence_policy: DELIVERY_EVIDENCE_POLICY }, scope_revision_refs: [requirement, ...deliveryCriteria], extensions: {} }] as unknown as ManagedObject[]
      ledger.transact([], objects.map(object => ({ kind: 'create', object })))
      if (parent) record('parent_goal_pending', { requirements: parent as unknown as Json, status: 'pending', reason: 'Separate prior platform outcome; this business delivery does not fulfill or discard it.' }, [project])
      const spec = { id: priorWork?.id ?? 'work:' + id, intent: v.goal, requirements: [requirement], acceptanceContract: contract, deliveryContract: deliveryRef, projects: [project], boundary: 'Only host-authorized paths; independent business acceptance plus exact-tree project gates before controlled local dev commit; no push or deployment', accountable: workers.get('coordinator')!.id, policy, nextReviewAt: Date.now()+60000 }
      const assignments = v.assignments.map(a => ({ role: a.role, applicable: true, basis: a.basis, worker: workers.get(a.role) ?? null, deliverables: a.deliverables, consumers: a.consumers, criteria: a.criteria.map(i => criteria[i]!), dependencies: [], combinationBasis: '' }))
      if (priorWork) record('amendment_plan', { inputId: pendingAmendmentId!, acceptanceContract: contract, assignments }, [project])
      work = priorWork ? coordination.host.amendManagedIntent({ id: priorWork.id, revision: ledger.get(priorWork.id)!.revision }, spec, [source.id]) : coordination.acceptManagedIntent(source, spec)
      team = priorWork ? coordination.host.replanProfessionalTeam(work, assignments) : ports.plan(work, assignments)
      if (priorWork) record('amendment_applied', { inputId: pendingAmendmentId!, commitment: work, contract, team }, [project])
      amending = false
      pendingAmendmentId = undefined
      const old = native.get('coordinator'), binding = ledger.snapshot('session_binding').find(o => (o.data.worker_ref as any)?.id === workers.get('coordinator')!.id)
      const resume = old ? { home: old.home, nativeSessionId: old.engine.identity.native_session_id } : binding ? { home: String(binding.data.runtime_namespace), nativeSessionId: String(binding.data.native_session_id) } : undefined
      if (old) await closeRole('coordinator')
      const next = await launchManagedCodex(kernel, { ...config.engine, source, stateRoot: resume!.home }, workers.get('coordinator')!, workspaces.get('coordinator')!.workspace, scope('coordinator'), instructions, [], managedCoordinatorSchema, resume)
      native.set('coordinator', next); attach('coordinator', next)
      return json({ status: 'accepted', commitment: work, team, criteria, parentRequirementsPreserved: true })
    }
    if (p.kind === 'dispatch') {
      const payload = record('dispatch_instruction', { operationId:key, role: p.role, instruction: p.instruction }, coordination.semanticScopes(work!.id))
      await ports.operate({ operation: 'dispatch', target: workers.get(p.role)!, payloadRef: payload })
      completeOperation(key,lastResult)
      return lastResult
    }
    if (p.kind === 'look') return { status: 'observed', reconciledOperations:reconcileOperations() as unknown as Json, objects: ledger.snapshot().filter(o => !['action','coordination_runtime_event','context_envelope','context_input'].includes(o.kind)).map(coordinationObjectView) as unknown as Json, runtimeEvents: ledger.snapshot('coordination_runtime_event').filter(o => ['proposal_unknown','independent_api_verification'].includes(String(o.data.event))).map(o => ({ ref: { id:o.id,revision:o.revision },event:o.data.event,payload:o.data.payload })).slice(-20) as unknown as Json }
    if (p.kind === 'wait') return { status: 'waiting', reason: p.reason, nextReviewAt: Date.now()+60000 }
    if (p.kind === 'verify') { const request=record('verification_instruction',{operationId:key,instruction:p.instruction},coordination.semanticScopes(work!.id)); await ports.verify({ method: 'json-equality@1', context: request }); completeOperation(key,lastResult); return lastResult }
    throw new Error('PROPOSAL_NOT_EXECUTABLE_IN_THIS_CONTEXT')
  }, { preflight(raw) { const p=raw as unknown as RuntimeProposal; if (abort.signal.aborted) throw Error('MANAGED_TURN_ABORTED'); if (amending && !['accept','look','wait'].includes(p.kind)) throw Error('AMENDMENT_CONTRACT_REQUIRED'); if(p.kind==='dispatch') assertRoleDispatchReady(p.role); else if(p.kind==='verify') assertVerificationReady() }, executionSlots(raw) { const p=raw as unknown as RuntimeProposal; return p.kind==='dispatch'?[p.role]:p.kind==='verify'?['quality','collect:baseline','collect:candidate']:[] }, domains(raw) {
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
    amendmentPending: () => amending,
    holdOwnerMessage: (id: string) => ownerInput.hold(id),
    async routeMessage(text: string, id = 'anonymous'): Promise<{ kind: 'discussion' | 'amendment'; answer: string }> {
      ownerInput.hold(id)
      if (!work) throw Error('OWNER_MESSAGE_INTAKE_PENDING')
      return ownerInput.classify(async () => {
        const batch = await askSecretary(JSON.stringify({ ownerMessageId: id, ownerMessage: text, task: ledger.get(work!.id), contract: contract && ledger.get(contract.id), requirements: requirement && ledger.get(requirement.id), instruction: 'Classify this authenticated owner message without executing it. Return exactly one answer proposal. Set role="discussion" for progress questions, explanations and discussion; answer it using current facts. Set role="amendment" only when the owner actually requests changes or explicitly resumes work; preserve their exact request in answer. Do not accept, dispatch, verify, or answer native technical questions in this classification turn. Ordinary conversation never changes the contract.' }), classificationAbort.signal, true)
        const response = batch.proposals[0]
        if (batch.proposals.length !== 1 || response?.kind !== 'answer' || !['discussion','amendment'].includes(response.role) || typeof response.answer !== 'string' || !response.answer.trim()) throw Error('OWNER_MESSAGE_CLASSIFICATION_REQUIRED')
        return { kind: response.role as 'discussion' | 'amendment', answer: response.answer }
      }, id)
    },
    async reconcile(): Promise<{ state: 'ready' | 'pending' | 'paused' | 'delivered' | 'unstarted'; reason?: string }> {
      if (work && ledger.get(work.id)!.data.control_state !== 'autonomous' && (!amending || amendmentSuspended)) return { state: 'paused' }
      for (const action of ledger.snapshot('action').filter(o => (o.data.execution_spec as any)?.kind === 'dispatch')) {
        if ((action.data.receipt as any)?.stopped === true || ledger.retiredNativeDomain({ id: action.id, revision: action.revision })) continue
        try { kernel.host.observeNativeDomainAbsence({ id: action.id, revision: action.revision }) }
        catch (error) { return { state: 'pending', reason: 'Original writer not yet proved absent: ' + String(error) } }
      }
      if (!work) {
        const fact = (ledger.eventEntries({ nativeKind: 'binding', latest: true })[0]?.body as any)?.controlled.command
        const identity = fact?.observation?.binding?.identity
        if (identity) {
          if (identity.runtime_namespace !== join(config.engine.stateRoot, 'coordinator')) return { state: 'pending', reason: 'Bootstrap native domain is not the configured coordinator.' }
          config.bootstrapResume = { home: identity.runtime_namespace, nativeSessionId: identity.native_session_id }
        }
        abort = new AbortController()
        return { state: 'unstarted' }
      }
      if (ledger.get(work.id)!.data.state === 'fulfilled') {
        const saved = JSON.parse(readFileSync(join(root, 'delivery-result.json'), 'utf8'))
        deliveryBindings.set(saved.step.ref.id, saved.binding)
        delivered = saved
        if (api.deliveryEvaluation().verdict !== 'pass') return { state: 'pending', reason: 'Published delivery evidence no longer verifies.' }
        return { state: 'delivered' }
      }
      if (api.hasPublishedDelivery()) { await api.recoverPublishedDelivery(); return { state: 'delivered' } }
      if (amending && ledger.get(work.id)!.data.control_state === 'paused') {
        const current = ledger.get(work.id)!
        work = coordination.host.resumeForAmendment({ id: current.id, revision: current.revision }, [pendingAmendmentId!])
      }
      reconcileOperations()
      const observation = record('recovery_observed', { commitment: work, reason: 'Native writers ceased; original artifacts and unanswered requests retained for diagnosis.' }, [project])
      try { coordination.host.retireInterruptedOperations(work.id, [observation.id]) }
      catch (error) { return { state: 'pending', reason: String(error) } }
      abort = new AbortController()
      return { state: 'ready' }
    },
    interrupt(reason: string, origin: 'owner' | 'lifecycle' | 'amendment' = 'owner') {
      abort.abort()
      ownerInput.clearAmendment()
      if (origin === 'amendment') {
        const earlier = pendingAmendmentId && (ledger.get(pendingAmendmentId)!.data.payload as any).text
        const event = record('authenticated_amendment', { text: earlier ? earlier + '\n' + reason : reason }, [project])
        pendingAmendmentId = event.id; amending = true; amendmentSuspended = false
      } else {
        record(origin === 'owner' ? 'owner_interrupted' : 'lifecycle_interrupted', { reason }, [project])
        if (origin === 'owner' && amending) amendmentSuspended = true
      }
      if (work && origin !== 'lifecycle') {
        const current = ledger.get(work.id)!
        if (current.data.control_state !== 'paused' && !['fulfilled','released','withdrawn','broken'].includes(String(current.data.state))) {
          const result = ledger.transact([{ id: current.id, revision: current.revision }], [{ kind: 'control', id: current.id, control_state: 'paused', reason, evidence_refs: [source.id] }])
          if (result.kind !== 'committed') throw Error('MANAGED_CONTROL_CONFLICT')
          work = result.refs[0]!
        }
      }
      const liveTargets = new Map<string, Ref>()
      for (const action of ledger.snapshot('action')) {
        const spec = action.data.execution_spec as any
        if (spec?.kind === 'dispatch' && (action.data.receipt as any)?.stopped !== true && workers.has(String(spec.target?.id).replace(/^worker:/, ''))) liveTargets.set(spec.target.id, spec.target)
      }
      for (const target of liveTargets.values()) kernel.host.revokeControl(target, source)
    },
    async wake(text: string): Promise<{ requestId: string; proposals: { proposals: RuntimeProposal[] } }> {
      if (amending && !amendmentSuspended) return api.amend((ledger.get(pendingAmendmentId!)!.data.payload as any).text)
      if (!work) throw Error('MANAGED_WORK_MISSING')
      const current = ledger.get(work.id)!
      if (current.data.control_state !== 'autonomous') throw Error('CONTROL_LOST')
      const launches = ledger.snapshot('action').filter(o => (o.data.execution_spec as any)?.kind === 'dispatch')
      if (launches.some(o => (o.data.receipt as any)?.stopped !== true && !ledger.retiredNativeDomain({ id: o.id, revision: o.revision }))) throw Error('NATIVE_CESSATION_UNKNOWN')
      reconcileOperations()
      abort = new AbortController()
      if (amending) return api.amend((ledger.get(pendingAmendmentId!)!.data.payload as any).text)
      return { requestId: 'review:' + randomUUID(), proposals: await askSecretary(JSON.stringify({ instruction: text, lastResults: lastResult, next: 'Continue the original task from actual durable state. Return look if diagnosis is needed. Do not abandon responsibility or repeat unknown effects.' })) }
    },
    async amend(text: string): Promise<{ requestId: string; proposals: { proposals: RuntimeProposal[] } }> {
      if (!work) { abort = new AbortController(); return api.bootstrap(text) }
      if (ledger.get(work.id)?.data.state === 'delivering' || existsSync(join(root, 'delivery-intent.json'))) throw Error('PUBLISHED_DELIVERY_RECONCILIATION_REQUIRED')
      const launches = ledger.snapshot('action').filter(o => (o.data.execution_spec as any)?.kind === 'dispatch')
      if (launches.some(o => (o.data.receipt as any)?.stopped !== true && !ledger.retiredNativeDomain({ id: o.id, revision: o.revision }))) throw Error('NATIVE_CESSATION_UNKNOWN')
      abort = new AbortController(); amending = true
      ownerInput.clearAmendment()
      if (amendmentSuspended) { pendingAmendmentId = undefined; amendmentSuspended = false }
      const event = pendingAmendmentId ? { id: pendingAmendmentId } : record('authenticated_amendment', { text }, [project])
      pendingAmendmentId = event.id
      const plan = (ledger.eventEntries({ runtimeEvent: 'amendment_plan', latest: true })[0]?.body as any)?.coordination.payload.payload
      if (plan?.inputId === pendingAmendmentId && JSON.stringify(ledger.get(work.id)!.data.acceptance_contract) === JSON.stringify(plan.acceptanceContract)) {
        const currentTeam = ledger.snapshot('team_assignment').filter(o => o.data.commitment_id === work!.id)
        if (currentTeam.some(o => ledger.applicability(o.id) !== 'usable')) team = coordination.host.replanProfessionalTeam({ id: work.id, revision: ledger.get(work.id)!.revision }, plan.assignments)
        record('amendment_applied', { inputId: pendingAmendmentId, commitment: work, contract, team }, [project])
        amending = false; pendingAmendmentId = undefined
        return api.wake('The interrupted contract amendment is durably applied; obtain fresh independent quality review and continue the retained candidate.')
      }
      const current = ledger.get(work.id)!
      if (current.data.control_state === 'paused') work = coordination.host.resumeForAmendment({ id: current.id, revision: current.revision }, [event.id])
      return { requestId: 'amend:' + event.id, proposals: await askSecretary(JSON.stringify({ instruction: text, originalRequest: originalText, next: 'Return one accept proposal with a full revised intake for this SAME responsibility. Preserve previous results, constraints, criteria and all responsibilities; add the new requirement. Do not dispatch or verify until that amendment is accepted. Keep the original native threads and candidate for repair.' })) }
    },
    deliveryEvaluation: () => delivered && ledger.get(delivered.step.action.target.id)?.data.state === 'fulfilled' ? delivery.verifyDeliveryReceipt(delivered.step.ref, delivered.receipt) : { verdict: 'fail' as const, reason: 'No independently verified local delivery', receipt: null },
    resultReport: () => delivered && ledger.get(delivered.step.action.target.id)?.data.state === 'fulfilled' ? delivery.report(delivered.step.ref, delivered.receipt) : undefined,
    hasPublishedDelivery() { return existsSync(join(root,'delivery-intent.json')) && ledger.get(work!.id)?.data.state === 'delivering' },
    async recoverPublishedDelivery() {
      if(native.size)throw Error('DELIVERY_RECOVERY_NOT_QUIESCENT')
      const intent=JSON.parse(readFileSync(join(root,'delivery-intent.json'),'utf8')) as {step:DeliveryStep;binding:DeliveryAcceptanceBinding;apiResult:any;baseline:unknown;operationId:string}
      const operation=ledger.get(intent.operationId)
      if(!operation||operation.kind!=='coordination_operation'||(operation.data.proposal as any)?.kind!=='verify'||intent.step.action.target.id!==work?.id)throw Error('DELIVERY_RECOVERY_OPERATION_REQUIRED')
      deliveryBindings.set(intent.step.ref.id,intent.binding)
      const recovered=await delivery.recoverPublished(intent.step.ref)
      delivered={...recovered,binding:intent.binding,operationId:intent.operationId}
      const result=json({status:'delivered-local',...intent.apiResult,commitment:recovered.step.action.target,receipt:recovered.receipt,priorPlatformGoal:'unchanged'})
      const resultPath=join(root,'delivery-result.json')
      if(existsSync(resultPath)){
        let stored: unknown
        try { stored=JSON.parse(readFileSync(resultPath,'utf8')) } catch { throw Error('DELIVERY_RECOVERY_RESULT_CONFLICT') }
        if(!isDeepStrictEqual(stored,{step:delivered.step,receipt:delivered.receipt,binding:delivered.binding}))throw Error('DELIVERY_RECOVERY_RESULT_CONFLICT')
      } else persistManagedDeliveryResult(root,delivered)
      const currentOperation=ledger.get(intent.operationId)!
      if(currentOperation.data.state==='completed' && (currentOperation.data.result as any)?.status==='reconciled') {
        const prior=currentOperation.data.result as any
        if(prior.operation!==intent.operationId || prior.basis!=='Persisted exact native input completion or controlled receipts; not an acceptance verdict')throw Error('DELIVERY_RECOVERY_OPERATION_CONFLICT')
        coordination.host.recordRuntimeEvent(intent.operationId+':delivery-completion','published_delivery_completion',json({operationRef:{id:currentOperation.id,revision:currentOperation.revision},operationSHA:createHash('sha256').update(JSON.stringify(currentOperation)).digest('hex'),step:recovered.step,receipt:recovered.receipt,result,acceptance:{ref:intent.binding.ref,sealDigest:intent.binding.seal.digest,evaluation:intent.binding.evaluation,gates:intent.binding.gates}}),recovered.step.action.scopeRefs,[String(operation.data.input_ref),recovered.receipt.commit])
      } else {
        if(currentOperation.data.state==='completed'){if(JSON.stringify(currentOperation.data.result)!==JSON.stringify(result))throw Error('DELIVERY_RECOVERY_OPERATION_CONFLICT')}
        else completeOperation(intent.operationId,result)
        coordination.host.recordRuntimeEvent(intent.operationId.replace(/:operation$/,':result'),'proposal_result',result,scope('coordinator'),[String(operation.data.input_ref)])
      }
      assertDeliveryProposalPersisted(ledger,intent.operationId,recovered.receipt,recovered.step)
      work=delivery.fulfill(recovered.step,recovered.receipt)
      const text=delivery.report(recovered.step.ref,recovered.receipt)
      record('local_delivery_verified',{commitment:work,receipt:recovered.receipt,text,recoveredFrom:intent.step.action.id},[project],[recovered.receipt.commit])
      return json({status:'fulfilled-local',commitment:work,receipt:recovered.receipt,text,priorPlatformGoal:'unchanged'})
    },
    async bootstrap(text: string, signal: AbortSignal = abort.signal) {
      originalText = text
      text = JSON.stringify({ userRequest: text, supportedVerificationMethod: { id: method.id, description: method.description }, sourceFiles: config.publicFiles, allowedWritePaths: config.implementationWritePaths, trustedMaterials: config.initialMaterials ?? '', engineeringPrerequisites: 'Put only business method assertions in criteria; put exact-tree gates, allowed-path local dev commit and truthful delivery in deliveryCriteria. Preserve all original results/constraints. Independent qualified business acceptance, all exact-tree project gates, controlled local dev commit. Prior M1 platform obligations remain separate pending work; do not treat them as this task criteria or silently fulfill them.' })
      const worker = workers.get('coordinator')!, home = config.bootstrapResume?.home ?? join(config.engine.stateRoot, 'coordinator')
      const session = await launchManagedCodex(kernel, { ...config.engine, source, stateRoot: home }, worker, workspaces.get('coordinator')!.workspace, [worker, project], instructions, [], managedCoordinatorSchema, config.bootstrapResume)
      native.set('coordinator', session)
      const requestId = 'bootstrap:' + randomUUID()
      coordination.host.recordRuntimeEvent(requestId, 'authenticated_intake', { text, projectRoot: config.projectRoot, manifest: workspaces.get('implementation')!.manifest }, [project], [source.id])
      coordinatorInputs.set(requestId, session)
      let proposals: { proposals: RuntimeProposal[] }
      try { proposals = await ports.coordinator({ request_id: requestId, assignment_revision: 1, text }, signal) }
      finally { coordinatorInputs.delete(requestId) }
      coordination.host.recordRuntimeEvent(requestId + ':proposals', 'coordinator_proposals', proposals as unknown as Json, [project], kernel.host.nativeFactRefs(session.io.stream))
      return { requestId, proposals, identity: session.engine.identity }
    },
    async prepareContinuation() {
      if (!work || native.size) throw Error('MANAGED_CONTINUATION_NOT_QUIESCENT')
      const partition = config.contractPartition && !ledger.get('contract-partition:' + work.id + ':' + config.contractPartition.acceptance.revision) ? config.contractPartition : undefined
      const handoff = config.interruptedVerificationHandoff
      if (handoff && (handoff.commitment.id !== work.id || handoff.candidateRoot !== workspaces.get('implementation')!.workspace.root || JSON.stringify(handoff.candidate.map(x => x.path).sort()) !== JSON.stringify([...config.publicFiles].sort()))) throw Error('VERIFY_HANDOFF_CANDIDATE_SCOPE')
      if (handoff) { verifyPartitionCandidate(handoff); verifyPartitionCandidate({ ...handoff, candidateRoot: workspaces.get('quality')!.workspace.root }) }
      const launches = ledger.snapshot('action').filter(o => (o.data.execution_spec as any)?.kind === 'dispatch')
      if (!launches.length) throw Error('MANAGED_CONTINUATION_WRITER_UNKNOWN')
      const domainQuiescenceProofs: string[] = []
      for (const action of launches.filter(o => (o.data.receipt as any)?.stopped !== true)) {
        const spec = action.data.execution_spec as any
        const binding = ledger.snapshot('session_binding').find(o => (o.data.worker_ref as any)?.id === workers.get('quality')!.id)
        if (binding && (binding.data.launch_ref as any)?.id !== action.id) {
          const retired = ledger.retiredNativeDomain({id:action.id,revision:action.revision})
          if (retired) { domainQuiescenceProofs.push(retired); continue }
        }
        if (spec.target.id !== workers.get('quality')!.id || !binding || (binding.data.launch_ref as any)?.id !== action.id || String(binding.data.runtime_namespace) !== join(config.engine.stateRoot, 'quality')) throw Error('MANAGED_CONTINUATION_WRITER_UNKNOWN')
        const observation = kernel.host.observeNativeDomainAbsence({id:action.id,revision:action.revision})
        domainQuiescenceProofs.push(observation.nativeRef)
        rmSync(join(String(binding.data.runtime_namespace),'auth.json'),{force:true})
      }
      // Completed native input is reconciled by the existing exact-terminal guard.
      // Domain absence alone never completes an operation or claims business acceptance.
      reconcileOperations()
      const unresolved = ledger.snapshot('coordination_operation').filter(o => o.data.state !== 'completed' && !partitionHandoff(ledger, o, contract ? [contract] : []))
      if (unresolved.length && JSON.stringify(unresolved.map(o => ({ id: o.id, revision: o.revision }))) !== JSON.stringify(partition?.operations ?? (handoff ? [handoff.operation] : []))) throw Error('MANAGED_CONTINUATION_NOT_QUIESCENT')
      if (partition && (partition.commitment.id !== work.id || partition.candidateRoot !== workspaces.get('implementation')!.workspace.root || JSON.stringify(partition.candidate.map(x => x.path).sort()) !== JSON.stringify([...config.publicFiles].sort()))) throw Error('PARTITION_CANDIDATE_SCOPE')
      if (partition) verifyPartitionCandidate(partition)
      const transition = config.frameworkBaselineTransition, head = git(config.projectRoot, ['rev-parse', 'HEAD'])
      const previous = latestFrameworkBaseline(ledger)
      if (!transition || transition.commitmentId !== work.id || !transition.evidenceRefs.length || transition.after !== head || (previous && previous.after !== transition.before && previous.after !== transition.after)) throw Error('MANAGED_BASELINE_TRANSITION_REQUIRED')
      if (git(config.projectRoot, ['merge-base', transition.before, head]) !== transition.before) throw Error('MANAGED_BASELINE_NOT_DESCENDANT')
      for (const role of ['coordinator','implementation','quality']) {
        const prepared = workspaces.get(role)!
        if (prepared.workspace.sourceStatus !== 'explicit-public-input:' + createHash('sha256').update(JSON.stringify(prepared.manifest)).digest('hex')) throw Error('MANAGED_PUBLIC_INPUT_CHANGED')
      }
      for (const path of config.publicFiles) {
        const before = treeEntries(config.projectRoot, transition.before).get(path), after = treeEntries(config.projectRoot, head).get(path)
        if (!before || !after || before.blob !== after.blob || before.mode !== after.mode) throw Error('MANAGED_BASELINE_BUSINESS_CHANGED')
        for (const sourceRoot of [config.projectRoot, ...['coordinator','implementation','quality'].map(role => workspaces.get(role)!.workspace.root)]) { if ((partition && sourceRoot === partition.candidateRoot) || (handoff && [handoff.candidateRoot, workspaces.get('quality')!.workspace.root].includes(sourceRoot))) continue; const entry = file(sourceRoot, path); if (!entry || entry.blob !== before.blob || entry.mode !== before.mode) throw Error('MANAGED_CANDIDATE_NOT_UNCHANGED') }
      }
      record('framework_baseline_bound', { ...transition, materialDigest: supplemental.digest, stoppedLaunches: launches.filter(o => (o.data.receipt as any)?.stopped === true).map(o => ({ id: o.id, revision: o.revision })), domainQuiescenceProofs }, [project], transition.evidenceRefs)
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
          const proof = consumed('quality', context, result.input, session)
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
      if (handoff && !ledger.get('verify-handoff:' + handoff.operation.id + ':' + handoff.operation.revision)) coordination.host.handoffInterruptedVerification(handoff)
      initialParent = head
      return { head, materialDigest: supplemental.digest, ...(partition ? { contractPartition: 'contract-partition:' + work.id + ':' + partition.acceptance.revision } : {}) }
    },
    async resume(text: string) {
      if (!work) throw new Error('MANAGED_WORK_MISSING')
      if (!initialParent) throw Error('MANAGED_BASELINE_TRANSITION_REQUIRED')
      const binding = ledger.snapshot().find(o => o.kind === 'session_binding' && (o.data.worker_ref as any)?.id === workers.get('coordinator')!.id)!
      const session = await launchManagedCodex(kernel, { ...config.engine, source, stateRoot: String(binding.data.runtime_namespace) }, workers.get('coordinator')!, workspaces.get('coordinator')!.workspace, scope('coordinator'), instructions, [], managedCoordinatorSchema, { home: String(binding.data.runtime_namespace), nativeSessionId: String(binding.data.native_session_id) })
      native.set('coordinator', session); attach('coordinator', session)
      return { requestId: 'resume:'+randomUUID(), proposals: await askSecretary(JSON.stringify({ instruction: text, hostInterruptedVerification: ledger.snapshot('coordination_runtime_event').filter(o => o.data.event === 'verify_interrupted_handoff').map(o => o.data.payload), hostContractPartition: ledger.snapshot('coordination_runtime_event').filter(o => o.data.event === 'contract_partition').map(o => o.data.payload), continuationRule: 'Old interrupted operations and unanswered request records remain history, not success. Their old native RPC is terminated; address outstanding technical content in the new original-thread turns, never claim the old request was answered. '+(coordination.dispatchReadiness(work.id).ready?'The current team intake is already approved. Continue its retained candidate and current outstanding evidence; do not repeat intake or team mapping.':'Obtain original independent quality approval of the current team mapping before implementation.') })) }
    },
    async advance(batch: { requestId: string; proposals: { proposals: RuntimeProposal[] } }) {
      const outcomes: Json[] = []
      let current = batch
      for (let turn = 0; turn < 8; turn++) {
        let result: Json[], applied = false
        try { result = await interpreter.apply(current.requestId, current.proposals.proposals as unknown as Json[], work && !amending ? coordination.semanticScopes(work.id) : [project]); applied = true } catch (error) { result = [{ status: 'refused_or_unknown', reason: String(error), instruction: 'Inspect durable operation/native facts; correct proposals internally. Never bypass quality or automatically repeat unknown effects.' }] }
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
        if (abort.signal.aborted) throw Error('MANAGED_TURN_ABORTED')
        if (current.proposals.proposals.some(p => p.kind === 'wait') || turn === 7) break
        const text = JSON.stringify({ observedResults: result, next: (coordination.dispatchReadiness(work!.id).ready?'Continue from the durable current phase and these actual results. Current independent team intake is approved; do not repeat intake or regenerate a completed candidate. A complete verification design goes directly to controlled replay. Observed candidate failure goes to the original implementation thread, then independent verification.':'First obtain independent quality approval of the criteria before implementation.')+' Criteria ids: '+criteria.map(r=>r.id).join(',')+'. The implementation must use ask if uncertain; technical matters stay internal. After candidate implementation request independent verify. After independent acceptance passes, the host runs the configured project gates and exact local dev delivery automatically. Only host receipt-backed reporting can claim completion; if a gate fails, use its actual evidence for original-thread repair.' })
        current = { requestId: 'advance:'+randomUUID(), proposals: await askSecretary(text) }
      }
      return outcomes
    },
    async stopNative(): Promise<Json[]> {
      const results: Json[] = []
      for (const callbacks of requestScopes.values()) await callbacks.requests.finish(callbacks.detach)
      await coordinatorTurns.settled()
      for (const role of [...native.keys()]) { try { results.push({ role, receipt: await closeRole(role) }) } catch (error) { results.push({ role, error: String(error), stopped: false }) } }
      return results
    },
    stopClassification() { classificationAbort.abort() },
    async dispose() { classificationAbort.abort(); const results = await api.stopNative(); ledger.close(); return results }
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
  beforeFulfill?(step: DeliveryStep, receipt: DeliveryReceipt): void
}) {
  const port = createLocalGitDelivery({ storageRoot: input.storageRoot, verifyReceipt: inspectDeliveryReceipt,
    readAcceptance: step => readDeliveryAcceptance(input.ledger, step, input.binding(step), true),
    fence: ref => { const result = input.host.fenceDispatch(ref); if (result.kind !== 'envelope') throw new Error('DELIVERY_EXECUTION_FENCED'); return result },
    authorizeRecovery: (before, after, journalDigest, proof) => {
      const o=input.ledger.get(proof.id),p=o?.data.payload as any
      if(!o||o.revision!==proof.revision||o.kind!=='coordination_runtime_event'||o.data.event!=='local_delivery_reauthorization'||JSON.stringify(p)!==JSON.stringify({before,after,journalDigest}))throw Error('DELIVERY_RECOVERY_PROOF_REQUIRED')
    },
  })
  const fulfill = createDeliveryFulfillment(input.ledger, input.source, (step, receipt) => {
    input.beforeFulfill?.(step,receipt)
    const acceptance = readDeliveryAcceptance(input.ledger, step, input.binding(step), true)
    const evaluation = inspectDeliveryReceipt(step, receipt)
    if (evaluation.verdict !== 'pass') throw new Error('DELIVERY_NOT_VERIFIED:' + evaluation.reason)
    return acceptance
  })
  const api = Object.freeze({
    prepareDeliveryStep,
    async execute(step: DeliveryStep, action: Ref): Promise<DeliveryReceipt> {
      const existing = input.ledger.get(action.id)
      if (existing?.data.state === 'confirmed' && JSON.stringify(existing.data.execution_spec) === JSON.stringify(prepareDeliveryStep(step))) {
        readDeliveryAcceptance(input.ledger,step,input.binding(step),true)
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
    async recoverPublished(ref: Ref) {
      const state=port.reconcile(ref)
      if(state.stage==='aligned'&&state.receipt){
        if(port.verifyDeliveryReceipt(ref,state.receipt).verdict!=='pass')throw Error('DELIVERY_RECONCILIATION_FAILED')
        const action=input.ledger.get(state.step.action.id)!
        const confirmed=action.data.state==='confirmed'?{ref:{id:action.id,revision:action.revision}}:input.host.reconcileAction({id:action.id,revision:action.revision},{status:'confirmed',stopped:true,evidenceRefs:['local-git:'+state.receipt.commit+':'+state.receipt.tree]}) as ActionRecord
        return {step:state.step,receipt:{...state.receipt,actionRef:confirmed.ref}}
      }
      const observed=port.inspectPublished(ref),before=observed.step
      readDeliveryAcceptance(input.ledger,before,input.binding(before),true)
      const rechecked=port.inspectPublished(ref)
      if(rechecked.journalDigest!==observed.journalDigest)throw Error('DELIVERY_RECOVERY_JOURNAL_CHANGED')
      const original=input.ledger.get(before.action.id)
      if(!original||JSON.stringify(original.data.execution_spec)!==JSON.stringify(prepareDeliveryStep(before)))throw Error('DELIVERY_PREDECESSOR_CHANGED')
      input.host.retirePartialDelivery({id:original.id,revision:original.revision},createHash('sha256').update(JSON.stringify(original.data.execution_spec)).digest('hex'),observed.journalDigest)
      const id=before.action.id+':recovery:'+randomUUID(),expiresAt=Date.now()+60000,control=input.host.grantControl(before.action.target,before.action.subject,expiresAt)
      const step:DeliveryStep={...before,action:{...before.action,id,idempotencyKey:id,epoch:control.epoch,capabilityRef:{id:id+':cap',revision:1},mandateRef:{id:id+':mandate',revision:1}}},spec=prepareDeliveryStep(step)
      const proof=createCoordinationService(input.ledger,input.source).host.recordRuntimeEvent(id+':authorization','local_delivery_reauthorization',json({before,after:step,journalDigest:observed.journalDigest}),spec.scopeRefs,['delivery-journal:'+observed.journalDigest])
      input.host.grantCapability({deliveryRecovery:proof,id:spec.capabilityRef.id,revision:1,scopeRefs:spec.scopeRefs,evidenceRefs:['delivery-journal:'+observed.journalDigest],expiresAt,externalTools:'blocked',revoked:false,launch:{executable:spec.executable,args:spec.args,processPolicy:spec.processPolicy},expectedDevTransition:spec.expectedDevTransition})
      input.host.grantMandate({id:spec.mandateRef.id,revision:1,requester:spec.requester,subject:spec.subject,target:spec.target,workspaceId:spec.workspaceId,resourceIds:spec.resourceIds,actions:['deliver'],scopeRefs:spec.scopeRefs,expiresAt,revoked:false})
      const kernel=createControlledKernel(input.ledger,input.source),action=kernel.actions.planAction(spec)
      kernel.actions.claimResources(action.ref,spec.resourceIds)
      port.reauthorize(ref,step,proof)
      return {step,receipt:await api.execute(step,action.ref)}
    },
  })
  return api
}

export function continuationVersion(prior: Record<string, any>, item: Record<string, any>) {
  const { error, endedAt, report, result, continuationStartedAt, baseline, ...retained } = prior
  return { ...retained, state: 'queued', continuations: [...(prior.continuations ?? []), item], priorOutcome: { state: prior.state, error, endedAt, report, result, continuationStartedAt, baseline, priorOutcome: prior.priorOutcome } }
}

export interface ManagedHostConfig { bootstrapFile: string }
interface HostProjects {
  root: string
  defaultProject: string
  projects: Record<string, Omit<ManagedRuntimeConfig, 'root' | 'engine'> & { engine: Omit<ManagedEngineConfig, 'source' | 'stateRoot'> }>
}
export type ManagedAdmissionRequest = AdmissionRequest
export function managedAdmissionRuntime(runtime: ReturnType<typeof createManagedRuntime>, settings: Pick<ManagedRuntimeConfig, 'frameworkBaselineTransition'>): AdmissionRuntime {
  return {
    holdOwnerMessage: runtime.holdOwnerMessage, stopClassification: runtime.stopClassification, routeMessage: runtime.routeMessage, amendmentPending: runtime.amendmentPending, reconcile: runtime.reconcile,
    start: async text => runtime.advance(await runtime.bootstrap(text)),
    wake: async text => {
      const proof = await runtime.reconcile()
      if (proof.state === 'delivered') return { status: 'delivery-reconciled' }
      if (proof.state === 'paused') throw Error('CONTROL_LOST')
      if (proof.state === 'pending') throw Error('RECOVERY_PENDING:' + proof.reason)
      return runtime.advance(await runtime.wake(text))
    },
    amend: async text => {
      if (runtime.hasPublishedDelivery()) throw Error('PUBLISHED_DELIVERY_RECONCILIATION_REQUIRED')
      if (settings.frameworkBaselineTransition) await runtime.prepareContinuation()
      return runtime.advance(await runtime.amend(text))
    },
    interrupt: runtime.interrupt,
    stopNative: async () => { const results = await runtime.stopNative(); if (results.some((r: any) => r.stopped === false)) throw Error('NATIVE_CESSATION_UNKNOWN'); return results },
    dispose: runtime.dispose, deliveryEvaluation: runtime.deliveryEvaluation, resultReport: runtime.resultReport,
  }
}
/** Bind delayed readiness to the authorization of this invocation. */
export function gateManagedAdmissionRuntime(port: AdmissionRuntime, waitReady: () => Promise<void>): AdmissionRuntime {
  let epoch = 0, disposed = false
  const invoke = async (method: 'start' | 'wake' | 'amend', text: string) => {
    const authorizedEpoch = epoch
    if (disposed) throw Error('MANAGED_ADMISSION_DISPOSED')
    await waitReady()
    if (disposed) throw Error('MANAGED_ADMISSION_DISPOSED')
    if (epoch !== authorizedEpoch) throw Error('MANAGED_INVOCATION_INTERRUPTED')
    return port[method](text)
  }
  return { ...port,
    interrupt: (...args) => { epoch++; return port.interrupt(...args) },
    start: text => invoke('start', text), wake: text => invoke('wake', text), amend: text => invoke('amend', text),
    dispose: async () => { if (disposed) return; disposed = true; epoch++; await port.dispose() },
  }
}
/** Host-only factory injection also lets lifecycle contracts run without a model or credentials. */
export function createManagedAdmission(config: ManagedHostConfig, onResult: (request: ManagedAdmissionRequest, result: { state: string; reason?: string; evaluate: () => import('./protocol/delivery.ts').DeliveryEvaluation }) => void, ports?: { runtime?(project: string, root: string): AdmissionRuntime; notice?(request: ManagedAdmissionRequest, text: string): void }) {
  const stat = statSync(config.bootstrapFile)
  if (!stat.isFile() || stat.mode & 0o022 || (process.getuid?.() !== 0 && stat.uid !== process.getuid?.())) throw new Error('MANAGED_HOST_BOOTSTRAP_TRUST_REQUIRED')
  const raw = JSON.parse(readFileSync(config.bootstrapFile, 'utf8')) as HostProjects
  if (!raw.root || !raw.defaultProject || !Object.hasOwn(raw.projects ?? {}, raw.defaultProject)) throw new Error('MANAGED_HOST_PROJECT_REQUIRED')
  mkdirSync(raw.root, { recursive: true, mode: 0o700 })
  const identity = managedLoadedIdentity()
  const calibrations = new Map<string, { state: string; evidence?: Awaited<ReturnType<typeof calibrateManagedMethod>>; error?: string; done: Promise<void> }>()
  for (const project of Object.values(raw.projects)) {
    const entry = project.verification?.methodId === 'javascript-module@1' ? project.verification.settings?.entryPath : undefined
    if (!entry || calibrations.has(entry)) continue
    const item: { state: string; evidence?: Awaited<ReturnType<typeof calibrateManagedMethod>>; error?: string; done: Promise<void> } = { state: 'pending', done: Promise.resolve() }
    item.done = calibrateManagedMethod(entry).then(evidence => {
      item.evidence = evidence; item.state = 'pass'
      const path = join(raw.root, 'readiness-' + identity.generation + '-' + methodAssetDigest(entry) + '.json'), bytes = JSON.stringify(evidence)
      if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx', mode: 0o400 })
      else if (readFileSync(path, 'utf8') !== bytes) throw Error('MANAGED_CALIBRATION_EVIDENCE_CHANGED')
    }).catch(error => { item.state = 'fail'; item.error = error instanceof Error ? error.message.split(':')[0] : 'CALIBRATION_FAILED' })
    calibrations.set(entry, item)
  }
  const projectReadiness = (id: string) => {
    const verification = raw.projects[id]!.verification, entry = verification?.settings?.entryPath, calibration = entry ? calibrations.get(entry) : undefined
    const qualification = verification?.qualification
    const matches = !!qualification && calibration?.state === 'pass' && qualification.runtimeDigest === identity.runtimeDigest && qualification.methodAssetsDigest === calibration.evidence?.methodAssetsDigest && qualification.expiresAt > Date.now() && qualification.evidenceRefs.length > 0
    return { id, ready: matches, methodId: verification?.methodId ?? null, calibration: calibration?.state ?? 'unconfigured', methodAssetsDigest: calibration?.evidence?.methodAssetsDigest ?? null, qualificationMatches: matches, expiresAt: qualification?.expiresAt ?? null, controls: calibration?.evidence?.results ?? [], error: calibration?.error ?? null }
  }
  let admissionDisposed = false
  const admission = createAdmissions({
    root: realpathSync(raw.root), projects: Object.keys(raw.projects), defaultProject: raw.defaultProject, onResult, onNotice: ports?.notice,
    projectsView: () => Object.entries(raw.projects).map(([id, project]) => ({ id, default: id === raw.defaultProject, verificationMethod: project.verification?.methodId ?? null })),
    materialDigest: project => loadManagedMaterials(raw.projects[project]!.readOnlyMaterials).digest,
    runtime: ports?.runtime ?? ((project, root) => {
      const settings = raw.projects[project]!
      const runtime = createManagedRuntime({ ...settings, root, engine: { ...settings.engine, stateRoot: join(root, 'native') } })
      const port = managedAdmissionRuntime(runtime, settings)
      const waitReady = async () => {
        if (admissionDisposed) throw Error('MANAGED_ADMISSION_DISPOSED')
        if (!settings.verification) return
        const item = calibrations.get(settings.verification.settings?.entryPath ?? '')
        if (item) await item.done
        if (admissionDisposed) throw Error('MANAGED_ADMISSION_DISPOSED')
        if (!projectReadiness(project).ready) throw Error('MANAGED_VERIFICATION_NOT_READY')
      }
      return gateManagedAdmissionRuntime(port, waitReady)
    }),
  })
  return { ...admission, readiness: () => ({ ...identity, ready: !admissionDisposed && Object.keys(raw.projects).every(id => projectReadiness(id).ready), projects: Object.keys(raw.projects).map(projectReadiness) }), dispose: async () => { admissionDisposed = true; await admission.dispose(); await Promise.all([...calibrations.values()].map(item => item.done)) } }
}
