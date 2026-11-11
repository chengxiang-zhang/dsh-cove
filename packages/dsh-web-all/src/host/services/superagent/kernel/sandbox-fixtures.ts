export interface FixtureLease {
  readonly index: number
  readonly owner: string
  readonly state: 'active' | 'released' | 'unknown'
}
/** One-shot endpoint ownership. A client close claim never makes a slot reusable. */
export class FixtureLeaseTable {
  readonly #capacity: number
  readonly #leases: FixtureLease[] = []
  #retired = false
  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 256) throw new Error('FIXTURE_POOL_LIMIT')
    this.#capacity = capacity
  }
  allocate(owner: string): Pick<FixtureLease, 'index' | 'state'> {
    if (this.#retired) throw new Error('FIXTURE_POOL_RETIRED')
    if (typeof owner !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(owner)) throw new Error('FIXTURE_LEASE_OWNER')
    if (this.#leases.length === this.#capacity) throw new Error('FIXTURE_POOL_EXHAUSTED')
    const index = this.#leases.length
    this.#leases.push(Object.freeze({ index, owner, state: 'active' }))
    return Object.freeze({ index, state: 'active' })
  }
  release(owner: string, index: number): void {
    const lease = this.#leases[index]
    if (!Number.isSafeInteger(index) || !lease || lease.owner !== owner) throw new Error('FIXTURE_LEASE_OWNER')
    if (lease.state !== 'active') throw new Error('FIXTURE_LEASE_STATE')
    this.#leases[index] = Object.freeze({ ...lease, state: 'released' })
  }
  disconnected(owner: string): void {
    for (const lease of this.#leases) if (lease.owner === owner && lease.state === 'active') this.#leases[lease.index] = Object.freeze({ ...lease, state: 'unknown' })
  }
  retire(): void {
    this.#retired = true
    for (const lease of this.#leases) if (lease.state === 'active') this.#leases[lease.index] = Object.freeze({ ...lease, state: 'unknown' })
  }
  snapshot(): readonly FixtureLease[] { return Object.freeze([...this.#leases]) }
}
