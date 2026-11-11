import type { HostPort } from '../../plugins/contracts'

/** Supplied by the existing web-all composition root, never a second entity. */
export interface DshHostBindings {
  host_ref: string
  now(): number
  onDispose(callback: () => void): void
}
export function createDshHostPort(bindings: DshHostBindings): HostPort {
  if (!bindings.host_ref.trim()) throw new Error('host identity required')
  return Object.freeze({
    host_ref: bindings.host_ref,
    loading_mode: 'domain-controlled' as const,
    now: () => bindings.now(),
    onDispose: (callback: () => void) => bindings.onDispose(callback),
  })
}
