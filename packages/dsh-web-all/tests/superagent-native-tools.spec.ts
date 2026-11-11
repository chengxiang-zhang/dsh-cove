import { afterEach, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './fixtures/superagent/controlled.ts'
import { ControlledFileTools } from '../src/host/services/superagent/executors/native/tools.ts'
import type { ExecutionEnvelope } from '../src/host/services/superagent/kernel/actions.ts'
const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.ledger.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
})
it('executes fixed helpers through the owner lease and denies traversal, symlinks, arbitrary commands and inherited credentials', async () => {
  const f = fixture()
  fixtures.push(f)
  f.k.host.grantMandate({
    id: 'tools',
    revision: 1,
    requester: 'owner',
    subject: 'worker',
    target: { id: 'target', revision: 1 },
    actions: ['dispatch', 'inspect', 'respond_request'],
    workspaceId: f.workspace.id,
    resourceIds: f.workspace.resources,
    scopeRefs: [],
    expiresAt: Date.now() + 60000,
    revoked: false
  })
  const launchSpec = { ...f.spec('launch'), mandateRef: { id: 'tools', revision: 1 } },
    a = f.k.actions.planAction(launchSpec)
  f.k.actions.claimResources(a.ref, launchSpec.resourceIds)
  const launch = f.k.host.beginDispatch(a.ref) as ExecutionEnvelope
  const tools = new ControlledFileTools(f.k, launch, process.execPath)
  expect(await tools.call('write', { path: 'candidate.txt', content: 'native-write' })).toEqual({
    success: true,
    text: 'written'
  })
  expect(readFileSync(join(f.workspace.root, 'candidate.txt'), 'utf8')).toBe('native-write')
  expect(await tools.call('read', { path: 'candidate.txt' })).toMatchObject({
    success: true,
    text: 'native-write'
  })
  expect(await tools.call('check', { path: 'candidate.txt', expected: 'native-write' })).toMatchObject({
    success: true
  })
  expect(await tools.call('write', { path: '../escape', content: 'bad' })).toMatchObject({ success: false })
  symlinkSync(f.dir, join(f.workspace.root, 'link'))
  expect(await tools.call('write', { path: 'link/escape', content: 'bad' })).toMatchObject({ success: false })
  expect(await tools.call('shell', { command: 'touch escape' })).toMatchObject({ success: false })
  expect(existsSync(join(f.dir, 'escape'))).toBe(false)
  expect(
    await tools.call('write', { path: 'once.txt', content: 'first' }, 'native:request-once')
  ).toMatchObject({ success: true })
  const otherTools = new ControlledFileTools(f.k, launch, process.execPath)
  expect(
    await otherTools.call('write', { path: 'once.txt', content: 'replayed' }, 'native:request-once')
  ).toEqual({ success: false, text: 'TOOL_REQUEST_ALREADY_CLAIMED' })
  expect(readFileSync(join(f.workspace.root, 'once.txt'), 'utf8')).toBe('first')
  const second = f.k.actions.planAction({ ...launchSpec, id: 'other', idempotencyKey: 'other' })
  expect(() => f.k.actions.claimResources(second.ref, launchSpec.resourceIds)).toThrow('RESOURCE_BUSY')
})

it('serializes and bounds helper work per workspace across tool instances', async () => {
  const f = fixture()
  fixtures.push(f)
  f.k.host.grantMandate({
    id: 'queue-tools',
    revision: 1,
    requester: 'owner',
    subject: 'worker',
    target: { id: 'target', revision: 1 },
    actions: ['dispatch', 'inspect', 'respond_request'],
    workspaceId: f.workspace.id,
    resourceIds: f.workspace.resources,
    scopeRefs: [],
    expiresAt: Date.now() + 60000,
    revoked: false
  })
  const spec = { ...f.spec('queue-launch'), mandateRef: { id: 'queue-tools', revision: 1 } }
  const action = f.k.actions.planAction(spec)
  f.k.actions.claimResources(action.ref, spec.resourceIds)
  const launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope
  const first = new ControlledFileTools(f.k, launch, process.execPath)
  const second = new ControlledFileTools(f.k, launch, process.execPath)
  const original = f.k.host.executeSessionHelper.bind(f.k.host)
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = 0
  f.k.host.executeSessionHelper = async (ref) => {
    entered++
    if (entered === 1) await blocked
    return original(ref)
  }
  const pending = [first.call('write', { path: 'ordered.txt', content: 'first' })]
  await new Promise((resolve) => setTimeout(resolve, 10))
  for (let i = 0; i < 8; i++) pending.push(second.call('write', { path: 'ordered.txt', content: String(i) }))
  const excess = await second.call('write', { path: 'ordered.txt', content: 'excess' })
  const simultaneous = entered
  const independent = fixture()
  fixtures.push(independent)
  independent.k.host.grantMandate({
    id: 'independent-tools',
    revision: 1,
    requester: 'owner',
    subject: 'worker',
    target: { id: 'target', revision: 1 },
    actions: ['dispatch', 'inspect', 'respond_request'],
    workspaceId: independent.workspace.id,
    resourceIds: independent.workspace.resources,
    scopeRefs: [],
    expiresAt: Date.now() + 60000,
    revoked: false
  })
  const independentSpec = {
    ...independent.spec('independent'),
    mandateRef: { id: 'independent-tools', revision: 1 }
  }
  const independentAction = independent.k.actions.planAction(independentSpec)
  independent.k.actions.claimResources(independentAction.ref, independentSpec.resourceIds)
  const independentLaunch = independent.k.host.beginDispatch(independentAction.ref) as ExecutionEnvelope
  const independentTools = new ControlledFileTools(independent.k, independentLaunch, process.execPath)
  const independentResult = await independentTools.call('write', {
    path: 'independent.txt',
    content: 'unblocked'
  })
  release()
  expect(independentResult.success).toBe(true)
  const results = await Promise.all(pending)
  expect(simultaneous).toBe(1)
  expect(excess).toEqual({ success: false, text: 'HELPER_QUEUE_FULL' })
  expect(results.every((r) => r.success)).toBe(true)
  expect(readFileSync(join(f.workspace.root, 'ordered.txt'), 'utf8')).toBe('7')
})

