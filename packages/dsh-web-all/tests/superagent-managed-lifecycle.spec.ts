import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'node:fs'
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

it('durably adopts an unchanged public baseline before intake and retains it after a work reload', async () => {
  const f = runtimeFixture(), git = (...args: string[]) => execFileSync('git', args, { cwd: f.config.projectRoot, encoding: 'utf8', stdio: 'pipe' }).trim()
  const before = git('rev-parse', 'HEAD'); await f.runtime.dispose()
  writeFileSync(join(f.config.projectRoot, 'framework.txt'), 'host diagnostic\n'); git('add', 'framework.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'chore: framework')
  const after = git('rev-parse', 'HEAD'), runtime = createManagedRuntime(f.config)
  const baselines = runtime.ledger.eventEntries({ runtimeEvent: 'job_baseline' }).map(e => (e.body as any).coordination.payload.payload)
  expect(baselines).toHaveLength(2); expect(baselines[0]).toMatchObject({ parent: before }); expect(baselines[1]).toMatchObject({ parent: after, previousParent: before, stoppedLaunches: [] })
  const r = { id: 'requirement', revision: 1 }, a = { id: 'acceptance', revision: 1 }, d = { id: 'delivery', revision: 1 }, base = { revision: 1, extensions: {}, scope_revision_refs: [] }
  runtime.ledger.transact([], [
    { kind: 'create', object: { ...base, id: r.id, kind: 'requirement', data: { intent: 'Keep result', source_refs: [runtime.source], wish_refs: [], observable_results: ['Keep result'], constraints: [], criterion_sources: ['owner'] } } },
    { kind: 'create', object: { ...base, id: a.id, kind: 'acceptance_contract', scope_revision_refs: [r], data: { intent: 'Keep result', requirement_refs: [r], criterion_refs: [r], source_refs: [runtime.source] } } },
    { kind: 'create', object: { ...base, id: d.id, kind: 'delivery_contract', scope_revision_refs: [r], data: { intent: 'Local commit', requirement_refs: [r], step_refs: [], source_refs: [runtime.source] } } },
  ] as never)
  runtime.coordination.acceptManagedIntent(runtime.source, { id: 'work', intent: 'Keep result', requirements: [r], acceptanceContract: a, deliveryContract: d, projects: [runtime.project], boundary: 'Local only', accountable: 'worker:coordinator', policy: runtime.policy, nextReviewAt: Date.now() + 60000 })
  await runtime.dispose(); const restored = createManagedRuntime(f.config); cleanup.push(() => restored.dispose())
  expect((restored.ledger.eventEntries({ runtimeEvent: 'job_baseline', latest: true })[0]?.body as any).coordination.payload.payload.parent).toBe(after)
})

it.each(['public-source', 'public-mode', 'workspace', 'unceased', 'operation'])('refuses pre-intake baseline adoption for %s', async failure => {
  const f = runtimeFixture(), git = (...args: string[]) => execFileSync('git', args, { cwd: f.config.projectRoot, encoding: 'utf8', stdio: 'pipe' }).trim()
  await f.runtime.dispose()
  writeFileSync(join(f.config.projectRoot, failure === 'public-source' ? 'input.ts' : 'framework.txt'), 'changed\n'); if (failure === 'public-mode') chmodSync(join(f.config.projectRoot, 'input.ts'), 0o755); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'chore: framework')
  if (failure === 'workspace') writeFileSync(join(f.config.root, 'implementation', 'input.ts'), 'candidate change\n')
  const { ManagedLedger } = await import('../src/host/services/superagent/kernel/managed-ledger.ts')
  const original = ManagedLedger.prototype.snapshot
  const spy = vi.spyOn(ManagedLedger.prototype, 'snapshot').mockImplementation(function (this: InstanceType<typeof ManagedLedger>, kind: any) {
    if (failure === 'unceased' && kind === 'action') return [{ id: 'native:unknown', revision: 1, data: { action_kind: 'dispatch', receipt: { stopped: false } } }] as any
    if (failure === 'operation' && kind === 'coordination_operation') return [{ id: 'pending', revision: 1, data: { state: 'running' } }] as any
    return original.call(this, kind)
  })
  try { expect(() => createManagedRuntime(f.config)).toThrow(/MANAGED_PREINTAKE_/ ) } finally { spy.mockRestore() }
})

it.each(['near-expiry', 'expired', 'guard-failed'])('bounds pre-intake profile renewal by current method qualification: %s', async mode => {
  const f = runtimeFixture(), started = Date.now(), originalProfile = f.runtime.ledger.get('profile:codex-controlled')!, originalWorkers = [...f.runtime.workers.values()]
  await f.runtime.dispose()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.config.projectRoot, stdio: 'pipe' })
  writeFileSync(join(f.config.projectRoot, mode === 'guard-failed' ? 'input.ts' : 'framework.txt'), 'framework\n'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'chore: framework')
  const now = started + (mode === 'near-expiry' ? 29 : 31) * 60000, expiresAt = now + 10 * 60000
  const { managedVerificationMethod, methodAssetDigest } = await import('../src/host/services/superagent/executors/managed-verification-method.ts')
  const { verificationRuntimeDigest } = await import('../src/host/services/superagent/executors/verification-run.ts')
  const config = { ...f.config, verification: { methodId: 'codex-runTurn-replay@1', qualification: { runtimeDigest: verificationRuntimeDigest(), methodAssetsDigest: methodAssetDigest(JSON.stringify(managedVerificationMethod('codex-runTurn-replay@1').assets)), evidenceRefs: ['host-method-qualification'], expiresAt } } }
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    if (mode === 'guard-failed') {
      expect(() => createManagedRuntime(config)).toThrow('MANAGED_PREINTAKE_PUBLIC_CHANGED')
      const { ManagedLedger } = await import('../src/host/services/superagent/kernel/managed-ledger.ts'), ledger = new ManagedLedger(join(config.root, 'managed.sqlite'))
      try { expect(ledger.snapshot('profile_qualification')).toHaveLength(0) } finally { ledger.close() }
    } else {
      const runtime = createManagedRuntime(config); cleanup.push(() => runtime.dispose())
      const qualification = runtime.ledger.snapshot('profile_qualification')[0]!
      expect(qualification?.data.expires_at).toBe(expiresAt)
      expect(qualification?.data.profile_ref).toEqual({ id: originalProfile.id, revision: originalProfile.revision })
      expect(runtime.ledger.get(originalProfile.id)).toEqual(originalProfile)
      expect([...runtime.workers.values()]).toEqual(originalWorkers)
      const baseline = runtime.ledger.eventEntries({ runtimeEvent: 'job_baseline', latest: true })[0]!
      expect(qualification?.data.evidence_refs).toContain((baseline.body as any).coordination.payload.id)
      expect(config.verification.qualification.expiresAt).toBe(expiresAt)
    }
  } finally { clock.mockRestore() }
})

