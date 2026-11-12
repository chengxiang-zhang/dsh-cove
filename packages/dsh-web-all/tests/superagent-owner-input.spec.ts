import { expect, it } from 'vitest'
import { OwnerInputGate } from '../src/host/services/superagent/kernel/owner-input.ts'

it('lets ordinary discussion run alongside project checks and waits for classification only at publication', async () => {
  const gate = new OwnerInputGate(); let finish!: (value: { kind: 'discussion' }) => void
  const conversation = gate.classify(() => new Promise<{ kind: 'discussion' }>(resolve => { finish = resolve }))
  expect(gate.amendmentPending).toBe(false)
  let published = false
  const delivery = gate.beforeDelivery().then(() => { published = true })
  await Promise.resolve(); expect(published).toBe(false)
  finish({ kind: 'discussion' }); await conversation; await delivery
  expect(published).toBe(true)
})

it('blocks old publication when classification finds an actual amendment', async () => {
  const gate = new OwnerInputGate()
  await gate.classify(async () => ({ kind: 'amendment' }))
  await expect(gate.beforeDelivery()).rejects.toThrow('OWNER_INPUT_PENDING')
  gate.clearAmendment()
  await expect(gate.beforeDelivery()).resolves.toBeUndefined()
})
