import { afterEach, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Only the native process boundary is scripted. Admissions, runtime, ledger,
// context consumption, contract acceptance and amendment are production code.
const native = vi.hoisted(() => ({ answer: undefined as undefined | ((text: string, signal: AbortSignal) => Promise<any>) }))
vi.mock('../src/host/services/superagent/executors/managed-native.ts', async importOriginal => {
  const original = await importOriginal<any>()
  return { ...original, launchManagedCodex: async (kernel: any, config: any, worker: any, workspace: any, scopes: any, _instructions: any, _tools: any, outputSchema: any, resume: any) => {
    const id = 'scripted-native:' + randomUUID(), expiresAt = Date.now() + 600000
    const control = kernel.host.grantControl(worker, worker.id, expiresAt)
    kernel.host.grantCapability({ id: id + ':cap', revision: 1, scopeRefs: scopes, evidenceRefs: ['scripted-boundary'], expiresAt, externalTools: 'blocked', revoked: false, launch: { executable: '/bin/sh', args: ['-c', 'true'], processPolicy: 'single' } })
    kernel.host.grantMandate({ id: id + ':mandate', revision: 1, requester: 'host', subject: worker.id, target: worker, actions: ['dispatch'], workspaceId: workspace.id, resourceIds: workspace.resources, scopeRefs: scopes, expiresAt, revoked: false })
    const action = kernel.actions.planAction({ id, idempotencyKey: id, requester: 'host', subject: worker.id, target: worker, epoch: control.epoch, mandateRef: { id: id + ':mandate', revision: 1 }, capabilityRef: { id: id + ':cap', revision: 1 }, kind: 'dispatch', scopeRefs: scopes, workspaceId: workspace.id, resourceIds: workspace.resources, purpose: workspace.role, executable: '/bin/sh', args: ['-c', 'true'], timeoutMs: 2000, processPolicy: 'single' })
    kernel.actions.claimResources(action.ref, workspace.resources)
    const launch = kernel.host.beginDispatch(action.ref)
    if (launch.kind === 'denial') throw Error(launch.code)
    const identity = { host_ref: 'host:local', engine_ref: 'codex', runtime_namespace: config.stateRoot, native_session_id: resume?.nativeSessionId ?? 'scripted-thread' }
    const observe = (observation: any) => kernel.host.observeNative(launch.actionRef, id, observation).nativeRef
    observe({ kind: 'binding', binding: { identity, ref: { id: id + ':binding', revision: 1 }, launchRef: launch.actionRef, epoch: control.epoch } })
    const engine = { identity, options: { outputSchema }, scripted: async (input: any, signal: AbortSignal) => {
      if (signal.aborted) throw Error('COORDINATOR_CANCELLED')
      observe({ kind: 'input-intent', input: { ...input, payload_digest: createHash('sha256').update(input.text).digest('hex'), payload_ref: input.request_id } })
      const answer = await native.answer!(input.text, signal)
      // Native inspection RPCs share the target but are not process launches.
      const rpc = 'scripted-inspect:' + randomUUID()
      kernel.actions.planAction({ ...launch.spec, id: rpc, idempotencyKey: rpc, kind: 'inspect', payloadDigest: createHash('sha256').update(input.text).digest('hex') })
      observe({ kind: 'input-consumed', consumption: { request_id: input.request_id, assignment_revision: input.assignment_revision, payload_digest: createHash('sha256').update(input.text).digest('hex'), session_identity: identity, turn_id: input.request_id, processing_started_event_ref: 'scripted:start' } })
      return answer
    } }
    return { engine, io: { stream: id }, home: config.stateRoot, launch, cleanupCredentials() {}, async stop() { return kernel.host.reconcileAction(launch.actionRef, { status: 'confirmed', stopped: true, evidenceRefs: ['scripted:closed'] }) } }
  } }
})
vi.mock('../src/host/services/superagent/executors/engines/codex-coordinator.ts', () => ({ CodexCoordinatorRuntime: class { constructor(private engine: any) {} run(input: any, signal: AbortSignal) { return this.engine.scripted(input, signal) } } }))
import { createManagedRuntime, managedAdmissionRuntime, type RuntimeProposal } from '../src/host/services/superagent/managed-runtime.ts'
import { createAdmissions } from '../src/host/services/superagent/kernel/admissions.ts'

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.useRealTimers() })
const proposal = (kind: RuntimeProposal['kind'], extra = {}): RuntimeProposal => ({ kind, role: 'none', instruction: '', reason: 'scripted native boundary', questionId: '', answer: '', intake: null, ...extra })
const accept = (addition = false) => ({ proposals: [proposal('accept', { intake: { goal: 'Validate input', results: ['Reject invalid input', ...(addition ? ['Also reject empty input'] : [])], constraints: [], criteria: ['Reject invalid input', ...(addition ? ['Also reject empty input'] : [])], deliveryCriteria: [], assignments: ['coordinator', 'implementation', 'quality'].map(role => ({ role, basis: 'required responsibility', deliverables: ['Validate input'], consumers: ['coordinator'], criteria: addition ? [0, 1] : [0] })) } }), proposal('wait')] })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owner-routing-')), source = join(root, 'source'); mkdirSync(source); writeFileSync(join(source, 'input.ts'), 'export const value = 1')
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const config = (runtimeRoot: string) => ({ root: runtimeRoot, projectRoot: source, publicFiles: ['input.ts'], implementationWritePaths: ['input.ts'], engine: { executable: '/never-execute', authFile: '/absent', model: 'scripted', stateRoot: join(runtimeRoot, 'native') } })
  const request = { requestId: 'initial', project: 'p', text: 'Reject invalid input', origin: { kind: 'trusted-host' as const } }
  const runtimes: ReturnType<typeof createManagedRuntime>[] = [], results: string[] = []
  const open = () => createAdmissions({ root: join(root, 'admission'), projects: ['p'], defaultProject: 'p', materialDigest: () => '', projectsView: () => [], onResult: (_q, r) => results.push(r.state), runtime: (_p, path) => { const runtime = createManagedRuntime(config(path)); runtimes.push(runtime); return managedAdmissionRuntime(runtime, {}) } })
  return { request, open, runtimes, results }
}

