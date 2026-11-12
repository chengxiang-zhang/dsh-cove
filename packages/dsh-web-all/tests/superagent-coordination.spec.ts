import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedLedger } from '../src/host/services/superagent/kernel/managed-ledger.ts'
import { validateManagedObject, type ManagedObject } from '../src/host/services/superagent/protocol/managed-work.ts'
import { fixture as controlledFixture } from './fixtures/superagent/controlled.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('amends the same paused commitment and retires its old contracts without adopting a live writer', async () => {
  const f = await coordinationFixture()
  const team = f.service.planProfessionalTeam(f.commitment, f.assignments)
  f.ledger.transact([f.commitment], [{ kind: 'control', id: f.commitment.id, control_state: 'paused', reason: 'Owner added a requirement', evidence_refs: ['message:update'] }])
  const paused = { id: f.commitment.id, revision: f.ledger.get(f.commitment.id)!.revision }
  const next = { ...requirement(), id: 'r2' }
  f.ledger.transact([], [{ kind: 'create', object: next },
    { kind: 'create', object: { ...f.ledger.get('contract')!, id: 'contract2', data: { ...f.ledger.get('contract')!.data, requirement_refs: [{ id: 'r2', revision: 1 }] }, scope_revision_refs: [{ id: 'r2', revision: 1 }] } },
    { kind: 'create', object: { ...f.ledger.get('delivery')!, id: 'delivery2', data: { ...f.ledger.get('delivery')!.data, requirement_refs: [{ id: 'r2', revision: 1 }] }, scope_revision_refs: [{ id: 'r2', revision: 1 }] } }])
  const amended = f.service.host.amendManagedIntent(paused, { id: f.commitment.id, intent: 'Preserve successful answers with the additional case', requirements: [{ id: 'r2', revision: 1 }], acceptanceContract: { id: 'contract2', revision: 1 }, deliveryContract: { id: 'delivery2', revision: 1 }, projects: [f.project], boundary: String(f.ledger.get('work')!.data.boundary), accountable: 'coordinator:owner', policy: f.policy, nextReviewAt: Date.now() + 60000 }, ['message:update'])
  expect(amended.id).toBe(f.commitment.id)
  expect(f.ledger.get('work')!.data).toMatchObject({ control_state: 'autonomous', requirement_revision: 2, acceptance_contract: { id: 'contract2', revision: 1 } })
  expect(f.ledger.applicability(team[0]!.id)).toBe('recheck_required')
  expect(f.service.dispatchReadiness('work').ready).toBe(false)
  expect(f.service.host.replanProfessionalTeam(amended, f.assignments)).toHaveLength(3)
  expect(f.ledger.get(team[0]!.id)!.revision).toBe(2)
  f.ledger.close()
})
const requirement = (): ManagedObject => ({ id: 'r', kind: 'requirement', revision: 1,
  data: { intent: 'Preserve successful answers', source_refs: [{ id: 'user-message', revision: 1 }], wish_refs: [], observable_results: ['Successful diagnostic answers remain successful'], constraints: ['Real authentication failures stay failures'], criterion_sources: ['original user intent'] }, scope_revision_refs: [], extensions: {} })

it('registered versioned extensions validate payloads, retain opaque optional fields after reopen and cannot override core', async () => {
  const { createExtensionRegistry } = await import('../src/host/services/superagent/protocol/extensions.ts')
  const registry = createExtensionRegistry([{ namespace: 'maintenance/source', schema: 1, owner: 'maintenance', validate: (p: unknown) => !!p && typeof p === 'object' && Object.keys(p).length === 1 && 'digest' in p && typeof p.digest === 'string' }])
  const root = mkdtempSync(join(tmpdir(), 'p5-')); roots.push(root)
  const path = join(root, 'ledger'); let ledger = new ManagedLedger(path, { extensions: registry })
  const item = { ...requirement(), extensions: { 'maintenance/source': { required: true, schema: 1, payload: { digest: 'source-v1' } }, 'future/optional': { required: false, schema: 7, payload: { opaque: [1] } } } }
  expect(() => validateManagedObject(item)).toThrow('UNKNOWN_REQUIRED_EXTENSION')
  ledger.transact([], [{ kind: 'create', object: item }]); ledger.close()
  ledger = new ManagedLedger(path, { extensions: registry })
  expect(ledger.get('r')?.extensions).toEqual(item.extensions)
  for (const payload of [{ digest: 42 }, { digest: 'ok', state: 'fulfilled' }])
    expect(() => ledger.transact([], [{ kind: 'create', object: { ...item, id: 'bad', extensions: { 'maintenance/source': { required: true, schema: 1, payload } } } }])).toThrow()
  expect(() => ledger.transact([], [{ kind: 'create', object: { ...item, id: 'bad-version', extensions: { 'maintenance/source': { required: true, schema: 2, payload: { digest: 'x' } } } } }])).toThrow('UNKNOWN_REQUIRED_EXTENSION')
  ledger.close()
  ledger = new ManagedLedger(path)
  expect(ledger.applicability('r')).toBe('recheck_required')
  ledger.close()
})

