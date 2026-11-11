import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { fixture } from './fixtures/superagent/controlled.ts'
import { ManagedLedger } from '../src/host/services/superagent/kernel/managed-ledger.ts'
import {
  createControlledKernel,
  type ExecutionEnvelope
} from '../src/host/services/superagent/kernel/actions.ts'
import { DshNativeExecutor } from '../src/host/services/superagent/executors/engines/dsh.ts'
import { bindingKey, encodeInput } from '../src/host/services/superagent/executors/native/bindings.ts'
const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.ledger.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
})
const identity = {
  host_ref: 'test',
  engine_ref: 'dsh',
  runtime_namespace: 'recovery',
  native_session_id: 'session'
}
const input = {
  request_id: 'input',
  assignment_revision: 1,
  payload_ref: 'payload',
  payload_digest: createHash('sha256').update('work').digest('hex'),
  text: 'work'
}
const event = (seq: number, type = 'diagnostic', data: any = {}) => ({
  type: 'event',
  event: { seq, type, time: seq, data }
})
function setup() {
  const f = fixture()
  fixtures.push(f)
  f.k.host.grantMandate({
    id: 'native',
    revision: 1,
    requester: 'owner',
    subject: 'worker',
    target: { id: 'target', revision: 1 },
    actions: ['dispatch', 'inspect', 'collect', 'respond_request'],
    workspaceId: f.workspace.id,
    resourceIds: f.workspace.resources,
    scopeRefs: [],
    expiresAt: Date.now() + 60000,
    revoked: false
  })
  const spec = { ...f.spec('launch'), mandateRef: { id: 'native', revision: 1 } },
    action = f.k.actions.planAction(spec)
  f.k.actions.claimResources(action.ref, spec.resourceIds)
  const launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope
  const io: any = {
    kernel: f.k,
    launch,
    stream: 'history',
    observe: (observation: any) => f.k.host.observeNative(launch.actionRef, 'history', observation).nativeRef,
    call: async () => {
      throw Error('UNAVAILABLE')
    }
  }
  io.observe({ kind: 'input-intent', binding: bindingKey(identity), input })
  return { f, io, launch, engine: new DshNativeExecutor(io, identity) }
}
it('backfills stable-cut pages across user/start boundaries and retains exact consumed proof after reconstruction', async () => {
  const { f, io, engine } = setup()
  const records = [
    event(0),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'user/message', {
      source: { rpcId: input.request_id },
      content: [{ type: 'text', text: encodeInput(input) }]
    }),
    ...Array.from({ length: 100 }, (_, i) => event(i + 3))
  ]
  const pages: any[] = []
  let projections = 0
  io.call = async (method: string, args: any) => {
    if (method === 'session/projections') {
      projections++
      return { asOfSeq: 102 }
    }
    const request = args.request
    pages.push(request)
    const end = request.beforeSeq ?? 103,
      start = Math.max(0, end - 101)
    return { records: records.slice(start, end), hasMore: start > 0 }
  }
  const collected = await engine.collectNativeEvents(engine.binding.ref, '0')
  expect(collected.completeness).toBe('complete')
  expect(collected.events.map((e) => Number(e.cursor))).toEqual(Array.from({ length: 102 }, (_, i) => i + 1))
  expect(projections).toBe(1)
  expect(pages.map((p) => [p.throughSeq, p.beforeSeq ?? null])).toEqual([
    [102, null],
    [102, 2]
  ])
  const consumed = await engine.receiptFor(input)
  expect(consumed.status).toBe('consumed')
  io.call = async () => {
    throw Error('DISCONNECTED')
  }
  const reopened = new DshNativeExecutor(io, identity)
  expect(await reopened.receiptFor(input)).toEqual(consumed)
  expect(
    f.k.host.nativeFacts('history').filter((f) => (f.observation as any).kind === 'input-consumed')
  ).toHaveLength(1)
  for (const changed of [
    { ...input, assignment_revision: 2 },
    { ...input, request_id: 'other' },
    { ...input, text: 'changed', payload_digest: createHash('sha256').update('changed').digest('hex') }
  ]) {
    expect((await reopened.receiptFor(changed)).status).toBe('unknown')
  }
  const other = new DshNativeExecutor(io, { ...identity, runtime_namespace: 'other-store' })
  expect((await other.receiptFor(input)).status).toBe('unknown')
})
it('reports bounded gaps for repeated, discontinuous, exhausted and over-budget pages without advancing the recovery cursor', async () => {
  const { io, engine } = setup()
  for (const mode of [
    'repeat',
    'gap',
    'exhausted',
    'budget',
    'overflow',
    'missing-hasMore',
    'read-failure'
  ]) {
    let count = 0
    io.call = async (method: string, args: any) => {
      if (method === 'session/projections') return { asOfSeq: 100 }
      count++
      if (mode === 'overflow')
        return { records: [event(100, 'diagnostic', { text: 'x'.repeat(8 * 1024 * 1024) })], hasMore: true }
      if (mode === 'missing-hasMore') return { records: [event(100)] }
      if (mode === 'read-failure') throw Error('CONNECTION_LOST')
      if (mode === 'repeat') return { records: [event(100)], hasMore: true }
      if (mode === 'gap') return { records: [event(98), event(100)], hasMore: false }
      if (mode === 'exhausted') return { records: [event(100)], hasMore: false }
      return {
        records: [event(args.request.beforeSeq === undefined ? 100 : args.request.beforeSeq - 1)],
        hasMore: true
      }
    }
    const page = await engine.collectNativeEvents(engine.binding.ref, '0')
    expect(page.completeness, mode).toBe('gap')
    expect(page.cursor, mode).toBe('0')
    expect(count, mode).toBeLessThanOrEqual(32)
  }
})
it('atomically admits only one reply before any response Action across kernels, lost outcomes and reconstruction', async () => {
  const { f, io, launch, engine } = setup()
  const stream = 'dsh:recovery:session'
  const pending = (id: string) =>
    f.k.host.observeNative(launch.actionRef, stream, {
      kind: 'native-tool-request',
      requestId: id,
      epoch: launch.epoch,
      callId: id,
      sessionId: 'session',
      tool: 'ask',
      args: { question: 'which value?' }
    })
  pending('ask')
  const request = (await engine.listNativeRequests(engine.binding.ref))[0]!
  const otherLedger = new ManagedLedger(f.path)
  try {
    const otherIo = { ...io, kernel: createControlledKernel(otherLedger, f.sourceRef) }
    const other = new DshNativeExecutor(otherIo, identity)
    const results = await Promise.allSettled([
      engine.respondNativeRequest(request.ref, { result: { success: true, text: 'A' } }, launch),
      other.respondNativeRequest(request.ref, { result: { success: true, text: 'B' } }, launch)
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const responseFacts = () =>
      f.k.host.nativeFacts(stream).filter((f) => (f.observation as any).kind === 'native-request-response')
    expect(responseFacts()).toHaveLength(1)
    const responsePlans = () =>
      f.ledger
        .events()
        .filter(
          (e) =>
            (e as any).controlled?.kind === 'plan' &&
            (e as any).controlled.spec?.id?.startsWith('dsh-response:')
        )
    expect(responsePlans()).toHaveLength(1)
    await expect(
      new DshNativeExecutor(otherIo, identity).respondNativeRequest(
        request.ref,
        { result: { success: true, text: 'A' } },
        launch
      )
    ).rejects.toThrow()
    expect(responseFacts()).toHaveLength(1)
    pending('lost')
    const lost = (await engine.listNativeRequests(engine.binding.ref)).find((r) => r.ref.id === 'lost')!
    const planAction = f.k.actions.planAction
    f.k.actions.planAction = () => {
      throw Error('INJECTED_AFTER_CLAIM')
    }
    await expect(
      engine.respondNativeRequest(lost.ref, { result: { success: true, text: 'lost' } }, launch)
    ).rejects.toThrow('INJECTED_AFTER_CLAIM')
    f.k.actions.planAction = planAction
    await expect(
      new DshNativeExecutor(otherIo, identity).respondNativeRequest(
        lost.ref,
        { result: { success: true, text: 'retry' } },
        launch
      )
    ).rejects.toThrow('REQUEST_RESPONSE_ALREADY_CLAIMED')
    await expect(
      new DshNativeExecutor(otherIo, identity).respondNativeRequest(
        lost.ref,
        { result: { success: true, text: 'lost' } },
        launch
      )
    ).rejects.toThrow('REQUEST_RESPONSE_ALREADY_CLAIMED')
    expect(responsePlans()).toHaveLength(1)
    expect(responseFacts()).toHaveLength(1)
  } finally {
    otherLedger.close()
  }
})

it('rejects stale response ownership and revision before admission and rejects identical concurrent replies too', async () => {
  const { f, io, launch, engine } = setup()
  f.k.host.observeNative(launch.actionRef, 'dsh:recovery:session', {
    kind: 'native-tool-request',
    requestId: 'precise',
    epoch: launch.epoch,
    callId: 'precise',
    sessionId: 'session',
    tool: 'ask',
    args: { question: 'which value?' }
  })
  const request = (await engine.listNativeRequests(engine.binding.ref))[0]!
  const response = { result: { success: true, text: 'same' } }
  const before = f.ledger.events().length
  await expect(
    engine.respondNativeRequest(request.ref, response, {
      ...launch,
      actionRef: { ...launch.actionRef, revision: launch.actionRef.revision + 1 }
    })
  ).rejects.toThrow('RESPONSE_CONTROL_MISMATCH')
  await expect(
    engine.respondNativeRequest({ ...request.ref, revision: 2 }, response, launch)
  ).rejects.toThrow('REQUEST_UNKNOWN')
  expect(f.ledger.events()).toHaveLength(before)
  const outcomes = await Promise.allSettled([
    engine.respondNativeRequest(request.ref, response, launch),
    engine.respondNativeRequest(request.ref, response, launch)
  ])
  expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected'])
  await expect(
    new DshNativeExecutor(io, identity).respondNativeRequest(request.ref, response, launch)
  ).rejects.toThrow()
  expect(
    f.k.host
      .nativeFacts('dsh:recovery:session')
      .filter((f) => (f.observation as any).kind === 'native-request-response')
  ).toHaveLength(1)
})
