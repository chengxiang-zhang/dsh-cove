/** One secretary input owns acquisition, consumption and physical close before the next input. */
export class NativeTurnQueue {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(turn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(turn, turn)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
  async settled(): Promise<void> { await this.tail }
}

/** Only callbacks already accepted by this worker session may outlive its polling result. */
export class NativeRequestScope {
  private accepting = true
  private pending = new Set<Promise<void>>()
  accept(callback: () => Promise<void>): void {
    if (!this.accepting) return
    const task = callback().then(() => undefined, () => undefined)
    this.pending.add(task)
    void task.then(() => this.pending.delete(task))
  }
  async finish(detach: () => void): Promise<void> {
    this.accepting = false
    detach()
    await Promise.all([...this.pending])
  }
}

export async function closeExactSession<T, R>(sessions: Map<string, T>, role: string, expected: T, release: (session: T) => Promise<R>): Promise<R> {
  if (sessions.get(role) !== expected) throw Error('NATIVE_SESSION_OWNERSHIP_CHANGED')
  const receipt = await release(expected)
  if (sessions.get(role) === expected) sessions.delete(role)
  return receipt
}