async function coordinationFixture(attach = false, extensionRegistry?: import('../src/host/services/superagent/protocol/extensions.ts').ExtensionRegistry) {
  const { createCoordinationService } = await import('../src/host/services/superagent/coordination/intake.ts')
  const controlled = controlledFixture(); roots.push(controlled.dir)
  let { ledger, k } = controlled
  if (extensionRegistry) {
    controlled.ledger.close(); ledger = new ManagedLedger(controlled.path, { extensions: extensionRegistry })
    const { createControlledKernel } = await import('../src/host/services/superagent/kernel/actions.ts')
    k = createControlledKernel(ledger, controlled.sourceRef)
  }
  ledger.transact([], [{ kind: 'create', object: requirement() }, { kind: 'create', object: { ...requirement(), id: 'criterion:success', data: { ...requirement().data, intent: 'Actual criterion definition: preserve complete diagnostic answer text' } } }, { kind: 'create', object: { id: 'contract', kind: 'acceptance_contract', revision: 1, data: { intent: 'Preserve user intent', requirement_refs: [{ id: 'r', revision: 1 }], criterion_refs: [{ id: 'criterion:success', revision: 1 }], source_refs: [{ id: 'user-message', revision: 1 }] }, scope_revision_refs: [{ id: 'r', revision: 1 }], extensions: {} } }, { kind: 'create', object: { id: 'delivery', kind: 'delivery_contract', revision: 1, data: { intent: 'local dev commit only', requirement_refs: [{ id: 'r', revision: 1 }], step_refs: [], source_refs: [] }, scope_revision_refs: [{ id: 'r', revision: 1 }], extensions: {} } }])
  const service = createCoordinationService(ledger, { id: 'host:authenticated-owner', revision: 1 })
  const host = service.host.registerHost({ id: 'host:local', authority: 'local-test-host', evidenceRefs: ['host-attestation'] })
  const project = service.host.registerProject({ id: 'project:parser', intent: 'Parser maintenance', repositoryIdentity: 'repository:fixture', hosts: [host], sourceRefs: [{ id: 'user-message', revision: 1 }] })
  const policy = service.host.registerPolicy({ id: 'policy:engineering', roles: [{ name: 'implementation', required: true, independentOf: [] }, { name: 'quality', required: true, independentOf: ['implementation'] }, { name: 'experience', required: false, independentOf: [] }] })
  const profile = service.host.registerProfile({ id: 'profile:qualified', capabilities: ['implementation', 'quality'], evidenceRefs: ['qualification:actual-probe'], expiresAt: Date.now() + 60000, limitations: ['fixture only'] })
  const native = new Map<string, { observe: (observation: unknown) => string; identity: Record<string, string>; fence: () => unknown; launch: import('../src/host/services/superagent/kernel/actions.ts').ExecutionEnvelope; evidence: string }>()
  const launchers: ((scoped?: boolean, bind?: boolean, commitmentId?: string) => void)[] = []
  const worker = (id: string) => {
    const seat = service.host.registerWorker({ id, host, profile, projects: [project], engineRef: 'codex@1', runtimeNamespace: 'test-native' })
    const connect = (scoped = true, bind = true, commitmentId = 'work') => {
    const separate = controlledFixture(); roots.push(separate.dir); separate.ledger.close()
    k.host.registerWorkspace(separate.workspace)
    const expiresAt = Date.now() + 60000
    k.host.grantMandate({ id: 'mandate:' + id, revision: 1, requester: 'owner', subject: id, target: seat, actions: ['dispatch', 'inspect', 'respond_request'], workspaceId: separate.workspace.id, resourceIds: separate.workspace.resources, scopeRefs: [seat], expiresAt, revoked: false })
    const control = k.host.grantControl(seat, id, expiresAt)
    const semantic = ledger.get(commitmentId) ? service.semanticScopes(commitmentId) : []
    const assignments = ledger.snapshot().filter(o => o.kind === 'team_assignment' && o.data.commitment_id === commitmentId && (o.data.worker_ref as any)?.id === seat.id).map(o => ({ id: o.id, revision: o.revision }))
    const spec = { ...controlled.spec('launch:' + id), target: seat, subject: id, epoch: control.epoch, mandateRef: { id: 'mandate:' + id, revision: 1 }, scopeRefs: scoped ? [seat, ...semantic, ...assignments] : [seat], workspaceId: separate.workspace.id, resourceIds: separate.workspace.resources }
    const action = k.actions.planAction(spec); k.actions.claimResources(action.ref, spec.resourceIds)
    const launch = k.host.beginDispatch(action.ref); if (launch.kind === 'denial') throw Error(launch.code)
    const observe = (observation: unknown) => k.host.observeNative(launch.actionRef, 'stream:' + id, observation as never).nativeRef
    const identity = { host_ref: host.id, engine_ref: 'codex@1', runtime_namespace: 'test-native', native_session_id: id + '-native' }
    const evidence = observe({ kind: 'binding', binding: { identity, ref: { id: 'native:' + id, revision: 1 }, launchRef: launch.actionRef, epoch: control.epoch } })
    native.set(id, { observe, identity, launch, evidence, fence: () => k.host.fenceDispatch(launch.actionRef) })
    if (bind) {
      try { service.host.bindNativeSession(seat, evidence) } catch (error) { ledger.close(); throw error }
    }
    }
    if (attach) connect(); else launchers.push(connect)
    return seat
  }
  const implementer = worker('worker:implementation'), reviewer = worker('worker:review')
  const commitment = service.acceptManagedIntent({ id: 'host:authenticated-owner', revision: 1 }, { id: 'work', intent: 'Keep successful diagnostic answers successful', requirements: [{ id: 'r', revision: 1 }], acceptanceContract: { id: 'contract', revision: 1 }, deliveryContract: { id: 'delivery', revision: 1 }, projects: [project], boundary: 'Local isolated work only', accountable: 'coordinator:owner', policy, nextReviewAt: Date.now() + 10000 })
  const assignments = [
    { role: 'implementation', applicable: true, basis: 'Actual parser defect', worker: implementer, deliverables: ['source patch'], consumers: ['quality'], criteria: [{ id: 'criterion:success', revision: 1 }], dependencies: [], combinationBasis: '' },
    { role: 'quality', applicable: true, basis: 'Independent user-result checks', worker: reviewer, deliverables: ['independent verdict'], consumers: ['implementation'], criteria: [{ id: 'criterion:success', revision: 1 }], dependencies: [], combinationBasis: '' },
    { role: 'experience', applicable: false, basis: 'No interface layout change', worker: null, deliverables: [], consumers: [], criteria: [], dependencies: [], combinationBasis: '' }
  ]
  return { k, ledger, service, host, project, policy, profile, implementer, reviewer, commitment, assignments, native, attachWorkers: (scoped = true, bind = true, commitmentId = 'work') => launchers.splice(0).forEach(connect => connect(scoped, bind, commitmentId)), path: controlled.path }
}

