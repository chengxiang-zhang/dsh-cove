import type { Json, Ref } from '../../protocol/managed-work.ts'
import type { ExecutionEnvelope, ActionReceipt } from '../../kernel/actions.ts'
import type {
  NativeExecutor,
  SessionIdentity,
  SessionBinding,
  InputRecord,
  InputReceipt,
  NativeEventPage,
  RequestResponse
} from '../native/adapter.ts'
import { bindingKey, encodeInput, consumptionProof } from '../native/bindings.ts'
import { ControlledJsonl, type RpcMessage } from '../native/jsonl.ts'
import { NativeRequests, type ExecutorRequest } from '../native/requests.ts'
const disabled = [
  'shell_tool',
  'code_mode_host',
  'apps',
  'plugins',
  'remote_plugin',
  'multi_agent',
  'browser_use',
  'computer_use',
  'in_app_browser'
]
/** Use a fresh, host-provisioned CODEX_HOME. No inherited plugins, MCP configuration, or shell environment. */
export function isolatedCodexArgs(): string[] {
  return [
    ...disabled.flatMap((name) => ['--disable', name]),
    '-c',
    'features.code_mode={enabled=false,direct_only_tool_namespaces=["managed"]}',
    '-c',
    'web_search="disabled"',
    '-c',
    'check_for_update_on_startup=false',
    'app-server',
    '--stdio'
  ]
}
export function assertCodexInventory(config: any, status: any): void {
  if (disabled.slice(0, 6).some((name) => config?.config?.features?.[name] !== false))
    throw new Error('CODEX_TOOL_ISOLATION_UNPROVEN')
  if (!Array.isArray(status?.data) || status.nextCursor) throw new Error('CODEX_INVENTORY_INCOMPLETE')
  if (status.data.some((server: any) => !server.tools || Object.keys(server.tools).length))
    throw new Error('CODEX_EXTERNAL_TOOLS_PRESENT')
}
export interface NativeTurn {
  id: string
  status: string
  startedAt?: number | null
  items: { type: string; content?: { type: string; text?: string }[]; text?: string; id?: string }[]
  itemsView?: string
}
export interface CodexOptions {
  hostRef: string
  engineRef: string
  runtimeNamespace: string
  cwd: string
  nativeSessionId?: string
  dynamicTools?: Json[]
  instructions: string
  outputSchema?: Json
}
/** Protocol details are confined to this adapter; facts never imply business completion. */
export class CodexNativeExecutor implements NativeExecutor {
  readonly identity: SessionIdentity
  readonly binding: SessionBinding
  readonly requests: NativeRequests
  #turnStarts = new Map<string, string>()
  #turns: NativeTurn[] = []
  #consumptionFacts = new Set<string>()
  #pageFacts = new Map<string, string>()
  #activeTurn?: string
  #listeners = new Set<(request: ExecutorRequest) => void>()
  #inputs = new Map<string, { input: InputRecord; turnId?: string; status: 'accepted' | 'unknown' }>()
  private constructor(
    readonly io: ControlledJsonl,
    readonly options: CodexOptions,
    threadId: string
  ) {
    this.identity = {
      host_ref: options.hostRef,
      engine_ref: options.engineRef,
      runtime_namespace: options.runtimeNamespace,
      native_session_id: threadId
    }
    this.binding = {
      ref: { id: bindingKey(this.identity), revision: io.launch.epoch },
      identity: this.identity,
      epoch: io.launch.epoch,
      launchRef: io.launch.actionRef,
      source: 'codex-app-server',
      control_version: io.launch.epoch
    }
    const facts = io.kernel.host.nativeFacts(io.stream)
    const restored = new Map<string, ExecutorRequest>()
    for (const fact of facts) {
      const v = fact.observation as any
      if (v.kind === 'request') restored.set(v.request.ref.id, v.request)
      if (v.kind === 'input-intent' && v.binding === this.binding.ref.id)
        this.#inputs.set(v.input.request_id, { input: v.input, status: 'unknown' })
      if (v.kind === 'rpc' && v.message.method === 'turn/started' && v.message.params?.threadId === threadId)
        this.#turnStarts.set(v.message.params.turn.id, fact.ref)
    }
    this.requests = new NativeRequests(
      io.generation,
      (request) => io.observe({ kind: 'request', request: request as unknown as Json }),
      [...restored.values()]
    )
    this.requests.restart(io.generation)
    io.onMessage((message, ref) => this.observe(message, ref))
    io.observe({ kind: 'binding', binding: this.binding as unknown as Json })
  }
  static async connect(io: ControlledJsonl, options: CodexOptions): Promise<CodexNativeExecutor> {
    await io.call(
      'initialize',
      { clientInfo: { name: 'superagent-native', version: '0.1' }, capabilities: { experimentalApi: true } },
      'attach'
    )
    await io.notify('initialized')
    const config = await io.call('config/read', { cwd: options.cwd, includeLayers: false }),
      status = await io.call('mcpServerStatus/list', {})
    assertCodexInventory(config, status)
    const common = {
      cwd: options.cwd,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      baseInstructions: options.instructions,
      config: Object.fromEntries(disabled.map((name) => ['features.' + name, false]))
    }
    const result = (await io.call(
      options.nativeSessionId ? 'thread/resume' : 'thread/start',
      options.nativeSessionId
        ? { ...common, threadId: options.nativeSessionId, excludeTurns: true }
        : {
            ...common,
            ephemeral: false,
            experimentalRawEvents: true,
            dynamicTools: options.dynamicTools?.length
              ? [
                  {
                    type: 'namespace',
                    name: 'managed',
                    description: 'Host-controlled candidate file operations and technical questions.',
                    tools: options.dynamicTools
                  }
                ]
              : []
          },
      'attach'
    )) as any
    const threadId = result?.thread?.id
    if (
      typeof threadId !== 'string' ||
      !threadId ||
      (options.nativeSessionId && threadId !== options.nativeSessionId)
    )
      throw new Error('NATIVE_THREAD_IDENTITY_CHANGED')
    return new CodexNativeExecutor(io, options, threadId)
  }
  attachNative(identity: SessionIdentity, envelope: ExecutionEnvelope): SessionBinding {
    if (
      bindingKey(identity) !== this.binding.ref.id ||
      envelope.actionRef.id !== this.binding.launchRef.id ||
      envelope.epoch !== this.binding.epoch
    )
      throw new Error('BINDING_IDENTITY_MISMATCH')
    this.fence()
    return structuredClone(this.binding)
  }
  onRequest(listener: (request: ExecutorRequest) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  async execute(input: InputRecord, signal: AbortSignal): Promise<InputReceipt> {
    if (signal.aborted) return { request_id: input.request_id, status: 'rejected' }
    const abort = () => {
      void this.cancel().catch(() => {})
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      return await this.sendNativeInput(this.binding.ref, input)
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
  async sendNativeInput(binding: Ref, input: InputRecord): Promise<InputReceipt> {
    this.assertBinding(binding)
    const text = encodeInput(input),
      old = this.#inputs.get(input.request_id)
    if (old) {
      if (encodeInput(old.input) !== text) throw new Error('INPUT_IDEMPOTENCY_CONFLICT')
      return this.receiptFor(input)
    }
    if (input.mode === 'steer' && !input.expectedTurnId) throw new Error('EXPECTED_TURN_REQUIRED')
    this.#inputs.set(input.request_id, { input: structuredClone(input), status: 'unknown' })
    this.io.observe({ kind: 'input-intent', binding: binding.id, input: input as unknown as Json })
    try {
      const parameters: Record<string, Json> = {
        threadId: this.identity.native_session_id,
        input: [{ type: 'text', text }],
        clientUserMessageId: input.request_id
      }
      if (input.mode === 'steer') parameters.expectedTurnId = input.expectedTurnId!
      else if (this.options.outputSchema) parameters.outputSchema = this.options.outputSchema
      const result = (await this.io.call(
        input.mode === 'steer' ? 'turn/steer' : 'turn/start',
        parameters,
        input.mode === 'steer' ? 'steer' : 'send_input',
        10000
      )) as any
      const turnId = result?.turn?.id ?? result?.turnId ?? input.expectedTurnId
      this.#inputs.set(input.request_id, {
        input: structuredClone(input),
        status: 'accepted',
        ...(turnId ? { turnId } : {})
      })
      this.io.observe({
        kind: 'input-accepted',
        binding: binding.id,
        requestId: input.request_id,
        turnId: turnId ?? null
      })
      return await this.receiptFor(input)
    } catch {
      return { request_id: input.request_id, status: 'unknown' }
    }
  }
  async receiptFor(input: InputRecord): Promise<InputReceipt> {
    await this.refreshTurns()
    for (const turn of this.#turns) {
      const user = turn.items.find(
        (item) =>
          item.type === 'userMessage' &&
          item.content?.some((c) => c.type === 'text' && c.text === encodeInput(input))
      )
      const text = user?.content?.find((c) => c.type === 'text' && c.text === encodeInput(input))?.text
      const proof = consumptionProof(this.identity, input, turn.id, text, this.#turnStarts.get(turn.id))
      if (proof) {
        const key = JSON.stringify(proof)
        if (!this.#consumptionFacts.has(key)) { this.io.observe({ kind: 'input-consumed', consumption: proof as unknown as Json }); this.#consumptionFacts.add(key) }
        return { request_id: input.request_id, status: 'consumed', consumption: proof }
      }
    }
    return { request_id: input.request_id, status: this.#inputs.get(input.request_id)?.status ?? 'unknown' }
  }
  async listNativeRequests(binding: Ref): Promise<ExecutorRequest[]> {
    this.assertBinding(binding)
    return this.requests.list()
  }
  async respondNativeRequest(
    request: Ref,
    response: RequestResponse,
    envelope: ExecutionEnvelope
  ): Promise<ActionReceipt> {
    this.fence()
    if (envelope.epoch !== this.binding.epoch || envelope.target.id !== this.io.launch.target.id)
      throw new Error('RESPONSE_CONTROL_MISMATCH')
    const pending = this.requests.beginResponse(request, this.binding.epoch, Date.now())
    if (pending.threadId !== this.identity.native_session_id) throw new Error('REQUEST_THREAD_MISMATCH')
    try {
      await this.io.respond(JSON.parse(pending.nativeId), response)
      this.requests.responseUnknown(pending.nativeId, 'response-written-without-native-ack')
    } catch (error) {
      this.requests.responseUnknown(pending.nativeId, 'response-write-unknown')
      throw error
    }
    return { status: 'unknown', stopped: false, evidenceRefs: [], reason: 'NATIVE_RESPONSE_ACK_UNAVAILABLE' }
  }
  async collectNativeEvents(binding: Ref, cursor?: string): Promise<NativeEventPage> {
    this.assertBinding(binding)
    const complete = await this.refreshTurns(),
      facts = this.io.kernel.host.nativeFacts(this.io.stream),
      index = cursor ? facts.findIndex((f) => f.ref === cursor) : -1
    if (cursor && index < 0)
      return {
        binding,
        source: 'codex-app-server',
        runtime_namespace: this.identity.runtime_namespace,
        control_version: this.binding.control_version,
        events: [],
        completeness: 'gap'
      }
    const events = facts.slice(index + 1).map((f) => ({
      ref: f.ref,
      identity: this.identity,
      cursor: f.ref,
      source: 'codex-app-server',
      kind: String((f.observation as any).kind),
      payload: f.observation
    }))
    return {
      binding,
      source: 'codex-app-server',
      runtime_namespace: this.identity.runtime_namespace,
      control_version: this.binding.control_version,
      events,
      completeness: complete ? 'complete' : 'gap',
      ...(facts.length ? { cursor: facts.at(-1)!.ref } : {})
    }
  }
  async cancel(): Promise<ActionReceipt> {
    this.fence()
    if (this.#activeTurn)
      await this.io.call(
        'turn/interrupt',
        { threadId: this.identity.native_session_id, turnId: this.#activeTurn },
        'cancel'
      )
    return { status: 'unknown', stopped: false, evidenceRefs: [], reason: 'INTERRUPT_NOT_PROCESS_CESSATION' }
  }
  turns(): NativeTurn[] {
    return structuredClone(this.#turns)
  }
  private async refreshTurns(): Promise<boolean> {
    const turns: NativeTurn[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let pages = 0; pages < 100; pages++) {
      const result = (await this.io.call(
        'thread/turns/list',
        {
          threadId: this.identity.native_session_id,
          // Full turns include material text; aggregate history must fit the unchanged 1 MiB frame fence.
          limit: 1,
          itemsView: 'full',
          sortDirection: 'asc',
          ...(cursor ? { cursor } : {})
        },
        'collect'
      )) as any
      if (!Array.isArray(result?.data)) throw new Error('NATIVE_HISTORY_INVALID')
      const pageKey = JSON.stringify(result)
      let evidence = this.#pageFacts.get(pageKey)
      if (!evidence) { evidence = this.io.observe({ kind: 'turn-page', threadId: this.identity.native_session_id, page: result }); this.#pageFacts.set(pageKey, evidence) }
      for (const turn of result.data as NativeTurn[]) {
        if (turn.itemsView && turn.itemsView !== 'full') throw new Error('NATIVE_ITEMS_INCOMPLETE')
        turns.push(turn)
        if (typeof turn.startedAt === 'number' && !this.#turnStarts.has(turn.id)) this.#turnStarts.set(turn.id, evidence)
        if (turn.status === 'inProgress') this.#activeTurn = turn.id
      }
      if (!result.nextCursor) {
        this.#turns = turns
        return true
      }
      cursor = result.nextCursor
      if (seen.has(cursor!)) break
      seen.add(cursor!)
    }
    this.#turns = turns
    return false
  }
  private observe(message: RpcMessage, ref: string): void {
    const p = message.params as any
    if (p?.threadId !== this.identity.native_session_id) return
    if (message.method === 'turn/started') {
      this.#activeTurn = p.turn.id
      this.#turnStarts.set(p.turn.id, ref)
    }
    if (message.method === 'turn/completed' && this.#activeTurn === p.turn?.id) this.#activeTurn = undefined
    if (message.id !== undefined && message.method) {
      const request = this.requests.observe({
        id: JSON.stringify(message.id),
        method: message.method,
        params: message.params ?? {},
        threadId: p.threadId,
        turnId: p.turnId ?? '',
        epoch: this.binding.epoch,
        expiresAt: this.io.launch.expiresAt
      })
      for (const listener of this.#listeners) listener(request)
    }
    if (message.method === 'serverRequest/resolved' && p.requestId !== undefined) {
      const id = JSON.stringify(p.requestId)
      if (this.requests.snapshot().some((r) => r.nativeId === id)) this.requests.clear(id, 'native-resolved')
    }
  }
  private fence(): void {
    const e = this.io.kernel.host.fenceDispatch(this.io.launch.actionRef)
    if (e.kind === 'denial') throw new Error(e.code)
  }
  private assertBinding(binding: Ref): void {
    if (binding.id !== this.binding.ref.id || binding.revision !== this.binding.ref.revision)
      throw new Error('BINDING_STALE')
    this.fence()
  }
}

/** Deployment observations, not an admission token. Each launch still requires host qualification. */
export const codexCapabilities: import('../native/adapter.ts').EngineCapabilities = {
  deployment_version: '0.167.0-alpha.3.2',
  evidence_refs: [
    'p3-probes/codex-controlled-handshake.json',
    'p3-probes/codex-controlled-qualification.json',
    'p3-probes/codex-controlled-dynamic.json',
    'p3-probes/codex-resume.json',
    'p3-probes/codex-controlled-secretary.json',
    'p3-probes/codex-controlled-steer.json'
  ],
  supported: [
    'native-thread-create',
    'native-thread-resume',
    'input-consumption-proof',
    'controlled-read-write-check-ask',
    'same-thread-rework',
    'active-turn-steer',
    'structured-coordinator-proposals',
    'single-process-cessation'
  ],
  gaps: [
    {
      capability: 'arbitrary-shell-build',
      owner: 'executors/native/tools',
      reason: 'Only fixed candidate file helpers are qualified; shell and code evaluation remain disabled.'
    },
    {
      capability: 'children-cessation',
      owner: 'kernel/sandbox-process',
      reason: 'Process-group exit cannot establish cessation of detached descendants.'
    },
    {
      capability: 'hot-session-migration',
      owner: 'plugins/lifecycle',
      reason: 'P6 must establish a safe point before replacing a live adapter.'
    }
  ]
}