async function continuationFixture() {
  const f = runtimeFixture(), runtime = f.runtime
  const r = { id: 'requirement', revision: 1 }, a = { id: 'acceptance', revision: 1 }, d = { id: 'delivery', revision: 1 }, base = { revision: 1, extensions: {}, scope_revision_refs: [] }
  runtime.ledger.transact([], [
    { kind: 'create', object: { ...base, id: r.id, kind: 'requirement', data: { intent: 'Keep result', source_refs: [runtime.source], wish_refs: [], observable_results: ['Keep result'], constraints: [], criterion_sources: ['owner'] } } },
    { kind: 'create', object: { ...base, id: a.id, kind: 'acceptance_contract', scope_revision_refs: [r], data: { intent: 'Keep result', requirement_refs: [r], criterion_refs: [r], source_refs: [runtime.source] } } },
    { kind: 'create', object: { ...base, id: d.id, kind: 'delivery_contract', scope_revision_refs: [r], data: { intent: 'Local commit', requirement_refs: [r], step_refs: [], source_refs: [runtime.source] } } },
  ] as never)
  runtime.coordination.acceptManagedIntent(runtime.source, { id: 'work', intent: 'Keep result', requirements: [r], acceptanceContract: a, deliveryContract: d, projects: [runtime.project], boundary: 'Local only', accountable: 'worker:coordinator', policy: runtime.policy, nextReviewAt: Date.now() + 60000 })
  runtime.coordination.host.claimOperation({ id: 'interrupted', inputRef: 'original-native-input', proposal: { kind: 'look' }, domainKeys: ['seat:worker:coordinator'], scopeRefs: runtime.coordination.semanticScopes('work'), executionSlots: [] })
  await runtime.dispose()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.config.projectRoot, encoding: 'utf8', stdio: 'pipe' }).trim(), before = git('rev-parse', 'HEAD')
  writeFileSync(join(f.config.projectRoot, 'framework.txt'), 'framework only\n'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'chore: framework')
  const after = git('rev-parse', 'HEAD')
  const { managedVerificationMethod, methodAssetDigest } = await import('../src/host/services/superagent/executors/managed-verification-method.ts'), { verificationRuntimeDigest } = await import('../src/host/services/superagent/executors/verification-run.ts')
  const config = { ...f.config, frameworkBaselineTransition: { before, after, commitmentId: 'work', evidenceRefs: ['trusted-framework-review'] }, verification: { methodId: 'codex-runTurn-replay@1', qualification: { runtimeDigest: verificationRuntimeDigest(), methodAssetsDigest: methodAssetDigest(JSON.stringify(managedVerificationMethod('codex-runTurn-replay@1').assets)), evidenceRefs: ['current-method'], expiresAt: Date.now() + 600000 } } }
  const restored = createManagedRuntime(config)
  // The fixture has no model process; this isolates the stopped launch boundary without external calls.
  const originalSnapshot = restored.ledger.snapshot.bind(restored.ledger)
  const launch = { id: 'stopped-native', revision: 2, kind: 'action', data: { execution_spec: { kind: 'dispatch', executable: config.engine.executable }, receipt: { stopped: true } } }
  vi.spyOn(restored.ledger, 'snapshot').mockImplementation(kind => kind === 'action' ? [launch] as any : originalSnapshot(kind))
  cleanup.push(() => restored.dispose())
  return { runtime: restored, config, before, after, launch, git, originalSnapshot }
}

