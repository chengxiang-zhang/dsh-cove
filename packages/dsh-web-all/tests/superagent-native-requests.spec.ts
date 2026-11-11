import { expect, it } from 'vitest'
import { NativeRequests } from '../src/host/services/superagent/executors/native/requests.ts'
it('preserves pending requests across observation, expires stale replies, and never treats clear as tool success', () => {
  const facts: unknown[] = []
  const requests = new NativeRequests('generation-a', (x) => facts.push(x))
  const pending = requests.observe({
    id: '1',
    method: 'item/tool/call',
    params: { tool: 'ask' },
    threadId: 'thread',
    turnId: 'turn',
    epoch: 1,
    expiresAt: 100
  })
  expect(requests.list()).toHaveLength(1)
  expect(() => requests.beginResponse(pending.ref, 1, 101)).toThrow('REQUEST_EXPIRED')
  expect(() => requests.beginResponse({ id: 'absent', revision: 1 }, 1, 50)).toThrow('REQUEST_UNKNOWN')
  expect(() => requests.beginResponse(pending.ref, 2, 50)).toThrow('REQUEST_EPOCH_CHANGED')
  requests.clear('1', 'native-resolved')
  expect(requests.list()).toHaveLength(0)
  expect(requests.snapshot()[0]).toMatchObject({ state: 'cleared', reason: 'native-resolved' })
  expect(requests.snapshot()[0]).not.toHaveProperty('tool_completed')
  expect(() => requests.beginResponse(pending.ref, 1, 50)).toThrow('REQUEST_NOT_PENDING')
  expect(facts.length).toBe(2)
})
it('keeps lost reply unknown and clears old process requests on restart without resending', () => {
  const requests = new NativeRequests('generation-a', () => {})
  const pending = requests.observe({
    id: '1',
    method: 'item/tool/call',
    params: {},
    threadId: 'thread',
    turnId: 'turn',
    epoch: 1,
    expiresAt: 100
  })
  requests.beginResponse(pending.ref, 1, 50)
  requests.responseUnknown('1', 'connection-lost')
  expect(requests.snapshot()[0]).toMatchObject({ state: 'unknown' })
  expect(() => requests.beginResponse(pending.ref, 1, 50)).toThrow('REQUEST_NOT_PENDING')
  requests.restart('generation-b')
  expect(requests.snapshot()[0]).toMatchObject({ state: 'cleared', reason: 'runtime-restarted' })
  const fresh = requests.observe({
    id: '1',
    method: 'item/tool/call',
    params: {},
    threadId: 'thread',
    turnId: 'turn-next',
    epoch: 2,
    expiresAt: 200
  })
  expect(fresh.ref.id).not.toBe(pending.ref.id)
  expect(requests.list()).toHaveLength(1)
})
