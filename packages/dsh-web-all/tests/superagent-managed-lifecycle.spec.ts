import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createManagedAdmission, createManagedRuntime, managedAdmissionRuntime, preserveManagedDeliveryCriteria } from '../src/host/services/superagent/managed-runtime.ts'

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sa-lifecycle-')), root = join(dir, 'host'), bootstrapFile = join(dir, 'bootstrap.json')
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(root, 'requests'), { recursive: true })
  writeFileSync(bootstrapFile, JSON.stringify({ root, defaultProject: 'p', projects: { p: { projectRoot: join(dir, 'missing-source'), publicFiles: [], implementationWritePaths: [], engine: { executable: '/never-execute', authFile: '/absent', model: 'fixture' } } } }), { mode: 0o600 })
  const request = { requestId: 'initial', text: 'Fix the authorized defect', project: 'p', origin: { kind: 'feishu' as const, chatId: 'chat', messageId: 'first', eventId: 'initial' } }
  const save = (value: unknown) => writeFileSync(join(root, 'requests', createHash('sha256').update(request.requestId).digest('hex') + '.json'), JSON.stringify(value))
  return { root, bootstrapFile, request, save }
}
function runtimeFixture() {
  const f = fixture(), project = join(f.root, 'project'); mkdirSync(project)
  writeFileSync(join(project, 'input.ts'), 'export const value = 1\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'pipe' })
  git('init', '-b', 'dev'); git('add', 'input.ts'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'test: seed')
  const config = { root: join(f.root, 'runtime'), projectRoot: project, publicFiles: ['input.ts'], implementationWritePaths: ['input.ts'], engine: { executable: '/never-execute', authFile: '/absent', model: 'fixture', stateRoot: join(f.root, 'native') } }
  return { config, runtime: createManagedRuntime(config) }
}

it('keeps every prior delivery criterion when a new intake adds business requirements', () => {
  expect(preserveManagedDeliveryCriteria(['Include migration instructions', 'Commit only task changes'], ['Commit only task changes', 'Attach reproduction'])).toEqual(['Include migration instructions', 'Commit only task changes', 'Attach reproduction'])
})

it('stops a real runtime before any professional worker has acquired control', async () => {
  const { runtime } = runtimeFixture()
  cleanup.push(() => runtime.dispose())
  expect(() => runtime.interrupt('停止')).not.toThrow()
})

it('restores a paused in-progress amendment after reload while preserving a later owner stop', async () => {
  const f = runtimeFixture(), r = { id: 'requirement', revision: 1 }, a = { id: 'acceptance', revision: 1 }, d = { id: 'delivery', revision: 1 }
  const base = { revision: 1, extensions: {}, scope_revision_refs: [] }
  f.runtime.ledger.transact([], [
    { kind: 'create', object: { ...base, id: r.id, kind: 'requirement', data: { intent: 'Keep result', source_refs: [f.runtime.source], wish_refs: [], observable_results: ['Keep result'], constraints: [], criterion_sources: ['owner'] } } },
    { kind: 'create', object: { ...base, id: a.id, kind: 'acceptance_contract', scope_revision_refs: [r], data: { intent: 'Keep result', requirement_refs: [r], criterion_refs: [r], source_refs: [f.runtime.source] } } },
    { kind: 'create', object: { ...base, id: d.id, kind: 'delivery_contract', scope_revision_refs: [r], data: { intent: 'Local commit', requirement_refs: [r], step_refs: [], source_refs: [f.runtime.source] } } },
  ] as never)
  f.runtime.coordination.acceptManagedIntent(f.runtime.source, { id: 'work', intent: 'Keep result', requirements: [r], acceptanceContract: a, deliveryContract: d, projects: [f.runtime.project], boundary: 'Local only', accountable: 'worker:coordinator', policy: f.runtime.policy, nextReviewAt: Date.now() + 60000 })
  await f.runtime.dispose()
  const before = createManagedRuntime(f.config)
  before.interrupt('Support empty input', 'amendment')
  await before.dispose()
  const recovered = createManagedRuntime(f.config)
  expect(recovered.amendmentPending()).toBe(true)
  expect(await recovered.reconcile()).toMatchObject({ state: 'ready' })
  expect(recovered.amendmentPending()).toBe(true)
  recovered.interrupt('停止')
  await recovered.dispose()
  const stopped = createManagedRuntime(f.config); cleanup.push(() => stopped.dispose())
  expect(await stopped.reconcile()).toMatchObject({ state: 'paused' })
})

it('applies added user requirements through amendment even when framework recovery is configured', async () => {
  const calls: string[] = []
  const runtime = {
    hasPublishedDelivery: () => false,
    async prepareContinuation() { calls.push('preflight') },
    async amend() { calls.push('amend'); return { amended: true } },
    async resume() { calls.push('old-resume'); return {} },
    async advance() { calls.push('advance') },
  }
  const port = managedAdmissionRuntime(runtime as never, { frameworkBaselineTransition: { commitmentId: 'work', before: 'a', after: 'b', evidenceRefs: ['host'] } })
  await port.amend('Additional requirement')
  expect(calls).toEqual(['preflight', 'amend', 'advance'])
})

it('replays an admitted but never started request after host reload, without a new request identity', async () => {
  const f = fixture()
  f.save({ request: f.request, state: 'queued', admittedAt: 1 })
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {})
  cleanup.push(() => port.dispose())
  await port.settle()
  // The deliberately absent project fails preparation, proving admission was actually attempted.
  expect(port.read(f.request.requestId)).toMatchObject({ request: f.request, state: 'recovering', error: expect.stringContaining('ENOENT') })
})

