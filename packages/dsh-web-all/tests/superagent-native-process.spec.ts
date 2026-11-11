import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { rmSync, realpathSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { fixture } from './fixtures/superagent/controlled.ts'
import { createControlledKernel } from '../src/host/services/superagent/kernel/actions.ts'
import { ManagedLedger } from '../src/host/services/superagent/kernel/managed-ledger.ts'
import type { ActionSpec, ExecutionEnvelope } from '../src/host/services/superagent/kernel/actions.ts'
const fixtures: ReturnType<typeof fixture>[] = []
const setup = () => {
  const f = fixture()
  fixtures.push(f)
  return f
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.ledger.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
})
function prepare(
  f: ReturnType<typeof fixture>,
  args = ['-c', 'while IFS= read -r line; do printf "%s\\n" "$line"; done'],
  executable = '/bin/sh'
) {
  f.k.host.grantCapability({
    id: 'stdio',
    revision: 1,
    expiresAt: Date.now() + 60000,
    scopeRefs: [],
    evidenceRefs: ['test:fixed-echo'],
    externalTools: 'blocked',
    revoked: false,
    launch: { executable, args, processPolicy: 'single' }
  })
  f.k.host.grantMandate({
    id: 'native',
    revision: 1,
    requester: 'owner',
    subject: 'worker',
    target: { id: 'target', revision: 1 },
    actions: ['dispatch', 'inspect', 'send_input', 'cancel'],
    workspaceId: f.workspace.id,
    resourceIds: f.workspace.resources,
    scopeRefs: [],
    expiresAt: Date.now() + 60000,
    revoked: false
  })
  const spec: ActionSpec = {
    ...f.spec('launch'),
    executable,
    args,
    capabilityRef: { id: 'stdio', revision: 1 },
    mandateRef: { id: 'native', revision: 1 }
  }
  const a = f.k.actions.planAction(spec)
  f.k.actions.claimResources(a.ref, spec.resourceIds)
  return { spec, action: a }
}
it('borrows only a live same-epoch launch lease and never releases it with an RPC receipt', () => {
  const f = setup(),
    { spec, action } = prepare(f)
  const launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope
  const rpc = f.k.actions.planAction({ ...spec, id: 'rpc', idempotencyKey: 'rpc', kind: 'inspect' })
  expect(f.k.host.beginDispatch(rpc.ref)).toMatchObject({ code: 'RESOURCE_LEASE_REQUIRED' })
  f.k.host.borrowSessionResources(rpc.ref, launch.actionRef)
  const sent = f.k.host.beginDispatch(rpc.ref) as ExecutionEnvelope
  expect(sent.kind).toBe('envelope')
  f.k.host.reconcileAction(sent.actionRef, {
    status: 'confirmed',
    stopped: true,
    evidenceRefs: ['rpc:response']
  })
  const contender = f.k.actions.planAction({ ...spec, id: 'other', idempotencyKey: 'other' })
  expect(() => f.k.actions.claimResources(contender.ref, spec.resourceIds)).toThrow('RESOURCE_BUSY')
  f.k.host.revokeControl(spec.target, f.sourceRef)
  expect(f.k.host.fenceDispatch(launch.actionRef)).toMatchObject({ kind: 'denial' })
})
it('refuses forged host lease borrowing and a different epoch or unsent owner', () => {
  const f = setup(),
    { spec, action } = prepare(f)
  const rpc = f.k.actions.planAction({ ...spec, id: 'rpc', idempotencyKey: 'rpc', kind: 'inspect' })
  expect(() => f.k.host.borrowSessionResources(rpc.ref, action.ref)).toThrow('SESSION_OWNER_FENCED')
  expect(() =>
    f.ledger.controlled({ kind: 'borrow', ref: rpc.ref, ownerRef: action.ref, token: {} } as never)
  ).toThrow('HOST_ADMISSION_REQUIRED')
  const launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope
  const fresh = f.k.host.grantControl(spec.target, 'worker', Date.now() + 60000)
  const other = f.k.actions.planAction({
    ...spec,
    id: 'fresh',
    idempotencyKey: 'fresh',
    epoch: fresh.epoch,
    kind: 'inspect'
  })
  expect(() => f.k.host.borrowSessionResources(other.ref, launch.actionRef)).toThrow('SESSION_OWNER_FENCED')
})
it('starts only sent launches, gates every stdio write, and observes real single-process cancellation', async () => {
  const f = setup(),
    { spec, action } = prepare(f)
  expect(() => f.k.host.openProcess(action.ref)).toThrow('ACTION_NOT_SENDABLE')
  const launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope
  const process = f.k.host.openProcess(launch.actionRef)
  expect(() => f.k.host.openProcess(launch.actionRef)).toThrow('PROCESS_ALREADY_OPEN')
  const output = new Promise<string>((resolve) => process.onLine(resolve))
  const rpc = f.k.actions.planAction({
    ...spec,
    id: 'rpc',
    idempotencyKey: 'rpc',
    kind: 'send_input',
    payloadDigest: createHash('sha256').update('native-payload').digest('hex')
  })
  f.k.host.borrowSessionResources(rpc.ref, launch.actionRef)
  const sent = f.k.host.beginDispatch(rpc.ref) as ExecutionEnvelope
  await process.writeLine(sent.actionRef, 'native-payload')
  expect(await output).toBe('native-payload')
  await expect(process.writeLine(sent.actionRef, 'replay')).rejects.toThrow('FRAME_ALREADY_SENT')
  f.k.host.revokeControl(spec.target, f.sourceRef)
  await expect(process.writeLine(launch.actionRef, 'after-revoke')).rejects.toThrow()
  expect(await process.closed).toMatchObject({ state: 'failed', receipt: { stopped: true } })
})

