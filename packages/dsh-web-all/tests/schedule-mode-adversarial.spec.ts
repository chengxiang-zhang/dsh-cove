import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeTaskView, type NativeTaskView } from '../src/core/schedule-mode/native.ts'
import { policyKey, type NativeCreateRequest, type ScheduleModePolicy, type ScheduleModeRule } from '../src/core/schedule-mode/types.ts'
import { ScheduleModeEngine, type ScheduleModePorts } from '../src/host/services/schedule-mode/engine.ts'
import { ScheduleModeStore } from '../src/host/services/schedule-mode/store.ts'

// Both sides of the protocol survive a restart; no native catalog remains in a
// JavaScript closure. A recorded create with unknown outcome is allowed to block,
// but never licenses a second create, hidden tracking loss, or false success.
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = realpathSync(root)
    if (!resolved.startsWith(`${realpathSync(tmpdir())}/schedule-adversarial-`)) throw new Error('unexpected cleanup target')
    rmSync(resolved, { recursive: true, force: true })
  }
})
const START = Date.parse('2026-10-17T00:00:00.000Z')
const RULES: ScheduleModeRule[] = [
  { kind: 'after', afterSeconds: 60 },
  { kind: 'every', everySeconds: 60 },
  { kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' },
  { kind: 'at', at: new Date(START + 60_000).toISOString() },
]
type Side = 'before' | 'after'
type Effect = 'write' | 'create' | 'delete' | 'session'
type Hook = (effect: Effect | 'catalog' | 'inspect', side: Side) => void | Promise<void>
interface NativeDisk {
  rows: NativeTaskView[]
  sessions: string[]
  archived: string[]
  sequence: number
  now: number
}
function ruleOf(selector: NativeCreateRequest['selector']): ScheduleModeRule {
  if ('after_seconds' in selector) return { kind: 'after', afterSeconds: selector.after_seconds }
  if ('every_seconds' in selector) return { kind: 'every', everySeconds: selector.every_seconds }
  if ('at' in selector) return { kind: 'at', at: selector.at }
  if ('daily' in selector) return { kind: 'daily', time: selector.daily.time, timeZone: selector.daily.time_zone }
  if ('weekly' in selector) return { kind: 'weekly', time: selector.weekly.time, timeZone: selector.weekly.time_zone, weekdays: selector.weekly.weekdays }
  return { kind: 'cron', expression: selector.cron.expression, timeZone: selector.cron.time_zone }
}
function nextAt(rule: ScheduleModeRule, now: number): string {
  return rule.kind === 'at' ? rule.at : new Date(now + (rule.kind === 'after' ? rule.afterSeconds * 1000 : rule.kind === 'every' ? rule.everySeconds * 1000 : 86_400_000)).toISOString()
}
class CrashPlan {
  counts = new Map<Effect, number>()
  target?: { effect: Effect; occurrence: number; side: Side }
  fired = false
  hit(effect: Effect, side: Side): void {
    if (side === 'before') this.counts.set(effect, (this.counts.get(effect) ?? 0) + 1)
    if (!this.fired && this.target?.effect === effect && this.target.side === side && this.counts.get(effect) === this.target.occurrence) {
      this.fired = true
      throw new Error(`simulated process loss ${side} ${effect} ${this.target.occurrence}`)
    }
  }
}
class JournalStore extends ScheduleModeStore {
  constructor(file: string, private readonly crash: CrashPlan) { super(file) }
  override upsert(policy: ScheduleModePolicy): ScheduleModePolicy {
    this.crash.hit('write', 'before')
    const value = super.upsert(policy)
    this.crash.hit('write', 'after')
    return value
  }
  override remove(key: string): boolean {
    this.crash.hit('write', 'before')
    const value = super.remove(key)
    this.crash.hit('write', 'after')
    return value
  }
}
function rig(rule: ScheduleModeRule = RULES[1]!) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'schedule-adversarial-')))
  roots.push(root)
  const file = join(root, 'policy.json')
  const native = join(root, 'native.json')
  const readNative = (): NativeDisk => JSON.parse(readFileSync(native, 'utf8')) as NativeDisk
  const saveNative = (value: NativeDisk): void => { writeFileSync(native, JSON.stringify(value)) }
  const update = (change: (value: NativeDisk) => void): void => { const value = readNative(); change(value); saveNative(value) }
  saveNative({ rows: [{ id: 'logical', sessionId: 'source', title: 'Task', prompt: 'lineage:logical', rule,
    status: 'active', scheduledAt: nextAt(rule, START) }], sessions: ['source'], archived: [], sequence: 0, now: START })
  const logs: string[] = []
  let hook: Hook = () => {}
  function boot(crash = new CrashPlan(), store: ScheduleModeStore = new JournalStore(file, crash)) {
    const ports: ScheduleModePorts = {
      listTasks: async () => { await hook('catalog', 'before'); const rows = readNative().rows; await hook('catalog', 'after'); return rows },
      createTask: async (sessionId, request) => {
        crash.hit('create', 'before'); await hook('create', 'before')
        const state = readNative()
        const id = `native-${++state.sequence}`
        const createdRule = ruleOf(request.selector)
        const scheduledAt = nextAt(createdRule, state.now)
        state.rows.push({ id, sessionId, title: request.title, prompt: request.prompt, rule: createdRule, status: 'active', scheduledAt })
        saveNative(state)
        await hook('create', 'after'); crash.hit('create', 'after')
        return { id, scheduledAt }
      },
      deleteTask: async (sessionId, id) => {
        crash.hit('delete', 'before'); await hook('delete', 'before')
        update(state => { state.rows = state.rows.filter(row => row.sessionId !== sessionId || row.id !== id) })
        await hook('delete', 'after'); crash.hit('delete', 'after')
      },
      createSession: async () => {
        crash.hit('session', 'before'); await hook('session', 'before')
        const state = readNative(); const id = `session-${++state.sequence}`; state.sessions.push(id); saveNative(state)
        await hook('session', 'after'); crash.hit('session', 'after')
        return id
      },
      inspectSession: async id => {
        await hook('inspect', 'before')
        if (readNative().archived.includes(id)) throw new Error('source archived')
        await hook('inspect', 'after')
        return { cwd: '/synthetic-workspace' }
      },
      now: () => readNative().now,
      log: (message, error) => { logs.push(`${message} ${String(error ?? '')}`) },
    }
    return { engine: new ScheduleModeEngine(store, ports), store, ports }
  }
  function deliver(id: string): void {
    update(state => {
      const due = state.rows.find(row => row.id === id)?.scheduledAt
      state.now = Math.max(state.now, due === undefined ? state.now : Date.parse(due)) + 1000
      state.rows = state.rows.map(row => row.id !== id ? row : { ...row,
        status: row.rule.kind === 'after' || row.rule.kind === 'at' ? 'inactive' : 'active',
        scheduledAt: row.rule.kind === 'after' || row.rule.kind === 'at' ? row.scheduledAt : nextAt(row.rule, Math.max(state.now, Date.parse(row.scheduledAt))),
        lastDelivery: { scheduledAt: row.scheduledAt, deliveredAt: new Date(state.now).toISOString() },
      })
    })
  }
  return { root, file, native, boot, readNative, saveNative, update, deliver, logs,
    setHook: (next: Hook) => { hook = next }, policy: () => new ScheduleModeStore(file).find('logical', 'source') }
}
async function recover(f: ReturnType<typeof rig>, rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await f.boot().engine.reconcile()
}
function assertTracked(f: ReturnType<typeof rig>): void {
  const policies = new ScheduleModeStore(f.file).list()
  for (const row of f.readNative().rows.filter(row => row.prompt.startsWith('lineage:'))) {
    const owned = policies.some(policy => (policy.armedTaskId === row.id && (policy.runSessionId === row.sessionId || policy.sourceSessionId === row.sessionId))
      || policy.transition?.created?.id === row.id
      || policy.transition?.deleteTasks.some(ref => ref.id === row.id && ref.sessionId === row.sessionId)
      || policy.transition?.phase === 'recovery-required')
    const untouchedOriginal = row.sessionId === 'source' && row.id === 'logical' && policies.length === 0
    expect(owned || untouchedOriginal, `untracked native row ${row.sessionId}/${row.id}`).toBe(true)
  }
}
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state }
}

