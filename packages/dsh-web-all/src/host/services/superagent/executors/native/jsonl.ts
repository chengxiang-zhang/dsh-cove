import { createHash, randomUUID } from 'node:crypto'
import type {
  createControlledKernel,
  ActionSpec,
  ExecutionEnvelope,
  ActionRecord
} from '../../kernel/actions.ts'
import type { SandboxProcess } from '../../kernel/sandbox-process.ts'
import type { Json, Ref } from '../../protocol/managed-work.ts'
type Kernel = ReturnType<typeof createControlledKernel>
export interface RpcMessage {
  id?: number | string
  method?: string
  params?: Json
  result?: Json
  error?: { code: number; message: string }
}
interface Pending {
  action: ExecutionEnvelope
  digest: string
  resolve: (value: Json) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
/** Engine-neutral JSONL transport. It cannot send a byte without a separately persisted Action. */
export class ControlledJsonl {
  readonly process: SandboxProcess<ActionRecord>
  readonly generation = randomUUID()
  #counter = 0
  #pending = new Map<string, Pending>()
  #listeners = new Set<(message: RpcMessage, ref: string) => void>()
  #closed = false
  constructor(
    readonly kernel: Kernel,
    readonly launch: ExecutionEnvelope,
    readonly stream: string
  ) {
    this.process = kernel.host.openProcess(launch.actionRef)
    this.process.onLine((line) => this.receive(line))
    void this.process.closed.then(
      () => this.close(),
      () => this.close()
    )
  }
  onMessage(listener: (message: RpcMessage, ref: string) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  observe(observation: Json): string {
    return this.kernel.host.observeNative(this.launch.actionRef, this.stream, observation).nativeRef
  }
  async call(
    method: string,
    params: Json,
    kind: ActionSpec['kind'] = 'inspect',
    timeoutMs = 10000
  ): Promise<Json> {
    if (this.#pending.size >= 32) throw new Error('RPC_BACKPRESSURE')
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000)
      throw new Error('RPC_TIMEOUT_INVALID')
    const id = ++this.#counter,
      message = { jsonrpc: '2.0', id, method, params },
      line = JSON.stringify(message),
      digest = createHash('sha256').update(line).digest('hex')
    const action = this.prepare(line, kind, String(id))
    const answer = new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(JSON.stringify(id))
        this.unknown(action.actionRef, 'RPC_RESPONSE_TIMEOUT')
        reject(new Error('RPC_RESPONSE_UNKNOWN'))
      }, timeoutMs)
      this.#pending.set(JSON.stringify(id), { action, digest, resolve, reject, timer })
    })
    // Writes and close notifications can race; attach a handler before awaiting backpressure.
    void answer.catch(() => {})
    try {
      await this.process.writeLine(action.actionRef, line)
    } catch (error) {
      const pending = this.#pending.get(JSON.stringify(id))
      if (pending) {
        clearTimeout(pending.timer)
        this.#pending.delete(JSON.stringify(id))
        this.unknown(action.actionRef, 'RPC_WRITE_UNKNOWN')
        pending.reject(error as Error)
      }
    }
    return answer
  }
  async notify(method: string, params: Json = {}): Promise<void> {
    const line = JSON.stringify({ jsonrpc: '2.0', method, params }),
      action = this.prepare(line, 'attach')
    await this.process.writeLine(action.actionRef, line)
    this.unknown(action.actionRef, 'NOTIFICATION_HAS_NO_NATIVE_RESPONSE')
  }
  async respond(
    id: string | number,
    response: { result?: Json; error?: { code: number; message: string } }
  ): Promise<Ref> {
    const line = JSON.stringify({ jsonrpc: '2.0', id, ...response }),
      action = this.prepare(line, 'respond_request', String(id))
    await this.process.writeLine(action.actionRef, line)
    this.unknown(action.actionRef, 'SERVER_RESPONSE_HAS_NO_RECEIPT')
    return action.actionRef
  }
  private prepare(line: string, kind: ActionSpec['kind'], nativeRequestId?: string): ExecutionEnvelope {
    if (this.#closed) throw new Error('RPC_CLOSED')
    const id = 'rpc:' + randomUUID(),
      spec: ActionSpec = {
        ...this.launch.spec,
        timeoutMs: Math.min(30000, this.launch.spec.timeoutMs),
        id,
        idempotencyKey: id,
        kind,
        payloadDigest: createHash('sha256').update(line).digest('hex'),
        ...(nativeRequestId ? { nativeRequestId } : {})
      }
    const action = this.kernel.actions.planAction(spec)
    const borrow = this.kernel.host.borrowSessionResources(action.ref, this.launch.actionRef)
    if (borrow.kind === 'denial') throw new Error(borrow.code)
    const envelope = this.kernel.host.beginDispatch(action.ref)
    if (envelope.kind === 'denial') throw new Error(envelope.code)
    return envelope
  }
  private unknown(ref: Ref, reason: string): void {
    this.kernel.actions.recordActionResult(ref, {
      status: 'unknown',
      stopped: false,
      evidenceRefs: [],
      reason
    })
  }
  private receive(line: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error()
    } catch {
      this.observe({ kind: 'invalid-jsonl', digest: createHash('sha256').update(line).digest('hex') })
      return
    }
    const evidence = this.observe({ kind: 'rpc', message: message as unknown as Json })
    if (message.id !== undefined && !message.method) {
      const hasResult = Object.hasOwn(message, 'result')
      const hasError = Object.hasOwn(message, 'error')
      if (
        hasResult === hasError ||
        (hasError &&
          (!message.error ||
            typeof message.error.code !== 'number' ||
            typeof message.error.message !== 'string'))
      )
        return
      const pending = this.#pending.get(JSON.stringify(message.id))
      if (!pending) return
      this.#pending.delete(JSON.stringify(message.id))
      clearTimeout(pending.timer)
      this.kernel.host.completeOperation(
        pending.action.actionRef,
        {
          ownerRef: this.launch.actionRef,
          payloadDigest: pending.digest,
          nativeRequestId: String(message.id),
          responseDigest: createHash('sha256').update(line).digest('hex')
        },
        [evidence]
      )
      if (message.error) pending.reject(new Error('NATIVE_RPC_ERROR:' + message.error.message))
      else pending.resolve(message.result ?? null)
    }
    for (const listener of this.#listeners) listener(message, evidence)
  }
  private close(): void {
    this.#closed = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      try {
        this.unknown(pending.action.actionRef, 'CONNECTION_LOST')
      } catch {
        /* Keep the durable sent Action if ledger is unavailable. */
      }
      pending.reject(new Error('RPC_RESPONSE_UNKNOWN'))
    }
    this.#pending.clear()
  }
}