it('framework wake adopts the trusted baseline without amending the original business and persists it across reload', async () => {
  const f = await continuationFixture(), { runtime } = f
  const work = runtime.ledger.get('work'), contract = runtime.ledger.get('acceptance'), workers = [...runtime.workers.values()]
  const wake = vi.spyOn(runtime, 'wake').mockResolvedValue({ requestId: 'original-thread-turn', proposals: { proposals: [] } })
  vi.spyOn(runtime, 'advance').mockResolvedValue([])
  const amend = vi.spyOn(runtime, 'amend')
  await managedAdmissionRuntime(runtime, f.config).wake('Continue original request')
  expect(wake).toHaveBeenCalledOnce(); expect(amend).not.toHaveBeenCalled()
  expect(runtime.ledger.get('work')).toEqual(work); expect(runtime.ledger.get('acceptance')).toEqual(contract); expect([...runtime.workers.values()]).toEqual(workers)
  expect(runtime.ledger.eventEntries({ runtimeEvent: 'authenticated_amendment' })).toHaveLength(0)
  expect((runtime.ledger.eventEntries({ runtimeEvent: 'job_baseline', latest: true })[0]!.body as any).coordination.payload.payload).toMatchObject({ parent: f.after, previousParent: f.before, commitment: { id: 'work' }, proofRef: { revision: 1 } })
  expect(runtime.ledger.snapshot('profile_qualification')[0]!.data.expires_at).toBe(f.config.verification.qualification.expiresAt)
  const qualification = runtime.ledger.snapshot('profile_qualification')
  writeFileSync(join(f.config.root, 'implementation', 'input.ts'), 'export const value = 2\n')
  await managedAdmissionRuntime(runtime, f.config).wake('Review the legitimate candidate')
  expect(wake).toHaveBeenCalledTimes(2); expect(amend).not.toHaveBeenCalled()
  expect(runtime.ledger.snapshot('profile_qualification')).toEqual(qualification)
  expect(runtime.ledger.eventEntries({ runtimeEvent: 'framework_baseline_bound' })).toHaveLength(1)
  const loaded = createManagedRuntime(f.config); cleanup.push(() => loaded.dispose())
  vi.spyOn(loaded.ledger, 'snapshot').mockImplementation(kind => kind === 'action' ? [f.launch] as any : runtime.ledger.snapshot(kind))
  vi.spyOn(loaded, 'wake').mockResolvedValue({ requestId: 'same-thread-after-reload', proposals: { proposals: [] } })
  vi.spyOn(loaded, 'advance').mockResolvedValue([])
  await managedAdmissionRuntime(loaded, f.config).wake('Continue candidate QA after reload')
  expect(loaded.ledger.snapshot('profile_qualification')).toEqual(qualification)
  expect(loaded.ledger.eventEntries({ runtimeEvent: 'framework_baseline_bound' })).toHaveLength(1)
  expect(loaded.ledger.get('work')).toEqual(work)
})

it.each(['running', 'forged', 'stale-retirement', 'unstopped', 'native-live', 'public', 'candidate', 'head', 'before', 'binding', 'expired', 'method', 'binary', 'revoked', 'owner-stop'])('framework continuation refuses %s without baseline or qualification writes', async failure => {
  const f = await continuationFixture(), { runtime } = f
  if (failure !== 'running') await runtime.reconcile()
  if (failure === 'forged') { const entries = runtime.ledger.eventEntries.bind(runtime.ledger); vi.spyOn(runtime.ledger, 'eventEntries').mockImplementation(filter => filter.operationRetirement ? [] : entries(filter)) }
  if (failure === 'stale-retirement') {
    const old = runtime.ledger.get.bind(runtime.ledger)
    vi.spyOn(runtime.ledger, 'get').mockImplementation(id => { const o = old(id); return id === 'interrupted' && o ? { ...o, revision: o.revision + 1 } : o })
    const snapshot = (kind?: string) => kind === 'action' ? [f.launch] as any : f.originalSnapshot(kind)
    vi.spyOn(runtime.ledger, 'snapshot').mockImplementation(kind => snapshot(kind).map(o => o.id === 'interrupted' ? { ...o, revision: o.revision + 1 } : o))
  }
  if (failure === 'unstopped') f.launch.data.receipt.stopped = false
  if (failure === 'native-live') runtime.native.set('implementation', {} as never)
  if (failure === 'public') { writeFileSync(join(f.config.projectRoot, 'input.ts'), 'changed'); f.git('add', '.'); f.git('-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','test: changed'); f.config.frameworkBaselineTransition.after = f.git('rev-parse','HEAD') }
  if (failure === 'candidate') writeFileSync(join(f.config.root, 'implementation', 'input.ts'), 'changed')
  if (failure === 'head') f.config.frameworkBaselineTransition.after = f.before
  if (failure === 'before') f.config.frameworkBaselineTransition.before = f.after
  if (failure === 'binding') f.config.frameworkBaselineTransition.commitmentId = 'other'
  if (failure === 'expired') f.config.verification.qualification.expiresAt = Date.now() - 1
  if (failure === 'method') f.config.verification.qualification.runtimeDigest = 'stale'
  if (failure === 'binary') f.launch.data.execution_spec.executable = '/different'
  if (failure === 'revoked') { const old = runtime.ledger.get.bind(runtime.ledger); vi.spyOn(runtime.ledger,'get').mockImplementation(id => { const o = old(id); return id === 'profile:codex-controlled' && o ? { ...o, data: { ...o.data, revoked: true } } : o }) }
  if (failure === 'owner-stop') runtime.interrupt('owner stop')
  try { await expect(runtime.prepareContinuation(true)).rejects.toThrow() } finally { runtime.native.clear() }
  expect(runtime.ledger.eventEntries({ runtimeEvent: 'framework_baseline_bound' })).toHaveLength(0)
  expect(runtime.ledger.eventEntries({ runtimeEvent: 'job_baseline' })).toHaveLength(1)
  expect(runtime.ledger.snapshot('profile_qualification')).toHaveLength(0)
})

it.each(['missing-action', 'live-native', 'live-helper', 'wrong-source', 'wrong-commitment', 'wrong-evidence'])('revalidates interrupted retirement proof against %s', async failure => {
  const f = await continuationFixture(), { runtime } = f
  await runtime.reconcile()
  const { retiredInterruptedOperation } = await import('../src/host/services/superagent/managed-runtime.ts')
  const operation = runtime.ledger.get('interrupted')!
  expect(retiredInterruptedOperation(runtime.ledger, operation, 'work')).toBe(true)
  if (failure.endsWith('action') || failure.startsWith('live-')) {
    operation.data.executions = [{ kind: failure === 'live-helper' ? 'controlled' : 'native', launch: { id: 'proof-action', revision: 1 }, action: { id: 'proof-action', revision: 1 } }] as any
    const original = runtime.ledger.get.bind(runtime.ledger)
    vi.spyOn(runtime.ledger, 'get').mockImplementation(id => id === 'proof-action' ? failure === 'missing-action' ? undefined : { kind: 'action', id, revision: 2, data: { execution_spec: { kind: failure === 'live-helper' ? 'collect' : 'dispatch' }, receipt: { stopped: false } } } as any : original(id))
  } else {
    const original = runtime.ledger.eventEntries.bind(runtime.ledger)
    vi.spyOn(runtime.ledger, 'eventEntries').mockImplementation(filter => original(filter).map(e => {
      if (!filter.operationRetirement) return e
      const body = JSON.parse(JSON.stringify(e.body))
      if (failure === 'wrong-source') body.coordination.source.id = 'unauthenticated'
      if (failure === 'wrong-commitment') body.coordination.payload.commitmentId = 'other'
      if (failure === 'wrong-evidence') body.coordination.payload.evidenceRefs = ['forged']
      return { ...e, body }
    }))
  }
  expect(retiredInterruptedOperation(runtime.ledger, operation, 'work')).toBe(false)
})