it('requires canonical projects and complete professional coverage with generation-independent quality', async () => {
  const f = await coordinationFixture()
  expect(f.ledger.get('work')?.data.project_refs).toEqual([f.project])
  expect(() => f.service.planProfessionalTeam(f.commitment, f.assignments.slice(0, 2))).toThrow('RESPONSIBILITY_COVERAGE')
  expect(() => f.service.planProfessionalTeam(f.commitment, f.assignments.map(a => ({ ...a, combinationBasis: 'Same small task', ...(a.role === 'quality' ? { worker: f.implementer } : {}) })))).toThrow('INDEPENDENCE_CONFLICT')
  const team = f.service.planProfessionalTeam(f.commitment, f.assignments)
  f.attachWorkers()
  expect(team).toHaveLength(3)
  expect(() => f.ledger.transact([], [{ kind: 'create', object: { ...f.ledger.get(team[0]!.id)!, id: 'forged' } }])).toThrow('COORDINATION_HOST_REQUIRED')
  expect(f.service.dispatchReadiness('work').code).toBe('QUALITY_INTAKE_REQUIRED')
  f.ledger.close()
})

it('compiles complete required context, refuses audience leaks and versions paged material and consumption', async () => {
  const { createContextCompiler } = await import('../src/host/services/superagent/context/compile.ts')
  const { createHash } = await import('node:crypto')
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  const f = await coordinationFixture(), team = f.service.planProfessionalTeam(f.commitment, f.assignments)
  f.attachWorkers()
  const body = 'Evidence '.repeat(800) + 'Required final constraint.'
  const source = { ref: { id: 'evidence', revision: 1 }, text: body, digest: digest(body), visibleTo: [f.implementer.id], mandatory: true, purpose: 'requirement evidence' }
  const compiler = createContextCompiler(f.ledger, f.service, r => r.id === 'evidence' ? source : undefined)
  const envelope = compiler.compile({ commitmentId: 'work', assignment: team[0]!, worker: f.implementer, audience: [f.implementer.id], purpose: 'implementation', sourceRefs: [source.ref], failedMethods: ['Old broad log scanning incorrectly rejects success'], nativeContextBlindSpots: ['Native automatic skill loading not observable'] })
  expect(envelope.text).toContain('Required final constraint.')
  expect(envelope.text).toContain('Actual criterion definition: preserve complete diagnostic answer text')
  expect(envelope.hardConstraints).toContain('Real authentication failures stay failures')
  expect(envelope.text).toContain('Old broad log scanning incorrectly rejects success')
  const context = f.service.host.recordContext(envelope)
  const first = compiler.readPage(context, source.ref, [f.implementer.id], undefined, 100)
  expect(first.text).toHaveLength(100); expect(first.nextCursor).toBeTruthy()
  expect(() => compiler.readPage(context, source.ref, ['unauthorized'], first.nextCursor)).toThrow('CONTEXT_AUDIENCE_MISMATCH')
  source.text += 'changed'; source.digest = digest(source.text)
  expect(() => compiler.readPage(context, source.ref, [f.implementer.id], first.nextCursor)).toThrow('CONTEXT_SOURCE_CHANGED')
  const n = f.native.get(f.implementer.id)!
  n.observe({ kind: 'input-intent', input: { request_id: 'input:1', assignment_revision: team[0]!.revision, payload_digest: envelope.digest, text: envelope.text } })
  const nativeEvidenceRef = n.observe({ kind: 'input-consumed', consumption: { request_id: 'input:1', assignment_revision: team[0]!.revision, payload_digest: envelope.digest, session_identity: n.identity, turn_id: 'turn:1', processing_started_event_ref: 'native:start:1' } })
  const proof = { context, requestId: 'input:1', assignmentRevision: team[0]!.revision, payloadDigest: envelope.digest, worker: f.implementer, nativeSessionId: 'worker:implementation-native', turnId: 'turn:1', processingStartedEventRef: 'native:start:1', nativeEvidenceRef }
  expect(() => f.service.host.recordConsumedContext({ ...proof, nativeSessionId: 'other' })).toThrow('CONTEXT_CONSUMPTION_MISMATCH')
  expect(() => f.service.host.recordConsumedContext({ ...proof, nativeEvidenceRef: 'model-says-consumed' })).toThrow('NATIVE_EVIDENCE_REQUIRED')
  const consumed = f.service.host.recordConsumedContext(proof)
  expect(f.service.host.recordConsumedContext(proof)).toEqual(consumed)
  expect(() => f.service.host.recordConsumedContext({ ...proof, turnId: 'other' })).toThrow('NATIVE_CONSUMPTION_PROOF_REQUIRED')
  expect(() => compiler.compile({ commitmentId: 'work', assignment: team[0]!, worker: f.implementer, audience: [f.reviewer.id], purpose: 'implementation', sourceRefs: [source.ref], failedMethods: [], nativeContextBlindSpots: [] })).toThrow('CONTEXT_TARGET_AUDIENCE')
  f.ledger.close()
})

