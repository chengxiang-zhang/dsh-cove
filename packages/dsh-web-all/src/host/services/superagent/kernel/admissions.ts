import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InboundEvent } from '../protocol/events.ts'
import type { DeliveryEvaluation } from '../protocol/delivery.ts'

export interface AdmissionRequest {
  requestId: string; project?: string; text: string
  origin: { kind: 'feishu' | 'trusted-host'; chatId?: string; messageId?: string; eventId?: string; event?: InboundEvent }
}
export interface AdmissionRuntime {
  routeMessage(text: string): Promise<{ kind: 'discussion' | 'amendment'; answer: string }>
  amendmentPending(): boolean
  reconcile(): Promise<{ state: 'ready' | 'pending' | 'paused' | 'delivered' | 'unstarted'; reason?: string }>
  start(text: string): Promise<unknown>
  wake(text: string): Promise<unknown>
  amend(text: string): Promise<unknown>
  interrupt(reason: string, origin?: 'owner' | 'lifecycle' | 'amendment'): void
  stopNative(): Promise<unknown>
  dispose(): Promise<unknown>
  deliveryEvaluation(): DeliveryEvaluation
  resultReport(): string | undefined
}
export interface AdmissionRecord {
  request: AdmissionRequest; state: string; runtimeRoot?: string; admittedAt?: number; startedAt?: number
  nextReviewAt?: number; result?: unknown; error?: string; report?: string | null; endedAt?: number
  inputs?: AdmissionRequest[]; consumedInputs?: string[]; continuations?: { id: string; text: string; materialDigest: string }[]
  priorOutcome?: unknown
  messages?: { request: AdmissionRequest; state: 'routing' | 'discussion' | 'amendment'; answer?: string }[]
}
interface AdmissionOptions {
  root: string; projects: string[]; defaultProject: string
  runtime(project: string, root: string): AdmissionRuntime
  materialDigest(project: string): string
  projectsView(): unknown
  onResult(request: AdmissionRequest, result: { state: string; reason?: string; evaluate: () => DeliveryEvaluation }): void
  onNotice?(request: AdmissionRequest, text: string): void
}

