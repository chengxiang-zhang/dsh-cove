import { describe, expect, it, vi } from 'vitest'
import { registerAsyncResources, registerResources } from '../src/host/services/resources.ts'

describe('service registration transactions', () => {
  it('rolls back partial synchronous setup in reverse order', () => {
    const calls: string[] = []
    expect(() => registerResources(own => {
      own(() => { calls.push('routes') })
      own(() => { calls.push('tools') })
      throw new Error('third registration failed')
    })).toThrow('third registration failed')
    expect(calls).toEqual(['tools', 'routes'])
  })

  it('attempts every cleanup even when a disposer throws and remains single-shot', () => {
    const release = vi.fn()
    const dispose = registerResources(own => {
      own(release)
      own(() => { throw new Error('cleanup failed') })
    })
    expect(dispose).toThrow(AggregateError)
    expect(release).toHaveBeenCalledOnce()
    expect(dispose).not.toThrow()
  })

  it('preserves both the setup error and rollback diagnostics', () => {
    try {
      registerResources(own => {
        own(() => { throw new Error('cleanup failed') })
        throw new Error('registration failed')
      })
      expect.fail('registration must reject')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors[0].message).toBe('registration failed')
    }
  })

  it('awaits rollback after an async registration rejects', async () => {
    const calls: string[] = []
    await expect(registerAsyncResources(async own => {
      own(async () => { await Promise.resolve(); calls.push('manager') })
      own(() => { calls.push('routes') })
      await Promise.resolve()
      throw new Error('enumeration failed')
    })).rejects.toThrow('enumeration failed')
    expect(calls).toEqual(['routes', 'manager'])
  })

  it('awaits all async resources despite cleanup failure and shares disposal completion', async () => {
    const release = vi.fn(async () => undefined)
    const dispose = await registerAsyncResources(async own => {
      own(release)
      own(async () => { throw new Error('cleanup failed') })
    })
    const first = dispose()
    expect(dispose()).toBe(first)
    await expect(first).rejects.toThrow(AggregateError)
    expect(release).toHaveBeenCalledOnce()
  })
})