function driver() {
  const calls: { kind: string; text: string }[] = []
  let finish: (() => void) | undefined, completed = false
  const runtime = {
    routeMessage: async (text: string) => ({ kind: 'amendment' as const, answer: text }),
    amendmentPending: () => false,
    reconcile: async () => ({ state: 'ready' as const }),
    async start(text: string) { calls.push({ kind: 'start', text }); await new Promise<void>(resolve => { finish = resolve }); return [] },
    async wake(text: string) { calls.push({ kind: 'wake', text }); completed = true; return [] },
    async amend(text: string) { calls.push({ kind: 'amend', text }); completed = true; return [] },
    interrupt(reason: string) { calls.push({ kind: 'interrupt', text: reason }); finish?.() },
    async stopNative() {}, async dispose() {},
    deliveryEvaluation: () => completed ? { verdict: 'pass' as const, reason: '', receipt: null } : { verdict: 'fail' as const, reason: 'pending', receipt: null },
    resultReport: () => undefined,
  }
  return { calls, runtime, finish: () => finish?.() }
}

it('durably wakes unfinished work at its next review without a user continuation', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const f = fixture(), d = driver()
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {}, { runtime: () => d.runtime })
  cleanup.push(() => port.dispose())
  port.enqueue(f.request)
  await vi.waitFor(() => expect(d.calls[0]?.kind).toBe('start'))
  d.finish(); await port.settle()
  expect(port.read(f.request.requestId)).toMatchObject({ state: 'waiting', nextReviewAt: expect.any(Number) })
  await vi.advanceTimersByTimeAsync(60000); await port.settle()
  expect(d.calls.map(c => c.kind)).toEqual(['start', 'wake'])
  expect(port.read(f.request.requestId).state).toBe('fulfilled-local')
})

it('routes stop immediately to the active work, never queues it as another task or resumes it on reload', async () => {
  const f = fixture(), d = driver()
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {}, { runtime: () => d.runtime })
  cleanup.push(() => port.dispose())
  port.message(f.request)
  await vi.waitFor(() => expect(d.calls[0]?.kind).toBe('start'))
  expect(port.message({ ...f.request, requestId: 'stop-message', text: '停止', origin: { ...f.request.origin, eventId: 'stop-message', messageId: 'stop' } })).toMatchObject({ requestId: f.request.requestId, state: 'paused' })
  expect(d.calls.at(-1)?.kind).toBe('interrupt')
  await port.settle()
  expect(port.read(f.request.requestId).state).toBe('paused')
  expect(() => port.read('stop-message')).toThrow()
  await port.dispose()
  const next = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {}, { runtime: () => d.runtime })
  cleanup.push(() => next.dispose())
  await next.settle()
  expect(next.read(f.request.requestId).state).toBe('paused')
  expect(d.calls.map(c => c.kind)).toEqual(['start', 'interrupt'])
})

it('resumes a stopped task only on an explicit resume command in the same responsibility', async () => {
  const f = fixture(), d = driver()
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {}, { runtime: () => d.runtime })
  cleanup.push(() => port.dispose())
  port.message(f.request); await vi.waitFor(() => expect(d.calls[0]?.kind).toBe('start'))
  port.message({ ...f.request, requestId: 'stop', text: '停止', origin: { ...f.request.origin, eventId: 'stop', messageId: 'stop' } })
  await port.settle()
  expect(port.message({ ...f.request, requestId: 'resume', text: '继续', origin: { ...f.request.origin, eventId: 'resume', messageId: 'resume' } })).toMatchObject({ requestId: f.request.requestId, state: 'queued' })
  await port.settle()
  expect(port.read(f.request.requestId).state).toBe('fulfilled-local')
})