it('keeps semantic questions after native clearing and binds professional answers to current scope', async () => {
  const f = await coordinationFixture()
  const team = f.service.planProfessionalTeam(f.commitment, f.assignments)
  f.attachWorkers()
  const n = f.native.get(f.implementer.id)!
  const request = { ref: { id: 'native:old-generation:1', revision: 1 }, threadId: n.identity.native_session_id, state: 'pending', params: { tool: 'ask', arguments: { question: 'Which behavior is authoritative?' } } }
  const nativeEvidenceRef = n.observe({ kind: 'request', request })
  const question = f.service.host.recordQuestion({ commitmentId: 'work', assignment: team[0]!, worker: f.implementer, nativeRequestRef: request.ref.id, question: 'Which behavior is authoritative?', evidenceRefs: [nativeEvidenceRef], nextReviewAt: Date.now() + 10000, nativeEvidenceRef })
  f.service.host.observeQuestionRequest(question, n.observe({ kind: 'request', request: { ...request, state: 'cleared', reason: 'runtime-restarted' } }))
  expect(f.service.pendingQuestions('work')[0]?.data.question).toBe('Which behavior is authoritative?')
  const current = f.ledger.get(question.id)!
  expect(() => f.service.recordProfessionalDecision({ commitmentId: 'work', question: { id: current.id, revision: current.revision }, reviewer: f.reviewer, kind: 'user_authorization', conclusion: 'Approve everything', evidenceRefs: ['x'], alternatives: ['x'], scopeRefs: [{ id: 'contract', revision: 1 }] } as never)).toThrow('PROFESSIONAL_DECISION_KIND')
  f.ledger.close()
  const reopened = new ManagedLedger(f.path)
  expect(reopened.get(question.id)?.data.state).toBe('pending')
  expect(reopened.get(question.id)?.data.native_state).toBe('cleared')
  reopened.close()
})

it('phase updates preserve assignments while changed requirements invalidate them', async () => {
  const f = await coordinationFixture(false), team = f.service.planProfessionalTeam(f.commitment, f.assignments)
  f.attachWorkers()
  expect(f.native.get(f.implementer.id)!.fence()).toHaveProperty('kind', 'envelope')
  f.ledger.transact([f.commitment], [{ kind: 'transition', id: 'work', state: 'ready', reason: 'Authorized intake prepared' }])
  expect(f.ledger.applicability(team[0]!.id)).toBe('usable')
  f.ledger.transact([{ id: 'r', revision: 1 }], [{ kind: 'revise', id: 'r', data: { ...requirement().data, intent: 'Additional user requirement' } }])
  expect(f.ledger.applicability(team[0]!.id)).toBe('recheck_required')
  expect(f.native.get(f.implementer.id)!.fence()).toHaveProperty('kind', 'denial')
  f.ledger.close()
})

it('rejects self-asserted intake authority, foreign project workers and executable proposals', async () => {
  const { validateCoordinationProposals } = await import('../src/host/services/superagent/coordination/advance.ts')
  const f = await coordinationFixture(false)
  expect(() => f.service.acceptManagedIntent({ id: 'owner-from-message', revision: 1 }, {} as never)).toThrow('INTAKE_SOURCE_NOT_AUTHENTICATED')
  const foreign = f.service.host.registerProject({ id: 'foreign-project', intent: 'Other private project', repositoryIdentity: 'other-repository', hosts: [f.host], sourceRefs: [{ id: 'other-source', revision: 1 }] })
  const worker = f.service.host.registerWorker({ id: 'foreign-worker', host: f.host, profile: f.profile, projects: [foreign], engineRef: 'codex@1', runtimeNamespace: 'foreign' })
  expect(() => f.service.planProfessionalTeam(f.commitment, f.assignments.map(a => a.role === 'implementation' ? { ...a, worker } : a))).toThrow('WORKER_PROJECT_MISMATCH')
  expect(() => validateCoordinationProposals({ proposals: [{ kind: 'operate', operation: { operation: 'inspect', target: f.implementer, payloadRef: f.project, executable: '/bin/sh', args: ['-c', 'anything'] } }] })).toThrow('INVALID_COORDINATION_PROPOSAL')
  expect(() => validateCoordinationProposals({ proposals: [{ kind: 'fulfilled', value: true }] })).toThrow('COORDINATION_PROPOSAL_NOT_REGISTERED')
  f.ledger.close()
})

it('does not drop a required criterion merely because all named roles have an owner', async () => {
  const f = await coordinationFixture(false)
  f.ledger.transact([], [{ kind: 'create', object: { id: 'contract-two', kind: 'acceptance_contract', revision: 1, data: { intent: 'Two required user results', requirement_refs: [{ id: 'r', revision: 1 }], criterion_refs: [{ id: 'criterion:success', revision: 1 }, { id: 'criterion:true-failure', revision: 1 }], source_refs: [] }, scope_revision_refs: [{ id: 'r', revision: 1 }], extensions: {} } }])
  const work = f.service.acceptManagedIntent({ id: 'host:authenticated-owner', revision: 1 }, { id: 'work-two', intent: 'Both user results', requirements: [{ id: 'r', revision: 1 }], acceptanceContract: { id: 'contract-two', revision: 1 }, deliveryContract: { id: 'delivery', revision: 1 }, projects: [f.project], boundary: 'Local only', accountable: 'coordinator', policy: f.policy, nextReviewAt: Date.now() + 10000 })
  expect(() => f.service.planProfessionalTeam(work, f.assignments)).toThrow('TEAM_CRITERIA_COVERAGE_REQUIRED')
  f.ledger.close()
})