it('persists launch ownership and frame replay fences across independent kernel handles', async () => {
  const f = setup(),
    { spec, action } = prepare(f)
  const launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope
  const process = f.k.host.openProcess(launch.actionRef)
  const reopened = new ManagedLedger(f.path),
    other = createControlledKernel(reopened, f.sourceRef)
  try {
    expect(() => other.host.openProcess(launch.actionRef)).toThrow('PROCESS_ALREADY_OPEN')
    const rpc = other.actions.planAction({
      ...spec,
      id: 'frame',
      idempotencyKey: 'frame',
      kind: 'send_input',
      payloadDigest: createHash('sha256').update('exact').digest('hex')
    })
    other.host.borrowSessionResources(rpc.ref, launch.actionRef)
    const sent = other.host.beginDispatch(rpc.ref) as ExecutionEnvelope
    await expect(process.writeLine(sent.actionRef, 'changed')).rejects.toThrow('FRAME_PAYLOAD_MISMATCH')
    await process.writeLine(sent.actionRef, 'exact')
    expect(() =>
      reopened.controlled({
        kind: 'frame',
        token: {},
        ref: sent.actionRef,
        ownerRef: launch.actionRef,
        digest: spec.id
      })
    ).toThrow('HOST_ADMISSION_REQUIRED')
    await expect(process.writeLine(sent.actionRef, 'exact')).rejects.toThrow('FRAME_ALREADY_SENT')
    other.host.revokeControl(spec.target, f.sourceRef)
    expect(await process.closed).toMatchObject({ receipt: { stopped: true } })
  } finally {
    f.k.host.revokeControl(spec.target, f.sourceRef)
    await process.closed
    reopened.close()
  }
})
it('rejects a lease borrowed from another write domain even with the same target', () => {
  const f = setup(),
    { spec, action } = prepare(f)
  const launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope
  const rpc = f.k.actions.planAction({
    ...spec,
    id: 'rpc-domain',
    idempotencyKey: 'rpc-domain',
    kind: 'inspect',
    subject: 'intruder'
  })
  expect(f.k.host.borrowSessionResources(rpc.ref, launch.actionRef)).toMatchObject({
    kind: 'denial',
    code: 'CONTROL_FENCE'
  })
})
it('confirms only the exact host-admitted native response without claiming engine cessation', async () => {
  const f = setup(),
    { spec, action } = prepare(f),
    digest = createHash('sha256').update('request-7').digest('hex')
  const launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope,
    process = f.k.host.openProcess(launch.actionRef)
  try {
    const rpc = f.k.actions.planAction({
      ...spec,
      id: 'response-action',
      idempotencyKey: 'response-action',
      kind: 'inspect',
      payloadDigest: digest,
      nativeRequestId: '7'
    })
    f.k.host.borrowSessionResources(rpc.ref, launch.actionRef)
    const proof = {
      ownerRef: launch.actionRef,
      payloadDigest: digest,
      nativeRequestId: '7',
      responseDigest: createHash('sha256').update('native-response').digest('hex')
    }
    expect(() => f.k.host.completeOperation(rpc.ref, proof, ['native:response'])).toThrow('INVALID_RECEIPT')
    const sent = f.k.host.beginDispatch(rpc.ref) as ExecutionEnvelope
    expect(() => f.k.host.completeOperation(sent.actionRef, proof, ['native:response'])).toThrow(
      'OPERATION_PROOF_MISMATCH'
    )
    await process.writeLine(sent.actionRef, 'request-7')
    expect(() =>
      f.k.actions.recordActionResult(sent.actionRef, {
        status: 'confirmed',
        stopped: false,
        evidenceRefs: ['fake'],
        operation: proof
      })
    ).toThrow('TRUSTED_RECEIPT_REQUIRED')
    expect(() =>
      f.k.host.completeOperation(sent.actionRef, { ...proof, payloadDigest: 'wrong' }, ['native:response'])
    ).toThrow('OPERATION_PROOF_MISMATCH')
    expect(() =>
      f.k.host.completeOperation(sent.actionRef, { ...proof, ownerRef: { id: 'other', revision: 2 } }, [
        'native:response'
      ])
    ).toThrow('OPERATION_PROOF_MISMATCH')
    expect(() =>
      f.k.host.completeOperation(sent.actionRef, { ...proof, nativeRequestId: '8' }, ['native:response'])
    ).toThrow('OPERATION_PROOF_MISMATCH')
    expect(f.k.host.completeOperation(sent.actionRef, proof, ['native:response'])).toMatchObject({
      state: 'confirmed',
      receipt: { stopped: false }
    })
    expect(f.k.host.completeOperation(sent.actionRef, proof, ['native:response'])).toMatchObject({
      kind: 'denial',
      code: 'STALE_ACTION'
    })
    const contender = f.k.actions.planAction({ ...spec, id: 'writer', idempotencyKey: 'writer' })
    expect(() => f.k.actions.claimResources(contender.ref, spec.resourceIds)).toThrow('RESOURCE_BUSY')
  } finally {
    f.k.host.revokeControl(spec.target, f.sourceRef)
    await process.closed
  }
})