// Expanded dimensions versus recovery.spec: disk-backed native effects, complete
// restarts for every reconcile, relative/calendar rules, and model assertions.
describe('adversarial persisted restart matrix', () => {
  for (const rule of RULES) for (const operation of ['new', 'original', 'rotate'] as const) {
    const complete = operation === 'rotate' && (rule.kind === 'after' || rule.kind === 'at')
    const effects: Effect[] = complete ? ['write', 'delete'] : operation === 'original' ? ['write', 'create', 'delete'] : ['write', 'create', 'delete', 'session']
    for (const effect of effects) for (const side of ['before', 'after'] as const) {
      const count = effect === 'write' ? complete ? 3 : operation === 'original' ? 5 : 7 : 1
      for (let occurrence = 1; occurrence <= count; occurrence++) {
        it(`${rule.kind}/${operation}: process loss ${side} ${effect} ${occurrence}, four fresh-reader reconciles`, async () => {
          const f = rig(rule)
          if (operation !== 'new') await f.boot().engine.setMode('source', 'logical', 'new')
          if (operation === 'rotate') f.deliver(f.readNative().rows[0]!.id)
          const crash = new CrashPlan(); crash.target = { effect, occurrence, side }
          const b = f.boot(crash)
          if (operation === 'rotate') await b.engine.reconcile()
          else await b.engine.setMode('source', 'logical', operation).catch(() => {})
          expect(crash.fired).toBe(true)
          await recover(f)
          expect(f.readNative().rows.length).toBeLessThanOrEqual(1)
          assertTracked(f)
          const policy = f.policy()
          if (f.readNative().rows.length === 0 && !complete) expect(policy?.transition?.phase).toBe('recovery-required')
          if (policy?.transition) {
            expect(policy.transition.phase).toBe('recovery-required')
            expect((await f.boot().engine.list()).tasks.some(task => task.recovery?.phase === 'recovery-required')).toBe(true)
            await expect(f.boot().engine.setMode('source', 'logical', 'new')).rejects.toMatchObject({ code: 'recovery-required' })
          }
        })
      }
    }
  }
})

