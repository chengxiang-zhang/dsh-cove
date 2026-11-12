/**
 * HTTP executor transport (T19 addendum).
 *
 * Drives a DSH web host through its `/api` Remote surface:
 *
 * - `session/create` (+ `session/selectModel`) creates the attempt session and pins
 *   its preset and model;
 * - `session/prompt` delivers the brief (and later appended input);
 * - `session/cancel` stops it;
 * - `session/projections` + `session/page` read the durable log without opening the
 *   body: the projection gives the cursor, the page gives the tail events that
 *   closure and the probes consume.
 *
 * Deliberately plain HTTP: every call is a unary POST, so no WebSocket mux client is
 * needed. Live progress comes from polling the page cursor, with the interval backing
 * off while a session is quiet.
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { ExecutorCreateRequest, ExecutorCreateResult, ExecutorEventLike, ExecutorSnapshot, ExecutorTransport } from './types.ts'
import { EndpointError, resolveEndpoint, type ExecutorTransportConfig, type ResolvedEndpoint } from './endpoint.ts'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_POLL_MS = 2_000
const MAX_POLL_MS = 15_000
const DEFAULT_PAGE = 200
const PROBE_TTL_MS = 60_000
/** Reconnect backoff for the push channel; the page poll keeps repairing meanwhile. */
const MUX_RECONNECT_MS = 2_000

