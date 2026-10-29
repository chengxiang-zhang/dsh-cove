import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeTaskView } from '../src/core/schedule-mode/native.ts'
import type { ScheduleModePolicy } from '../src/core/schedule-mode/types.ts'
import { ScheduleModeEngine, type ScheduleModePorts } from '../src/host/services/schedule-mode/engine.ts'
import { ScheduleModeStore } from '../src/host/services/schedule-mode/store.ts'

const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

/** Faults surround real atomic store writes; restart always uses a fresh disk reader. */
class FaultStore extends ScheduleModeStore {
  count = 0
  failAt = 0
  after = false
  override remove(key: string): boolean {
    this.count += 1
    if (this.count === this.failAt && !this.after) throw new Error('remove before commit')
    const removed = super.remove(key)
    if (this.count === this.failAt && this.after) throw new Error('remove committed then interrupted')
    return removed
  }
  override upsert(policy: ScheduleModePolicy): ScheduleModePolicy {
    this.count += 1
    if (this.count === this.failAt && !this.after) throw new Error('persist before commit')
    const saved = super.upsert(policy)
    if (this.count === this.failAt && this.after) throw new Error('persist committed then interrupted')
    return saved
  }
}

function fixture(at?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-recovery-'))
  dirs.push(dir)
  const file = join(dir, 'state.json')
  const store = new FaultStore(file)
  let seq = 0
  let sessions = 0
  let creates = 0
  let rows: NativeTaskView[] = [{ sessionId: 'source', id: 'original', title: 'Same title', prompt: 'P',
    status: 'active', rule: at === undefined ? { kind: 'every', everySeconds: 60 } : { kind: 'at', at }, scheduledAt: at ?? '2026-10-17T10:00:00Z' }]
  const ports: ScheduleModePorts = {
    listTasks: async () => rows.map(row => ({ ...row })),
    createTask: async (sessionId, request) => {
      creates += 1
      const id = `native-${++seq}`
      const scheduledAt = 'at' in request.selector ? request.selector.at : '2026-10-17T10:00:00Z'
      rows.push({ sessionId, id, title: request.title, prompt: request.prompt,
        rule: 'at' in request.selector ? { kind: 'at', at: request.selector.at } : { kind: 'every', everySeconds: 60 }, status: 'active', scheduledAt })
      return { id, scheduledAt }
    },
    deleteTask: async (sessionId, id) => { rows = rows.filter(row => row.id !== id || row.sessionId !== sessionId) },
    createSession: async () => `run-${++sessions}`,
    inspectSession: async () => ({}), now: () => 0, log: () => {},
  }
  return { file, store, ports, engine: new ScheduleModeEngine(store, ports),
    rows: () => rows, clear: () => { rows = [] }, creates: () => creates, sessions: () => sessions,
    deliver: () => { rows = rows.map(row => ({ ...row, scheduledAt: '2026-10-17T11:00:00Z',
      lastDelivery: { scheduledAt: row.scheduledAt, deliveredAt: '2026-10-17T10:00:00Z' } })) },
    restart: (overrides: Partial<ScheduleModePorts> = {}) => {
      const disk = new ScheduleModeStore(file)
      return { disk, engine: new ScheduleModeEngine(disk, { ...ports, ...overrides }) }
    },
  }
}

