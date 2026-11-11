import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  bindingKey,
  consumptionProof,
  encodeInput
} from '../src/host/services/superagent/executors/native/bindings.ts'
const identity = {
  host_ref: 'local',
  engine_ref: 'test',
  runtime_namespace: 'store-a',
  native_session_id: 'thread-1'
}
const input = {
  request_id: 'request',
  assignment_revision: 2,
  payload_digest: createHash('sha256').update('do work').digest('hex'),
  payload_ref: 'input:1',
  text: 'do work'
}
it('separates identical native ids in independent stores and proves only actual matching native input plus started turn', () => {
  expect(bindingKey(identity)).not.toBe(bindingKey({ ...identity, runtime_namespace: 'store-b' }))
  expect(consumptionProof(identity, input, 'turn-1', undefined, undefined)).toBeUndefined()
  expect(consumptionProof(identity, input, 'turn-1', encodeInput(input), undefined)).toBeUndefined()
  expect(consumptionProof(identity, input, 'turn-1', encodeInput(input), 'native:turn-start')).toMatchObject({
    request_id: 'request',
    assignment_revision: 2,
    payload_digest: input.payload_digest,
    session_identity: identity,
    turn_id: 'turn-1'
  })
  expect(
    consumptionProof(
      identity,
      input,
      'turn-1',
      encodeInput({ ...input, assignment_revision: 3 }),
      'native:turn-start'
    )
  ).toBeUndefined()
  expect(consumptionProof(identity, input, 'turn-1', 'do work', 'native:turn-start')).toBeUndefined()
  expect(() => encodeInput({ ...input, text: 'changed' })).toThrow('INPUT_DIGEST_MISMATCH')
})

it('preserves an unexplained native abort until exact trusted provenance establishes platform interruption or human takeover', async () => {
  const { attributeNativeAbort } =
    await import('../src/host/services/superagent/executors/native/cancellation.ts')
  const aborted = {
    binding: { id: 'binding', revision: 4 },
    epoch: 4,
    turnId: 'turn',
    nativeEventRef: 'native:aborted'
  }
  const fact = {
    ...aborted,
    cause: 'platform-interruption' as const,
    sourceRef: { id: 'host:supervisor', revision: 1 },
    evidenceRef: 'host:interrupt'
  }
  expect(attributeNativeAbort(aborted, []).cause).toBe('unknown')
  expect(attributeNativeAbort(aborted, [{ ...fact, epoch: 3 }]).cause).toBe('unknown')
  expect(attributeNativeAbort(aborted, [fact]).cause).toBe('platform-interruption')
  expect(attributeNativeAbort(aborted, [{ ...fact, cause: 'human-takeover' }]).cause).toBe('human-takeover')
  expect(attributeNativeAbort(aborted, [fact, { ...fact, cause: 'human-takeover' }]).cause).toBe('unknown')
  expect(attributeNativeAbort(aborted, []).evidenceRefs).toContain('native:aborted')
})

it('retains DSH lost prompt responses as unknown across adapter reconstruction without resubmitting', async () => {
  const { DshNativeExecutor } = await import('../src/host/services/superagent/executors/engines/dsh.ts')
  const facts: any[] = []
  let prompts = 0
  const io: any = {
    stream: 'lost-input',
    launch: { epoch: 1, actionRef: { id: 'launch', revision: 2 } },
    kernel: { host: { nativeFacts: () => facts, fenceDispatch: () => ({ kind: 'envelope' }) } },
    observe: (observation: unknown) => {
      facts.push({ ref: String(facts.length), observation })
    },
    call: async (method: string) => {
      if (method === 'session/prompt') {
        prompts++
        throw new Error('CONNECTION_LOST')
      }
    }
  }
  const page: any = { events: [], completeness: 'complete' }
  const first = new DshNativeExecutor(io, identity)
  first.collectNativeEvents = async () => page
  expect(await first.sendNativeInput(first.binding.ref, input)).toMatchObject({ status: 'unknown' })
  const reopened = new DshNativeExecutor(io, identity)
  reopened.collectNativeEvents = async () => page
  expect(await reopened.sendNativeInput(reopened.binding.ref, input)).toMatchObject({ status: 'unknown' })
  expect(prompts).toBe(1)
})

it('does not let an old DSH callback result clear a new-epoch request with a reused native call id', async () => {
  const { DshNativeExecutor } = await import('../src/host/services/superagent/executors/engines/dsh.ts')
  const facts = [
    { ref: 'old', observation: { kind: 'native-tool-result', requestId: 'reused', epoch: 1 } },
    {
      ref: 'new',
      observation: {
        kind: 'native-tool-request',
        requestId: 'reused',
        epoch: 2,
        callId: 'same',
        sessionId: identity.native_session_id,
        tool: 'read',
        args: { path: 'candidate.txt' }
      }
    }
  ]
  const io: any = {
    stream: 'callbacks',
    launch: { epoch: 2, expiresAt: Date.now() + 1000, actionRef: { id: 'launch2', revision: 2 } },
    kernel: { host: { nativeFacts: () => facts, fenceDispatch: () => ({ kind: 'envelope' }) } },
    observe: () => {}
  }
  const engine = new DshNativeExecutor(io, identity)
  expect(await engine.listNativeRequests(engine.binding.ref)).toHaveLength(1)
})
