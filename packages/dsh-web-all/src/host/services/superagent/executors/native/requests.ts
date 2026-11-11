import type { Ref, Json } from '../../protocol/managed-work.ts'
export interface ExecutorRequest {
  ref: Ref
  nativeId: string
  generation: string
  method: string
  params: Json
  threadId: string
  turnId: string
  epoch: number
  expiresAt: number
  state: 'pending' | 'responding' | 'unknown' | 'cleared'
  reason?: string
}
export class NativeRequests {
  #generation: string
  #requests = new Map<string, ExecutorRequest>()
  constructor(
    generation: string,
    private readonly persist: (request: ExecutorRequest) => void,
    restored: ExecutorRequest[] = []
  ) {
    this.#generation = generation
    for (const request of restored)
      this.#requests.set(request.generation + ':' + request.nativeId, structuredClone(request))
  }
  observe(input: {
    id: string
    method: string
    params: Json
    threadId: string
    turnId: string
    epoch: number
    expiresAt: number
  }): ExecutorRequest {
    const key = this.#generation + ':' + input.id,
      old = this.#requests.get(key)
    if (old) {
      if (
        old.generation !== this.#generation ||
        old.method !== input.method ||
        JSON.stringify(old.params) !== JSON.stringify(input.params)
      )
        throw new Error('REQUEST_ID_COLLISION')
      return structuredClone(old)
    }
    const request: ExecutorRequest = {
      ref: { id: `request:${this.#generation}:${input.id}`, revision: 1 },
      nativeId: input.id,
      generation: this.#generation,
      method: input.method,
      params: structuredClone(input.params),
      threadId: input.threadId,
      turnId: input.turnId,
      epoch: input.epoch,
      expiresAt: input.expiresAt,
      state: 'pending'
    }
    this.persist(request)
    this.#requests.set(key, request)
    return structuredClone(request)
  }
  beginResponse(ref: Ref, epoch: number, now: number): ExecutorRequest {
    const r = [...this.#requests.values()].find((r) => r.ref.id === ref.id)
    if (!r) throw new Error('REQUEST_UNKNOWN')
    if (r.state !== 'pending') throw new Error('REQUEST_NOT_PENDING')
    if (r.ref.revision !== ref.revision) throw new Error('REQUEST_STALE')
    if (r.epoch !== epoch) throw new Error('REQUEST_EPOCH_CHANGED')
    if (now >= r.expiresAt) throw new Error('REQUEST_EXPIRED')
    return this.change(r.nativeId, 'responding')
  }
  clear(id: string, reason: string): void {
    this.change(id, 'cleared', reason)
  }
  responseUnknown(id: string, reason: string): void {
    this.change(id, 'unknown', reason)
  }
  restart(generation: string): void {
    for (const r of this.#requests.values())
      if (r.state !== 'cleared') this.change(r.nativeId, 'cleared', 'runtime-restarted', r.generation)
    this.#generation = generation
  }
  list(): ExecutorRequest[] {
    return this.snapshot().filter((r) => r.state === 'pending')
  }
  snapshot(): ExecutorRequest[] {
    return structuredClone([...this.#requests.values()])
  }
  private change(
    id: string,
    state: ExecutorRequest['state'],
    reason?: string,
    generation = this.#generation
  ): ExecutorRequest {
    const key = generation + ':' + id,
      old = this.#requests.get(key)
    if (!old) throw new Error('REQUEST_UNKNOWN')
    const r = {
      ...old,
      ref: { ...old.ref, revision: old.ref.revision + 1 },
      state,
      ...(reason ? { reason } : {})
    }
    this.persist(r)
    this.#requests.set(key, r)
    return structuredClone(r)
  }
}