describe('schedule-mode one-shot deadline transitions', () => {
  const deadline = '2026-10-17T10:00:00.000Z'
  const due = Date.parse(deadline)
  afterEach(() => { vi.useRealTimers() })

  for (const mode of ['new', 'original'] as const) {
    async function setup() {
      vi.useFakeTimers({ now: due - 59_000 })
      const f = fixture(deadline)
      f.ports.now = () => Date.now()
      if (mode === 'original') await f.engine.setMode('source', 'original', 'new')
      return f
    }

    it(`${mode}: switches before the deadline without changing the one-shot time`, async () => {
      const f = await setup()
      const view = await f.engine.setMode('source', 'original', mode)
      expect(view).toMatchObject({ mode, status: 'active', scheduledAt: deadline, runs: [] })
      expect(view.recovery).toBeUndefined()
      expect(f.rows()).toHaveLength(1)
      expect(f.rows()[0]?.sessionId === 'source').toBe(mode === 'original')
    })

    it(`${mode}: rejects an expired at before deleting the existing row`, async () => {
      const f = await setup()
      const before = f.rows().map(row => ({ ...row }))
      const creates = f.creates()
      vi.setSystemTime(due)
      await expect(f.engine.setMode('source', 'original', mode)).rejects.toMatchObject({ code: 'task-ended' })
      expect(f.rows()).toEqual(before)
      expect(f.creates()).toBe(creates)
      expect(f.store.find('original', 'source')?.transition).toBeUndefined()
    })

    it(`${mode}: preserves the old row if the catalog read crosses the deadline`, async () => {
      const f = await setup()
      const before = f.rows().map(row => ({ ...row }))
      let reads = 0
      const engine = new ScheduleModeEngine(f.store, { ...f.ports, listTasks: async () => {
        const tasks = await f.ports.listTasks()
        if (++reads === 2) vi.setSystemTime(due)
        return tasks
      } })
      await expect(engine.setMode('source', 'original', mode)).rejects.toMatchObject({ code: 'recovery-required' })
      expect(f.rows()).toEqual(before)
      expect(f.store.find('original', 'source')?.transition?.phase).toBe('recovery-required')
    })

    it(`${mode}: exposes recovery instead of success when deletion crosses the deadline`, async () => {
      const f = await setup()
      const creates = f.creates()
      const engine = new ScheduleModeEngine(f.store, { ...f.ports, deleteTask: async (sessionId, id) => {
        await f.ports.deleteTask(sessionId, id)
        vi.setSystemTime(due + 1)
      } })
      await expect(engine.setMode('source', 'original', mode)).rejects.toMatchObject({ code: 'recovery-required' })
      const { engine: restarted, disk } = f.restart()
      await restarted.reconcile()
      const policy = disk.find('original', 'source')!
      expect(policy).toMatchObject({ active: true, runs: [], transition: { kind: mode, phase: 'recovery-required' } })
      expect(policy.endedReason).toBeUndefined()
      expect(policy.transition?.reason).toMatch(/deadline.*delivery outcome is unknown/)
      expect((await restarted.list()).tasks[0]).toMatchObject({ status: 'inactive', runs: [], recovery: { phase: 'recovery-required' } })
      expect(f.rows()).toEqual([])
      expect(f.creates()).toBe(creates)
      await expect(restarted.setMode('source', 'original', mode)).rejects.toMatchObject({ code: 'recovery-required' })
    })

    for (const phase of ['deleting', 'prepare'] as const) {
      it(`${mode}: reconcile preserves ${phase} intent across a deadline without recreating delivery`, async () => {
        const f = await setup()
        f.store.count = 0
        // Interrupt immediately after persisting the desired journal phase.
        f.store.failAt = phase === 'deleting' ? 1 : 2
        f.store.after = true
        await expect(f.engine.setMode('source', 'original', mode)).rejects.toThrow(/interrupted/)
        expect(new ScheduleModeStore(f.file).find('original', 'source')?.transition?.phase).toBe(phase)
        const before = f.rows().map(row => ({ ...row }))
        const creates = f.creates()
        vi.setSystemTime(due + 1)
        const { engine, disk } = f.restart()
        await engine.reconcile()
        await engine.reconcile()
        expect(f.rows()).toEqual(before)
        expect(f.creates()).toBe(creates)
        expect(disk.find('original', 'source')).toMatchObject({ runs: [], transition: { kind: mode, phase: 'recovery-required' } })
        expect(disk.find('original', 'source')?.endedReason).toBeUndefined()
        expect((await engine.list()).tasks[0]?.recovery?.phase).toBe('recovery-required')
      })
    }
  }

  it('does not create a past-deadline reminder after slow session creation', async () => {
    vi.useFakeTimers({ now: due - 59_000 })
    const f = fixture(deadline)
    const engine = new ScheduleModeEngine(f.store, { ...f.ports, now: () => Date.now(), createSession: async input => {
      const sessionId = await f.ports.createSession(input)
      vi.setSystemTime(due + 1)
      return sessionId
    } })
    await expect(engine.setMode('source', 'original', 'new')).rejects.toMatchObject({ code: 'recovery-required' })
    expect(f.store.find('original', 'source')?.transition).toMatchObject({ phase: 'recovery-required', sessionId: 'run-1' })
    expect(f.creates()).toBe(0)
    expect(f.rows()).toEqual([])
  })
})

