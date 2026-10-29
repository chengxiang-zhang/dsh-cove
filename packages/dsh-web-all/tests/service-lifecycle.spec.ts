import { describe, expect, it, vi } from 'vitest'
import { createServiceLifecycleOwner } from '../src/host/services/lifecycle.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('host service lifecycle owner', () => {
  it('disposes an async registration that settles after owner disposal', async () => {
    const gate = deferred<() => void>()
    const disposeLate = vi.fn()
    const owner = createServiceLifecycleOwner()
    owner.track('playwright-sessions', gate.promise)
    const disposing = owner.dispose()
    gate.resolve(disposeLate)
    await disposing
    expect(disposeLate).toHaveBeenCalledOnce()
    expect(owner.signal.aborted).toBe(true)
  })

  it('waits for async disposers and runs registrations in reverse order', async () => {
    const calls: string[] = []
    const owner = createServiceLifecycleOwner()
    owner.mount('one', () => async () => { await Promise.resolve(); calls.push('one') })
    owner.mount('two', () => () => { calls.push('two') })
    await owner.dispose()
    expect(calls).toEqual(['two', 'one'])
  })

  it('records tolerant registration and disposal diagnostics', async () => {
    const seen = vi.fn()
    const owner = createServiceLifecycleOwner({ onDiagnostic: seen, now: () => 42 })
    owner.mount('broken-register', () => { throw new Error('mount failed') })
    owner.mount('broken-dispose', () => () => { throw new Error('cleanup failed') })
    await owner.dispose()
    expect(owner.diagnostics.map(row => ({ service: row.service, phase: row.phase, message: row.message, at: row.at }))).toEqual([
      { service: 'broken-register', phase: 'register', message: 'mount failed', at: 42 },
      { service: 'broken-dispose', phase: 'dispose', message: 'cleanup failed', at: 42 },
    ])
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('ignores duplicate disposal and tears down a tracked registration added late', async () => {
    const dispose = vi.fn()
    const disposeLate = vi.fn()
    const owner = createServiceLifecycleOwner()
    owner.mount('active', () => dispose)
    await owner.dispose()
    owner.mount('late-sync', () => vi.fn())
    owner.track('late-async', Promise.resolve(disposeLate))
    await Promise.resolve()
    await owner.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    expect(disposeLate).toHaveBeenCalledOnce()
  })
})