it('binds follow-up input to the same work, fences its old candidate immediately and consumes the input once', async () => {
  const f = fixture(), d = driver()
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {}, { runtime: () => d.runtime })
  cleanup.push(() => port.dispose())
  port.message(f.request)
  await vi.waitFor(() => expect(d.calls[0]?.kind).toBe('start'))
  const update = { ...f.request, requestId: 'update', text: '再加一个边界条件', origin: { ...f.request.origin, eventId: 'update', messageId: 'second' } }
  expect(port.message(update)).toMatchObject({ requestId: f.request.requestId })
  await vi.waitFor(() => expect(d.calls.some(c => c.kind === 'interrupt')).toBe(true))
  expect(port.message(update)).toMatchObject({ duplicate: true })
  await port.settle()
  expect(d.calls.map(c => c.kind)).toEqual(['start', 'interrupt', 'amend'])
  expect(d.calls.at(-1)?.text).toContain(update.text)
  expect(port.read(f.request.requestId)).toMatchObject({ state: 'fulfilled-local', inputs: [expect.objectContaining({ requestId: 'update' })] })
  expect(() => port.read('update')).toThrow()
})

it('answers status and discussion without interrupting or revising an active task', async () => {
  const f = fixture(), d = driver(), notices: string[] = []
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {}, { runtime: () => ({ ...d.runtime, routeMessage: async () => ({ kind: 'discussion', answer: 'The implementation and quality roles are independent.' }) }), notice: (_request, text) => notices.push(text) })
  cleanup.push(() => port.dispose())
  port.message(f.request)
  await vi.waitFor(() => expect(d.calls[0]?.kind).toBe('start'))
  const message = (id: string, text: string) => ({ ...f.request, requestId: id, text, origin: { ...f.request.origin, eventId: id, messageId: id } })
  expect(port.message(message('status', '进展怎样'))).toMatchObject({ state: 'running', notice: expect.stringContaining('running') })
  port.message(message('discussion', '为什么需要独立质量角色？'))
  await vi.waitFor(() => expect(notices).toContain('The implementation and quality roles are independent.'))
  expect(d.calls.map(c => c.kind)).toEqual(['start'])
  expect(port.read(f.request.requestId).state).toBe('running')
})

it('does not consume an amendment until its new contract is durably applied', async () => {
  const f = fixture(), d = driver()
  d.runtime.amendmentPending = () => true
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {}, { runtime: () => d.runtime })
  cleanup.push(() => port.dispose())
  port.message(f.request)
  await vi.waitFor(() => expect(d.calls[0]?.kind).toBe('start'))
  port.message({ ...f.request, requestId: 'addition', text: '支持空输入', origin: { ...f.request.origin, eventId: 'addition', messageId: 'addition' } })
  await port.settle()
  expect(port.read(f.request.requestId)).toMatchObject({ state: 'waiting', consumedInputs: [] })
})

it('schedules read-only reconciliation after an execution failure and resumes only when proof says ready', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const f = fixture(), d = driver(), outcomes: string[] = []
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {}, { runtime: () => ({ ...d.runtime, start: async () => { throw Error('Lost native callback') }, reconcile: async () => { outcomes.push('reconciled'); return { state: 'ready' } } }) })
  cleanup.push(() => port.dispose())
  port.enqueue(f.request); await port.settle()
  expect(port.read(f.request.requestId)).toMatchObject({ state: 'recovering', nextReviewAt: expect.any(Number) })
  await vi.advanceTimersByTimeAsync(60000); await port.settle()
  expect(outcomes).toEqual(['reconciled'])
  expect(d.calls.map(c => c.kind)).toEqual(['wake'])
  expect(port.read(f.request.requestId).state).toBe('fulfilled-local')
})

it('reconciles published delivery before any wake and never dispatches it twice', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const f = fixture(), d = driver()
  f.save({ request: f.request, state: 'running', startedAt: 1, runtimeRoot: join(f.root, 'original-job') })
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {}, { runtime: () => ({ ...d.runtime, reconcile: async () => { d.calls.push({ kind: 'delivery-reconciled', text: '' }); return { state: 'delivered' } }, deliveryEvaluation: () => ({ verdict: 'pass', reason: '', receipt: null }) }) })
  cleanup.push(() => port.dispose())
  await vi.advanceTimersByTimeAsync(60000); await port.settle()
  expect(port.read(f.request.requestId).state).toBe('fulfilled-local')
  expect(d.calls.map(c => c.kind)).toEqual(['delivery-reconciled'])
})

