import { expect, it } from 'vitest'
import { createDshHostPort } from '../src/host/services/superagent/adapters/host/dsh'
import type { ExecutorPort } from '../src/host/services/superagent/plugins/contracts'
it('adapts only host lifecycle and clock without importing DSH into mechanisms', () => {
  let dispose: (() => void) | undefined
  const host = createDshHostPort({ host_ref: 'machine:test', now: () => 42, onDispose: callback => { dispose = callback } })
  let retired = false
  host.onDispose(() => { retired = true })
  expect(host.now()).toBe(42)
  expect(host.loading_mode).toBe('domain-controlled')
  dispose!()
  expect(retired).toBe(true)
})
it('keeps accepted receipts separate from consumption and stable native identity', async () => {
  const executor: ExecutorPort = {
    identity: { host_ref: 'machine:a', engine_ref: 'adapter@1', runtime_namespace: 'account:store', native_session_id: 'opaque' },
    async execute(command) { return { request_id: command.request_id, status: 'accepted' } },
  }
  const receipt = await executor.execute({ request_id: 'r', assignment_revision: 2, payload_digest: 'sha256:x', payload_ref: 'input:x' }, new AbortController().signal)
  expect(receipt.status).toBe('accepted')
  expect('consumption' in receipt).toBe(false)
  expect(executor.identity.native_session_id).toBe('opaque')
})