/** The stream endpoint of the same host (`http` -> `ws`). */
function muxUrl(baseUrl: string): string {
  const url = new URL('/api/remote.mux', baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/** A transport call that failed; `code` is quoted in the dispatch failure reason. */
export class HttpTransportError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

interface CallOptions {
  timeoutMs: number
  headers: Readonly<Record<string, string>>
}

/** One unary Remote call; resolves the `value` payload or throws `HttpTransportError`. */
function call(endpoint: ResolvedEndpoint, method: string, args: unknown, options: CallOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const target = new URL(`/api/${method}`, endpoint.baseUrl)
    const body = JSON.stringify({ type: 'client-request', rpcId: `sa-x-${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, method, payload: { args } })
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...endpoint.headers, ...options.headers },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode === 403) { reject(new HttpTransportError('HOST_FORBIDDEN', `${target.host} refused the call (Host not trusted)`)); return }
        if (res.statusCode === 401) { reject(new HttpTransportError('HOST_UNAUTHORIZED', `${target.host} requires a session`)); return }
        if (res.statusCode !== undefined && res.statusCode >= 500) { reject(new HttpTransportError('HOST_ERROR', `${target.host} returned ${res.statusCode}`)); return }
        let parsed: unknown
        try { parsed = JSON.parse(text) } catch { reject(new HttpTransportError('HOST_PROTOCOL', `${target.host} returned non-JSON for ${method}`)); return }
        if (typeof parsed !== 'object' || parsed === null) { reject(new HttpTransportError('HOST_PROTOCOL', `empty response for ${method}`)); return }
        const result = (parsed as { result?: { ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } } }).result
        if (result === undefined) { reject(new HttpTransportError('HOST_PROTOCOL', `no result for ${method}`)); return }
        if (result.ok === true) { resolve(result.value); return }
        const code = typeof result.error?.code === 'string' ? result.error.code : 'HOST_ERROR'
        const message = typeof result.error?.message === 'string' ? result.error.message : `call ${method} failed`
        reject(new HttpTransportError(code, message))
      })
    })
    req.setTimeout(options.timeoutMs, () => req.destroy(new HttpTransportError('HOST_TIMEOUT', `call ${method} timed out after ${options.timeoutMs}ms`)))
    req.on('error', error => reject(error instanceof HttpTransportError ? error : new HttpTransportError('HOST_UNREACHABLE', `${target.host}: ${(error as Error).message}`)))
    req.end(body)
  })
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `{ records: [{type:'event', event}, ...] }` -> the raw event list. */
function eventsOf(value: unknown): ExecutorEventLike[] {
  if (!isObject(value) || !Array.isArray(value.records)) return []
  const out: ExecutorEventLike[] = []
  for (const record of value.records) {
    if (!isObject(record)) continue
    const raw = record.type === 'event' ? record.event : record
    if (!isObject(raw) || typeof raw.type !== 'string' || typeof raw.seq !== 'number') continue
    out.push({ type: raw.type, seq: raw.seq, ...(typeof raw.time === 'number' ? { time: raw.time } : {}), data: isObject(raw.data) ? raw.data : {} })
  }
  return out
}

/** One raw wire event, or undefined when the shape is not an event. */
function parseEvent(raw: unknown): ExecutorEventLike | undefined {
  if (!isObject(raw) || typeof raw.type !== 'string' || typeof raw.seq !== 'number') return undefined
  return { type: raw.type, seq: raw.seq, ...(typeof raw.time === 'number' ? { time: raw.time } : {}), data: isObject(raw.data) ? raw.data : {} }
}

/** Running means the last turn started has not ended yet. */
function runningFrom(events: readonly ExecutorEventLike[]): boolean {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

export interface HttpTransportDeps {
  config: ExecutorTransportConfig
  /** The commitment target this transport was opened for, if any. */
  target?: string | null
}

export interface HttpTransport extends ExecutorTransport {
  readonly endpoint: ResolvedEndpoint
}

/**
 * Build the HTTP transport for one target. A transport instance is cheap: it holds
 * only the endpoint, the poll timers and the preset-probe cache.
 */
export function createHttpTransport(deps: HttpTransportDeps): HttpTransport {
  const config = deps.config
  const endpoint = resolveEndpoint(deps.target, config)
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = config.pollMs ?? DEFAULT_POLL_MS
  const pageSize = config.maxEventPage ?? DEFAULT_PAGE
  const probeTtlMs = config.probeTtlMs ?? PROBE_TTL_MS
  const timers = new Set<NodeJS.Timeout>()
  const presetCache = new Map<string, { at: number; presets: string[] }>()

  const callOptions: CallOptions = { timeoutMs, headers: {} }
  const invoke = (method: string, args: unknown): Promise<unknown> => call(endpoint, method, args, callOptions)

  async function presets(): Promise<string[]> {
    const key = endpoint.baseUrl
    const hit = presetCache.get(key)
    if (hit !== undefined && Date.now() - hit.at < probeTtlMs) return hit.presets
    const value = await invoke('agentPresets/list', {})
    const list = isObject(value) && Array.isArray(value.presets)
      ? value.presets.flatMap(item => (isObject(item) && typeof item.id === 'string' ? [item.id] : []))
      : []
    presetCache.set(key, { at: Date.now(), presets: list })
    return list
  }

  async function resolvePreset(preferred: string | undefined): Promise<{ preset: string; degraded?: { asked: string; used: string } }> {
    if (preferred === undefined || preferred === '') return { preset: 'standard' }
    let available: string[]
    try { available = await presets() } catch { return { preset: preferred } }
    if (available.length === 0 || available.includes(preferred)) return { preset: preferred }
    if (available.includes('standard')) return { preset: 'standard', degraded: { asked: preferred, used: 'standard' } }
    throw new HttpTransportError('PRESET_UNAVAILABLE', `host ${endpoint.host ?? endpoint.baseUrl} has no ${preferred} or standard preset`)
  }

  async function create(req: ExecutorCreateRequest): Promise<ExecutorCreateResult> {
    const { preset, degraded } = await resolvePreset(req.preset)
    const value = await invoke('session/create', { request: { sessionId: req.sessionId, cwd: req.cwd, agentPreset: preset } })
    if (!isObject(value) || typeof value.sessionId !== 'string') throw new HttpTransportError('HOST_PROTOCOL', 'session/create returned no session id')
    const agentPreset = typeof value.agentPreset === 'string' ? value.agentPreset : undefined
    if (req.model !== undefined) {
      const selection: Record<string, unknown> = { sessionId: value.sessionId, provider: req.model.provider, model: req.model.model }
      if (req.model.effort !== undefined) selection.reasoningEffort = req.model.effort
      try { await invoke('session/selectModel', { request: selection }) } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new HttpTransportError('MODEL_UNAVAILABLE', `host ${endpoint.host ?? endpoint.baseUrl} rejected the model route: ${reason}`)
      }
    }
    return { sessionId: value.sessionId, ...(agentPreset === undefined ? {} : { agentPreset }), ...(degraded === undefined ? {} : { presetDegraded: degraded }) }
  }

  async function prompt(req: { sessionId: string; requestId: string; text: string; mode: 'queue' | 'steer' }): Promise<void> {
    await invoke('session/prompt', { request: { sessionId: req.sessionId, mode: req.mode, content: [{ type: 'text', text: req.text }], requestId: req.requestId } })
  }

  async function cancel(sessionId: string): Promise<void> {
    await invoke('session/cancel', { request: { sessionId } })
  }

  async function cursorOf(sessionId: string): Promise<{ exists: boolean; cursor: number }> {
    const value = await invoke('session/projections', { request: { sessionId } })
    if (value === null) return { exists: false, cursor: 0 }
    if (!isObject(value)) return { exists: false, cursor: 0 }
    return { exists: true, cursor: typeof value.asOfSeq === 'number' ? value.asOfSeq : 0 }
  }

  async function page(sessionId: string, throughSeq: number, maxMessages: number, beforeSeq?: number): Promise<ExecutorEventLike[]> {
    const request: Record<string, unknown> = { address: { kind: 'session', sessionId }, throughSeq, maxMessages }
    if (beforeSeq !== undefined) request.beforeSeq = beforeSeq
    const value = await invoke('session/page', { request })
    return eventsOf(value)
  }

  async function snapshot(sessionId: string): Promise<ExecutorSnapshot> {
    const { exists, cursor } = await cursorOf(sessionId)
    if (!exists) return { exists: false, running: false, cursor: 0, events: [] }
    const events = cursor === 0 ? [] : await page(sessionId, cursor, pageSize)
    return { exists: true, running: runningFrom(events), cursor, events }
  }

  /**
   * Two channels, one cursor. The mux subscription (`session/follow`) pushes events
   * as the host commits them; the page poll repairs gaps and covers a host whose mux
   * endpoint is unreachable (no WebSocket, older fence, dropped connection). Both
   * deliver through `deliver`, which deduplicates by seq, so a duplicate is harmless.
   */
  function watch(sessionId: string, onEvent: (event: ExecutorEventLike) => void): () => void {
    let stopped = false
    let lastSeq = -1
    let interval = pollMs
    let timer: NodeJS.Timeout | undefined
    let failures = 0
    let socket: WebSocket | undefined
    let muxOpen = false
    let reconnect: NodeJS.Timeout | undefined

    const deliver = (event: ExecutorEventLike): void => {
      if (stopped) return
      if (event.seq <= lastSeq) return
      lastSeq = event.seq
      onEvent(event)
    }

    const openMux = (): void => {
      if (stopped) return
      const streamId = randomUUID()
      let ws: WebSocket
      try {
        // `headers` carries the canonical Host on a peer; the loopback case needs none.
        ws = new WebSocket(muxUrl(endpoint.baseUrl), { headers: endpoint.headers })
      } catch {
        return
      }
      socket = ws
      ws.on('open', () => {
        muxOpen = true
        ws.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow',
          payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: pageSize } } } }))
      })
      ws.on('message', (raw: WebSocket.RawData) => {
        let frame: unknown
        try { frame = JSON.parse(raw.toString()) } catch { return }
        if (!isObject(frame) || frame.streamId !== streamId) return
        const value = frame.value
        if (frame.type === 'item' && isObject(value)) {
          if (value.type === 'snapshot') {
            // Opening window: replay the records that already exist, then start at the cursor.
            if (Array.isArray(value.records)) {
              for (const record of value.records) {
                if (!isObject(record) || record.type !== 'event' || !isObject(record.event)) continue
                const event = parseEvent(record.event)
                if (event !== undefined) deliver(event)
              }
            }
            const cursor = typeof value.cursor === 'number' ? value.cursor : lastSeq
            if (cursor > lastSeq) lastSeq = cursor
            return
          }
          if (value.type === 'event' && isObject(value.event)) {
            const event = parseEvent(value.event)
            if (event !== undefined) deliver(event)
          }
          return
        }
        if (frame.type === 'end') ws.close()
        if (frame.type === 'error') ws.close()
      })
      ws.on('error', () => { muxOpen = false; try { ws.close() } catch { /* already closed */ } })
      ws.on('close', () => {
        muxOpen = false
        if (socket === ws) socket = undefined
        if (!stopped) {
          reconnect = setTimeout(openMux, MUX_RECONNECT_MS)
          timers.add(reconnect)
        }
      })
    }

    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const { exists, cursor } = await cursorOf(sessionId)
        if (!exists) { failures += 1 } else {
          if (lastSeq < 0) lastSeq = Math.max(0, cursor - pageSize)
          if (cursor > lastSeq) {
            const events = await page(sessionId, cursor, pageSize, lastSeq + 1)
            for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
              if (stopped) return
              if (event.seq <= lastSeq) continue
              deliver(event)
            }
            lastSeq = Math.max(lastSeq, cursor)
            interval = pollMs
          } else {
            interval = Math.min(MAX_POLL_MS, Math.max(pollMs, interval * 2))
          }
          failures = 0
        }
      } catch {
        failures += 1
      }
      if (failures >= 5) interval = MAX_POLL_MS
      if (stopped) return
      // With the push channel open, polling only repairs gaps: keep it slow.
      timer = setTimeout(() => { void tick() }, muxOpen ? Math.max(pollMs * 5, 10_000) : interval)
      timers.add(timer)
    }

    const stop = (): void => {
      stopped = true
      if (timer !== undefined) { clearTimeout(timer); timers.delete(timer); timer = undefined }
      if (reconnect !== undefined) { clearTimeout(reconnect); timers.delete(reconnect); reconnect = undefined }
      socket?.close()
      socket = undefined
    }

    openMux()
    void tick()
    return stop
  }

  return {
    kind: 'http',
    endpoint,
    create,
    prompt,
    cancel,
    snapshot,
    watch,
    dispose() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
  }
}

/** Re-exported so callers can name the refusal without importing `endpoint.ts`. */
export { EndpointError }