it.each(['proof-id', 'proof-revision', 'commitment', 'commitment-revision', 'source', 'transition', 'head', 'expired', 'revoked', 'owner-stop'])('does not reuse an adopted framework binding with %s mismatch', async failure => {
  const f = await continuationFixture(), { runtime } = f
  await runtime.reconcile(); await runtime.prepareContinuation(true)
  const qualifications = runtime.ledger.snapshot('profile_qualification'), baselines = runtime.ledger.eventEntries({ runtimeEvent: 'job_baseline' })
  writeFileSync(join(f.config.root, 'implementation', 'input.ts'), 'export const value = 2\n')
  if (['proof-id', 'proof-revision', 'commitment', 'commitment-revision', 'source'].includes(failure)) {
    const entries = runtime.ledger.eventEntries.bind(runtime.ledger)
    vi.spyOn(runtime.ledger, 'eventEntries').mockImplementation(filter => entries(filter).map(e => {
      if (filter.runtimeEvent !== 'job_baseline' || !filter.latest) return e
      const body = JSON.parse(JSON.stringify(e.body)), command = body.coordination
      if (failure === 'proof-id') command.payload.payload.proofRef.id = 'forged'
      if (failure === 'proof-revision') command.payload.payload.proofRef.revision++
      if (failure === 'commitment') command.payload.payload.commitment.id = 'other'
      if (failure === 'commitment-revision') command.payload.payload.commitment.revision++
      if (failure === 'source') command.source.id = 'other-host'
      return { ...e, body }
    }))
  }
  if (failure === 'transition') f.config.frameworkBaselineTransition.evidenceRefs = ['different-transition']
  if (failure === 'head') f.config.frameworkBaselineTransition.after = f.before
  if (failure === 'expired') f.config.verification.qualification.expiresAt = Date.now() - 1
  if (failure === 'revoked') { const get = runtime.ledger.get.bind(runtime.ledger); vi.spyOn(runtime.ledger, 'get').mockImplementation(id => { const o = get(id); return id === 'profile:codex-controlled' && o ? { ...o, data: { ...o.data, revoked: true } } : o }) }
  if (failure === 'owner-stop') runtime.interrupt('owner stopped after candidate progress')
  await expect(runtime.prepareContinuation(true)).rejects.toThrow()
  expect(runtime.ledger.snapshot('profile_qualification')).toEqual(qualifications)
  expect(runtime.ledger.eventEntries({ runtimeEvent: 'job_baseline' })).toEqual(baselines)
  expect(runtime.ledger.eventEntries({ runtimeEvent: 'framework_baseline_bound' })).toHaveLength(1)
})