it('refuses ambiguous unthreaded follow-ups rather than mutating one of several tasks', async () => {
  const f = fixture(), d = driver()
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {}, { runtime: () => d.runtime })
  cleanup.push(() => port.dispose())
  port.enqueue(f.request)
  port.enqueue({ ...f.request, requestId: 'other' })
  expect(() => port.message({ ...f.request, requestId: 'ambiguous', text: '停止' })).toThrow('MANAGED_TARGET_AMBIGUOUS')
  await vi.waitFor(() => expect(d.calls[0]?.kind).toBe('start'))
  d.finish()
  // Prevent the second intentionally blocked fixture from starting during cleanup.
  await port.dispose()
})

it('does not stop an unrelated active task when replying to a completed task thread', async () => {
  const f = fixture(), d = driver()
  f.save({ request: f.request, state: 'fulfilled-local' })
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {}, { runtime: () => d.runtime })
  cleanup.push(() => port.dispose())
  port.enqueue({ ...f.request, requestId: 'other', origin: { ...f.request.origin, messageId: 'other-first' } })
  await vi.waitFor(() => expect(d.calls[0]?.kind).toBe('start'))
  const event = { event_id: 'reply-old', chat: { id: 'chat', type: 'p2p' as const }, sender: { open_id: 'owner' }, thread: 'p2p:chat:first', text: '停止', message_id: 'reply-old', received_at: Date.now() }
  expect(() => port.message({ requestId: 'reply-old', text: '停止', origin: { kind: 'feishu', chatId: 'chat', messageId: event.message_id, event } })).toThrow('MANAGED_TARGET_NOT_ACTIVE')
  expect(port.read('other').state).toBe('running')
  expect(d.calls.map(c => c.kind)).toEqual(['start'])
})

it('never announces an old published delivery as satisfying pending added input', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const f = fixture(), d = driver(), results: string[] = [], notices: string[] = []
  const addition = { ...f.request, requestId: 'addition', text: 'Also support empty input' }
  f.save({ request: f.request, state: 'running', startedAt: 1, runtimeRoot: join(f.root, 'original-job'), inputs: [addition] })
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, (_request, result) => results.push(result.evaluate().verdict), {
    runtime: () => ({ ...d.runtime, reconcile: async () => ({ state: 'delivered' }), deliveryEvaluation: () => ({ verdict: 'pass', reason: '', receipt: null }), resultReport: () => 'Original delivery verified' }),
    notice: (_request, text) => notices.push(text),
  })
  cleanup.push(() => port.dispose())
  await vi.advanceTimersByTimeAsync(60000); await port.settle()
  expect(port.read(f.request.requestId)).toMatchObject({ state: 'needs-attention', inputs: [addition] })
  expect(results).toEqual([])
  expect(notices).toEqual([expect.stringContaining('additional input')])
  expect(d.calls).toEqual([])
})

it('retains added input arriving while published delivery reconciliation is in flight', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const f = fixture(), d = driver(), results: string[] = []
  let reconcileStarted = false, finishReconcile: (() => void) | undefined
  f.save({ request: f.request, state: 'running', startedAt: 1, runtimeRoot: join(f.root, 'original-job') })
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, (_request, result) => results.push(result.evaluate().verdict), {
    runtime: () => ({ ...d.runtime, reconcile: async () => { reconcileStarted = true; await new Promise<void>(resolve => { finishReconcile = resolve }); return { state: 'delivered' } }, deliveryEvaluation: () => ({ verdict: 'pass', reason: '', receipt: null }) }),
  })
  cleanup.push(() => port.dispose())
  await vi.advanceTimersByTimeAsync(60000)
  expect(reconcileStarted).toBe(true)
  port.message({ ...f.request, requestId: 'during-reconcile', text: 'Also support empty input' })
  await vi.waitFor(() => expect(d.calls.some(c => c.kind === 'interrupt')).toBe(true))
  finishReconcile!(); await port.settle()
  expect(port.read(f.request.requestId)).toMatchObject({ state: 'needs-attention', inputs: [expect.objectContaining({ requestId: 'during-reconcile' })] })
  expect(results).toEqual([])
})

