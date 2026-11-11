import type { ResolvedGraph } from './contracts'
export type PluginState = 'discovered' | 'validated' | 'prepared' | 'active' | 'draining' | 'retired' | 'quarantine'
export interface GenerationAuthority {
  current(): number
  compareAndSwap(expected: number, next: number): boolean
  /** Synchronous hold shared across generations; release only after invocation settles. */
  acquire(generation: number): () => void
  pending(generation: number): number
}
export function createGenerationAuthority(initial = 0): GenerationAuthority {
  let current = initial
  const calls = new Map<number, number>()
  return {
    current: () => current,
    pending: generation => calls.get(generation) ?? 0,
    acquire(generation) {
      if (current !== generation) throw new Error('stale generation invocation')
      calls.set(generation, (calls.get(generation) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const remaining = calls.get(generation)! - 1
        if (remaining) calls.set(generation, remaining)
        else calls.delete(generation)
      }
    },
    compareAndSwap(expected, next) {
      if (current !== expected || next !== expected + 1 || (calls.get(current) ?? 0) > 0) return false
      current = next
      return true
    },
  }
}
export interface CurrentGenerationRefs { authority: GenerationAuthority; in_flight: readonly string[] }
export interface InvocationCheckpoint {
  readonly signal: AbortSignal
  /** Call immediately before each side effect after an await; this is cooperative, not a sandbox. */
  assertCurrent(): void
}
export interface PreparedGeneration {
  readonly generation: number
  readonly loading_mode: 'domain-controlled'
  readonly state: PluginState
  register(plugin: string, port: string, implementation: unknown): void
  activate(): void
  port<T>(id: string): { generation: number; invoke<R>(callback: (implementation: T, checkpoint: InvocationCheckpoint) => R): R }
  writePrivate<T>(caller: string, owner: string, schema: string, write: (checkpoint: InvocationCheckpoint) => T): T
  beginDrain(deadline: number): void
  retire(now: number, inFlight: readonly string[]): { ok: true } | { ok: false; reason: 'IN_FLIGHT' | 'DRAIN_TIMEOUT' }
  quarantine(): void
}
export function prepareGeneration(graph: ResolvedGraph, currentRefs: CurrentGenerationRefs): PreparedGeneration {
  const expected = currentRefs.authority.current()
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('invalid generation')
  let state: PluginState = 'prepared', deadline = Infinity
  const generation = expected + 1
  const cancellation = new AbortController()
  const implementations = new Map<string, unknown>()
  const checkAdmission = (owner?: string) => {
    const rejection = graph.checkAdmission(owner)
    if (rejection) throw new Error(rejection.code + ': ' + rejection.plugin_id + '/' + rejection.subject)
  }
  const assertActive = (owner?: string) => {
    if (state !== 'active' || currentRefs.authority.current() !== generation) throw new Error('generation not active')
    if (owner !== undefined) checkAdmission(owner)
  }
  const withInvocation = <R>(owner: string, callback: (checkpoint: InvocationCheckpoint) => R): R => {
    assertActive(owner)
    const release = currentRefs.authority.acquire(generation)
    try {
      const result = callback({ signal: cancellation.signal, assertCurrent: () => assertActive(owner) })
      if (result != null && typeof (result as { then?: unknown }).then === 'function') {
        return Promise.resolve(result).finally(release) as R
      }
      release()
      return result
    } catch (error) {
      release()
      throw error
    }
  }
  return {
    generation, loading_mode: 'domain-controlled',
    get state() { return state },
    register(plugin, port, implementation) {
      if (state !== 'prepared') throw new Error('registration requires prepared generation')
      if (graph.providers.get(port)?.plugin_id !== plugin) throw new Error('port owner mismatch')
      if (implementations.has(port) || implementation == null) throw new Error('invalid duplicate registration')
      implementations.set(port, implementation)
    },
    activate() {
      if (state !== 'prepared') throw new Error('activation requires prepared generation')
      if (currentRefs.in_flight.length || currentRefs.authority.pending(expected)) throw new Error('domain switch blocked by in-flight references')
      checkAdmission()
      for (const port of graph.providers.keys()) if (!implementations.has(port)) throw new Error('unregistered port: ' + port)
      if (!currentRefs.authority.compareAndSwap(expected, generation)) throw new Error('stale generation activation')
      state = 'active'
    },
    port<T>(id: string) {
      const owner = graph.providers.get(id)?.plugin_id
      assertActive(owner)
      if (!owner || !implementations.has(id)) throw new Error('unknown port: ' + id)
      return { generation, invoke<R>(callback: (implementation: T, checkpoint: InvocationCheckpoint) => R): R {
        return withInvocation(owner, checkpoint => callback(implementations.get(id) as T, checkpoint))
      } }
    },
    writePrivate(caller, owner, schema, write) {
      assertActive()
      if (caller !== owner || !graph.manifests.some(m => m.id === owner && m.owned_state_schemas.some(s => s.id === schema))) throw new Error('private state access denied')
      return withInvocation(owner, write)
    },
    beginDrain(at) {
      assertActive()
      if (!Number.isFinite(at)) throw new Error('finite drain deadline required')
      deadline = at; state = 'draining'; cancellation.abort()
    },
    retire(now, inFlight) {
      if (state !== 'draining') throw new Error('retirement requires draining generation')
      if (inFlight.length || currentRefs.in_flight.length || currentRefs.authority.pending(generation)) return { ok: false, reason: now >= deadline ? 'DRAIN_TIMEOUT' : 'IN_FLIGHT' }
      state = 'retired'; implementations.clear(); return { ok: true }
    },
    quarantine() { state = 'quarantine'; cancellation.abort(); implementations.clear() },
  }
}