async function borrowedContinuationFixture(orphan = false) {
  const f = await continuationFixture(), { runtime } = f, kernel = runtime.kernel
  vi.mocked(runtime.ledger.snapshot).mockImplementation(f.originalSnapshot)
  const workspace = runtime.workspaces.get('coordinator')!.workspace, target = { id: 'requirement', revision: 1 }, expiresAt = Date.now() + 60000
  if (orphan) mkdirSync(f.config.engine.stateRoot,{recursive:true})
  const executable = f.config.engine.executable, args = ['app-server', '--stdio'], control = kernel.host.grantControl(target, 'fixture-worker', expiresAt)
  kernel.host.grantCapability({ id: 'rpc-fixture-cap', revision: 1, expiresAt, scopeRefs: [], evidenceRefs: ['fixture-authorized-native'], externalTools: 'blocked', revoked: false, launch: { executable, args, processPolicy: 'single' }, ...(orphan ? {nativeRuntime:{root:realpathSync(f.config.engine.stateRoot),stateDirectoryVariable:'CODEX_HOME',network:'engine-transport' as const,evidenceRefs:['fixture-native-only']}} : {}) })
  kernel.host.grantMandate({ id: 'rpc-fixture-mandate', revision: 1, requester: 'fixture-owner', subject: 'fixture-worker', target, actions: ['dispatch','attach','respond_request','collect','inspect'], workspaceId: workspace.id, resourceIds: workspace.resources, scopeRefs: [], expiresAt, revoked: false })
  const spec = { id: 'native-parent', idempotencyKey: 'native-parent', requester: 'fixture-owner', subject: 'fixture-worker', target, epoch: control.epoch, mandateRef: { id: 'rpc-fixture-mandate', revision: 1 }, capabilityRef: { id: 'rpc-fixture-cap', revision: 1 }, kind: 'dispatch' as const, workspaceId: workspace.id, resourceIds: workspace.resources, scopeRefs: [], purpose: 'engineering' as const, executable, args, timeoutMs: 30000, processPolicy: 'single' as const }
  const planned = kernel.actions.planAction(spec); kernel.actions.claimResources(planned.ref, spec.resourceIds)
  const parent = kernel.host.beginDispatch(planned.ref); if (parent.kind === 'denial') throw Error(parent.code)
  for (const [name, kind, reason] of [['confirmed-attach','attach',''], ['notification','attach','NOTIFICATION_HAS_NO_NATIVE_RESPONSE'], ['server-response','respond_request','SERVER_RESPONSE_HAS_NO_RECEIPT'], ['connection-lost','collect','CONNECTION_LOST']] as const) {
    const payload = JSON.stringify({ method: name }), payloadDigest = createHash('sha256').update(payload).digest('hex'), nativeRequestId = name === 'notification' ? undefined : name
    const action = kernel.actions.planAction({ ...spec, id: 'rpc:' + name, idempotencyKey: 'rpc:' + name, kind, payloadDigest, ...(nativeRequestId ? { nativeRequestId } : {}) })
    kernel.host.borrowSessionResources(action.ref, parent.actionRef)
    const sent = kernel.host.beginDispatch(action.ref); if (sent.kind === 'denial') throw Error(sent.code)
    kernel.host.reserveNativeExchange(sent.actionRef, parent.actionRef, payload)
    if (name === 'confirmed-attach') kernel.host.completeOperation(sent.actionRef, { ownerRef: parent.actionRef, payloadDigest, nativeRequestId, responseDigest: createHash('sha256').update('response').digest('hex') }, ['native-response'])
    else kernel.actions.recordActionResult(sent.actionRef, { status: 'unknown', stopped: false, evidenceRefs: [], reason })
  }
  const receipt = { status: 'failed' as const, stopped: true, evidenceRefs: ['native-cessation'], reason: 'LIVE_FENCE_REVOKED', observation: { stdout: 'synthetic stdout', stderr: 'synthetic stderr', observedAt: 1700000000000 } }
  if (orphan) {
    kernel.actions.planAction({ ...spec, id: 'orphan-rpc', idempotencyKey: 'orphan-rpc', kind: 'collect', payloadDigest: createHash('sha256').update('pending-rpc').digest('hex') })
    kernel.host.observeNative(parent.actionRef, 'execution:' + parent.actionRef.id, { kind: 'process_exit', launchRef: parent.actionRef, executionDigest: createHash('sha256').update(JSON.stringify(spec)).digest('hex'), receipt } as never)
  }
  kernel.host.reconcileAction(parent.actionRef, receipt)
  // Parent finality is the fence even while control/capability leases remain current.
  await runtime.reconcile()
  return { ...f, parent, spec }
}

it('adopts a framework baseline with canonically borrowed attach notification response and connection-lost RPCs after parent cessation', async () => {
  const f = await borrowedContinuationFixture()
  const { DatabaseSync } = await import('node:sqlite'), prepare = DatabaseSync.prototype.prepare
  let controlReads = 0, borrowReads = 0
  const read = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
    if (sql === 'SELECT body_json FROM sa_managed_control WHERE singleton=1') controlReads++
    if (sql.includes("json_extract(body_json,'$.controlled.kind')='borrow'")) borrowReads++
    return prepare.call(this, sql)
  })
  try { await expect(f.runtime.prepareContinuation(true)).resolves.toMatchObject({ head: f.after }) } finally { read.mockRestore() }
  expect(controlReads).toBe(1); expect(borrowReads).toBe(1)
  expect(f.runtime.ledger.get('rpc:confirmed-attach')!.data.receipt).toMatchObject({ stopped: false, status: 'confirmed' })
  expect(f.runtime.ledger.get('rpc:connection-lost')!.data.receipt).toMatchObject({ stopped: false, status: 'unknown', reason: 'CONNECTION_LOST' })
})

it.each(['unowned', 'missing-borrow-event', 'forged-owner', 'parent-live', 'different-executable', 'helper-opened', 'independent-collect'])('refuses apparent RPC cessation with %s and writes no adoption', async failure => {
  const f = await borrowedContinuationFixture(), { runtime } = f
  if (failure === 'missing-borrow-event') runtime.kernel.actions.planAction({ ...f.spec, id: 'missing-proof', idempotencyKey: 'missing-proof', kind: 'attach', payloadDigest: createHash('sha256').update('attach').digest('hex') })
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(join(f.config.root, 'managed.sqlite'))
  try {
    if (['unowned','forged-owner','helper-opened','missing-borrow-event'].includes(failure)) {
      const row = db.prepare('SELECT body_json FROM sa_managed_control WHERE singleton=1').get()!, state = JSON.parse(String(row.body_json))
      if (failure === 'missing-borrow-event') state.borrowed.push({ actionId: 'missing-proof', ownerRef: f.parent.actionRef })
      if (failure === 'unowned') state.borrowed = state.borrowed.filter((b: any) => b.actionId !== 'rpc:notification')
      if (failure === 'forged-owner') state.borrowed.find((b: any) => b.actionId === 'rpc:notification').ownerRef.revision++
      if (failure === 'helper-opened') (state.opened ??= []).push('rpc:notification')
      db.prepare('UPDATE sa_managed_control SET body_json=? WHERE singleton=1').run(JSON.stringify(state))
    }
  } finally { db.close() }
  if (failure === 'parent-live' || failure === 'different-executable') {
    const snapshot = f.originalSnapshot
    vi.mocked(runtime.ledger.snapshot).mockImplementation(kind => snapshot(kind).map(o => {
      if (failure === 'parent-live' && o.id === 'native-parent') return { ...o, data: { ...o.data, receipt: { ...(o.data.receipt as any), stopped: false } } }
      if (failure === 'different-executable' && o.id === 'rpc:notification') return { ...o, data: { ...o.data, execution_spec: { ...(o.data.execution_spec as any), executable: '/independent-helper' } } }
      return o
    }))
  }
  if (failure === 'independent-collect') runtime.kernel.actions.planAction({ ...f.spec, id: 'independent-collect', idempotencyKey: 'independent-collect', kind: 'collect', payloadDigest: createHash('sha256').update('collect').digest('hex') })
  await expect(runtime.prepareContinuation(true)).rejects.toThrow('MANAGED_CONTINUATION_NOT_QUIESCENT')
  expect(runtime.ledger.eventEntries({ runtimeEvent: 'framework_baseline_bound' })).toHaveLength(0)
  expect(runtime.ledger.eventEntries({ runtimeEvent: 'job_baseline' })).toHaveLength(1)
  expect(runtime.ledger.snapshot('profile_qualification')).toHaveLength(0)
})