it('fences a worker through stable semantic ancestry when its commitment is paused', async () => {
  const f = await coordinationFixture(false)
  f.service.planProfessionalTeam(f.commitment, f.assignments); f.attachWorkers()
  expect(f.native.get(f.implementer.id)!.fence()).toHaveProperty('kind', 'envelope')
  f.ledger.transact([f.commitment], [{ kind: 'control', id: 'work', control_state: 'paused', reason: 'owner pause', evidence_refs: ['authenticated-owner-event'] }])
  expect(f.native.get(f.implementer.id)!.fence()).toHaveProperty('kind', 'denial')
  f.ledger.close()
})

it('rejects native proof from another seat and makes a later failed intake review authoritative', async () => {
  const f = await coordinationFixture(), team = f.service.planProfessionalTeam(f.commitment, f.assignments)
  f.attachWorkers()
  const n = f.native.get(f.reviewer.id)!
  const request = { ref: { id: 'native:other-seat:1', revision: 1 }, threadId: n.identity.native_session_id, state: 'pending', params: { tool: 'ask', arguments: { question: 'Which behavior?' } } }
  const nativeEvidenceRef = n.observe({ kind: 'request', request })
  expect(() => f.service.host.recordQuestion({ commitmentId: 'work', assignment: team[0]!, worker: f.implementer, nativeRequestRef: request.ref.id, question: 'Which behavior?', evidenceRefs: [nativeEvidenceRef], nextReviewAt: Date.now() + 10000, nativeEvidenceRef })).toThrow('NATIVE_EVIDENCE_TARGET_MISMATCH')
  f.service.host.recordTeamReview('work', f.reviewer, team, ['trusted-native-quality-review'], 'pass')
  expect(f.service.dispatchReadiness('work').ready).toBe(true)
  f.service.host.recordTeamReview('work', f.reviewer, team, ['trusted-new-counterexample'], 'fail')
  expect(f.service.dispatchReadiness('work').code).toBe('QUALITY_INTAKE_REQUIRED')
  f.ledger.close()
})

it('invokes registered runtime, role, context, executor, verifier and maintenance observer ports with missing project gate refused', async () => {
  const { createManagedPorts, maintenanceSchemas, selectQualifiedEngine, createMaintenanceObserver, observeMaintenance } = await import('../src/host/services/superagent/coordination/advance.ts')
  const { createExtensionRegistry } = await import('../src/host/services/superagent/protocol/extensions.ts')
  const f = await coordinationFixture(false, createExtensionRegistry(maintenanceSchemas))
  const calls: string[] = []
  const implementations = {
    coordinator: { run: async (input: unknown) => { calls.push('coordinator'); return { proposals: [{ kind: 'wait', reason: 'Need independent quality intake', waitingOn: 'quality-intake', nextReviewAt: Date.now() + 1000 }] } } },
    roles: { plan: (commitment: unknown, assignments: unknown) => { calls.push('roles'); return f.service.planProfessionalTeam(commitment as never, assignments as never) } },
    context: { compile: (input: unknown) => { calls.push('context'); return input } },
    executor: { operate: async () => { calls.push('executor'); return { status: 'unknown', evidenceRefs: [] } } },
    verifier: { methods: ['offline-json@1'], request: async () => { calls.push('verifier'); return { status: 'requested', evidenceRefs: ['canonical:request'] } } },
    observer: { observe: (id: string, refs: import('../src/host/services/superagent/protocol/managed-work.ts').Ref[]) => { calls.push('observer'); return createMaintenanceObserver(f.ledger).observe(id, refs) } },
  }
  const permissions = ['propose', 'coordinate', 'read-context', 'controlled-execute', 'verify', 'observe']
  const modules = ['coordinator', 'roles', 'context', 'executor', 'verifier', 'observer']
  const caps = { contract_version: '1.0.0', schema_versions: ['2'], permissions, extensions: ['maintenance/source@1'], isolated_modes: ['controlled'], now: Date.now(), qualifications: modules.map(id => ({ plugin_id: 'builtin:' + id, version: '1.0.0', evidence_ref: 'fixture-qualified:' + id, expires_at: Date.now() + 60000 })) }
  const ports = createManagedPorts(implementations as never, () => caps)
  await ports.coordinator({ request_id: 'test', assignment_revision: 1, text: 'Current goal' }, new AbortController().signal)
  ports.plan(f.commitment, f.assignments)
  ports.compile({ snapshot: 'current' } as never)
  await ports.operate({ operation: 'inspect', target: f.implementer, payloadRef: f.project })
  await ports.verify({ method: 'offline-json@1', context: f.project })
  expect(() => ports.verify({ method: 'project-gates@1', context: f.project })).toThrow('VERIFICATION_METHOD_UNAVAILABLE')
  const observation = ports.observe('work', [f.project])
  const registry = createExtensionRegistry(maintenanceSchemas)
  registry.validate('maintenance/source', { required: true, schema: 1, payload: observation as never })
  expect(calls).toEqual(['coordinator', 'roles', 'context', 'executor', 'verifier', 'observer'])
  const observed = observeMaintenance(ports, f.service, 'work', [f.project])
  expect(f.ledger.get(observed.id)?.extensions['maintenance/source']?.required).toBe(true)
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const draining = createManagedPorts({ ...implementations, coordinator: { run: async () => { await blocked; return { proposals: [{ kind: 'wait', reason: 'Waiting for quality', waitingOn: 'quality', nextReviewAt: Date.now() + 10000 }] } } } } as never, () => caps)
  const late = draining.coordinator({ request_id: 'late', assignment_revision: 1, text: 'Goal' }, new AbortController().signal)
  draining.generation.beginDrain(Date.now() + 10000)
  release()
  await expect(late).rejects.toThrow('generation not active')
  caps.qualifications = caps.qualifications.filter(q => q.plugin_id !== 'builtin:executor')
  expect(() => ports.operate({ operation: 'inspect', target: f.implementer, payloadRef: f.project })).toThrow('QUALIFICATION_MISSING')
  expect(selectQualifiedEngine([{ engine: 'claude', capabilities: ['write'], evidenceRefs: ['actual'], qualified: true }, { engine: 'codex', capabilities: ['read'], evidenceRefs: ['read-only'], qualified: true }, { engine: 'dsh', capabilities: ['write'], evidenceRefs: ['actual-dsh'], qualified: true }], ['write'])).toMatchObject({ engine: 'dsh', declined: [{ engine: 'codex', reason: 'CAPABILITY_MISSING:write' }] })
  expect(() => selectQualifiedEngine([{ engine: 'codex', capabilities: ['write'], evidenceRefs: [], qualified: true }], ['write'])).toThrow('NO_QUALIFIED_ENGINE')
  f.ledger.close()
})