describe('adversarial cleanup durable restart matrix', () => {
  for (const rule of RULES) for (const operation of ['stop', 'delete'] as const) {
    for (const effect of ['write', 'delete'] as const) for (const side of ['before', 'after'] as const) {
      for (let occurrence = 1; occurrence <= (effect === 'write' ? 3 : 1); occurrence++) {
        it(`${rule.kind}/${operation}: ${side} ${effect} ${occurrence} never loses cleanup tracking`, async () => {
          const f = rig(rule)
          await f.boot().engine.setMode('source', 'logical', 'new')
          const crash = new CrashPlan(); crash.target = { effect, occurrence, side }
          const b = f.boot(crash)
          await (operation === 'stop' ? b.engine.stopSession('source') : b.engine.deleteTask('source', 'logical')).catch(() => {})
          expect(crash.fired).toBe(true)
          await recover(f)
          if (effect === 'write' && occurrence === 1 && side === 'before') {
            // An intent that never committed is not a successful cancellation.
            expect(f.readNative().rows).toHaveLength(1)
            const retry = f.boot()
            await (operation === 'stop' ? retry.engine.stopSession('source') : retry.engine.deleteTask('source', 'logical'))
          }
          expect(f.readNative().rows).toHaveLength(0)
          assertTracked(f)
        })
      }
    }
  }
})