it('continues after an exact canonical RPC plan lost its parent before borrowing without fabricating a receipt', async () => {
  const f = await borrowedContinuationFixture(true), original = f.runtime.ledger.get('orphan-rpc')
  const receipt = f.runtime.ledger.get('native-parent')!.data.receipt
  expect(receipt).toEqual({ status: 'failed', stopped: true, evidenceRefs: ['native-cessation'], reason: 'LIVE_FENCE_REVOKED', observation: { stdout: 'synthetic stdout', stderr: 'synthetic stderr', observedAt: 1700000000000 } })
  const exit = f.runtime.ledger.eventEntries({ nativeKind: 'process_exit' })[0]!.body as any
  const result = f.runtime.ledger.events().find((event: any) => event.controlled?.kind === 'result' && event.controlled.ref.id === 'native-parent') as any
  expect(exit.controlled.command.observation.receipt).toEqual(receipt)
  expect(result.controlled.receipt).toEqual(receipt)
  await expect(f.runtime.prepareContinuation(true)).resolves.toMatchObject({ head: f.after })
  expect(f.runtime.ledger.get('orphan-rpc')).toEqual(original)
  expect(original).toMatchObject({ revision: 1, data: { state: 'planned' } })
  expect(original!.data.receipt).toBeUndefined()
  expect(()=>f.runtime.kernel.host.borrowSessionResources({id:'orphan-rpc',revision:1},f.parent.actionRef)).toThrow('SESSION_OWNER_FENCED')
  expect(f.runtime.kernel.host.reserveNativeExchange({id:'orphan-rpc',revision:1},f.parent.actionRef,'pending-rpc')).toMatchObject({kind:'denial'})
  expect(f.runtime.ledger.get('orphan-rpc')).toEqual(original)
})

it.each(['parent', 'exit', 'result'])('rejects a never-started RPC when any field of the %s receipt differs', async source => {
  const f = await borrowedContinuationFixture(true), { runtime } = f
  let field = ''
  const change = (original: any) => {
    const receipt = structuredClone(original)
    if (field === 'stdout' || field === 'stderr') receipt.observation[field] = 'different output'
    else if (field === 'observedAt') receipt.observation.observedAt++
    else if (field === 'missing-observation') delete receipt.observation
    else receipt[field] = ({ status: 'confirmed', stopped: false, evidenceRefs: ['different-evidence'], reason: 'DIFFERENT_REASON', exitCode: 1, cessation: { kind: 'stopped', evidenceRefs: ['different-cessation'] }, operation: { ownerRef: f.parent.actionRef, payloadDigest: 'different-digest' }, extra: 'unmatched-field' } as Record<string, unknown>)[field]
    return receipt
  }
  if (source === 'parent') vi.mocked(runtime.ledger.snapshot).mockImplementation(kind => f.originalSnapshot(kind).map(o => o.id === 'native-parent' ? { ...o, data: { ...o.data, receipt: change(o.data.receipt) } } : o))
  if (source === 'exit') {
    const entries = runtime.ledger.eventEntries.bind(runtime.ledger)
    vi.spyOn(runtime.ledger, 'eventEntries').mockImplementation(filter => entries(filter).map(event => {
      if (filter.nativeKind !== 'process_exit') return event
      const body = structuredClone(event.body) as any
      body.controlled.command.observation.receipt = change(body.controlled.command.observation.receipt)
      return { ...event, body }
    }))
  }
  if (source === 'result') {
    const { DatabaseSync } = await import('node:sqlite'), prepare = DatabaseSync.prototype.prepare
    const read = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
      const statement = prepare.call(this, sql)
      if (!sql.includes("json_extract(body_json,'$.controlled.kind')='result'")) return statement
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...args) => all(...args).map(row => {
        const body = JSON.parse(String(row.body_json))
        body.controlled.receipt = change(body.controlled.receipt)
        return { ...row, body_json: JSON.stringify(body) }
      }))
      return statement
    })
    cleanup.push(() => read.mockRestore())
  }
  for (field of ['stdout', 'stderr', 'observedAt', 'missing-observation', 'status', 'stopped', 'evidenceRefs', 'reason', 'exitCode', 'cessation', 'operation', 'extra']) {
    await expect(runtime.prepareContinuation(true), field).rejects.toThrow('MANAGED_CONTINUATION_NOT_QUIESCENT')
    expect(runtime.ledger.eventEntries({ runtimeEvent: 'framework_baseline_bound' }), field).toHaveLength(0)
    expect(runtime.ledger.eventEntries({ runtimeEvent: 'job_baseline' }), field).toHaveLength(1)
    expect(runtime.ledger.snapshot('profile_qualification'), field).toHaveLength(0)
  }
})

