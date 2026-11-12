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

it('keeps a rejected message blocking after an unrelated successful classification until same-message retry', async () => {
  const gate = new OwnerInputGate()
  let reject!: (error: Error) => void
  const classification = gate.classify(() => new Promise<{ kind: 'discussion' }>((_resolve, fail) => { reject = fail }), 'failed')
  const outcome = classification.catch(error => error.message)
  const publication = gate.beforeDelivery().then(() => 'published', () => 'blocked')
  reject(Error('OWNER_MESSAGE_CLASSIFICATION_REQUIRED'))
  expect(await outcome).toBe('OWNER_MESSAGE_CLASSIFICATION_REQUIRED')
  expect(await publication).toBe('blocked')
  await gate.classify(async () => ({ kind: 'discussion' }), 'other')
  await expect(gate.beforeDelivery()).rejects.toThrow('OWNER_INPUT_PENDING')
  await gate.classify(async () => ({ kind: 'discussion' }), 'failed')
  await expect(gate.beforeDelivery()).resolves.toBeUndefined()
})