it.each([false, true])('retains early requirements through blocked intake (reload=%s), classifies and applies the exact addition once', async reload => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const f = fixture(); let entered = false, release!: () => void, block = true
  native.answer = async (text, signal) => {
    if (text.includes('ownerMessage')) return { proposals: [proposal('answer', { role: 'amendment', answer: 'Also reject empty input' })] }
    if (text.includes('additionalInputs')) return accept(true)
    if (block) { entered = true; await new Promise<void>((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(Error('COORDINATOR_CANCELLED')), { once: true }) }) }
    return accept()
  }
  let port = f.open(); cleanup.push(() => port.dispose()); port.enqueue(f.request)
  await vi.waitFor(() => expect(entered).toBe(true))
  const addition = { ...f.request, requestId: 'early', text: 'Also reject empty input' }
  port.message(addition)
  await vi.waitFor(() => expect(port.read('initial').messages?.[0]?.answer).toContain('OWNER_MESSAGE_INTAKE_PENDING'))
  expect(port.read('initial').messages?.[0]?.state).toBe('routing')
  if (reload) { await port.dispose(); block = false; port = f.open(); await vi.advanceTimersByTimeAsync(60000) }
  else { block = false; release() }
  await vi.waitFor(() => expect(f.runtimes.at(-1)!.ledger.snapshot('commitment')).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(1000); await port.settle()
  const runtime = f.runtimes.at(-1)!, work = runtime.ledger.snapshot('commitment')[0]!
  const contract = runtime.ledger.get((work.data.acceptance_contract as any).id)!
  const criteria = (contract.data.criterion_refs as any[]).map(r => runtime.ledger.get(r.id)!.data.intent)
  expect(criteria.filter(text => text === addition.text), JSON.stringify(port.read('initial'))).toHaveLength(1)
  expect(port.read('initial').consumedInputs).toEqual(['early'])
  expect(port.message(addition)).toMatchObject({ duplicate: true })
  expect(port.read('initial').inputs).toHaveLength(1)
  expect(f.results).toEqual([])
})