describe('adversarial deterministic seeded operation model', () => {
  for (const seed of [0x17, 0xc0ffee, 0x5eed]) {
    it(`seed ${seed}: reboots, edits, deliveries, outages, switches and same-engine cancellation`, async () => {
      const f = rig()
      const random = rng(seed)
      const trace: string[] = []
      let b = f.boot()
      for (let step = 0; step < 90; step++) {
        const choice = (random() >>> 16) % 8
        trace.push(`${step}:${choice}`)
        const policy = f.policy()
        if (choice === 0) {
          b = f.boot()
        } else if (choice === 1) {
          await b.engine.setMode('source', 'logical', 'new').catch(() => {})
        } else if (choice === 2 && policy?.active) {
          await b.engine.setMode('source', 'logical', 'original').catch(() => {})
        } else if (choice === 3 && policy?.active && policy.armedTaskId && !policy.transition) {
          f.deliver(policy.armedTaskId)
          await b.engine.reconcile()
        } else if (choice === 4) {
          const before = f.readNative().rows
          f.setHook((effect, side) => { if (effect === 'catalog' && side === 'before') throw new Error('seeded catalog outage') })
          await b.engine.reconcile()
          expect(f.readNative().rows).toEqual(before)
          f.setHook(() => {})
        } else if (choice === 5 && policy?.active && !policy.transition) {
          f.update(state => { state.rows = state.rows.map(row => row.id === policy.armedTaskId ? { ...row, title: `edit-${step}` } : row) })
          await b.engine.reconcile()
        } else if (choice === 6 && policy?.active && !policy.transition) {
          await Promise.allSettled([b.engine.setMode('source', 'logical', 'original'), b.engine.stopSession('source')])
        } else {
          await b.engine.reconcile()
        }
        expect(f.readNative().rows.length, trace.join(',')).toBeLessThanOrEqual(1)
        assertTracked(f)
        const current = f.policy()
        if (current?.active && !current.transition) {
          expect(f.readNative().rows.some(row => row.id === current.armedTaskId), trace.join(',')).toBe(true)
        }
        if (current?.transition) expect((await b.engine.list()).tasks.some(row => row.recovery !== undefined)).toBe(true)
      }
    })
  }
})

describe('adversarial seeded faults combined with operation sequences', () => {
  for (const seed of [0x517, 0xabc123, 0xdecade]) {
    it(`seed ${seed}: varied operations plus process-loss points preserve the model`, async () => {
      const random = rng(seed)
      const trace: string[] = []
      const covered = new Set<number>()
      for (let scenario = 0; scenario < 18; scenario++) {
        const f = rig(RULES[(random() >>> 16) % RULES.length]!)
        let b = f.boot()
        for (let step = 0; step < 12; step++) {
          const choice = (random() >>> 16) % 7
          covered.add(choice)
          trace.push(`${scenario}/${step}:${choice}`)
          const plan = new CrashPlan()
          if ((random() >>> 16) % 3 === 0) {
            const effects: Effect[] = ['write', 'create', 'delete', 'session']
            plan.target = { effect: effects[(random() >>> 16) % 4]!, occurrence: 1 + ((random() >>> 16) % 2), side: (random() >>> 16) % 2 ? 'after' : 'before' }
          }
          b = f.boot(plan)
          const policy = f.policy()
          if (choice === 0) await b.engine.setMode('source', 'logical', 'new').catch(() => {})
          if (choice === 1) await b.engine.setMode('source', 'logical', 'original').catch(() => {})
          if (choice === 2 && policy?.armedTaskId && policy.active && !policy.transition) { f.deliver(policy.armedTaskId); await b.engine.reconcile() }
          if (choice === 3) await b.engine.stopSession('source').catch(() => {})
          if (choice === 4) await b.engine.deleteTask('source', 'logical').catch(() => {})
          if (choice === 5) {
            f.setHook((effect, side) => { if (effect === 'catalog' && side === 'before') throw new Error('randomized catalog failure') })
            await b.engine.reconcile(); f.setHook(() => {})
          }
          if (choice === 6) await b.engine.reconcile()
          await recover(f, 3)
          expect(f.readNative().rows.length, trace.join(',')).toBeLessThanOrEqual(1)
          assertTracked(f)
          const p = f.policy()
          if (p?.transition) expect((await f.boot().engine.list()).tasks.some(row => row.recovery !== undefined), trace.join(',')).toBe(true)
        }
      }
      expect(covered.size).toBe(7)
    })
  }
})