it('atomically fences concurrent borrowed helpers across reopened kernels until real cessation', async () => {
  const f = fixture()
  fixtures.push(f)
  f.k.host.grantMandate({
    id: 'domain-tools',
    revision: 1,
    requester: 'owner',
    subject: 'worker',
    target: { id: 'target', revision: 1 },
    actions: ['dispatch', 'inspect', 'respond_request'],
    workspaceId: f.workspace.id,
    resourceIds: f.workspace.resources,
    scopeRefs: [],
    expiresAt: Date.now() + 60000,
    revoked: false
  })
  const spec = { ...f.spec('domain-launch'), mandateRef: { id: 'domain-tools', revision: 1 } }
  const action = f.k.actions.planAction(spec)
  f.k.actions.claimResources(action.ref, spec.resourceIds)
  const launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope
  const { ManagedLedger } = await import('../src/host/services/superagent/kernel/managed-ledger.ts')
  const { createControlledKernel } = await import('../src/host/services/superagent/kernel/actions.ts')
  const otherLedger = new ManagedLedger(f.path)
  const other = createControlledKernel(otherLedger, f.sourceRef)
  const plan = (id: string, delay: number) => {
    const args = ['-e', `setTimeout(()=>require('node:fs').writeFileSync('atomic.txt','${id}'),${delay})`]
    f.k.host.grantCapability({
      id,
      revision: 1,
      expiresAt: Date.now() + 60000,
      scopeRefs: [],
      evidenceRefs: ['test:fixed-code'],
      externalTools: 'blocked',
      revoked: false,
      launch: { executable: process.execPath, args, processPolicy: 'single' }
    })
    const a = f.k.actions.planAction({
      ...spec,
      id,
      idempotencyKey: id,
      kind: 'respond_request',
      executable: process.execPath,
      args,
      capabilityRef: { id, revision: 1 }
    })
    f.k.host.borrowSessionResources(a.ref, launch.actionRef)
    return a
  }
  try {
    expect(f.k.host.claimNativeRequest(launch.actionRef, 'native:one')).toBe(true)
    expect(other.host.claimNativeRequest(launch.actionRef, 'native:one')).toBe(false)
    const a = plan('slow', 250),
      b = plan('next', 0)
    const first = f.k.host.executeSessionHelper(a.ref)
    const sent = f.ledger.get(a.ref.id)!
    f.k.actions.recordActionResult(
      { id: sent.id, revision: sent.revision },
      {
        status: 'unknown',
        stopped: false,
        evidenceRefs: [],
        reason: 'model-report-not-cessation'
      }
    )
    const concurrent = await other.host.executeSessionHelper(b.ref)
    expect(await first).toMatchObject({
      state: 'failed',
      receipt: { stopped: true },
      reconciliation: 'updated'
    })
    expect(concurrent).toMatchObject({ kind: 'denial', code: 'HELPER_DOMAIN_BUSY' })
    expect(otherLedger.get(b.ref.id)?.data.state).toBe('planned')
    expect(await other.host.executeSessionHelper(b.ref)).toMatchObject({ state: 'confirmed' })
    expect(readFileSync(join(f.workspace.root, 'atomic.txt'), 'utf8')).toBe('next')
    const historical = plan('historical-helper', 250)
    const running = f.k.host.executeSessionHelper(historical.ref)
    const historicalSent = f.ledger.get(historical.ref.id)!
    f.k.host.reconcileAction(
      { id: historicalSent.id, revision: historicalSent.revision },
      {
        status: 'failed',
        stopped: true,
        evidenceRefs: ['host:prior-terminal'],
        reason: 'prior-trusted-result'
      }
    )
    expect(await running).toMatchObject({
      state: 'failed',
      receipt: { reason: 'prior-trusted-result' },
      reconciliation: 'historical'
    })
  } finally {
    otherLedger.close()
  }
})