async function retainedContinuationFixture() {
  const f = await continuationFixture(), { runtime } = f
  await runtime.reconcile()
  const contract = runtime.ledger.get('work')!.data.acceptance_contract as any
  const evidence = runtime.coordination.host.recordRuntimeEvent('implementation-input','fixture-input',{original:true},[contract])
  const op = runtime.coordination.host.claimOperation({id:'implemented',inputRef:'original-input',proposal:{kind:'look'},domainKeys:['seat:worker:implementation'],scopeRefs:runtime.coordination.semanticScopes('work'),executionSlots:[]})
  const professionalResultRef = runtime.coordination.host.recordRuntimeEvent('professional:original','professional_result',{operationId:op.id,role:'implementation',nativeSessionId:'original-thread',turnId:'original-turn'},[contract,runtime.workers.get('implementation')!],[evidence.id])
  const completed = {...runtime.ledger.get(op.id)!,data:{...runtime.ledger.get(op.id)!.data,state:'completed',result:{status:'observed',role:'implementation',evidence:professionalResultRef}}}
  const originalGet=runtime.ledger.get.bind(runtime.ledger)
  const fixtureContext = {id:'implementation-context',revision:1,kind:'context_envelope',data:{envelope:{commitmentId:'work',assignment:{id:'implementation-team',revision:1},semanticRefs:[contract]}}}
  const fixtureTeam = {id:'implementation-team',revision:1,kind:'team_assignment',data:{commitment_id:'work',worker_ref:runtime.workers.get('implementation')}}
  vi.spyOn(runtime.ledger,'get').mockImplementation(id=>id===op.id?completed:id===evidence.id?{...originalGet(id)!,kind:'context_input',data:{context_ref:{id:fixtureContext.id,revision:1},worker_ref:runtime.workers.get('implementation')!,native_session_id:'original-thread',turn_id:'original-turn'}}:id===fixtureContext.id?fixtureContext as any:id===fixtureTeam.id?fixtureTeam as any:originalGet(id))
  const binding = {id:'fixture-binding',kind:'session_binding',revision:1,data:{worker_ref:runtime.workers.get('implementation'),host_ref:{id:'host:local',revision:1},engine_ref:'codex',runtime_namespace:f.config.engine.stateRoot+'/implementation',native_session_id:'original-thread'}}
  const snapshot = vi.mocked(runtime.ledger.snapshot).getMockImplementation()!
  vi.mocked(runtime.ledger.snapshot).mockImplementation(kind => kind==='session_binding'?[binding] as any:snapshot(kind).map(o=>o.id===op.id?completed:o))
  for (const state of ['ready','working'] as const) { const work=runtime.ledger.get('work')!; runtime.ledger.transact([{id:work.id,revision:work.revision}],[{kind:'transition',id:work.id,state,reason:'fixture implementation'}]) }
  const { createVerificationService } = await import('../src/host/services/superagent/verification/index.ts'), { managedVerificationMethod } = await import('../src/host/services/superagent/executors/managed-verification-method.ts')
  const service=createVerificationService(runtime.ledger,runtime.source,join(f.config.root,'verification'))
  const assignment=service.registerAssignment({commitmentId:'work',contract,requirements:[{id:'requirement',revision:1}],generators:[JSON.stringify([binding.data.host_ref,binding.data.engine_ref,binding.data.runtime_namespace,binding.data.native_session_id])],reviewer:'independent-quality'})
  const prepared=join(f.config.root,'prepared-candidate');mkdirSync(prepared)
  writeFileSync(join(prepared,'input.ts'),'export const value = 2\n')
  for (const [path,bytes] of Object.entries(managedVerificationMethod('codex-runTurn-replay@1').assets)) writeFileSync(join(prepared,path),bytes)
  const candidateRef=service.collectCandidate(assignment,{sourceRoot:prepared,entry:'candidate.mjs',exportName:'inspect',environment:'node-local:codex-runTurn-replay@1'})
  service.assessCandidate(contract,candidateRef,[])
  writeFileSync(join(f.config.root,'implementation','input.ts'),'export const value = 2\n')
  writeFileSync(join(f.config.root,'quality','input.ts'),'export const value = 2\n')
  const proof={candidateRef,manifestDigest:String(runtime.ledger.get(candidateRef.id)!.data.digest),professionalResultRef,evidenceRefs:[professionalResultRef.id]}
  ;(f.config.frameworkBaselineTransition as any).retainedCandidate=proof
  return {...f,proof,assignment,candidate:runtime.ledger.get(candidateRef.id)!,binding}
}

it('retains only the exact host-frozen candidate during first framework adoption and preserves failed evidence', async () => {
  const f=await retainedContinuationFixture(), work=f.runtime.ledger.get('work'), evaluations=f.runtime.ledger.snapshot('evaluation'), candidate=f.candidate
  await expect(f.runtime.prepareContinuation(true)).resolves.toMatchObject({head:f.after})
  expect(f.runtime.ledger.get('work')).toEqual(work);expect(f.runtime.ledger.get(candidate.id)).toEqual(candidate);expect(f.runtime.ledger.snapshot('evaluation')).toEqual(evaluations)
  writeFileSync(join(f.config.root,'implementation','input.ts'),'export const value = 3\n')
  await expect(f.runtime.prepareContinuation(true)).resolves.toMatchObject({head:f.after})
  expect(f.runtime.ledger.eventEntries({runtimeEvent:'framework_baseline_bound'})).toHaveLength(1)
})

