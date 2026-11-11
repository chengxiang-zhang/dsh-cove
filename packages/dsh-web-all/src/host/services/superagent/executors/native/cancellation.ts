import type { Ref } from '../../protocol/managed-work.ts'
export interface NativeAbort {
  binding: Ref
  epoch: number
  turnId: string
  nativeEventRef: string
}
export interface TrustedAbortCause extends NativeAbort {
  cause: 'platform-interruption' | 'human-takeover'
  sourceRef: Ref
  evidenceRef: string
}
/** Host facts only. Missing human logs never establish a platform cause. No lifecycle state is changed. */
export function attributeNativeAbort(aborted: NativeAbort, trustedFacts: readonly TrustedAbortCause[]) {
  const matching = trustedFacts.filter(
    (fact) =>
      fact.binding.id === aborted.binding.id &&
      fact.binding.revision === aborted.binding.revision &&
      fact.epoch === aborted.epoch &&
      fact.turnId === aborted.turnId &&
      fact.nativeEventRef === aborted.nativeEventRef &&
      fact.sourceRef.id.trim() &&
      fact.evidenceRef.trim()
  )
  const causes = new Set(matching.map((fact) => fact.cause))
  return {
    ...aborted,
    cause: causes.size === 1 ? matching[0]!.cause : ('unknown' as const),
    evidenceRefs: [aborted.nativeEventRef, ...matching.map((fact) => fact.evidenceRef)]
  }
}