it('keeps host-sealed engine state separate from candidate-only helper privileges', async () => {
  const f = setup(),
    stateRoot = join(realpathSync(f.dir), 'native-state')
  mkdirSync(stateRoot)
  const args = [
    '-c',
    'printf state > "$NATIVE_STATE/probe"; while IFS= read -r line; do printf "%s\\n" "$line"; done'
  ]
  f.k.host.grantCapability({
    id: 'engine-runtime',
    revision: 1,
    expiresAt: Date.now() + 60000,
    scopeRefs: [],
    evidenceRefs: ['test:sealed-runtime'],
    externalTools: 'blocked',
    revoked: false,
    launch: { executable: '/bin/sh', args, processPolicy: 'single' },
    nativeRuntime: {
      root: stateRoot,
      stateDirectoryVariable: 'NATIVE_STATE',
      network: 'engine-transport',
      evidenceRefs: ['test:tool-inventory-and-rejection']
    }
  })
  const spec = { ...f.spec('engine'), args, capabilityRef: { id: 'engine-runtime', revision: 1 } }
  const a = f.k.actions.planAction(spec)
  f.k.actions.claimResources(a.ref, spec.resourceIds)
  await expect(f.k.actions.execute(a.ref)).rejects.toThrow('NATIVE_PROCESS_REQUIRES_HOST')
  const sent = f.k.host.beginDispatch(a.ref) as ExecutionEnvelope,
    process = f.k.host.openProcess(sent.actionRef)
  try {
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(existsSync(join(stateRoot, 'probe'))).toBe(true)
    expect(readFileSync(join(stateRoot, 'probe'), 'utf8')).toBe('state')
  } finally {
    f.k.host.revokeControl(spec.target, f.sourceRef)
    await process.closed
  }
})

