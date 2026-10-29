import { describe, expect, it, vi } from 'vitest'
import { createServiceLifecycleOwner } from '../src/host/services/lifecycle.ts'
import { registerAsyncResources, registerResources, type OwnResource } from '../src/host/services/resources.ts'
import { registerGitRoutes } from '../src/host/services/git-graph/routes.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('adversarial lifecycle cleanup', () => {
  it('cleans a delayed synchronous owner callback after its transaction disposed', () => {
    let ownLate!: OwnResource<() => void>
    const release = vi.fn()
    const dispose = registerResources(own => { ownLate = own })
    dispose()
    ownLate(release)
    expect(release).toHaveBeenCalledOnce()
  })

  it('does not let a broken diagnostic consumer prevent other cleanup', async () => {
    const release = vi.fn()
    const owner = createServiceLifecycleOwner({ onDiagnostic: () => { throw new Error('logging failed') } })
    owner.mount('earlier', () => release)
    owner.mount('broken', () => () => { throw new Error('cleanup failed') })
    await expect(owner.dispose()).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledOnce()
    expect(owner.diagnostics.some(item => item.service === 'broken')).toBe(true)
  })

  it('continues registration even if failure diagnostics throw', async () => {
    const owner = createServiceLifecycleOwner({ onDiagnostic: () => { throw new Error('logging failed') } })
    expect(() => owner.mount('broken', () => { throw new Error('register failed') })).not.toThrow()
    await expect(owner.dispose()).resolves.toBeUndefined()
  })

  it('rolls back early real git route registrations when the later route collides', () => {
    const active = new Set<string>()
    const ctx = { webServer: { register: (route: { path: string }) => {
      if (active.size === 1) throw new Error('route collision')
      active.add(route.path)
      return () => { active.delete(route.path) }
    } } }
    expect(() => registerGitRoutes(ctx as never, {} as never)).toThrow('route collision')
    expect([...active]).toEqual([])
  })

  it('does not leak an asynchronously registered resource after setup rejects', async () => {
    const gate = deferred<void>()
    const release = vi.fn()
    let pending!: Promise<void>
    await expect(registerAsyncResources(async own => {
      pending = gate.promise.then(() => { own(release) })
      throw new Error('setup failed')
    })).rejects.toThrow('setup failed')
    gate.resolve()
    await pending
    expect(release).toHaveBeenCalledOnce()
  })
})