it('refuses an unscoped native binding and blocks its actual writes after managed assignment and pause', async () => {
  const { ControlledFileTools } = await import('../src/host/services/superagent/executors/native/tools.ts')
  const f = await coordinationFixture(false)
  f.attachWorkers(false, false)
  const n = f.native.get(f.implementer.id)!, tools = new ControlledFileTools(f.k, n.launch, process.execPath)
  expect(await tools.call('write', { path: 'before-managed.txt', content: 'standalone positive control' })).toHaveProperty('success', true)
  const team = f.service.planProfessionalTeam(f.commitment, f.assignments)
  expect.soft(() => f.service.host.bindNativeSession(f.implementer, n.evidence)).toThrow()
  f.ledger.transact([f.commitment], [{ kind: 'control', id: 'work', control_state: 'paused', reason: 'owner pause', evidence_refs: ['authenticated-owner'] }])
  expect.soft(await tools.call('write', { path: 'after-pause.txt', content: 'must not write' })).toHaveProperty('success', false)
  expect.soft(existsSync(join(n.launch.workspace.root, 'after-pause.txt'))).toBe(false)
  expect(f.ledger.get(f.implementer.id)?.revision).toBe(1)
  expect(f.ledger.get(team[0]!.id)?.revision).toBe(1)
  f.ledger.close()
})

it('keeps correctly scoped native helper writes live through phase progress but refuses after pause', async () => {
  const { ControlledFileTools } = await import('../src/host/services/superagent/executors/native/tools.ts')
  const f = await coordinationFixture(false), team = f.service.planProfessionalTeam(f.commitment, f.assignments)
  f.attachWorkers()
  const n = f.native.get(f.implementer.id)!, tools = new ControlledFileTools(f.k, n.launch, process.execPath)
  f.ledger.transact([f.commitment], [{ kind: 'transition', id: 'work', state: 'ready', reason: 'normal phase progress' }])
  expect(await tools.call('write', { path: 'phase.txt', content: 'still live' })).toHaveProperty('success', true)
  f.ledger.transact([{ id: 'work', revision: 2 }], [{ kind: 'control', id: 'work', control_state: 'paused', reason: 'owner pause', evidence_refs: ['authenticated-owner'] }])
  expect(await tools.call('write', { path: 'after-pause.txt', content: 'must not write' })).toHaveProperty('success', false)
  expect(existsSync(join(n.launch.workspace.root, 'after-pause.txt'))).toBe(false)
  expect(f.ledger.get(f.implementer.id)?.revision).toBe(1)
  expect(f.ledger.get(team[0]!.id)?.revision).toBe(1)
  f.ledger.close()
})

it('refuses revision 77 consumption without append or durable proof after reopen', async () => {
  const { createContextCompiler } = await import('../src/host/services/superagent/context/compile.ts')
  const f = await coordinationFixture(false), team = f.service.planProfessionalTeam(f.commitment, f.assignments)
  f.attachWorkers()
  const envelope = createContextCompiler(f.ledger, f.service, () => undefined).compile({ commitmentId: 'work', assignment: team[0]!, worker: f.implementer, audience: [f.implementer.id], purpose: 'implementation', sourceRefs: [], failedMethods: [], nativeContextBlindSpots: ['fixture events only'] })
  const beforeContext = f.ledger.events().length
  expect.soft(() => f.service.host.recordContext({ ...envelope, assignment: team[1]! })).toThrow()
  expect.soft(f.ledger.events().length).toBe(beforeContext)
  const context = f.service.host.recordContext(envelope), n = f.native.get(f.implementer.id)!
  n.observe({ kind: 'input-intent', input: { request_id: 'bad-revision', assignment_revision: 77, payload_digest: envelope.digest, text: envelope.text } })
  const nativeEvidenceRef = n.observe({ kind: 'input-consumed', consumption: { request_id: 'bad-revision', assignment_revision: 77, payload_digest: envelope.digest, session_identity: n.identity, turn_id: 'turn', processing_started_event_ref: 'started' } })
  const before = f.ledger.events().length
  expect.soft(() => f.service.host.recordConsumedContext({ context, requestId: 'bad-revision', assignmentRevision: 77, payloadDigest: envelope.digest, worker: f.implementer, nativeSessionId: n.identity.native_session_id!, turnId: 'turn', processingStartedEventRef: 'started', nativeEvidenceRef })).toThrow()
  expect.soft(f.ledger.events().length).toBe(before)
  f.ledger.close()
  const reopened = new ManagedLedger(f.path)
  expect(reopened.snapshot().filter(o => o.kind === 'context_input')).toHaveLength(0)
  reopened.close()
})