describe('adversarial ownership, cancellation and native delivery races', () => {
  for (const cancel of ['delete', 'stop'] as const) {
    it(`same-engine ${cancel} queued behind slow session creation leaves no running copy`, async () => {
      const f = rig(); const b = f.boot()
      let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve })
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
      f.setHook(async (effect, side) => { if (effect === 'session' && side === 'before') { entered(); await gate } })
      const arming = b.engine.setMode('source', 'logical', 'new')
      await waiting
      const cancelling = cancel === 'delete' ? b.engine.deleteTask('source', 'logical') : b.engine.stopSession('source')
      release(); await arming; await cancelling
      f.setHook(() => {}); await recover(f)
      expect(f.readNative().rows).toHaveLength(0)
    })
  }

  for (const rule of RULES) {
    it(`${rule.kind}: native delivery while create result is returning remains tracked through restarts`, async () => {
      const f = rig(rule)
      let first = true
      f.setHook((effect, side) => {
        if (first && effect === 'create' && side === 'after') { first = false; f.deliver(f.readNative().rows[0]!.id) }
      })
      await f.boot().engine.setMode('source', 'logical', 'new')
      f.setHook(() => {}); await recover(f)
      expect(f.policy()?.runs).toHaveLength(1)
      expect(f.readNative().rows.length).toBe(rule.kind === 'after' || rule.kind === 'at' ? 0 : 1)
      assertTracked(f)
    })
  }

  it('already-delivered after task cannot be replayed by switching before the changed event is reconciled', async () => {
    const f = rig(RULES[0]!); const b = f.boot()
    await b.engine.setMode('source', 'logical', 'new')
    f.deliver(f.readNative().rows[0]!.id)
    // No race inside the port: the very first disarm catalog already contains
    // inactive + lastDelivery, before a pending schedule/changed handler runs.
    await b.engine.setMode('source', 'logical', 'original').catch(() => {})
    await recover(f)
    expect(f.readNative().rows.filter(row => row.status === 'active')).toHaveLength(0)
    expect(f.policy()?.runs).toHaveLength(1)
  })

  it('slow session creation crossing at deadline and archive keeps explicit pending cancellation', async () => {
    const f = rig(RULES[3]!); const b = f.boot()
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    f.setHook(async (effect, side) => { if (effect === 'session' && side === 'before') { entered(); await gate } })
    const arming = b.engine.setMode('source', 'logical', 'new').then(() => 'success', () => 'error')
    await waiting
    f.update(state => { state.archived.push('source'); state.now += 120_000 })
    const stopping = b.engine.stopSession('source').then(() => 'success', () => 'error')
    release()
    expect(await arming).toBe('error')
    expect(await stopping).toBe('error')
    f.setHook(() => {}); await recover(f)
    expect(f.readNative().rows).toHaveLength(0)
    expect((await f.boot().engine.list()).tasks[0]?.recovery?.phase).toBe('recovery-required')
  })

  it('after: delivery committed just before deletion cannot be replayed as a fresh one-shot', async () => {
    const f = rig(RULES[0]!); const b = f.boot()
    await b.engine.setMode('source', 'logical', 'new')
    const copy = f.readNative().rows[0]!
    f.setHook((effect, side) => { if (effect === 'delete' && side === 'before') f.deliver(copy.id) })
    await b.engine.setMode('source', 'logical', 'original').catch(() => {})
    f.setHook(() => {}); await recover(f)
    expect(f.readNative().rows.filter(row => row.status === 'active')).toHaveLength(0)
  })

  it('two independent engines cannot both successfully arm the same logical task', async () => {
    const f = rig()
    const a = f.boot(); const b = f.boot()
    a.store.load(); b.store.load()
    const outcomes = await Promise.allSettled([a.engine.setMode('source', 'logical', 'new'), b.engine.setMode('source', 'logical', 'new')])
    await recover(f)
    expect(f.readNative().rows.length, JSON.stringify({ outcomes: outcomes.map(result => result.status), rows: f.readNative().rows, policies: new ScheduleModeStore(f.file).list() })).toBeLessThanOrEqual(1)
    assertTracked(f)
  })

  it('a stale store cannot erase an unrelated already-armed policy on its next write', async () => {
    const f = rig()
    f.update(state => { state.rows.push({ ...state.rows[0]!, sessionId: 'other-source', id: 'second', prompt: 'lineage:second' }) })
    const a = f.boot(); const b = f.boot()
    a.store.load(); b.store.load()
    await a.engine.setMode('source', 'logical', 'new')
    await b.engine.setMode('other-source', 'second', 'new')
    expect(new ScheduleModeStore(f.file).list(), JSON.stringify({ rows: f.readNative().rows, policies: new ScheduleModeStore(f.file).list() })).toHaveLength(2)
    await recover(f)
    assertTracked(f)
  })

  it('cross-engine stop during a slow create must not return success and then resurrect its source', async () => {
    const f = rig()
    const a = f.boot(); const b = f.boot()
    a.store.load(); b.store.load()
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    f.setHook(async (effect, side) => { if (effect === 'session' && side === 'before') { entered(); await gate } })
    const arming = a.engine.setMode('source', 'logical', 'new')
    await waiting
    f.update(state => { state.archived.push('source') })
    const stopped = await b.engine.stopSession('source').then(() => true, () => false)
    release(); await arming.catch(() => {})
    f.setHook(() => {})
    await recover(f)
    expect(stopped && f.readNative().rows.some(row => row.status === 'active')).toBe(false)
  })

  for (const rule of [RULES[0]!, RULES[1]!, RULES[2]!]) {
    it(`${rule.kind}: a confirmed native delivery between snapshot and delete is not erased from history`, async () => {
      const f = rig(rule)
      const b = f.boot()
      await b.engine.setMode('source', 'logical', 'new')
      const copy = f.readNative().rows[0]!
      let delivered = false
      f.setHook((effect, side) => {
        if (effect === 'delete' && side === 'before' && !delivered) { delivered = true; f.deliver(copy.id) }
      })
      await b.engine.setMode('source', 'logical', 'original').catch(() => {})
      f.setHook(() => {})
      await recover(f)
      const policy = f.policy()!
      expect(policy.runs.some(run => run.taskId === copy.id) || policy.transition?.phase === 'recovery-required').toBe(true)
      if (rule.kind === 'after') expect(f.readNative().rows.filter(row => row.status === 'active')).toHaveLength(0)
    })
  }

  it('source inspection reporting archive cannot silently inherit defaults and arm a task', async () => {
    const f = rig()
    f.update(state => { state.archived.push('source') })
    const result = await f.boot().engine.setMode('source', 'logical', 'new').then(() => 'success', () => 'error')
    expect(result).toBe('error')
    expect(f.readNative().rows.some(row => row.sessionId !== 'source')).toBe(false)
  })
})

