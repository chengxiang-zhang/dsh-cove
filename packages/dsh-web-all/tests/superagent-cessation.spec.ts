import { expect, it } from 'vitest'
import { nativeWriterCeased } from '../src/host/services/superagent/kernel/coordination-ledger.ts'
import type { ManagedObject } from '../src/host/services/superagent/protocol/managed-work.ts'

it('accepts ledger-attested domain absence for handoff without forging an old stopped receipt', () => {
  const action = { id: 'launch', kind: 'action', revision: 2, data: { execution_spec: { kind: 'dispatch' }, receipt: { status: 'unknown', stopped: false } } } as unknown as ManagedObject
  expect(nativeWriterCeased({ retiredNativeDomain: () => undefined }, action)).toBe(false)
  expect(nativeWriterCeased({ retiredNativeDomain: ref => ref.id === 'launch' && ref.revision === 2 ? 'native-event:10' : undefined }, action)).toBe(true)
  expect(action.data.receipt).toEqual({ status: 'unknown', stopped: false })
  expect(nativeWriterCeased({ retiredNativeDomain: () => 'native-event:10' }, { ...action, data: { ...action.data, execution_spec: { kind: 'collect' } } })).toBe(false)
})
