// The limiter is a security control, so it has a memory bound as well as a behaviour:
// its keys are strings an unauthenticated caller chooses.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginLimiter } from '../src/host/services/remote-web-ui/server-mode/gateway-routes.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('login limiter bounds', () => {
  it('blocks inside the window and allows again after it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limiter = new LoginLimiter({ windowMs: 60_000, maxFailsPerWindow: 3 })
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.recordFailure('203.0.113.9:admin')
    expect(limiter.check('203.0.113.9:admin').allowed).toBe(false)
    vi.setSystemTime(60_001)
    expect(limiter.check('203.0.113.9:admin').allowed).toBe(true)
  })

  it('drops expired buckets instead of keeping every key it ever saw', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limiter = new LoginLimiter({ windowMs: 60_000 })
    for (let index = 0; index < 10; index += 1) limiter.recordFailure(`203.0.113.${String(index)}:admin`)
    expect(limiter.counts().failures).toBe(10)
    vi.setSystemTime(61_000)
    limiter.check('someone-else')
    expect(limiter.counts().failures).toBe(0)
  })

  it('caps the failure map when the keys are attacker-chosen', () => {
    // One failure per invented username is enough to grow an unbounded map; the cap is
    // what keeps that from being a memory sink on a public entry.
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limiter = new LoginLimiter({ maxKeys: 50 })
    for (let index = 0; index < 500; index += 1) limiter.recordFailure(`198.51.100.${String(index)}:user${String(index)}`)
    expect(limiter.counts().failures).toBeLessThanOrEqual(50)
  })

  it('keeps a lockout until it expires, however many new keys arrive', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limiter = new LoginLimiter({ windowMs: 60_000, maxFailsBeforeLockout: 3, lockoutMs: 300_000, maxKeys: 10 })
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.recordFailure('victim')
    expect(limiter.check('victim').allowed).toBe(false)
    for (let index = 0; index < 100; index += 1) limiter.recordFailure(`flood-${String(index)}`)
    expect(limiter.check('victim').allowed).toBe(false)
    vi.setSystemTime(300_001)
    expect(limiter.check('victim').allowed).toBe(true)
  })
})