it('classifies after real runtime owner stop without resetting its execution pause and keeps malformed output unresolved', async () => {
  const f = fixture(); native.answer = async () => accept()
  const port = f.open(); cleanup.push(() => port.dispose()); port.enqueue(f.request); await port.settle()
  port.message({ ...f.request, requestId: 'stop', text: '停止' }); await port.settle()
  const runtime = f.runtimes[0]!
  native.answer = async () => ({ proposals: [proposal('answer', { role: 'discussion', answer: '' })] })
  port.message({ ...f.request, requestId: 'question', text: 'Explain the criteria' })
  await port.settle()
  expect(port.read('initial').messages?.[0]?.state).toBe('routing')
  native.answer = async () => ({ proposals: [proposal('answer', { role: 'discussion', answer: 'Criteria retained.' })] })
  await expect.poll(() => port.read('initial').messages?.[0], { timeout: 3000 }).toMatchObject({ state: 'discussion' })
  expect(port.read('initial').state).toBe('paused')
  expect(await runtime.reconcile()).toMatchObject({ state: 'paused' })
  expect(f.results).toEqual([])
})

it('uses an answer-only model schema and stable classifier identity across retry and reload', async () => {
  const { ownerClassificationSchema, managedCoordinatorSchema } = await import('../src/host/services/superagent/managed-runtime.ts')
  const schema = (ownerClassificationSchema as any).properties.proposals
  expect(schema).toMatchObject({ minItems: 1, maxItems: 1, items: { properties: { kind: { enum: ['answer'] }, role: { enum: ['discussion', 'amendment'] } } } })
  expect((managedCoordinatorSchema as any).properties.proposals.items.properties.role.enum).not.toContain('amendment')
  const f = fixture(); native.answer = async () => accept()
  let port = f.open(); cleanup.push(() => port.dispose()); port.enqueue(f.request); await port.settle()
  port.message({ ...f.request, requestId: 'stop', text: '停止' }); await port.settle()
  native.answer = async () => ({ proposals: [proposal('answer', { role: 'discussion', answer: 'Paused.' })] })
  port.message({ ...f.request, requestId: 'one', text: 'Explain the current work' }); await port.settle()
  const identity = (r: ReturnType<typeof createManagedRuntime>) => r.ledger.eventEntries({ nativeKind: 'binding' }).map(({ body }: any) => body.controlled.command.observation.binding.identity).filter(i => i.runtime_namespace.endsWith('/owner-classifier'))
  const first = identity(f.runtimes[0]!)[0]; expect(first).toBeDefined()
  await port.dispose(); port = f.open()
  port.message({ ...f.request, requestId: 'two', text: 'Explain again' }); await port.settle()
  expect(identity(f.runtimes.at(-1)!)).toEqual([first, first])
  expect(port.read('initial').state).toBe('paused')
  expect(f.runtimes.at(-1)!.ledger.snapshot('team_assignment')).toHaveLength(3)
})

it('disposal cancels an active read-only classifier and leaves its durable message unresolved', async () => {
  const f = fixture(); native.answer = async () => accept()
  const port = f.open(); port.enqueue(f.request); await port.settle()
  let entered = false, cancelled = false
  native.answer = async (_text, signal) => new Promise((_resolve, reject) => { entered = true; signal.addEventListener('abort', () => { cancelled = true; reject(Error('COORDINATOR_CANCELLED')) }, { once: true }) })
  port.message({ ...f.request, requestId: 'active', text: 'Explain current work' })
  await expect.poll(() => entered).toBe(true)
  await port.dispose()
  expect(cancelled).toBe(true)
  expect(port.read('initial').messages?.[0]?.state).toBe('routing')
})