it('keeps a stopped task paused through a later amendment and reload until explicit resume applies it', async () => {
  const f = fixture(), d = driver()
  const message = (requestId: string, text: string) => ({ ...f.request, requestId, text, origin: { ...f.request.origin, messageId: requestId, eventId: requestId } })
  let port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {}, { runtime: () => d.runtime })
  cleanup.push(() => port.dispose())
  port.message(f.request)
  await vi.waitFor(() => expect(d.calls[0]?.kind).toBe('start'))
  port.message(message('stop', '停止')); await port.settle()
  port.message(message('addition', 'Also support empty input')); await port.settle()
  expect(port.read(f.request.requestId)).toMatchObject({ state: 'paused', inputs: [expect.objectContaining({ requestId: 'stop' }), expect.objectContaining({ requestId: 'addition' })], consumedInputs: ['stop'] })
  expect(d.calls.map(c => c.kind)).toEqual(['start', 'interrupt'])
  await port.dispose()
  port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, () => {}, { runtime: () => d.runtime })
  await port.settle()
  expect(port.read(f.request.requestId).state).toBe('paused')
  expect(d.calls.map(c => c.kind)).toEqual(['start', 'interrupt'])
  port.message(message('resume', '继续')); await port.settle()
  expect(d.calls.map(c => c.kind)).toEqual(['start', 'interrupt', 'amend'])
  expect(d.calls.at(-1)?.text).toContain('Also support empty input')
  expect(port.read(f.request.requestId)).toMatchObject({ state: 'fulfilled-local', consumedInputs: ['stop', 'addition', 'resume'] })
})

it('never releases an early actual requirement as discussion before real runtime acceptance', async () => {
  const { runtime } = runtimeFixture(); cleanup.push(() => runtime.dispose())
  await expect(runtime.routeMessage('Also reject empty input', 'early')).rejects.toThrow('OWNER_MESSAGE_INTAKE_PENDING')
})

it('retries the same rejected durable message independently while delivery is active, without releasing unrelated holds', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const { OwnerInputGate } = await import('../src/host/services/superagent/kernel/owner-input.ts')
  const gate = new OwnerInputGate(), f = fixture(), d = driver(), results: string[] = [], attempts: string[] = []
  let allow = false
  const runtime = { ...d.runtime, holdOwnerMessage: (id: string) => gate.hold(id),
    routeMessage: (text: string, id?: string) => gate.classify(async () => { attempts.push(text); if (text === 'change' && !allow) throw Error('CLASSIFIER_FAILED'); return { kind: 'discussion' as const, answer: 'classified' } }, id),
  }
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, (_r, r) => results.push(r.state), { runtime: () => runtime })
  cleanup.push(() => port.dispose())
  port.message(f.request); await vi.waitFor(() => expect(d.calls[0]?.kind).toBe('start'))
  port.message({ ...f.request, requestId: 'failed', text: 'change' })
  port.message({ ...f.request, requestId: 'other', text: 'question' })
  await vi.waitFor(() => expect(attempts).toEqual(['change', 'question']))
  await expect(gate.beforeDelivery()).rejects.toThrow('OWNER_INPUT_PENDING')
  expect(port.read('initial').messages?.find(m => m.request.requestId === 'failed')?.state).toBe('routing')
  allow = true
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(attempts).toEqual(['change', 'question', 'change']))
  await expect(gate.beforeDelivery()).resolves.toBeUndefined()
  expect(d.calls.map(c => c.kind)).toEqual(['start'])
  expect(results).toEqual([])
  d.finish(); await port.settle()
})

it('suppresses completion while durable routing failed even when the runtime reports a passing old delivery', async () => {
  const f = fixture(), d = driver(), results: string[] = []
  const port = createManagedAdmission({ bootstrapFile: f.bootstrapFile }, (_r, r) => results.push(r.state), { runtime: () => ({ ...d.runtime, routeMessage: async () => { throw Error('MALFORMED_CLASSIFICATION') }, deliveryEvaluation: () => ({ verdict: 'pass', reason: '', receipt: null }) }) })
  cleanup.push(() => port.dispose()); port.message(f.request)
  await vi.waitFor(() => expect(d.calls[0]?.kind).toBe('start'))
  port.message({ ...f.request, requestId: 'unresolved', text: 'Additional condition' })
  await vi.waitFor(() => expect(port.read('initial').messages?.[0]?.answer).toContain('MALFORMED_CLASSIFICATION'))
  d.finish(); await port.settle()
  expect(port.read('initial').state).toBe('waiting')
  expect(results).toEqual([])
})
