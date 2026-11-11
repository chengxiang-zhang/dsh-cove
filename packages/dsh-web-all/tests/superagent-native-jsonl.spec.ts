import { afterEach, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { fixture } from './fixtures/superagent/controlled.ts'
import { ControlledJsonl } from '../src/host/services/superagent/executors/native/jsonl.ts'
import type { ExecutionEnvelope } from '../src/host/services/superagent/kernel/actions.ts'
const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const f of fixtures.splice(0)) {
    f.ledger.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
})
function setup() {
  const f = fixture()
  fixtures.push(f)
  f.k.host.grantMandate({
    id: 'rpc',
    revision: 1,
    requester: 'owner',
    subject: 'worker',
    target: { id: 'target', revision: 1 },
    actions: ['dispatch', 'inspect'],
    workspaceId: f.workspace.id,
    resourceIds: f.workspace.resources,
    scopeRefs: [],
    expiresAt: Date.now() + 60000,
    revoked: false
  })
  const spec = { ...f.spec('launch'), mandateRef: { id: 'rpc', revision: 1 } },
    a = f.k.actions.planAction(spec)
  f.k.actions.claimResources(a.ref, spec.resourceIds)
  const launch = f.k.host.beginDispatch(a.ref) as ExecutionEnvelope
  let receive!: (line: string) => void, close!: () => void
  const lines: string[] = []
  f.k.host.openProcess = (() => ({
    closed: new Promise<void>((r) => {
      close = r
    }),
    onLine: (r: (line: string) => void) => {
      receive = r
      return () => {}
    },
    writeLine: async (ref: any, line: string) => {
      f.k.host.reserveNativeExchange(ref, launch.actionRef, line)
      lines.push(line)
    }
  })) as any
  const io = new ControlledJsonl(f.k, launch, 'jsonl-test')
  return { f, io, lines, receive: (value: unknown) => receive(JSON.stringify(value)), close: () => close() }
}
it('correlates typed native IDs and requires a real result or error before confirming', async () => {
  const s = setup()
  let settled = false
  const answer = s.io.call('test', {}).then((value) => {
    settled = true
    return value
  })
  await Promise.resolve()
  s.receive({ id: '1', result: 'wrong-id-type' })
  s.receive({ id: 1 })
  await Promise.resolve()
  const prematurelySettled = settled
  s.receive({ id: 1, result: 'real-response' })
  expect(await answer).toBe('real-response')
  expect(prematurelySettled).toBe(false)
  s.close()
})
it('bounds pending RPCs before creating another Action and leaves lost responses unknown', async () => {
  const s = setup()
  const pending = Array.from({ length: 32 }, () => s.io.call('test', {}).catch((e) => e.message))
  await Promise.resolve()
  const before = s.f.ledger.events().length
  const extra = s.io.call('extra', {}).catch((e) => e.message)
  await Promise.resolve()
  const after = s.f.ledger.events().length
  s.close()
  expect(await extra).toBe('RPC_BACKPRESSURE')
  expect(after).toBe(before)
  expect((await Promise.all(pending)).every((x) => x === 'RPC_RESPONSE_UNKNOWN')).toBe(true)
}, 20000)

it('bounds native HTTP streamed responses before parsing or persisting them', async () => {
  const s = setup()
  const { ControlledNativeHttp } = await import('../src/host/services/superagent/executors/native/http.ts')
  const io = new ControlledNativeHttp(s.f.k, s.io.launch, 'http-test', 'http://127.0.0.1:12345/')
  let cancelled = false,
    chunks = 0
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (chunks++ < 10) controller.enqueue(new Uint8Array(1024 * 1024).fill(32))
            else controller.close()
          },
          cancel() {
            cancelled = true
          }
        })
      )
  )
  await expect(io.call('session/page', {})).rejects.toThrow('NATIVE_HTTP_RESPONSE_TOO_LARGE')
  expect(cancelled).toBe(true)
  expect(s.f.k.host.nativeFacts('http-test')).toEqual([])
  s.close()
})

it('uses a caller remaining-history deadline without admitting invalid timeout requests', async () => {
  const s = setup()
  const { ControlledNativeHttp } = await import('../src/host/services/superagent/executors/native/http.ts')
  const io = new ControlledNativeHttp(s.f.k, s.io.launch, 'http-deadline', 'http://127.0.0.1:12345/')
  const before = s.f.ledger.events().length
  await expect(io.call('session/page', {}, 'inspect', 0)).rejects.toThrow('NATIVE_HTTP_TIMEOUT_INVALID')
  expect(s.f.ledger.events()).toHaveLength(before)
  let signal: AbortSignal | undefined
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal
    return await new Promise((_resolve, reject) =>
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    )
  })
  await expect(io.call('session/page', {}, 'inspect', 20)).rejects.toThrow()
  expect(signal?.aborted).toBe(true)
  expect(s.f.k.host.nativeFacts('http-deadline')).toEqual([])
  s.close()
})