it('bounds concurrent unread stdin before reserve and settles every write on cancellation', async () => {
  const f = setup(),
    { spec, action } = prepare(f, ['-c', 'while :; do :; done']),
    launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope,
    process = f.k.host.openProcess(launch.actionRef)
  const line = JSON.stringify('x'.repeat(1048574)),
    writes: Promise<unknown>[] = []
  try {
    for (let i = 0; i < 24; i++) {
      const a = f.k.actions.planAction({
        ...spec,
        id: 'queue-' + i,
        idempotencyKey: 'queue-' + i,
        kind: 'send_input',
        payloadDigest: createHash('sha256').update(line).digest('hex')
      })
      f.k.host.borrowSessionResources(a.ref, launch.actionRef)
      const e = f.k.host.beginDispatch(a.ref) as ExecutionEnvelope
      writes.push(
        process.writeLine(e.actionRef, line).then(
          () => ({ ok: true }),
          (error) => ({ error: String(error) })
        )
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    const frames = f.ledger.events().filter((v) => (v as any).controlled?.kind === 'frame')
    expect(frames.length).toBeLessThanOrEqual(2)
    f.k.host.revokeControl(spec.target, f.sourceRef)
    const outcomes = await Promise.all(writes)
    expect(outcomes).toHaveLength(24)
    expect(outcomes.some((v) => String((v as any).error).includes('STDIN_BACKPRESSURE'))).toBe(true)
  } finally {
    f.k.host.revokeControl(spec.target, f.sourceRef)
    await process.closed
    await Promise.all(writes)
  }
}, 20000)
it('reconciles a true single-process exit after an untrusted unknown revision without losing its evidence', async () => {
  const f = setup(),
    { spec, action } = prepare(f, ['-c', 'while :; do :; done']),
    launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope,
    process = f.k.host.openProcess(launch.actionRef)
  f.k.actions.recordActionResult(launch.actionRef, {
    status: 'unknown',
    stopped: false,
    evidenceRefs: ['worker:uncertain']
  })
  const result = await process.closed
  expect(result).not.toHaveProperty('kind', 'denial')
  expect(result).toMatchObject({ state: 'failed', receipt: { stopped: true }, reconciliation: 'updated' })
  expect(f.ledger.get(launch.actionRef.id)?.data.receipt).toMatchObject({ stopped: true })
  expect(JSON.stringify(f.ledger.events())).toContain('worker:uncertain')
  expect(JSON.stringify(f.ledger.events())).toContain('process_exit')
  await expect(process.writeLine(launch.actionRef, 'old')).rejects.toThrow('EXECUTION_FENCED')
})
it('accepts a full 1MiB line and multiple Unicode lines without counting delimiters as payload', async () => {
  const f = setup(),
    { spec, action } = prepare(f),
    launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope,
    process = f.k.host.openProcess(launch.actionRef)
  const lines = [JSON.stringify('x'.repeat(1048574)), JSON.stringify('中文'), JSON.stringify('tail')],
    received: string[] = []
  process.onLine((line) => received.push(line))
  try {
    for (const [i, line] of lines.entries()) {
      const a = f.k.actions.planAction({
        ...spec,
        id: 'boundary-' + i,
        idempotencyKey: 'boundary-' + i,
        kind: 'send_input',
        payloadDigest: createHash('sha256').update(line).digest('hex')
      })
      f.k.host.borrowSessionResources(a.ref, launch.actionRef)
      const e = f.k.host.beginDispatch(a.ref) as ExecutionEnvelope
      await process.writeLine(e.actionRef, line)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(received.map((line) => createHash('sha256').update(line).digest('hex'))).toEqual(
      lines.map((line) => createHash('sha256').update(line).digest('hex'))
    )
  } finally {
    f.k.host.revokeControl(spec.target, f.sourceRef)
    await process.closed
  }
})

it('decodes split UTF8 and multiple native lines while rejecting a true oversized unfinished line', async () => {
  for (const oversized of [false, true]) {
    const f = setup(),
      code = oversized
        ? 'print "x" x 1048577; select(undef,undef,undef,0.4);'
        : '$|=1; print pack("H*","e4"); select(undef,undef,undef,0.05); print pack("H*","b8ad"),"\\nsecond\\n"; select(undef,undef,undef,0.1);'
    const { action } = prepare(f, ['-e', code], '/usr/bin/perl'),
      launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope,
      process = f.k.host.openProcess(launch.actionRef),
      lines: string[] = []
    process.onLine((line) => lines.push(line))
    const result = await process.closed
    if (oversized) {
      expect(lines).toEqual([])
      expect(result.receipt?.reason).toBe('JSONL_FRAME_TOO_LARGE')
    } else {
      expect(lines).toEqual(['中', 'second'])
      expect(result.receipt?.stopped).toBe(true)
    }
  }
})
it('preserves a trusted terminal result while recording a late process observation as history', async () => {
  const f = setup(),
    { spec, action } = prepare(f, ['-c', 'while :; do :; done']),
    launch = f.k.host.beginDispatch(action.ref) as ExecutionEnvelope,
    process = f.k.host.openProcess(launch.actionRef)
  f.k.host.revokeControl(spec.target, f.sourceRef)
  const prior = f.k.host.reconcileAction(launch.actionRef, {
    status: 'failed',
    stopped: true,
    evidenceRefs: ['host:independent-exit-observation'],
    reason: 'prior-host-result'
  })
  const result = await process.closed
  expect(result).toMatchObject({
    reconciliation: 'historical',
    receipt: { reason: 'prior-host-result' },
    ref: prior.ref
  })
  expect(f.ledger.get(prior.ref.id)?.revision).toBe(prior.ref.revision)
  expect(f.k.host.nativeFacts('execution:' + launch.actionRef.id)).toHaveLength(1)
})
