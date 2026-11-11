import { createHash } from 'node:crypto'
import type { InputRecord, InputConsumption, SessionIdentity } from './adapter.ts'
export function bindingKey(identity: SessionIdentity): string {
  for (const value of Object.values(identity))
    if (typeof value !== 'string' || !value.trim()) throw new Error('NATIVE_IDENTITY_REQUIRED')
  return (
    'native:' +
    createHash('sha256')
      .update(
        JSON.stringify([
          identity.host_ref,
          identity.engine_ref,
          identity.runtime_namespace,
          identity.native_session_id
        ])
      )
      .digest('hex')
  )
}
export function encodeInput(input: InputRecord): string {
  if (
    !input.request_id.trim() ||
    !Number.isSafeInteger(input.assignment_revision) ||
    input.assignment_revision < 1 ||
    createHash('sha256').update(input.text).digest('hex') !== input.payload_digest
  )
    throw new Error('INPUT_DIGEST_MISMATCH')
  return JSON.stringify({
    managed_input: {
      request_id: input.request_id,
      assignment_revision: input.assignment_revision,
      payload_digest: input.payload_digest
    },
    text: input.text
  })
}
/** Accepted transport writes are deliberately insufficient: match the actual native user item and turn-start fact. */
export function consumptionProof(
  identity: SessionIdentity,
  input: InputRecord,
  turnId: string,
  nativeUserText: string | undefined,
  startedRef: string | undefined
): InputConsumption | undefined {
  if (!turnId || !startedRef || nativeUserText !== encodeInput(input)) return undefined
  return {
    request_id: input.request_id,
    assignment_revision: input.assignment_revision,
    payload_digest: input.payload_digest,
    session_identity: { ...identity },
    turn_id: turnId,
    processing_started_event_ref: startedRef
  }
}
