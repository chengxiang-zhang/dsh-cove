/** Discussion does not revoke execution. Publication waits for pending intent classification. */
export class OwnerInputGate {
  private tail: Promise<void> = Promise.resolve()
  amendmentPending = false
  async classify<T extends { kind: 'discussion' | 'amendment' }>(classify: () => Promise<T>): Promise<T> {
    let release!: () => void
    const complete = new Promise<void>(resolve => { release = resolve })
    this.tail = Promise.all([this.tail, complete]).then(() => undefined)
    try { const result = await classify(); if (result.kind === 'amendment') this.amendmentPending = true; return result }
    finally { release() }
  }
  async beforeDelivery(): Promise<void> {
    let observed: Promise<void>
    do { observed = this.tail; await observed } while (observed !== this.tail)
    if (this.amendmentPending) throw Error('OWNER_INPUT_PENDING')
  }
  clearAmendment(): void { this.amendmentPending = false }
}