it.each([['create', false], ['revise', false], ['create', true], ['revise', true]] as const)('keeps generic Worker %s declarative without granting a professional seat (foreign=%s)', async (mode, foreignScope) => {
  const f = await coordinationFixture(false)
  const foreign = f.service.host.registerHost({ id: 'host:foreign', authority: 'foreign', evidenceRefs: ['fixture'] })
  expect(() => f.service.host.registerWorker({ id: 'typed-bad', host: foreign, profile: f.profile, projects: [f.project], engineRef: 'codex@1', runtimeNamespace: 'test' })).toThrow('PROJECT_HOST_MISMATCH')
  const original = f.ledger.get(f.implementer.id)!
  const id = mode === 'create' ? 'worker:declaration' : original.id
  const declaredHost = foreignScope ? foreign : f.host
  const data = { ...original.data, host_binding_ref: declaredHost.id }
  const scopes = [declaredHost, f.profile, f.project]
  const result = mode === 'create'
    ? f.ledger.transact([], [{ kind: 'create', object: { ...original, id, data, scope_revision_refs: scopes } }])
    : f.ledger.transact([f.implementer], [{ kind: 'revise', id, data, scope_revision_refs: scopes }])
  expect(result.kind).toBe('committed')
  const worker = { id, revision: mode === 'create' ? 1 : 2 }, before = f.ledger.events().length
  expect.soft(() => f.service.planProfessionalTeam(f.commitment, f.assignments.map(a => a.role === 'implementation' ? { ...a, worker } : a))).toThrow()
  expect(f.ledger.events().length).toBe(before)
  expect(f.ledger.snapshot().filter(o => o.kind === 'team_assignment')).toHaveLength(0)
  f.ledger.close()
})


it('refuses pre-assignment native attach rather than later adopting its unscoped writer', async () => {
  await expect(coordinationFixture(true)).rejects.toThrow('MANAGED_LAUNCH_SCOPE_REQUIRED')
})

it('a scoped Task B launch ignores unrelated paused Task A on the same stable registered seat', async () => {
  const { ControlledFileTools } = await import('../src/host/services/superagent/executors/native/tools.ts')
  const f = await coordinationFixture(false)
  f.service.planProfessionalTeam(f.commitment, f.assignments)
  const workB = f.service.acceptManagedIntent({ id: 'host:authenticated-owner', revision: 1 }, { id: 'work-b', intent: 'Independent Task B', requirements: [{ id: 'r', revision: 1 }], acceptanceContract: { id: 'contract', revision: 1 }, deliveryContract: { id: 'delivery', revision: 1 }, projects: [f.project], boundary: 'Local isolated work only', accountable: 'owner', policy: f.policy, nextReviewAt: Date.now() + 10000 })
  f.service.planProfessionalTeam(workB, f.assignments)
  f.ledger.transact([f.commitment], [{ kind: 'control', id: 'work', control_state: 'paused', reason: 'Only Task A paused', evidence_refs: ['authenticated-owner'] }])
  f.attachWorkers(true, true, 'work-b')
  const n = f.native.get(f.implementer.id)!, tools = new ControlledFileTools(f.k, n.launch, process.execPath)
  expect(await tools.call('write', { path: 'task-b.txt', content: 'Task B remains live' })).toHaveProperty('success', true)
  expect(existsSync(join(n.launch.workspace.root, 'task-b.txt'))).toBe(true)
  f.ledger.close()
})


it('does not consume Task A context through a Task B launch sharing the same Worker and revision number', async () => {
  const { createContextCompiler } = await import('../src/host/services/superagent/context/compile.ts')
  const f = await coordinationFixture(false), teamA = f.service.planProfessionalTeam(f.commitment, f.assignments)
  const workB = f.service.acceptManagedIntent({ id: 'host:authenticated-owner', revision: 1 }, { id: 'work-b', intent: 'Task B', requirements: [{ id: 'r', revision: 1 }], acceptanceContract: { id: 'contract', revision: 1 }, deliveryContract: { id: 'delivery', revision: 1 }, projects: [f.project], boundary: 'Local only', accountable: 'owner', policy: f.policy, nextReviewAt: Date.now() + 10000 })
  f.service.planProfessionalTeam(workB, f.assignments)
  f.attachWorkers(true, true, 'work-b')
  const envelope = createContextCompiler(f.ledger, f.service, () => undefined).compile({ commitmentId: 'work', assignment: teamA[0]!, worker: f.implementer, audience: [f.implementer.id], purpose: 'Task A', sourceRefs: [], failedMethods: [], nativeContextBlindSpots: ['fixture only'] })
  const before = f.ledger.events().length
  expect.soft(() => f.service.host.recordContext(envelope)).toThrow()
  expect(f.ledger.events().length).toBe(before)
  f.ledger.close()
})

