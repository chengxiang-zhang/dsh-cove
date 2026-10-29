import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScheduleModeEngine, type ScheduleModePorts } from '../src/host/services/schedule-mode/engine.ts'
import { ScheduleModeStore } from '../src/host/services/schedule-mode/store.ts'
import { register } from '../src/host/services/schedule-mode/index.ts'
import { bindFamilyConfig } from '../src/host/services/family-config.ts'
import type { NativeTaskView } from '../src/core/schedule-mode/native.ts'
import type { ScheduleModePolicy } from '../src/core/schedule-mode/types.ts'

const roots: string[] = []
afterEach(() => {
  bindFamilyConfig(undefined)
  for (const root of roots.splice(0)) {
    if (!realpathSync(root).startsWith(`${realpathSync(tmpdir())}/schedule-fixes-`)) throw new Error('unexpected cleanup target')
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'schedule-fixes-')))
  roots.push(root)
  const file = join(root, 'policy.json')
  const store = new ScheduleModeStore(file)
  let rows: NativeTaskView[] = [{ id: 'original', sessionId: 'source', title: 'task', prompt: 'P', status: 'active',
    scheduledAt: '2026-10-17T20:00:00Z', rule: { kind: 'every', everySeconds: 60 } }]
  const ports: ScheduleModePorts = {
    now: () => 0, log: () => {}, inspectSession: async () => ({}),
    listTasks: async () => rows.map(row => ({ ...row })),
    createSession: vi.fn(async () => 'run'),
    createTask: vi.fn(async (sessionId, request) => {
      rows.push({ ...rows[0]!, sessionId, id: 'copy', title: request.title, prompt: request.prompt,
        status: 'active', rule: { kind: 'every', everySeconds: 60 }, scheduledAt: '2026-10-17T20:00:00Z' })
      return { id: 'copy', scheduledAt: '2026-10-17T20:00:00Z' }
    }),
    deleteTask: async (sessionId, id) => { rows = rows.filter(row => row.sessionId !== sessionId || row.id !== id) },
  }
  return { file, store, ports, rows: () => rows, engine: new ScheduleModeEngine(store, ports) }
}
function policy(id: string): ScheduleModePolicy {
  return { key: `source\0${id}`, sourceSessionId: 'source', logicalId: id, title: id, prompt: 'P', active: true,
    rule: { kind: 'every', everySeconds: 60 }, runs: [], createdAt: 0, updatedAt: 0 }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('schedule-mode fail-closed persistence and lifetime fixes', () => {
  it('refreshes stale reads and never overwrites a corrupt store', () => {
    const f = fixture()
    const other = new ScheduleModeStore(f.file)
    other.load()
    f.store.upsert(policy('one'))
    other.upsert(policy('two'))
    expect(f.store.list()).toHaveLength(2)
    const damaged = '{"formatVersion":1,"policies":'
    writeFileSync(f.file, damaged)
    expect(() => f.store.list()).toThrow()
    expect(() => f.store.upsert(policy('three'))).toThrow()
    expect(readFileSync(f.file, 'utf8')).toBe(damaged)
  })

  it('rejects a stale same-policy mutation instead of losing a committed update', () => {
    const f = fixture()
    f.store.upsert(policy('one'))
    const other = new ScheduleModeStore(f.file)
    const stale = other.find('one', 'source')!
    f.store.upsert({ ...policy('one'), title: 'new committed title', updatedAt: 2 })
    expect(() => other.upsert({ ...stale, prompt: 'stale overwrite' })).toThrow(/concurrently/)
    expect(new ScheduleModeStore(f.file).find('one', 'source')?.title).toBe('new committed title')
  })

  for (const mode of ['dispose', 'disable-reenable'] as const) {
    it(`${mode} prevents pending session creation from admitting a late task`, async () => {
      const f = fixture()
      const entered = deferred<void>()
      const release = deferred<string>()
      f.ports.createSession = async () => { entered.resolve(); return release.promise }
      const pending = f.engine.setMode('source', 'original', 'new')
      await entered.promise
      if (mode === 'dispose') f.engine.dispose()
      else { f.engine.setEnabled(false); f.engine.setEnabled(true) }
      release.resolve('late-session')
      await expect(pending).rejects.toMatchObject({ code: 'recovery-required' })
      expect(f.ports.createTask).not.toHaveBeenCalled()
      expect(f.store.find('original', 'source')?.transition).toMatchObject({ phase: 'prepare', sessionId: 'late-session' })
      if (mode === 'dispose') await expect(f.engine.setMode('source', 'original', 'new')).rejects.toMatchObject({ code: 'recovery-required' })
    })
  }

  it('rolls back tools and routes when a later initialization event fails', () => {
    const f = fixture()
    const offRoute = vi.fn(); const offTool = vi.fn(); const offEvent = vi.fn()
    let events = 0
    const ctx = {
      get: () => undefined,
      webServer: { register: () => offRoute },
      tools: { register: () => offTool },
      on: () => { if (++events === 2) throw new Error('event registration failed'); return offEvent },
    }
    expect(() => register(ctx as never, { storePath: f.file })).toThrow('event registration failed')
    expect(offRoute).toHaveBeenCalledOnce()
    expect(offTool).toHaveBeenCalledTimes(2)
    expect(offEvent).toHaveBeenCalledOnce()
  })

  it('disposal while native create is returning retains its result and never commits late success', async () => {
    const f = fixture()
    const entered = deferred<void>(); const release = deferred<void>()
    const create = f.ports.createTask
    f.ports.createTask = async (...args) => {
      const result = await create(...args)
      entered.resolve(); await release.promise
      return result
    }
    const pending = f.engine.setMode('source', 'original', 'new')
    await entered.promise
    f.engine.dispose(); release.resolve()
    await expect(pending).rejects.toMatchObject({ code: 'recovery-required' })
    expect(new ScheduleModeStore(f.file).find('original', 'source')?.transition).toMatchObject({ phase: 'created', created: { id: 'copy' } })
    expect(f.rows()).toHaveLength(1)
  })

  it('rejects unknown native task schema without interpreting it as deletion', async () => {
    const f = fixture()
    await f.engine.setMode('source', 'original', 'new')
    f.ports.listTasks = async () => [{ ...f.rows()[0]!, status: 'delivering' } as unknown as NativeTaskView]
    await f.engine.reconcile()
    expect(f.store.find('original', 'source')?.active).toBe(true)
    expect((await f.engine.list()).available).toBe(false)
  })

  for (const transition of [
    { kind: 'stop', phase: 'created', deleteTasks: [], created: { sessionId: 'source', id: 'original', scheduledAt: '2026-10-17T20:00:00Z' } },
    { kind: 'original', phase: 'creating-session', deleteTasks: [] },
    { kind: 'new', phase: 'creating-task', deleteTasks: [], sessionId: '' },
    { kind: 'new', phase: 'prepare', deleteTasks: [{ sessionId: 'source', id: 'original' }, { sessionId: 'source', id: 'original' }] },
  ]) it(`rejects malformed intent ${transition.kind}/${transition.phase} without a native effect`, async () => {
    const f = fixture()
    const record = { ...policy('one'), transition }
    writeFileSync(f.file, JSON.stringify({ formatVersion: 1, policies: { [record.key]: record } }))
    await f.engine.reconcile()
    expect(f.rows()).toHaveLength(1)
    expect(f.ports.createTask).not.toHaveBeenCalled()
    expect(f.ports.createSession).not.toHaveBeenCalled()
    expect(f.store.find('one', 'source')?.transition?.phase).toBe('recovery-required')
  })

  it('does not execute semantically malformed cleanup-created intents', async () => {
    const f = fixture()
    f.store.upsert({ ...policy('one'), transition: { kind: 'stop', phase: 'created', deleteTasks: [],
      created: { sessionId: 'source', id: 'original', scheduledAt: '2026-10-17T20:00:00Z' } } })
    await f.engine.reconcile()
    expect(f.rows()).toHaveLength(1)
    expect(f.store.find('one', 'source')?.transition?.phase).toBe('recovery-required')
  })
})

// Existing store tests describe the retired permissive parser/cache contract.
// These assertions deliberately verify the new fail-closed public behavior.

describe('schedule-mode hot settings cleanup', () => {
  it('disabled settings do not mount routes or start native creation', async () => {
    const f = fixture()
    bindFamilyConfig({ 'schedule-mode': { enabled: false } })
    const registerRoute = vi.fn()
    const dispose = register({ get: () => undefined, webServer: { register: registerRoute } } as never, { storePath: f.file })
    dispose(); dispose()
    expect(registerRoute).not.toHaveBeenCalled()
    expect(f.ports.createTask).not.toHaveBeenCalled()
  })
})