describe('adversarial malformed persistence and external results', () => {
  for (const transition of [null, { kind: 'future', phase: 'prepare', deleteTasks: [] }, { kind: 'new', phase: 'future', deleteTasks: [] }]) {
    it(`unrecognized transition ${JSON.stringify(transition)} is visible and never recreated`, async () => {
      const f = rig(); await f.boot().engine.setMode('source', 'logical', 'new')
      const json = JSON.parse(readFileSync(f.file, 'utf8'))
      json.policies[policyKey('source', 'logical')].transition = transition
      writeFileSync(f.file, JSON.stringify(json))
      const before = f.readNative()
      await recover(f)
      expect(f.readNative()).toEqual(before)
      expect((await f.boot().engine.list()).tasks[0]?.recovery?.phase).toBe('recovery-required')
    })
  }

  it('semantically invalid cleanup-created journal cannot forget a known live task', async () => {
    const f = rig(); await f.boot().engine.setMode('source', 'logical', 'new')
    const policy = f.policy()!; const row = f.readNative().rows[0]!
    new ScheduleModeStore(f.file).upsert({ ...policy, transition: { kind: 'stop', phase: 'created', deleteTasks: [], created: { id: row.id, sessionId: row.sessionId, scheduledAt: row.scheduledAt } } })
    await recover(f)
    const view = (await f.boot().engine.list()).tasks.find(task => task.id === 'logical')
    expect(f.readNative().rows.length === 0 || view?.recovery !== undefined).toBe(true)
    assertTracked(f)
  })

  for (const text of ['{"policies":', '{"formatVersion":999,"policies":null}']) {
    it(`damaged journal ${text} does not masquerade as an ordinary unmanaged task`, async () => {
      const f = rig(); await f.boot().engine.setMode('source', 'logical', 'new')
      writeFileSync(f.file, text)
      await recover(f)
      const result = await f.boot().engine.list()
      expect(result.available === false || result.tasks.some(task => task.recovery !== undefined)).toBe(true)
      expect(f.readNative().rows).toHaveLength(1)
    })
  }

  it('an invalid native status is not treated as proof that a managed task was user-deleted', async () => {
    const f = rig(); await f.boot().engine.setMode('source', 'logical', 'new')
    const actual = f.readNative().rows[0]!
    const b = f.boot()
    const malformed = { ...actual, kind: 'every', everySeconds: 60, status: 'delivering' }
    const ports = { ...b.ports, listTasks: async () => [malformed].map(nativeTaskView).filter((row): row is NativeTaskView => row !== undefined) }
    const engine = new ScheduleModeEngine(b.store, ports)
    await engine.reconcile()
    const policy = f.policy()!
    expect(policy.endedReason).not.toBe('deleted')
    expect(policy.active || policy.transition !== undefined).toBe(true)
  })

  for (const bad of ['empty-id', 'duplicate-id', 'empty-session'] as const) {
    it(`${bad}: native create result cannot be committed as successful unambiguous ownership`, async () => {
      const f = rig(); const b = f.boot()
      const ports = { ...b.ports,
        ...(bad === 'empty-session' ? { createSession: async () => '' } : {}),
        createTask: async (sessionId: string, request: NativeCreateRequest) => {
          const created = await b.ports.createTask(sessionId, request)
          if (bad === 'empty-session') return created
          const id = bad === 'empty-id' ? '' : 'collision'
          f.update(state => {
            state.rows = state.rows.map(row => row.id === created.id ? { ...row, id } : row)
            if (bad === 'duplicate-id') state.rows.push({ ...state.rows[0]!, sessionId: 'foreign', prompt: 'foreign-task' })
          })
          return { ...created, id }
        },
      }
      const result = await new ScheduleModeEngine(b.store, ports).setMode('source', 'logical', 'new').then(() => 'success', () => 'error')
      await recover(f)
      expect(result === 'error' || f.policy()?.transition?.phase === 'recovery-required').toBe(true)
    })
  }
})