it.each(['generic-cap','missing-cap','borrowed','framed','opened','leased','parent-leased','missing-exit','bad-exit','changed-plan','sent','unknown','ambiguous-parent','live-parent'])('rejects never-started RPC proof with %s', async failure => {
  const f=await borrowedContinuationFixture(true), {runtime}=f
  if (['generic-cap','missing-cap','borrowed','framed','opened','leased','parent-leased'].includes(failure)) {
    const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(join(f.config.root,'managed.sqlite'))
    try { const state=JSON.parse(String(db.prepare('SELECT body_json FROM sa_managed_control WHERE singleton=1').get()!.body_json))
      if(failure==='generic-cap')delete state.capabilities.find((c:any)=>c.id==='rpc-fixture-cap').nativeRuntime
      if(failure==='missing-cap')state.capabilities=state.capabilities.filter((c:any)=>c.id!=='rpc-fixture-cap')
      if(failure==='borrowed')state.borrowed.push({actionId:'orphan-rpc',ownerRef:f.parent.actionRef})
      if(failure==='framed')(state.frames??=[]).push({actionId:'orphan-rpc',digest:'frame'})
      if(failure==='opened')(state.opened??=[]).push('orphan-rpc')
      if(failure==='leased')state.resources.push({...state.resources[0],actionRef:{id:'orphan-rpc',revision:1}})
      if(failure==='parent-leased')state.resources[0].status='held'
      db.prepare('UPDATE sa_managed_control SET body_json=? WHERE singleton=1').run(JSON.stringify(state))
    }finally{db.close()}
  }
  if(failure==='missing-exit'||failure==='bad-exit'){const entries=runtime.ledger.eventEntries.bind(runtime.ledger);vi.spyOn(runtime.ledger,'eventEntries').mockImplementation(filter=>filter.nativeKind==='process_exit'?failure==='missing-exit'?[]:entries(filter).map(e=>{const body=JSON.parse(JSON.stringify(e.body));body.controlled.command.observation.executionDigest='forged';return{...e,body}}):entries(filter))}
  if(['changed-plan','sent','unknown','ambiguous-parent','live-parent'].includes(failure))vi.mocked(runtime.ledger.snapshot).mockImplementation(kind=>{
    const objects=f.originalSnapshot(kind).map(o=>o.id==='orphan-rpc'&&['changed-plan','sent','unknown'].includes(failure)?{...o,revision:failure==='changed-plan'?1:2,data:{...o.data,state:failure==='changed-plan'?'planned':failure,execution_spec:{...(o.data.execution_spec as any),...(failure==='changed-plan'?{nativeRequestId:'forged'}:{})}}}:o.id==='native-parent'&&failure==='live-parent'?{...o,data:{...o.data,receipt:{stopped:false}}}:o)
    if(kind==='action'&&failure==='ambiguous-parent')objects.push({...objects.find(o=>o.id==='native-parent')!,id:'ambiguous-parent'})
    return objects
  })
  await expect(runtime.prepareContinuation(true)).rejects.toThrow('MANAGED_CONTINUATION_NOT_QUIESCENT')
  expect(runtime.ledger.eventEntries({runtimeEvent:'framework_baseline_bound'})).toHaveLength(0)
  expect(runtime.ledger.snapshot('profile_qualification')).toHaveLength(0)
})

it.each(['manifest','candidate-revision','professional-revision','wrong-work','wrong-contract','unfrozen','changed-file','extra-file','asset','quality-dirty','unauthorized-path','stale-result','accepted','gate','publish'])('rejects retained candidate with %s without new baseline or qualification', async failure => {
  const f=await retainedContinuationFixture(),{runtime}=f
  if(failure==='manifest')f.proof.manifestDigest='forged'
  if(failure==='candidate-revision')f.proof.candidateRef={...f.proof.candidateRef,revision:2}
  if(failure==='professional-revision')f.proof.professionalResultRef={...f.proof.professionalResultRef,revision:2}
  if(failure==='unfrozen')chmodSync(join(String(f.candidate.data.root),'input.ts'),0o600)
  if(failure==='changed-file')writeFileSync(join(f.config.root,'implementation','input.ts'),'unfrozen change')
  if(failure==='extra-file')writeFileSync(join(f.config.root,'implementation','extra.ts'),'unauthorized')
  if(failure==='asset'){chmodSync(join(String(f.candidate.data.root),'candidate.mjs'),0o600);writeFileSync(join(String(f.candidate.data.root),'candidate.mjs'),'forged');chmodSync(join(String(f.candidate.data.root),'candidate.mjs'),0o400)}
  if(failure==='quality-dirty')writeFileSync(join(f.config.root,'quality','input.ts'),'arbitrary mix')
  if(failure==='unauthorized-path')f.config.implementationWritePaths=[]
  if(failure==='gate')mkdirSync(join(f.config.root,'gate-work-started'))
  if(failure==='publish')writeFileSync(join(f.config.root,'delivery-intent.json'),'{}')
  if(failure==='stale-result')runtime.coordination.host.recordRuntimeEvent('professional:new','professional_result',{operationId:'new',role:'implementation',nativeSessionId:'original-thread'},[{id:'acceptance',revision:1}],['implementation-input'])
  if(failure==='wrong-work'||failure==='wrong-contract'){const get=vi.mocked(runtime.ledger.get).getMockImplementation()!;vi.spyOn(runtime.ledger,'get').mockImplementation(id=>{const o=get(id);return id===f.assignment.id&&o?{...o,data:{...o.data,...(failure==='wrong-work'?{commitment_id:'other-work'}:{contract_ref:{id:'acceptance',revision:2}})}}:o})}
  if(failure==='accepted'){const snapshot=vi.mocked(runtime.ledger.snapshot).getMockImplementation()!;vi.mocked(runtime.ledger.snapshot).mockImplementation(kind=>kind==='evaluation'?snapshot(kind).map(o=>({...o,data:{...o.data,verdict:'pass'}})):snapshot(kind))}
  await expect(runtime.prepareContinuation(true)).rejects.toThrow()
  expect(runtime.ledger.eventEntries({runtimeEvent:'framework_baseline_bound'})).toHaveLength(0)
  expect(runtime.ledger.snapshot('profile_qualification')).toHaveLength(0)
})

it('retains a frozen implementation while quality still has the complete original baseline', async () => {
  const f=await retainedContinuationFixture()
  writeFileSync(join(f.config.root,'quality','input.ts'),'export const value = 1\n')
  await expect(f.runtime.prepareContinuation(true)).resolves.toMatchObject({head:f.after})
})
