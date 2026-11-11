import { readFileSync, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ManagedLedger } from '../../kernel/managed-ledger.ts'
import { createControlledKernel, type ExecutionEnvelope } from '../../kernel/actions.ts'
import { assertJson, assertRefs, type Ref, type Json } from '../../protocol/managed-work.ts'
import { ControlledFileTools, nativeFileToolSchemas } from '../native/tools.ts'
export interface DshNativeHostConfig {
  bootstrapFile: string
}
interface Bootstrap {
  ledgerPath: string
  sourceRef: Ref
  nodeExecutable: string
  runtimeNamespace: string
  bindings: { sessionId: string; launchRef: Ref; role: 'worker' | 'coordinator' }[]
}
/** Called only by the existing web-all composition root. No second runtime row or route. */
export function registerDshNativeRoles(ctx: Context, config?: DshNativeHostConfig): () => Promise<void> {
  if (!config) return async () => {}
  const raw = JSON.parse(readFileSync(config.bootstrapFile, 'utf8')) as Bootstrap
  assertJson(raw)
  assertRefs([raw.sourceRef, ...raw.bindings.map((b) => b.launchRef)])
  if (
    statSync(config.bootstrapFile).mode & 0o022 ||
    !raw.ledgerPath.startsWith('/') ||
    !raw.nodeExecutable.startsWith('/') ||
    !raw.runtimeNamespace.trim() ||
    raw.bindings.some((b) => !b.sessionId.trim() || !['worker', 'coordinator'].includes(b.role)) ||
    new Set(raw.bindings.map((b) => b.sessionId)).size !== raw.bindings.length
  )
    throw new Error('INVALID_DSH_NATIVE_BOOTSTRAP')
  const ledger = new ManagedLedger(raw.ledgerPath),
    kernel = createControlledKernel(ledger, raw.sourceRef),
    disposers: (() => void)[] = [],
    attached = new WeakSet<object>()
  let retired = false
  const retiring = new AbortController()
  const calls = new Set<Promise<unknown>>()
  const off = ctx.on(
    'agent/created' as never,
    ((payload: any) => {
      const agent = payload.agent,
        sessionId = agent?.session?.id,
        binding = raw.bindings.find((b) => b.sessionId === sessionId)
      if (!binding || attached.has(agent)) return
      const tools = agent?.ctx?.tools
      if (
        !tools ||
        typeof tools.restrict !== 'function' ||
        typeof tools.guard !== 'function' ||
        typeof tools.register !== 'function'
      )
        throw new Error('DSH_NATIVE_SCOPE_UNAVAILABLE')
      attached.add(agent)
      // The agent owns these fences. Keep them installed when the web-all owner retires.
      tools.restrict({ allow: [] })
      const allowed = binding.role === 'worker' ? ['read', 'write', 'check', 'ask'] : []
      const fence = () => kernel.host.fenceDispatch(binding.launchRef)
      tools.guard((execution: { name: string }) => {
        if (retired) return 'MANAGED_NATIVE_RETIRED'
        if (!allowed.includes(execution.name)) return 'MANAGED_NATIVE_TOOL_DENIED'
        return fence().kind === 'denial' ? 'MANAGED_NATIVE_CONTROL_FENCED' : undefined
      })
      const envelope = fence()
      if (envelope.kind === 'denial') throw new Error(envelope.code)
      const stream = 'dsh:' + raw.runtimeNamespace + ':' + sessionId
      for (const schema of nativeFileToolSchemas as any[]) {
        if (!allowed.includes(schema.name)) continue
        const parameters = Object.fromEntries(
          Object.entries(schema.inputSchema.properties).map(([key, property]) => [
            key,
            { ...(property as object), required: schema.inputSchema.required.includes(key) }
          ])
        )
        const tool = defineTool({
          name: schema.name,
          description: schema.description,
          parameters,
          output: {
            schema: { type: 'json' },
            render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }]
          },
          execute: (args: any, execution: any) => {
            const run = (async () => {
              const current = fence()
              if (current.kind === 'denial') return { success: false, text: current.code }
              const requestId =
                'dsh-request:' +
                raw.runtimeNamespace +
                ':' +
                sessionId +
                ':' +
                binding.launchRef.id +
                ':' +
                execution.callId
              kernel.host.observeNative(binding.launchRef, stream, {
                kind: 'native-tool-request',
                requestId,
                sessionId,
                callId: execution.callId,
                tool: schema.name,
                args,
                epoch: envelope.epoch
              })
              let result: { success: boolean; text: string }
              result = await waitForNativeResponse(
                kernel,
                envelope,
                stream,
                requestId,
                AbortSignal.any([execution.signal, retiring.signal])
              )
              kernel.host.observeNative(binding.launchRef, stream, {
                kind: 'native-tool-result',
                epoch: envelope.epoch,
                requestId,
                sessionId,
                callId: execution.callId,
                result
              })
              return result
            })()
            calls.add(run)
            void run.finally(() => calls.delete(run)).catch(() => {})
            return run
          }
        } as any)
        disposers.push(tools.register(tool))
      }
      const visible = tools.schemas(agent).map((s: { name: string }) => s.name)
      kernel.host.observeNative(binding.launchRef, stream, {
        kind: 'native-tool-inventory',
        sessionId,
        role: binding.role,
        visible
      })
      if (visible.some((name: string) => !allowed.includes(name)))
        throw new Error('DSH_NATIVE_TOOL_INVENTORY_LEAK')
    }) as never
  ) as () => void
  return async () => {
    retired = true
    retiring.abort()
    off()
    for (const dispose of disposers.reverse()) dispose()
    await Promise.allSettled([...calls])
    ledger.close()
  }
}
async function waitForNativeResponse(
  kernel: ReturnType<typeof createControlledKernel>,
  envelope: ExecutionEnvelope,
  stream: string,
  requestId: string,
  signal: AbortSignal
): Promise<{ success: boolean; text: string }> {
  while (Date.now() < envelope.expiresAt) {
    if (signal.aborted || kernel.host.fenceDispatch(envelope.actionRef).kind === 'denial')
      return { success: false, text: 'REQUEST_CONTROL_REVOKED' }
    const answer = kernel.host
      .nativeFacts(stream)
      .map((f) => f.observation as any)
      .find(
        (v) => v.kind === 'native-request-response' && v.requestId === requestId && v.epoch === envelope.epoch
      )
    if (answer) {
      const value = answer.result
      if (!value || typeof value.success !== 'boolean' || typeof value.text !== 'string')
        return { success: false, text: 'NATIVE_RESPONSE_INVALID' }
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return { success: false, text: 'REQUEST_EXPIRED' }
}

import { createHash, randomUUID } from 'node:crypto'
import type {
  NativeExecutor,
  SessionIdentity,
  SessionBinding,
  InputRecord,
  InputReceipt,
  InputConsumption,
  NativeEventPage,
  RequestResponse
} from '../native/adapter.ts'
import type { ActionReceipt } from '../../kernel/actions.ts'
import type { ExecutorRequest } from '../native/requests.ts'
import { bindingKey, encodeInput, consumptionProof } from '../native/bindings.ts'
import { ControlledNativeHttp } from '../native/http.ts'
/** DSH-only native API adapter. Existing transport remains a DSH connection layer, not a portable engine claim. */
export class DshNativeExecutor implements NativeExecutor {
  readonly binding: SessionBinding
  #inputs = new Map<string, InputRecord>()
  #accepted = new Set<string>()
  constructor(
    readonly io: ControlledNativeHttp,
    readonly identity: SessionIdentity
  ) {
    this.binding = {
      ref: { id: bindingKey(identity), revision: io.launch.epoch },
      identity,
      epoch: io.launch.epoch,
      launchRef: io.launch.actionRef,
      source: 'dsh-session-api',
      control_version: io.launch.epoch
    }
    for (const f of io.kernel.host.nativeFacts(io.stream)) {
      const o = f.observation as any
      if (o.kind === 'input-intent' && o.binding === this.binding.ref.id)
        this.#inputs.set(o.input.request_id, o.input)
      if (o.kind === 'input-accepted' && o.binding === this.binding.ref.id) this.#accepted.add(o.requestId)
    }
    io.observe({ kind: 'binding', binding: this.binding as unknown as Json })
  }
  static async connect(
    io: ControlledNativeHttp,
    identity: SessionIdentity,
    options: { create: boolean; cwd: string; preset: string; provider: string; model: string }
  ): Promise<DshNativeExecutor> {
    if (options.create) {
      const result = await io.call(
        'session/create',
        { request: { sessionId: identity.native_session_id, cwd: options.cwd, agentPreset: options.preset } },
        'attach'
      )
      if (
        result?.sessionId !== identity.native_session_id ||
        (result.agentPreset && result.agentPreset !== options.preset)
      )
        throw new Error('DSH_NATIVE_IDENTITY_CHANGED')
    } else {
      const existing = await io.call(
        'session/projections',
        { request: { sessionId: identity.native_session_id } },
        'attach'
      )
      if (!existing || !existing.asOfSeq) throw new Error('DSH_NATIVE_SESSION_MISSING')
    }
    // Never call create(existingSid) for recovery: filled sessions get a new id in DSH.
    await io.call(
      'session/selectModel',
      {
        request: { sessionId: identity.native_session_id, provider: options.provider, model: options.model }
      },
      'attach'
    )
    return new DshNativeExecutor(io, identity)
  }
  attachNative(identity: SessionIdentity, envelope: ExecutionEnvelope): SessionBinding {
    if (
      bindingKey(identity) !== this.binding.ref.id ||
      envelope.actionRef.id !== this.binding.launchRef.id ||
      envelope.epoch !== this.binding.epoch
    )
      throw new Error('BINDING_IDENTITY_MISMATCH')
    this.fence(this.binding.ref)
    return structuredClone(this.binding)
  }
  async execute(input: InputRecord, signal: AbortSignal): Promise<InputReceipt> {
    if (signal.aborted) return { request_id: input.request_id, status: 'rejected' }
    const cancel = () => {
      void this.cancel().catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await this.sendNativeInput(this.binding.ref, input)
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
  async sendNativeInput(binding: Ref, input: InputRecord): Promise<InputReceipt> {
    this.fence(binding)
    const encoded = encodeInput(input),
      old = this.#inputs.get(input.request_id)
    if (old) {
      if (encodeInput(old) !== encoded) throw new Error('INPUT_IDEMPOTENCY_CONFLICT')
      return this.receiptFor(input)
    }
    this.io.observe({ kind: 'input-intent', binding: binding.id, input: input as unknown as Json })
    this.#inputs.set(input.request_id, structuredClone(input))
    try {
      await this.io.call(
        'session/prompt',
        {
          request: {
            sessionId: this.identity.native_session_id,
            requestId: input.request_id,
            mode: input.mode ?? 'queue',
            content: [{ type: 'text', text: encoded }]
          }
        },
        input.mode === 'steer' ? 'steer' : 'send_input'
      )
      this.io.observe({ kind: 'input-accepted', binding: binding.id, requestId: input.request_id })
      this.#accepted.add(input.request_id)
      return await this.receiptFor(input)
    } catch {
      return { request_id: input.request_id, status: 'unknown' }
    }
  }
  async receiptFor(input: InputRecord): Promise<InputReceipt> {
    this.fence(this.binding.ref)
    const text = encodeInput(input)
    const previous = this.persistedConsumption(input)
    if (previous) return { request_id: input.request_id, status: 'consumed', consumption: previous }

    const page = await this.collectNativeEvents(this.binding.ref)
    const events = page.events.map((e) => e.payload as any)
    const user = events.find(
      (e) =>
        e.type === 'user/message' &&
        e.data?.source?.rpcId === input.request_id &&
        e.data?.content?.some((c: any) => c.type === 'text' && c.text === text)
    )
    // The reader admits only contiguous pages. The nearest preceding start therefore
    // belongs to this actual user record, even when older unrelated history has a gap.
    const start = user
      ? [...events].reverse().find((e) => e.type === 'turn/start' && e.seq < user.seq)
      : undefined
    const proof = consumptionProof(
      this.identity,
      input,
      String(start?.data?.turn ?? ''),
      user?.data?.content?.find((c: any) => c.text === text)?.text,
      start ? 'dsh-native:' + this.binding.ref.id + ':' + start.seq : undefined
    )
    if (proof) {
      this.io.observe({
        kind: 'input-consumed',
        binding: this.binding.ref as unknown as Json,
        consumption: proof as unknown as Json
      })
      return { request_id: input.request_id, status: 'consumed', consumption: proof }
    }
    const intended = this.#inputs.get(input.request_id)
    return {
      request_id: input.request_id,
      status:
        intended && encodeInput(intended) === text && this.#accepted.has(input.request_id)
          ? 'accepted'
          : 'unknown'
    }
  }
  private persistedConsumption(input: InputRecord): InputConsumption | undefined {
    for (const fact of this.io.kernel.host.nativeFacts(this.io.stream)) {
      const observation = fact.observation as any
      const proof = observation?.consumption
      if (
        observation?.kind !== 'input-consumed' ||
        !proof ||
        proof.request_id !== input.request_id ||
        proof.assignment_revision !== input.assignment_revision ||
        proof.payload_digest !== input.payload_digest ||
        typeof proof.turn_id !== 'string' ||
        !proof.turn_id ||
        typeof proof.processing_started_event_ref !== 'string'
      )
        continue
      // A previous epoch may have proved this historical input. Reuse that fact only
      // for the same complete native identity, never as authority for a new action.
      try {
        if (
          bindingKey(proof.session_identity) !== this.binding.ref.id ||
          (observation.binding && observation.binding.id !== this.binding.ref.id) ||
          !proof.processing_started_event_ref.startsWith('dsh-native:' + this.binding.ref.id + ':')
        )
          continue
      } catch {
        continue
      }
      return structuredClone(proof) as InputConsumption
    }
    return undefined
  }
  async collectNativeEvents(binding: Ref, cursor?: string): Promise<NativeEventPage> {
    this.fence(binding)
    const after = cursor === undefined ? -1 : Number(cursor)
    if (!Number.isSafeInteger(after) || after < -1) throw new Error('DSH_NATIVE_CURSOR_INVALID')
    const deadline = Date.now() + 10000
    let through = after
    let complete = false
    const records: { seq: number; type: string; [key: string]: any }[] = []
    let bytes = 0
    try {
      const projection = await this.io.call(
        'session/projections',
        { request: { sessionId: this.identity.native_session_id } },
        'collect',
        remainingHistoryTime(deadline)
      )
      through = projection?.asOfSeq
      if (!Number.isSafeInteger(through) || through < -1 || after > through)
        throw new Error('DSH_NATIVE_CURSOR_INVALID')
      let before = through + 1
      complete = after === through
      for (let pageNumber = 0; !complete && pageNumber < 32; pageNumber++) {
        const page = await this.io.call(
          'session/page',
          {
            request: {
              address: { kind: 'session', sessionId: this.identity.native_session_id },
              throughSeq: through,
              maxMessages: 100,
              ...(pageNumber === 0 ? {} : { beforeSeq: before })
            }
          },
          'collect',
          remainingHistoryTime(deadline)
        )
        bytes += Buffer.byteLength(JSON.stringify(page), 'utf8')
        if (
          bytes > 8 * 1024 * 1024 ||
          !Array.isArray(page?.records) ||
          typeof page.hasMore !== 'boolean' ||
          records.length + page.records.length > 10000
        )
          break
        const older = contiguousHistoryPage(page.records, before)
        if (!older || older.length === 0) break
        if (older[0]!.seq === 0 && page.hasMore) break
        records.unshift(...older)
        before = older[0]!.seq
        complete = before <= after + 1
        if (!page.hasMore) break
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'DSH_NATIVE_CURSOR_INVALID') throw error
      // Failed reads and exhausted budgets preserve a gap and the caller's old cursor.
    }
    const events = records
      .filter((r) => r.seq > after)
      .map((r) => ({
        ref: 'dsh-native:' + binding.id + ':' + r.seq,
        identity: this.identity,
        cursor: String(r.seq),
        source: 'dsh-session-api',
        kind: r.type,
        payload: r as Json
      }))
    return {
      binding,
      source: 'dsh-session-api',
      runtime_namespace: this.identity.runtime_namespace,
      control_version: this.binding.control_version,
      events,
      cursor: String(complete ? through : after),
      completeness: complete ? 'complete' : 'gap'
    }
  }
  async listNativeRequests(binding: Ref): Promise<ExecutorRequest[]> {
    this.fence(binding)
    const facts = this.io.kernel.host.nativeFacts(this.toolStream()).map((f) => f.observation as any),
      done = new Set(
        facts
          .filter(
            (f) =>
              f.epoch === this.binding.epoch &&
              ['native-tool-result', 'native-request-response', 'native-request-cleared'].includes(f.kind)
          )
          .map((f) => f.requestId)
      )
    return facts
      .filter(
        (f) => f.kind === 'native-tool-request' && f.epoch === this.binding.epoch && !done.has(f.requestId)
      )
      .map((f) => ({
        ref: { id: f.requestId, revision: 1 },
        nativeId: f.callId,
        generation: this.io.launch.actionRef.id,
        method: 'dsh/tool/' + f.tool,
        params: f.args,
        threadId: f.sessionId,
        turnId: '',
        epoch: f.epoch,
        expiresAt: this.io.launch.expiresAt,
        state: 'pending'
      }))
  }
  async respondNativeRequest(
    request: Ref,
    response: RequestResponse,
    envelope: ExecutionEnvelope
  ): Promise<ActionReceipt> {
    this.fence(this.binding.ref)
    if (
      envelope.actionRef.id !== this.binding.launchRef.id ||
      envelope.actionRef.revision !== this.binding.launchRef.revision ||
      envelope.epoch !== this.binding.epoch
    )
      throw new Error('RESPONSE_CONTROL_MISMATCH')
    const pending = (await this.listNativeRequests(this.binding.ref)).find(
      (r) => r.ref.id === request.id && r.ref.revision === request.revision
    )
    if (!pending) throw new Error('REQUEST_UNKNOWN')
    if (envelope.epoch !== pending.epoch || Date.now() >= pending.expiresAt)
      throw new Error('REQUEST_EXPIRED')
    const claimKey =
      'response:' + JSON.stringify([this.binding.ref.id, pending.ref.id, pending.ref.revision, pending.epoch])
    if (!this.io.kernel.host.claimNativeRequest(this.io.launch.actionRef, claimKey))
      throw new Error('REQUEST_RESPONSE_ALREADY_CLAIMED')
    // The durable claim precedes every response Action/fact. Lost outcomes are not
    // replayed; even an identical payload must be reconciled from the original fact.
    const id = 'dsh-response:' + randomUUID(),
      payload = JSON.stringify(response),
      digest = createHash('sha256').update(payload).digest('hex'),
      k = this.io.kernel
    const action = k.actions.planAction({
      ...this.io.launch.spec,
      id,
      idempotencyKey: id,
      kind: 'respond_request',
      payloadDigest: digest,
      nativeRequestId: request.id
    })
    const borrowed = k.host.borrowSessionResources(action.ref, this.io.launch.actionRef)
    if (borrowed.kind === 'denial') throw new Error(borrowed.code)
    const sent = k.host.beginDispatch(action.ref)
    if (sent.kind === 'denial') throw new Error(sent.code)
    const reserved = k.host.reserveNativeExchange(sent.actionRef, this.io.launch.actionRef, payload)
    if (reserved.kind === 'denial') throw new Error(reserved.code)
    const evidence = k.host.observeNative(this.io.launch.actionRef, this.toolStream(), {
      kind: 'native-request-response',
      requestId: request.id,
      epoch: pending.epoch,
      responseActionRef: sent.actionRef as unknown as Json,
      result: response.error ? { success: false, text: response.error.message } : (response.result ?? null)
    }).nativeRef
    const receipt: ActionReceipt = {
      status: 'unknown',
      stopped: false,
      evidenceRefs: [evidence],
      reason: 'AWAITING_NATIVE_TOOL_RESULT'
    }
    k.actions.recordActionResult(sent.actionRef, receipt)
    return receipt
  }
  serveControlledTools(
    nodeExecutable: string,
    answerQuestion?: (question: string, request: ExecutorRequest) => Promise<string>
  ): () => void {
    const helper = new ControlledFileTools(this.io.kernel, this.io.launch, nodeExecutable)
    const active = new Set<string>()
    let stopped = false
    const poll = async () => {
      if (stopped) return
      const requests = await this.listNativeRequests(this.binding.ref)
      for (const request of requests) {
        if (active.has(request.ref.id)) continue
        active.add(request.ref.id)
        if (!this.io.kernel.host.claimNativeRequest(this.io.launch.actionRef, 'broker:' + request.ref.id))
          continue
        void (async () => {
          const name = request.method.slice('dsh/tool/'.length)
          let result: { success: boolean; text: string }
          if (name === 'ask') {
            if (!answerQuestion) return
            const question = (request.params as { question?: Json }).question
            if (typeof question !== 'string') result = { success: false, text: 'INVALID_TECHNICAL_QUESTION' }
            else result = { success: true, text: await answerQuestion(question, request) }
          } else result = await helper.call(name, request.params, request.ref.id)
          await this.respondNativeRequest(request.ref, { result }, this.io.launch)
        })().catch((error) => {
          this.io.observe({
            kind: 'native-broker-unknown',
            requestId: request.ref.id,
            reason: String(error instanceof Error ? error.message : error)
          })
        })
      }
    }
    const timer = setInterval(() => {
      void poll().catch(() => {
        stopped = true
        clearInterval(timer)
      })
    }, 50)
    void poll().catch(() => {
      stopped = true
      clearInterval(timer)
    })
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }
  async cancel(): Promise<ActionReceipt> {
    this.fence(this.binding.ref)
    await this.io.call(
      'session/cancel',
      { request: { sessionId: this.identity.native_session_id } },
      'cancel'
    )
    return {
      status: 'unknown',
      stopped: false,
      evidenceRefs: [],
      reason: 'SESSION_CANCEL_NOT_PROCESS_CESSATION'
    }
  }
  private toolStream(): string {
    return 'dsh:' + this.identity.runtime_namespace + ':' + this.identity.native_session_id
  }
  private fence(binding: Ref): void {
    if (binding.id !== this.binding.ref.id || binding.revision !== this.binding.ref.revision)
      throw new Error('BINDING_STALE')
    const value = this.io.kernel.host.fenceDispatch(this.io.launch.actionRef)
    if (value.kind === 'denial') throw new Error(value.code)
  }
}

/** Deployment observations, not a substitute for the role guard and the current launch fence. */
export const dshCapabilities: import('../native/adapter.ts').EngineCapabilities = {
  deployment_version: '0.2.1-rc.5',
  evidence_refs: ['p0-probes/dsh-capability-summary.json', 'p3-probes/dsh-controlled-adapter.json'],
  supported: [
    'native-session-create',
    'native-session-attach',
    'input-consumption-proof',
    'controlled-read-write-check-ask',
    'same-thread-rework',
    'role-scoped-tool-guard'
  ],
  gaps: [
    {
      capability: 'children-cessation',
      owner: 'kernel/sandbox-process',
      reason:
        'Revocation remains unknown and keeps the old writable domain locked; P4 must prove isolation for handoff.'
    },
    {
      capability: 'arbitrary-shell-build',
      owner: 'executors/native/tools',
      reason: 'DSH builtins remain denied. Only external P2 fixed helpers are admitted.'
    },
    {
      capability: 'hot-session-migration',
      owner: 'plugins/lifecycle',
      reason:
        'Retired Agent guards remain installed. P6 must stop or isolate the old model before migrating handlers.'
    },
    {
      capability: 'coordinator-runtime',
      owner: 'executors/engines/dsh',
      reason:
        'Empty business-tool role is enforced; a product structured proposal runtime has not been qualified.'
    }
  ]
}

function remainingHistoryTime(deadline: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('DSH_HISTORY_BUDGET_EXHAUSTED')
  return Math.min(10000, remaining)
}

function contiguousHistoryPage(
  records: any[],
  before: number
): { seq: number; type: string; [key: string]: any }[] | undefined {
  if (!records.length) return []
  const events = records.map((record) => (record?.type === 'event' ? record.event : undefined))
  const first = events[0]?.seq
  if (!Number.isSafeInteger(first) || first < 0 || first >= before || first + events.length !== before)
    return undefined
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (!event || event.seq !== first + index || typeof event.type !== 'string') return undefined
  }
  return events
}