it('checks live managed ancestry and native evidence without decoding unrelated full event history', async () => {
  const f = await coordinationFixture()
  try {
    f.service.planProfessionalTeam(f.commitment, f.assignments); f.attachWorkers()
    const original = f.ledger.events.bind(f.ledger)
    f.ledger.events = () => { throw Error('FULL_EVENT_HISTORY_READ') }
    expect(f.native.get(f.implementer.id)!.fence()).toMatchObject({ kind: 'envelope' })
    expect(f.k.host.nativeFacts('stream:' + f.implementer.id).some(v => (v.observation as any).kind === 'binding')).toBe(true)
    f.ledger.transact([f.commitment], [{ kind: 'control', id: f.commitment.id, control_state: 'paused', reason: 'live pause', evidence_refs: ['owner'] }])
    expect(f.native.get(f.implementer.id)!.fence()).toMatchObject({ kind: 'denial' })
    f.ledger.events = original
  } finally { f.ledger.close() }
})

it('renews only an exact host registered profile qualification without changing seat capabilities or semantic revisions', async () => {
  const { vi } = await import('vitest')
  const f = await coordinationFixture(), before = f.ledger.get(f.profile.id)!, seat = f.ledger.get(f.implementer.id)!
  vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(Date.now()+61000)
  try {
    expect(f.ledger.applicability(f.implementer.id)).toBe('recheck_required')
    expect(() => f.service.host.renewProfileQualification({...f.profile,revision:77},['actual-qualified-runtime-rechecked'],Date.now()+60000)).toThrow()
    f.service.host.renewProfileQualification(f.profile,['actual-qualified-runtime-rechecked'],Date.now()+60000)
    expect(f.ledger.applicability(f.implementer.id)).toBe('usable')
    expect(f.ledger.get(f.profile.id)).toEqual(before); expect(f.ledger.get(f.implementer.id)).toEqual(seat)
    expect(f.ledger.snapshot('profile_qualification')).toHaveLength(1)
  } finally { vi.useRealTimers(); f.ledger.close() }
})

it('requires a fresh exact domain observation when resuming the same SID without a historical stop receipt', async () => {
 const {createHash}=await import('node:crypto'), f=await coordinationFixture()
 try {
  f.service.planProfessionalTeam(f.commitment,f.assignments);f.attachWorkers()
  const old=f.native.get(f.reviewer.id)!, oldObject=f.ledger.get(old.launch.actionRef.id)!, oldSpec=oldObject.data.execution_spec as any
  const workspace=old.launch.workspace,expiresAt=Date.now()+60000
  const proof=(changes:Record<string,unknown>={})=>f.k.host.observeNative(old.launch.actionRef,'execution:'+old.launch.actionRef.id,{kind:'domain_absence',launchRef:old.launch.actionRef,executionDigest:createHash('sha256').update(JSON.stringify(oldSpec)).digest('hex'),runtimeRoot:'test-native',processPolicy:'single',observedAt:Date.now(),...changes} as any).nativeRef
  const stale=proof({observedAt:Date.now()-60001}),wrong=proof({executionDigest:'wrong'}),fresh=proof()
  // Fixture relinquishment is separate from the native evidence under test; the old action stays sent.
  const db=new (await import('node:sqlite')).DatabaseSync(f.path),state=JSON.parse(String(db.prepare('SELECT body_json FROM sa_managed_control').get()!.body_json))
  for(const lease of state.resources)if(lease.actionRef.id===old.launch.actionRef.id)lease.status='released'
  db.prepare('UPDATE sa_managed_control SET body_json=?').run(JSON.stringify(state));db.close()
  const control=f.k.host.grantControl(f.reviewer,f.reviewer.id,expiresAt),id='new-quality',spec={...oldSpec,id,idempotencyKey:id,epoch:control.epoch}
  const action=f.k.actions.planAction(spec);f.k.actions.claimResources(action.ref,workspace.resources)
  const launch=f.k.host.beginDispatch(action.ref);if(launch.kind==='denial')throw Error(launch.code)
  const evidence=f.k.host.observeNative(launch.actionRef,'new-stream',{kind:'binding',binding:{identity:old.identity,ref:{id:'new-binding',revision:control.epoch},launchRef:launch.actionRef}} as any).nativeRef
  expect(()=>f.service.host.resumeNativeSession(f.reviewer,evidence)).toThrow('OLD_NATIVE_WRITER_CESSATION_REQUIRED')
  expect(()=>f.service.host.resumeNativeSession(f.reviewer,evidence,stale)).toThrow('OLD_NATIVE_WRITER_CESSATION_REQUIRED')
  expect(()=>f.service.host.resumeNativeSession(f.reviewer,evidence,wrong)).toThrow('OLD_NATIVE_WRITER_CESSATION_REQUIRED')
  expect(f.service.host.resumeNativeSession(f.reviewer,evidence,fresh)).toBeTruthy()
  expect(f.ledger.get(oldObject.id)?.data.state).toBe('sent')
  expect(f.ledger.get(oldObject.id)?.data.receipt).toBeUndefined()
  expect(()=>f.service.host.resumeNativeSession(f.reviewer,evidence,fresh)).toThrow('OLD_NATIVE_WRITER_CESSATION_REQUIRED')
 }finally{f.ledger.close()}
})
