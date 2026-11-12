/** Discussion does not revoke execution. Publication waits for pending intent classification. */
export class OwnerInputGate {
  private tail: Promise<void> = Promise.resolve()
  private readonly unresolved = new Set<string>()
  hold(id: string): void { this.unresolved.add(id) }
  amendmentPending = false
  async classify<T extends { kind: 'discussion' | 'amendment' }>(classify: () => Promise<T>, id = 'anonymous'): Promise<T> {
    this.hold(id)
    let release!: () => void
    const complete = new Promise<void>(resolve => { release = resolve })
    this.tail = Promise.all([this.tail, complete]).then(() => undefined)
    try { const result = await classify(); if (!['discussion', 'amendment'].includes(result.kind)) throw Error('OWNER_MESSAGE_CLASSIFICATION_REQUIRED'); if (result.kind === 'amendment') this.amendmentPending = true; this.unresolved.delete(id); return result }
    finally { release() }
  }
  async beforeDelivery(): Promise<void> {
    let observed: Promise<void>
    do { observed = this.tail; await observed } while (observed !== this.tail)
    if (this.amendmentPending || this.unresolved.size) throw Error('OWNER_INPUT_PENDING')
  }
  clearAmendment(): void { this.amendmentPending = false }
}
