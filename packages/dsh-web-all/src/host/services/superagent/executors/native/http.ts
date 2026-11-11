import { createHash, randomUUID } from 'node:crypto'
import type { createControlledKernel, ExecutionEnvelope, ActionSpec } from '../../kernel/actions.ts'
import type { Json } from '../../protocol/managed-work.ts'
async function boundedJson(response: Response): Promise<Json> {
  if (!response.body) throw new Error('NATIVE_HTTP_RESPONSE_EMPTY')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 8 * 1024 * 1024) throw new Error('NATIVE_HTTP_RESPONSE_TOO_LARGE')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
/** Owned loopback target only. Startup authentication remains in memory, never in the ledger. */
export class ControlledNativeHttp {
  readonly baseUrl: string
  #cookie = ''
  constructor(
    readonly kernel: ReturnType<typeof createControlledKernel>,
    readonly launch: ExecutionEnvelope,
    readonly stream: string,
    startupUrl: string
  ) {
    const url = new URL(startupUrl)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password)
      throw new Error('NATIVE_HTTP_TARGET_DENIED')
    this.baseUrl = url.origin
  }
  async authenticate(startupUrl: string): Promise<void> {
    if (new URL(startupUrl).origin !== this.baseUrl) throw new Error('NATIVE_HTTP_TARGET_DENIED')
    await this.exchange('attach', 'owner-auth', startupUrl, { method: 'GET' }, true)
  }
  async call(
    method: string,
    args: Json,
    kind: ActionSpec['kind'] = 'inspect',
    timeoutMs = 10000
  ): Promise<any> {
    if (
      ![
        'session/create',
        'session/prompt',
        'session/cancel',
        'session/projections',
        'session/page',
        'session/selectModel',
        'session/modelCatalog'
      ].includes(method)
    )
      throw new Error('NATIVE_HTTP_METHOD_DENIED')
    const requestId = randomUUID(),
      body = JSON.stringify({ type: 'client-request', rpcId: requestId, method, payload: { args } })
    const response = (await this.exchange(
      kind,
      requestId,
      this.baseUrl + '/api/' + method,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: this.baseUrl, Cookie: this.#cookie },
        body
      },
      false,
      timeoutMs
    )) as any
    if (response?.result?.ok !== true)
      throw new Error('DSH_NATIVE_RPC_REJECTED:' + String(response?.result?.error?.code ?? 'unknown'))
    return response.result.value
  }
  observe(observation: Json): string {
    return this.kernel.host.observeNative(this.launch.actionRef, this.stream, observation).nativeRef
  }
  private async exchange(
    kind: ActionSpec['kind'],
    nativeRequestId: string,
    url: string,
    init: RequestInit,
    authenticate = false,
    timeoutMs = 10000
  ): Promise<Json> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
      throw new Error('NATIVE_HTTP_TIMEOUT_INVALID')
    const payload = JSON.stringify({ url, method: init.method, body: init.body ?? null }),
      digest = createHash('sha256').update(payload).digest('hex'),
      id = 'http:' + randomUUID()
    const spec = {
        ...this.launch.spec,
        id,
        idempotencyKey: id,
        kind,
        nativeRequestId,
        payloadDigest: digest
      },
      planned = this.kernel.actions.planAction(spec),
      borrow = this.kernel.host.borrowSessionResources(planned.ref, this.launch.actionRef)
    if (borrow.kind === 'denial') throw new Error(borrow.code)
    const sent = this.kernel.host.beginDispatch(planned.ref)
    if (sent.kind === 'denial') throw new Error(sent.code)
    const reserved = this.kernel.host.reserveNativeExchange(sent.actionRef, this.launch.actionRef, payload)
    if (reserved.kind === 'denial') throw new Error(reserved.code)
    try {
      const response = await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (authenticate) {
        const cookies = response.headers.getSetCookie()
        this.#cookie = cookies.map((value) => value.split(';')[0]).join('; ')
        await response.body?.cancel()
      }
      if (!response.ok && !(authenticate && response.status >= 300 && response.status < 400 && this.#cookie))
        throw new Error('DSH_NATIVE_HTTP_STATUS:' + response.status)
      const body = authenticate ? { status: response.status } : await boundedJson(response)
      const evidence = this.observe({ kind: 'http-response', nativeRequestId, body })
      this.kernel.host.completeOperation(
        sent.actionRef,
        {
          ownerRef: this.launch.actionRef,
          payloadDigest: digest,
          nativeRequestId,
          responseDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex')
        },
        [evidence]
      )
      return body
    } catch (error) {
      this.kernel.actions.recordActionResult(sent.actionRef, {
        status: 'unknown',
        stopped: false,
        evidenceRefs: [],
        reason: 'HTTP_RESPONSE_UNKNOWN'
      })
      throw error
    }
  }
}