describe('schedule-mode durable boundary recovery', () => {
  for (const operation of ['new', 'original', 'rotate'] as const) {
    const writes = operation === 'original' ? 5 : 7
    for (const after of [false, true]) {
      for (let boundary = 1; boundary <= writes; boundary += 1) {
        it(`${operation}: ${after ? 'after' : 'before'} durable write ${boundary}`, async () => {
          const f = fixture()
          if (operation !== 'new') await f.engine.setMode('source', 'original', 'new')
          if (operation === 'rotate') f.deliver()
          f.store.count = 0
          f.store.failAt = boundary
          f.store.after = after
          if (operation === 'rotate') await f.engine.reconcile()
          else await f.engine.setMode('source', 'original', operation).catch(() => {})
          const { disk, engine } = f.restart()
          await engine.reconcile()
          const policy = disk.find('original', 'source')
          const blocked = policy?.transition?.phase === 'recovery-required'
          if (!blocked && operation !== 'rotate') await engine.setMode('source', 'original', operation)
          await engine.reconcile()
          await engine.reconcile()
          expect(f.rows().length).toBeLessThanOrEqual(1)
          expect(f.creates()).toBeLessThanOrEqual(operation === 'new' ? 1 : 2)
          const result = disk.find('original', 'source')
          if (blocked) {
            expect(result?.transition?.reason).toMatch(/unknown/)
            await expect(engine.setMode('source', 'original', operation === 'original' ? 'original' : 'new')).rejects.toMatchObject({ code: 'recovery-required' })
          } else {
            expect(result?.transition).toBeUndefined()
            expect(f.rows()).toHaveLength(1)
            expect(f.rows()[0]?.sessionId === 'source').toBe(operation === 'original')
          }
          if (operation === 'rotate') expect(result?.runs).toHaveLength(1)
        })
      }
    }
  }

  for (const operation of ['new', 'original', 'rotate'] as const) {
    for (const after of [false, true]) {
      for (const effect of ['delete', 'create', 'session'] as const) {
        if (operation === 'original' && effect === 'session') continue
        it(`${operation}: ${effect} throws ${after ? 'after' : 'before'} native effect`, async () => {
          const f = fixture()
          if (operation !== 'new') await f.engine.setMode('source', 'original', 'new')
          if (operation === 'rotate') f.deliver()
          const faulty = new ScheduleModeEngine(f.store, { ...f.ports,
            ...(effect === 'delete' ? { deleteTask: async (sessionId: string, id: string) => {
              if (after) await f.ports.deleteTask(sessionId, id)
              throw new Error('native delete interrupted')
            } } : {}),
            ...(effect === 'create' ? { createTask: async (...args: Parameters<ScheduleModePorts['createTask']>) => {
              if (after) await f.ports.createTask(...args)
              throw new Error('native create interrupted')
            } } : {}),
            ...(effect === 'session' ? { createSession: async (...args: Parameters<ScheduleModePorts['createSession']>) => {
              if (after) await f.ports.createSession(...args)
              throw new Error('session create interrupted')
            } } : {}),
          })
          if (operation === 'rotate') await faulty.reconcile()
          else await faulty.setMode('source', 'original', operation).catch(() => {})
          const { engine, disk } = f.restart()
          await engine.reconcile()
          await engine.reconcile()
          expect(f.rows().length).toBeLessThanOrEqual(1)
          expect(f.creates()).toBeLessThanOrEqual(operation === 'new' ? 1 : 2)
          if (effect === 'delete') {
            expect(disk.find('original', 'source')?.transition).toBeUndefined()
            expect(f.rows()).toHaveLength(1)
            expect(f.rows()[0]?.sessionId === 'source').toBe(operation === 'original')
          } else {
            expect(disk.find('original', 'source')?.transition?.phase).toBe('recovery-required')
            expect((await engine.list()).tasks.find(task => task.id === 'original')?.recovery?.phase).toBe('recovery-required')
          }
          if (operation === 'rotate') expect(disk.find('original', 'source')?.runs).toHaveLength(1)
        })
      }
    }
  }

  for (const operation of ['stop', 'delete'] as const) {
    for (const effect of ['catalog', 'delete'] as const) {
      it(`${operation} retains exact cleanup intent after ${effect} failure`, async () => {
        const f = fixture()
        await f.engine.setMode('source', 'original', 'new')
        const copy = f.rows()[0]!
        const faulty = new ScheduleModeEngine(f.store, { ...f.ports,
          ...(effect === 'catalog' ? { listTasks: async () => { throw new Error('catalog unavailable') } }
            : { deleteTask: async () => { throw new Error('delete unavailable') } }),
        })
        await expect(operation === 'stop' ? faulty.stopSession('source') : faulty.deleteTask('source', 'original')).rejects.toThrow()
        const { engine, disk } = f.restart()
        expect(disk.find('original', 'source')?.transition).toMatchObject({ kind: operation, phase: 'deleting', deleteTasks: [{ sessionId: copy.sessionId, id: copy.id }] })
        await engine.reconcile()
        expect(f.rows()).toHaveLength(0)
        if (operation === 'delete') expect(disk.list()).toHaveLength(0)
        else expect(disk.find('original', 'source')).toMatchObject({ active: false, endedReason: 'ended' })
      })
    }
  }

  for (const kind of ['stop', 'delete'] as const) {
    for (const after of [false, true]) {
      for (let boundary = 1; boundary <= 3; boundary += 1) {
        it(`${kind}: ${after ? 'after' : 'before'} cleanup persist ${boundary}`, async () => {
          const f = fixture()
          await f.engine.setMode('source', 'original', 'new')
          f.store.count = 0
          f.store.failAt = boundary
          f.store.after = after
          await (kind === 'stop' ? f.engine.stopSession('source') : f.engine.deleteTask('source', 'original')).catch(() => {})
          const { disk, engine } = f.restart()
          // If the very first intent never committed, the caller must retry it.
          if (boundary === 1 && !after) {
            expect(f.rows()).toHaveLength(1)
            await (kind === 'stop' ? engine.stopSession('source') : engine.deleteTask('source', 'original'))
          }
          await engine.reconcile()
          await engine.reconcile()
          expect(f.rows()).toHaveLength(0)
          expect(f.creates()).toBe(1)
          if (kind === 'delete') expect(disk.list()).toHaveLength(0)
          else expect(disk.find('original', 'source')).toMatchObject({ active: false, endedReason: 'ended' })
        })
      }
    }
  }

  it('treats a missing steady-state copy as user deletion even when setMode is retried', async () => {
    const f = fixture()
    await f.engine.setMode('source', 'original', 'new')
    f.clear()
    await expect(f.engine.setMode('source', 'original', 'new')).rejects.toMatchObject({ code: 'unknown-task' })
    expect(f.creates()).toBe(1)
  })

  it('does not adopt an unrelated same-title task after an ambiguous create', async () => {
    const f = fixture()
    f.store.failAt = 6
    await f.engine.setMode('source', 'original', 'new').catch(() => {})
    await f.ports.createTask('unrelated', { title: 'Same title', prompt: 'P', selector: { every_seconds: 60 } })
    const ids = f.rows().map(row => row.id)
    const { engine, disk } = f.restart()
    await engine.reconcile()
    expect(f.rows().map(row => row.id)).toEqual(ids)
    expect(disk.find('original', 'source')?.transition?.phase).toBe('recovery-required')
    expect(disk.find('original', 'source')?.armedTaskId).toBeUndefined()
  })

  it('does not resurrect a user-deleted copy after its ID was journaled but final commit failed', async () => {
    const f = fixture()
    f.store.failAt = 7
    await expect(f.engine.setMode('source', 'original', 'new')).rejects.toThrow()
    expect(new ScheduleModeStore(f.file).find('original', 'source')?.transition?.phase).toBe('created')
    f.clear()
    const { engine, disk } = f.restart()
    await engine.reconcile()
    await engine.reconcile()
    expect(disk.find('original', 'source')?.endedReason).toBe('deleted')
    expect(f.creates()).toBe(1)
  })

  it('does not forget an ambiguous create when stop/delete is requested', async () => {
    const f = fixture()
    f.store.failAt = 6
    await f.engine.setMode('source', 'original', 'new').catch(() => {})
    const { engine, disk } = f.restart()
    await expect(engine.deleteTask('source', 'original')).rejects.toMatchObject({ code: 'recovery-required' })
    await expect(engine.stopSession('source')).rejects.toThrow()
    expect(disk.find('original', 'source')?.transition?.phase).toBe('recovery-required')
    expect(f.rows()).toHaveLength(1)
    expect(f.creates()).toBe(1)
  })

  it('records stop intent for every source policy even when the catalog fails for all of them', async () => {
    const f = fixture()
    await f.engine.setMode('source', 'original', 'new')
    const second = await f.ports.createTask('source', { title: 'Second', prompt: 'P', selector: { every_seconds: 60 } })
    await f.engine.setMode('source', second.id, 'new')
    const blind = new ScheduleModeEngine(f.store, { ...f.ports, listTasks: async () => { throw new Error('catalog down') } })
    await expect(blind.stopSession('source')).rejects.toThrow()
    expect(new ScheduleModeStore(f.file).list().every(policy => policy.transition?.kind === 'stop')).toBe(true)
    const { engine, disk } = f.restart()
    await engine.reconcile()
    expect(f.rows()).toHaveLength(0)
    expect(disk.list().every(policy => !policy.active)).toBe(true)
  })

  it('keeps existing v1 ambiguous duplicates visible without title matching or making another copy', async () => {
    const f = fixture()
    await f.engine.setMode('source', 'original', 'new')
    const policy = f.store.find('original', 'source')!
    f.store.upsert({ ...policy, armedTaskId: undefined })
    await f.ports.createTask('source', { title: 'Same title', prompt: 'P', selector: { every_seconds: 60 } })
    const ids = f.rows().map(row => row.id)
    const { engine, disk } = f.restart()
    await engine.reconcile()
    await engine.reconcile()
    expect(f.rows().map(row => row.id)).toEqual(ids)
    expect(f.creates()).toBe(2)
    expect(disk.find('original', 'source')?.transition?.phase).toBe('recovery-required')
    expect((await engine.list()).tasks.filter(task => task.mode === 'original')).toHaveLength(2)
  })

  it('does not publish an uncommitted memory snapshot on actual filesystem write failure', () => {
    const f = fixture()
    const policy: ScheduleModePolicy = { key: 'source\u0000original', logicalId: 'original', sourceSessionId: 'source',
      title: 'T', prompt: 'P', rule: { kind: 'every', everySeconds: 60 }, runs: [], active: true, createdAt: 1, updatedAt: 1 }
    f.store.upsert(policy)
    const before = readFileSync(f.file, 'utf8')
    // A directory at the temporary-file path makes the real writeFileSync fail.
    mkdirSync(`${f.file}.tmp`)
    expect(() => f.store.upsert({ ...policy, title: 'UNCOMMITTED' })).toThrow()
    expect(f.store.find('original', 'source')?.title).toBe('T')
    expect(readFileSync(f.file, 'utf8')).toBe(before)
    expect(new ScheduleModeStore(f.file).find('original', 'source')?.title).toBe('T')
  })
})