/** A durable admission is the wake-up owner. Timers are only rebuildable projections. */
export function createAdmissions(options: AdmissionOptions) {
  const requestsRoot = join(options.root, 'requests')
  mkdirSync(requestsRoot, { recursive: true, mode: 0o700 })
  const runtimes = new Map<string, AdmissionRuntime>(), scheduled = new Set<string>(), timers = new Map<string, ReturnType<typeof setTimeout>>()
  const routing = new Map<string, Promise<void>>()
  let queue = Promise.resolve(), disposed = false
  const key = (id: string) => createHash('sha256').update(id).digest('hex')
  const pathOf = (id: string) => join(requestsRoot, key(id) + '.json')
  const jobRoot = (id: string) => join(options.root, 'jobs', key(id))
  const read = (id: string): AdmissionRecord => JSON.parse(readFileSync(pathOf(id), 'utf8'))
  const persist = (record: AdmissionRecord) => {
    const path = pathOf(record.request.requestId), tmp = path + '.next'
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
    const fd = openSync(tmp, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, path)
    const directory = openSync(requestsRoot, 'r'); try { fsyncSync(directory) } finally { closeSync(directory) }
  }
  const records = () => readdirSync(requestsRoot).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(requestsRoot, n), 'utf8')) as AdmissionRecord)
  const clearTimer = (id: string) => { clearTimeout(timers.get(id)); timers.delete(id) }
  const arm = (record: AdmissionRecord) => {
    const id = record.request.requestId; clearTimer(id)
    if (disposed || !['waiting', 'recovering', 'needs-reconciliation'].includes(record.state) || record.nextReviewAt === undefined) return
    const timer = setTimeout(() => { timers.delete(id); schedule(id) }, Math.max(0, record.nextReviewAt - Date.now()))
    timer.unref?.(); timers.set(id, timer)
  }
  const schedule = (id: string) => {
    if (disposed || scheduled.has(id)) return
    scheduled.add(id); clearTimer(id)
    queue = queue.then(async () => {
      if (disposed) return
      let record = read(id)
      if (!['queued', 'waiting', 'recovering', 'needs-reconciliation'].includes(record.state)) return
      const recovering = ['recovering', 'needs-reconciliation'].includes(record.state)
      let runtime = runtimes.get(id)
      const pending = (record.inputs ?? []).filter(i => !(record.consumedInputs ?? []).includes(i.requestId))
      const initial = record.startedAt === undefined
      record = { ...record, state: 'running', runtimeRoot: record.runtimeRoot ?? jobRoot(id), startedAt: record.startedAt ?? Date.now(), nextReviewAt: undefined }
      persist(record)
      try {
        if (!runtime) { runtime = options.runtime(record.request.project!, record.runtimeRoot!); runtimes.set(id, runtime) }
        if (recovering) {
          const proof = await runtime.reconcile()
          if (proof.state === 'paused') { persist({ ...read(id), state: 'paused', nextReviewAt: undefined }); return }
          if (proof.state === 'pending') { persist({ ...read(id), state: 'needs-reconciliation', error: proof.reason, nextReviewAt: Date.now() + 60000 }); return }
          if (proof.state === 'delivered') {
            const latest = read(id)
            if (latest.state === 'paused') return
            const pending = (latest.inputs ?? []).filter(i => !(latest.consumedInputs ?? []).includes(i.requestId))
            const evaluation = runtime.deliveryEvaluation()
            if (evaluation.verdict !== 'pass') throw Error('RECOVERED_DELIVERY_NOT_VERIFIED')
            persist({ ...read(id), state: pending.length ? 'needs-attention' : 'fulfilled-local', report: runtime.resultReport() ?? null, nextReviewAt: undefined, endedAt: Date.now(), ...(pending.length ? { error: 'Original delivery reconciled; additional input requires a new linked responsibility.' } : {}) })
            if (pending.length) options.onNotice?.(record.request, 'Original delivery reconciled; additional input requires a new linked responsibility.')
            else options.onResult(record.request, { state: 'fulfilled-local', evaluate: runtime.deliveryEvaluation })
            return
          }
          if (proof.state === 'unstarted') record.startedAt = undefined
        }
        const text = pending.map(i => i.text).join('\n')
        const result = (initial || record.startedAt === undefined) ? await runtime.start([record.request.text, text].filter(Boolean).join('\n'))
          : pending.length ? await runtime.amend(JSON.stringify({ originalRequest: record.request.text, additionalInputs: pending.map(i => i.text) })) : await runtime.wake('Scheduled review: inspect durable results and advance the original responsibility. Do not repeat unknown effects.')
        const current = read(id)
        if (current.state === 'paused' || (current.inputs ?? []).length !== (record.inputs ?? []).length) return
        const amendmentPending = runtime.amendmentPending()
        const evaluation = runtime.deliveryEvaluation(), state = !amendmentPending && evaluation.verdict === 'pass' ? 'fulfilled-local' : 'waiting'
        const next = { ...current, state, result, report: runtime.resultReport() ?? null, consumedInputs: [...(record.consumedInputs ?? []), ...(amendmentPending ? [] : pending.map(i => i.requestId))], endedAt: Date.now(), ...(state === 'waiting' ? { nextReviewAt: Date.now() + 60000 } : {}) }
        persist(next)
        if (state === 'fulfilled-local') options.onResult(current.request, { state, evaluate: runtime.deliveryEvaluation })
      } catch (error) {
        const current = read(id)
        if (current.state === 'paused' || (current.inputs ?? []).length !== (record.inputs ?? []).length) return
        const reason = error instanceof Error ? error.message : String(error)
        persist({ ...current, state: 'recovering', error: reason, endedAt: Date.now(), nextReviewAt: Date.now() + 60000 })
      } finally {
        try { await runtime?.stopNative() } catch (error) {
          const current = read(id)
          persist({ ...current, state: current.state === 'paused' ? 'paused' : 'needs-reconciliation', error: String(error), nextReviewAt: current.state === 'paused' ? undefined : Date.now() + 60000 })
        }
      }
    }).catch(error => { const record = read(id); persist({ ...record, state: 'needs-reconciliation', error: String(error) }) }).finally(() => {
      scheduled.delete(id)
      if (disposed) return
      const current = read(id)
      if (current.state === 'queued') schedule(id)
      else arm(current)
    })
  }
  const routeMessage = (id: string, request: AdmissionRequest) => {
    const task = (routing.get(id) ?? Promise.resolve()).then(async () => {
      if (disposed) return
      const current = read(id)
      let runtime = runtimes.get(id)
      if (!runtime) { runtime = options.runtime(current.request.project!, current.runtimeRoot ?? jobRoot(id)); runtimes.set(id, runtime) }
      const result = await runtime.routeMessage(request.text)
      const latest = read(id), messages = (latest.messages ?? []).map(m => m.request.requestId === request.requestId ? { ...m, state: result.kind, answer: result.answer } : m)
      if (result.kind === 'discussion') { persist({ ...latest, messages }); options.onNotice?.(request, result.answer); return }
      if (latest.state === 'paused' && (latest.inputs ?? []).length !== (current.inputs ?? []).length) { persist({ ...latest, messages }); options.onNotice?.(request, '事项已暂停，补充尚未执行；请明确继续后应用。'); return }
      persist({ ...latest, state: 'queued', messages, inputs: [...(latest.inputs ?? []), request], nextReviewAt: undefined })
      clearTimer(id); runtime.interrupt(request.text, 'amendment'); schedule(id)
      options.onNotice?.(request, '补充已归入原事项，将按新要求重新验收。')
    }).catch(error => { options.onNotice?.(request, '本次消息尚未归位：' + String(error)); const current = read(id); persist({ ...current, messages: (current.messages ?? []).map(m => m.request.requestId === request.requestId ? { ...m, answer: String(error) } : m) }) }).finally(() => { if (routing.get(id) === task) routing.delete(id) })
    routing.set(id, task)
  }
  const api = {
    projects: options.projectsView, read,
    enqueue(request: AdmissionRequest) {
      if (disposed || !request.requestId || !request.text.trim() || request.text.length > 64000) throw Error('MANAGED_INTAKE_INVALID')
      const project = request.project ?? options.defaultProject
      if (!options.projects.includes(project)) throw Error('MANAGED_PROJECT_NOT_CONFIGURED')
      const input = { ...request, project }
      if (existsSync(pathOf(request.requestId))) {
        const prior = read(request.requestId)
        if (JSON.stringify(prior.request) !== JSON.stringify(input)) throw Error('MANAGED_ADMISSION_CONFLICT')
        return { requestId: request.requestId, state: prior.state, duplicate: true }
      }
      const fd = openSync(pathOf(request.requestId), 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify({ request: input, state: 'queued', admittedAt: Date.now() })); fsyncSync(fd) } finally { closeSync(fd) }
      schedule(request.requestId)
      return { requestId: request.requestId, state: 'queued', duplicate: false }
    },
    message(request: AdmissionRequest) {
      if (disposed || !request.text.trim() || request.text.length > 64000) throw Error('MANAGED_INTAKE_INVALID')
      const explicit = /^\/work\s+(\S+)\s+([\s\S]+)$/.exec(request.text)
      if (explicit) return api.enqueue({ ...request, project: explicit[1], text: explicit[2]! })
      const all = records(), duplicate = all.find(r => r.request.requestId === request.requestId || r.inputs?.some(i => i.requestId === request.requestId) || r.messages?.some(m => m.request.requestId === request.requestId))
      if (duplicate) {
        const input = duplicate.request.requestId === request.requestId ? duplicate.request : duplicate.inputs?.find(i => i.requestId === request.requestId) ?? duplicate.messages!.find(m => m.request.requestId === request.requestId)!.request
        if (input.text !== request.text || JSON.stringify(input.origin) !== JSON.stringify(request.origin)) throw Error('MANAGED_ADMISSION_CONFLICT')
        return { requestId: duplicate.request.requestId, state: duplicate.state, duplicate: true }
      }
      const active = all.filter(r => r.request.origin.kind === request.origin.kind && r.request.origin.chatId === request.origin.chatId && !['fulfilled-local', 'released'].includes(r.state))
      const thread = request.origin.event?.thread
      const linked = thread ? active.filter(r => r.request.origin.event?.thread === thread || thread === `p2p:${request.origin.chatId}:${r.request.origin.messageId}` || r.inputs?.some(i => thread === `p2p:${request.origin.chatId}:${i.origin.messageId}`)) : []
      const explicitThread = thread && thread !== `p2p:${request.origin.chatId}:${request.origin.messageId}`
      if (explicitThread && !linked.length) throw Error('MANAGED_TARGET_NOT_ACTIVE')
      const candidates = linked.length ? linked : active
      if (candidates.length > 1) throw Error('MANAGED_TARGET_AMBIGUOUS: ' + candidates.map(r => r.request.requestId).join(', '))
      const stop = /^(停|停止|算了|stop|别做了|先别做了|不用了)$/i.test(request.text.trim().replace(/\p{P}/gu, ''))
      const resume = /^(继续|恢复执行|resume)$/i.test(request.text.trim().replace(/\p{P}/gu, ''))
      if (!candidates.length) { if (stop || resume) throw Error('MANAGED_TARGET_MISSING'); return api.enqueue(request) }
      const prior = candidates[0]!, id = prior.request.requestId
      if (/^(?:\/?status|状态|进度|进展怎样|进展如何|进度如何|现在怎么样|怎么样了)[?？。！!\s]*$/i.test(request.text.trim())) return { requestId: id, state: prior.state, duplicate: false, notice: `事项 ${id}：${prior.state}${prior.error ? '；' + prior.error : ''}` }
      if (!stop && !resume) {
        persist({ ...prior, messages: [...(prior.messages ?? []), { request, state: 'routing' }] })
        routeMessage(id, request)
        return { requestId: id, state: 'routing', duplicate: false }
      }
      const next = { ...prior, state: stop ? 'paused' : 'queued', inputs: [...(prior.inputs ?? []), request], consumedInputs: stop ? [...(prior.consumedInputs ?? []), request.requestId] : prior.consumedInputs, nextReviewAt: undefined }
      persist(next); clearTimer(id)
      runtimes.get(id)?.interrupt(request.text, resume ? 'amendment' : 'owner')
      if (!stop) schedule(id)
      return { requestId: id, state: next.state, duplicate: false }
    },
    continue(requestId: string, continuationId: string, text: string) {
      if (disposed || !continuationId || !text.trim() || text.length > 64000) throw Error('MANAGED_CONTINUATION_INVALID')
      const prior = read(requestId), materialDigest = options.materialDigest(prior.request.project!)
      const old = prior.continuations?.find(i => i.id === continuationId)
      if (old) { if (old.text !== text || old.materialDigest !== materialDigest) throw Error('MANAGED_CONTINUATION_CONFLICT'); return { requestId, continuationId, state: prior.state, duplicate: true } }
      if (!['needs-attention', 'recovering', 'needs-reconciliation', 'paused', 'waiting'].includes(prior.state) || !prior.runtimeRoot) throw Error('MANAGED_CONTINUATION_NOT_READY')
      const input: AdmissionRequest = { requestId: 'continuation:' + continuationId, text, origin: { kind: 'trusted-host' } }
      persist({ ...prior, state: 'queued', inputs: [...(prior.inputs ?? []), input], continuations: [...(prior.continuations ?? []), { id: continuationId, text, materialDigest }], priorOutcome: { ...prior }, nextReviewAt: undefined })
      schedule(requestId)
      return { requestId, continuationId, state: 'queued', duplicate: false }
    },
    async settle() { let tail; do { await Promise.all([...routing.values()]); tail = queue; await tail } while (queue !== tail || routing.size) },
    async dispose() {
      if (disposed) return
      disposed = true; for (const id of timers.keys()) clearTimer(id)
      for (const [id, runtime] of runtimes) if (read(id).state === 'running') runtime.interrupt('Host lifecycle disposal; preserve responsibility and reconcile before resuming.', 'lifecycle')
      await Promise.all([...routing.values()]); await queue
      for (const runtime of runtimes.values()) await runtime.dispose()
      runtimes.clear()
    },
  }
  for (const record of records()) {
    if (record.state === 'queued' && record.startedAt === undefined && !existsSync(jobRoot(record.request.requestId))) schedule(record.request.requestId)
    else if (['waiting','recovering','needs-reconciliation'].includes(record.state)) arm({ ...record, nextReviewAt: record.nextReviewAt ?? Date.now() + 60000 })
    else if (record.state === 'queued' || record.state === 'running') { const retained = { ...record, state: 'needs-reconciliation', nextReviewAt: Date.now() + 60000, error: 'Previous execution retained; reconcile exact native operations before resuming.' }; persist(retained); arm(retained) }
    for (const message of record.messages ?? []) if (message.state === 'routing') routeMessage(record.request.requestId, message.request)
  }
  return api
}
