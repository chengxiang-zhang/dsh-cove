import type { DatabaseSync } from 'node:sqlite'
import type { ManagedLedger } from './managed-ledger.ts'
import type { Ref, ManagedObject } from '../protocol/managed-work.ts'
import type { DeliveryStep, DeliveryReceipt } from '../protocol/delivery.ts'
import { deliveryActionSpec as prepareDeliveryStep, type DeliveryAcceptance } from '../protocol/delivery.ts'
const tokens = new WeakMap<object, (step: DeliveryStep, receipt: DeliveryReceipt) => DeliveryAcceptance>()
export interface DeliveryCommitCommand { token: object; source: Ref; step: DeliveryStep; receipt: DeliveryReceipt }
/** Never exported as a secretary tool. Generic proposals cannot obtain the token. */
export function createDeliveryFulfillment(ledger: ManagedLedger, source: Ref, revalidate: (step: DeliveryStep, receipt: DeliveryReceipt) => DeliveryAcceptance) {
  const token = Object.freeze({}); tokens.set(token, revalidate)
  return (step: DeliveryStep, receipt: DeliveryReceipt) => ledger.delivery({ token, source, step, receipt })
}
export function deliveryTransaction(db: DatabaseSync, ledger: ManagedLedger, command: DeliveryCommitCommand): Ref {
  if (!tokens.has(command.token)) throw new Error('DELIVERY_HOST_REQUIRED')
  db.exec('BEGIN IMMEDIATE')
  try {
    const { step, receipt } = command
    // All semantic versions, gate artifacts and physical Git facts are read again
    // inside this transaction, after any asynchronous executor work has finished.
    const acceptance = tokens.get(command.token)!(step, receipt)
    const prior = ledger.eventEntries({deliveryStep:step.ref}).map(e=>e.body).find(event => { const x = event as unknown as { delivery?: string; step?: DeliveryStep; receipt?: DeliveryReceipt }; return x.delivery === 'fulfilled' && JSON.stringify(x.step) === JSON.stringify(step) && JSON.stringify(x.receipt) === JSON.stringify(receipt) })
    if (prior) { db.exec('COMMIT'); return { id: step.action.target.id, revision: step.action.target.revision + 1 } }
    const action = ledger.get(receipt.actionRef.id)
    if (!action || action.kind !== 'action' || action.revision !== receipt.actionRef.revision || action.data.state !== 'confirmed' || (action.data.receipt as Record<string, unknown>)?.stopped !== true || JSON.stringify(action.data.execution_spec) !== JSON.stringify(prepareDeliveryStep(step))) throw new Error('DELIVERY_ACTION_RECEIPT_REQUIRED')
    const c = ledger.get(step.action.target.id)!
    const contractRef = c.data.delivery_contract as unknown as Ref | null
    const contract = contractRef && ledger.get(contractRef.id)
    if (!contract || contract.kind !== 'delivery_contract' || contract.revision !== contractRef!.revision || ledger.applicability(contract.id) !== 'usable' || !Array.isArray(contract.data.step_refs) || contract.data.step_refs.length !== 1 || JSON.stringify(contract.data.step_refs[0]) !== JSON.stringify(step.ref)) throw new Error('DELIVERY_CONTRACT_SCOPE_REQUIRED')
    const next: ManagedObject = { ...c, revision: c.revision + 1, data: { ...c.data, state: 'fulfilled', state_reason: 'Independently verified exact local dev delivery' } }
    ledger.validate(next)
    const changed = db.prepare('UPDATE sa_managed_object SET revision=?,body_json=? WHERE id=? AND revision=?').run(next.revision, JSON.stringify(next), c.id, step.action.target.revision)
    if (Number(changed.changes) !== 1) throw new Error('DELIVERY_FULFILLMENT_CAS')
    const sequence = Number(db.prepare('SELECT sequence FROM sa_managed_meta WHERE singleton=1').get()!.sequence) + 1
    db.prepare('UPDATE sa_managed_meta SET sequence=? WHERE singleton=1').run(sequence)
    db.prepare('INSERT INTO sa_managed_event VALUES(?,?)').run(sequence, JSON.stringify({ delivery: 'fulfilled', source: command.source, step, receipt, acceptance, ref: { id: next.id, revision: next.revision } }))
    db.exec('COMMIT')
    return { id: next.id, revision: next.revision }
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
