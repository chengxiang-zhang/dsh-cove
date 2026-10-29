/**
 * schedule-mode 引擎单测：轮转语义、一次性任务收尾、切回原会话、删除/归档、
 * 幂等收敛与崩溃恢复。全部通过假件驱动，不依赖 DSH 运行时。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ruleFromRecord, type NativeTaskView } from '../src/core/schedule-mode/native.ts'
import type { NativeCreateRequest, ScheduleModeRule } from '../src/core/schedule-mode/types.ts'
import { ScheduleModeEngine } from '../src/host/services/schedule-mode/engine.ts'
import { ScheduleModeStore } from '../src/host/services/schedule-mode/store.ts'

/** 每个用例一个临时目录，跑完统一删除（不往 /tmp 堆垃圾）。 */
const tempDirs: string[] = []
function tempStorePath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return join(dir, 'store.json')
}
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

/** 把 selector 还原成规则（测试假件的 create 用）。 */
function ruleFromSelector(selector: NativeCreateRequest['selector']): ScheduleModeRule {
  if ('after_seconds' in selector) return { kind: 'after', afterSeconds: selector.after_seconds }
  if ('at' in selector) return { kind: 'at', at: selector.at }
  if ('every_seconds' in selector) return { kind: 'every', everySeconds: selector.every_seconds }
  if ('daily' in selector) return { kind: 'daily', time: selector.daily.time, timeZone: selector.daily.time_zone }
  if ('weekly' in selector) return { kind: 'weekly', time: selector.weekly.time, timeZone: selector.weekly.time_zone, weekdays: selector.weekly.weekdays }
  return { kind: 'cron', expression: selector.cron.expression, timeZone: selector.cron.time_zone }
}

interface FakeOptions {
  now?: number
  historyLimit?: number
}

/** 原生 schedule + 会话服务的假件：记录目录与新建会话。 */
class FakePorts {
  rows: NativeTaskView[] = []
  createdSessions: string[] = []
  renamed: Array<{ sessionId: string; title: string }> = []
  attached: Array<{ sessionId: string; cwd?: string }> = []
  deleted: string[] = []
  headers = new Map<string, { cwd?: string; agentPreset?: string }>()
  nowMs: number
  private seq = 0

  constructor(options: FakeOptions = {}) {
    this.nowMs = options.now ?? Date.parse('2026-10-09T00:00:00.000Z')
    void options
  }

  /** 预置一条原生任务。 */
  seed(row: Partial<NativeTaskView> & { id: string; sessionId: string; rule: ScheduleModeRule }): NativeTaskView {
    const task: NativeTaskView = {
      status: 'active',
      title: row.title ?? 'Daily digest',
      prompt: row.prompt ?? 'summarize the repo',
      scheduledAt: row.scheduledAt ?? new Date(this.nowMs + 3_600_000).toISOString(),
      ...row,
    }
    this.rows.push(task)
    return task
  }

  /** 模拟原生投递一次：一次性任务变 inactive，周期任务推进时点并写入回执。 */
  deliver(id: string, at = new Date(this.nowMs).toISOString()): void {
    const row = this.rows.find(candidate => candidate.id === id)
    if (row === undefined) throw new Error(`no row ${id}`)
    const next = new Date(Date.parse(row.scheduledAt) + 3_600_000).toISOString()
    const recurring = row.rule.kind !== 'at' && row.rule.kind !== 'after'
    const updated: NativeTaskView = {
      ...row,
      status: recurring ? 'active' : 'inactive',
      scheduledAt: recurring ? next : row.scheduledAt,
      lastDelivery: { scheduledAt: row.scheduledAt, deliveredAt: at },
    }
    this.rows = this.rows.map(candidate => candidate.id === id ? updated : candidate)
  }

  /** 模拟用户在原生任务页/原生工具上改副本（标题 / prompt / 规则 / 时点）。 */
  editArmed(id: string, patch: { rule?: ScheduleModeRule; title?: string; prompt?: string; scheduledAt?: string }): void {
    const row = this.rows.find(candidate => candidate.id === id)
    if (row === undefined) throw new Error(`no row ${id}`)
    const updated: NativeTaskView = {
      ...row,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
      ...(patch.rule === undefined ? {} : { rule: patch.rule }),
      ...(patch.scheduledAt === undefined ? {} : { scheduledAt: patch.scheduledAt }),
    }
    this.rows = this.rows.map(candidate => candidate.id === id ? updated : candidate)
  }

  readonly ports = {
    listTasks: async (): Promise<NativeTaskView[]> => this.rows.map(row => ({ ...row })),
    createTask: async (sessionId: string, request: NativeCreateRequest): Promise<{ id: string; scheduledAt: string }> => {
      this.seq += 1
      const id = `task-${this.seq}`
      const rule = ruleFromSelector(request.selector)
      const scheduledAt = rule.kind === 'at' ? rule.at : new Date(this.nowMs + 3_600_000).toISOString()
      this.rows.push({ sessionId, id, status: 'active', title: request.title, prompt: request.prompt, scheduledAt, rule })
      return { id, scheduledAt }
    },
    deleteTask: async (sessionId: string, id: string): Promise<void> => {
      this.deleted.push(`${sessionId}/${id}`)
      this.rows = this.rows.filter(row => !(row.id === id && row.sessionId === sessionId))
    },
    inspectSession: async (sessionId: string): Promise<{ cwd?: string; agentPreset?: string }> => this.headers.get(sessionId) ?? {},
    createSession: async (): Promise<string> => {
      const sessionId = `run-${this.createdSessions.length + 1}`
      this.createdSessions.push(sessionId)
      this.headers.set(sessionId, this.headers.get('source') ?? {})
      return sessionId
    },
    renameSession: async (sessionId: string, title: string): Promise<void> => { this.renamed.push({ sessionId, title }) },
    attachSession: async (sessionId: string, cwd?: string): Promise<void> => { this.attached.push({ sessionId, ...(cwd === undefined ? {} : { cwd }) }) },
    now: (): number => this.nowMs,
    log: (): void => {},
    runHistoryLimit: 5,
  }
}

function makeEngine(options: FakeOptions = {}): { engine: ScheduleModeEngine; fake: FakePorts; store: ScheduleModeStore } {
  const fake = new FakePorts(options)
  const store = new ScheduleModeStore(tempStorePath('dsh-schedule-mode-test-'))
  const engine = new ScheduleModeEngine(store, {
    ...fake.ports,
    ...(options.historyLimit === undefined ? {} : { runHistoryLimit: options.historyLimit }),
  })
  return { engine, fake, store }
}

const SOURCE = 'source'

describe('schedule-mode engine', () => {
  it('adopts a task: arms a copy on a new run session and removes the original row', async () => {
    const { engine, fake } = makeEngine()
    fake.headers.set(SOURCE, { cwd: '/repo', agentPreset: 'code-vibe' })
    const seeded = fake.seed({ id: 'task-original', sessionId: SOURCE, rule: { kind: 'daily', time: '09:00:00.000', timeZone: 'Asia/Shanghai' } })

    const view = await engine.setMode(SOURCE, seeded.id, 'new')
    expect(view.mode).toBe('new')
    expect(view.id).toBe('task-original')
    expect(fake.createdSessions).toEqual(['run-1'])
    expect(fake.renamed).toEqual([{ sessionId: 'run-1', title: 'Daily digest · #1' }])
    // 原行被撤掉，只剩挂在运行会话上的副本。
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]?.sessionId).toBe('run-1')
    expect(fake.rows[0]?.rule).toEqual({ kind: 'daily', time: '09:00:00.000', timeZone: 'Asia/Shanghai' })
    expect(fake.deleted).toContain(`${SOURCE}/task-original`)
    expect(view.runSessionId).toBe('run-1')
    expect(view.runs).toHaveLength(0)
  })

  it('inherits the source cwd when creating the run session', async () => {
    const { engine, fake } = makeEngine()
    fake.headers.set(SOURCE, { cwd: '/repo/sub' })
    const seeded = fake.seed({ id: 'task-cwd', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    const contexts: Array<{ cwd?: string }> = []
    const engineWithProbe = new ScheduleModeEngine(
      new ScheduleModeStore(tempStorePath('dsh-schedule-mode-cwd-')),
      { ...fake.ports, createSession: async (input: { cwd?: string }) => { contexts.push(input); return `run-${contexts.length}` } },
    )
    await engineWithProbe.setMode(SOURCE, seeded.id, 'new')
    expect(contexts[0]?.cwd).toBe('/repo/sub')
    void engine
  })

  it('rotates to a fresh session after each recurring delivery', async () => {
    const { engine, fake } = makeEngine()
    fake.headers.set(SOURCE, { cwd: '/repo' })
    const seeded = fake.seed({ id: 'task-rotate', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    const armed = fake.rows[0]
    expect(armed?.sessionId).toBe('run-1')

    // 原生投递一轮：回执 + 时点推进。
    fake.deliver(armed?.id as string, '2026-10-09T01:00:00.000Z')
    await engine.reconcile()

    const listed = await engine.list()
    const view = listed.tasks.find(task => task.id === 'task-rotate')
    expect(view?.runs).toHaveLength(1)
    expect(view?.runs[0]?.sessionId).toBe('run-1')
    expect(view?.runSessionId).toBe('run-2')
    expect(fake.createdSessions).toEqual(['run-1', 'run-2'])
    // 旧副本已撤，只剩新副本。
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]?.sessionId).toBe('run-2')
    expect(fake.rows[0]?.status).toBe('active')
  })

  it('is idempotent: repeated reconcile after one delivery records a single run', async () => {
    const { engine, fake } = makeEngine()
    const seeded = fake.seed({ id: 'task-idem', sessionId: SOURCE, rule: { kind: 'daily', time: '09:00:00.000', timeZone: 'UTC' } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    const armed = fake.rows[0]
    fake.deliver(armed?.id as string, '2026-10-09T01:00:00.000Z')
    await engine.reconcile()
    await engine.reconcile()
    await engine.reconcile()
    const listed = await engine.list()
    const view = listed.tasks.find(task => task.id === 'task-idem')
    expect(view?.runs).toHaveLength(1)
    expect(fake.createdSessions).toHaveLength(2)
  })

  it('completes a one-shot task, keeps its run history and drops the internal row', async () => {
    const { engine, fake } = makeEngine()
    const target = new Date(Date.parse('2026-10-09T02:00:00.000Z')).toISOString()
    const seeded = fake.seed({ id: 'task-once', sessionId: SOURCE, rule: { kind: 'at', at: target }, scheduledAt: target })
    await engine.setMode(SOURCE, seeded.id, 'new')
    const armed = fake.rows[0]
    fake.deliver(armed?.id as string, target)
    await engine.reconcile()

    // 一次性任务的原子（`at`）在投递后不再可挂：内部行被清掉，策略留在历史里。
    expect(fake.rows).toHaveLength(0)
    const listed = await engine.list()
    const view = listed.tasks.find(task => task.id === 'task-once')
    expect(view?.status).toBe('ended')
    expect(view?.mode).toBe('original')
    expect(view?.runs).toHaveLength(1)
    expect(view?.runs[0]?.sessionId).toBe('run-1')
    expect(fake.createdSessions).toEqual(['run-1'])
    // 一次性任务同样在投递后才把运行会话挂回工作区。
    expect(fake.attached).toEqual([{ sessionId: 'run-1' }])
  })

  it('restores the original conversation and re-arms a native row there', async () => {
    const { engine, fake } = makeEngine()
    const seeded = fake.seed({ id: 'task-back', sessionId: SOURCE, rule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    expect(fake.rows[0]?.sessionId).toBe('run-1')

    const view = await engine.setMode(SOURCE, seeded.id, 'original')
    expect(view.mode).toBe('original')
    expect(view.status).toBe('active')
    // 副本撤掉，原会话上重新挂了一把同规则任务。
    expect(fake.createdSessions).toEqual(['run-1'])
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]?.sessionId).toBe(SOURCE)
    expect(fake.rows[0]?.rule).toEqual({ kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' })
    // 列表里这条任务只出现一次，并保留原有运行历史。
    const listed = await engine.list()
    expect(listed.tasks.filter(task => task.id === 'task-back')).toHaveLength(1)
    expect(listed.tasks.find(task => task.id === 'task-back')?.mode).toBe('original')
  })

  it('keeps one logical row after a round trip new -> original -> new', async () => {
    const { engine, fake } = makeEngine()
    const seeded = fake.seed({ id: 'task-round', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    await engine.setMode(SOURCE, seeded.id, 'original')
    const armed = fake.rows[0]
    const again = await engine.setMode(SOURCE, seeded.id, 'new')
    expect(again.mode).toBe('new')
    expect(again.activeTaskId).toBe(fake.rows[0]?.id)
    expect(armed).toBeDefined()
    const listed = await engine.list()
    expect(listed.tasks.filter(task => task.id === 'task-round')).toHaveLength(1)
    expect(listed.tasks).toHaveLength(1)
  })

  it('resolves an internal run-copy id back to its logical task', async () => {
    const { engine, fake } = makeEngine()
    const seeded = fake.seed({ id: 'task-copy-id', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    const copyId = fake.rows[0]?.id as string
    // 用副本 id 再切一次运行方式：应归一到同一条逻辑任务，不新建第二条策略。
    const switched = await engine.setMode(SOURCE, copyId, 'original')
    expect(switched.id).toBe('task-copy-id')
    expect(switched.mode).toBe('original')
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]?.sessionId).toBe(SOURCE)
    expect((await engine.list()).tasks).toHaveLength(1)
  })

  it('rejects switching an already finished one-shot task', async () => {
    const { engine, fake } = makeEngine()
    fake.seed({ id: 'task-done', sessionId: SOURCE, status: 'inactive', rule: { kind: 'at', at: '2026-10-08T00:00:00.000Z' } })
    await expect(engine.setMode(SOURCE, 'task-done', 'new')).rejects.toMatchObject({ code: 'task-ended' })
  })

  it('fails closed for an ambiguous v1 rotationInFlight journal', async () => {
    const { engine, fake, store } = makeEngine()
    const seeded = fake.seed({ id: 'task-crash', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    const armedId = fake.rows[0]?.id as string
    // 模拟真实的中途崩溃：投递已记录（run-1 落在 runs 里）、「轮转中」标记已落盘、旧副本已删。
    const policy = store.find('task-crash', SOURCE) as NonNullable<ReturnType<typeof store.find>>
    expect(policy.rotationInFlight).toBeUndefined()
    store.upsert({
      ...policy,
      runs: [{ scheduledAt: '2026-10-09T01:00:00.000Z', deliveredAt: '2026-10-09T01:00:00.000Z', sessionId: 'run-1', taskId: armedId }],
      lastDeliveredAt: '2026-10-09T01:00:00.000Z',
      rotationInFlight: true,
      armedTaskId: 'task-gone',
    })
    fake.rows = []
    await engine.reconcile()
    expect(fake.createdSessions).toEqual(['run-1'])
    expect(fake.rows).toHaveLength(0)
    expect(store.find('task-crash', SOURCE)?.transition?.phase).toBe('recovery-required')
    expect(store.find('task-crash', SOURCE)?.runs).toHaveLength(1)
    await expect(engine.setMode(SOURCE, seeded.id, 'new')).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('fails closed for a v1 pending arm without a create association', async () => {
    const { engine, fake, store } = makeEngine()
    const seeded = fake.seed({ id: 'task-pending', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    const policy = store.find('task-pending', SOURCE) as NonNullable<ReturnType<typeof store.find>>
    // 模拟 setMode 在「先落策略」与「挂上副本」之间中断：策略 active、没有 armedTaskId，
    // 也还没有任何运行会话（否则就是下一条用例的复用场景）。
    store.upsert({ ...policy, armedTaskId: undefined, runSessionId: undefined })
    fake.rows = []
    await engine.reconcile()
    expect(fake.createdSessions).toEqual(['run-1'])
    expect(fake.rows).toHaveLength(0)
    expect(store.find('task-pending', SOURCE)?.transition?.phase).toBe('recovery-required')
  })

  it('does not guess a v1 create outcome from an empty pending run session', async () => {
    const { engine, fake, store } = makeEngine()
    const seeded = fake.seed({ id: 'task-reuse', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    // 模拟：运行会话已建好并已落盘，但副本还没挂上就中断了。
    const policy = store.find('task-reuse', SOURCE) as NonNullable<ReturnType<typeof store.find>>
    expect(policy.runSessionId).toBe('run-1')
    store.upsert({ ...policy, armedTaskId: undefined })
    fake.rows = []
    await engine.reconcile()
    expect(fake.createdSessions).toEqual(['run-1'])
    expect(fake.rows).toHaveLength(0)
    expect(store.find('task-reuse', SOURCE)?.transition?.phase).toBe('recovery-required')
  })

  it('attaches a run session to its workspace only after the first delivery', async () => {
    const { engine, fake } = makeEngine()
    fake.headers.set(SOURCE, { cwd: '/repo' })
    const seeded = fake.seed({ id: 'task-attach', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    // 待运行期间不入工作区：工作区里的空会话会被 DSH 的「新建会话」当成草稿复用。
    expect(fake.attached).toEqual([])
    const armed = fake.rows[0] as NativeTaskView
    fake.deliver(armed.id, '2026-10-09T01:00:00.000Z')
    await engine.reconcile()
    expect(fake.attached).toEqual([{ sessionId: 'run-1', cwd: '/repo' }])
  })

  it('retires the policy instead of rebuilding when the run copy was deleted by the user', async () => {
    const { engine, fake, store } = makeEngine()
    const seeded = fake.seed({ id: 'task-user-del', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    // 模拟：用户在原生自动化页把运行会话上的副本删掉（引擎没有标记）；目录里仍有其它任务。
    fake.rows = []
    fake.seed({ id: 'task-other', sessionId: 'elsewhere', rule: { kind: 'every', everySeconds: 3600 } })
    await engine.reconcile()
    await engine.reconcile()
    expect(fake.createdSessions).toEqual(['run-1'])
    expect(fake.rows.map(row => row.id)).toEqual(['task-other'])
    const retired = store.find('task-user-del', SOURCE)
    expect(retired?.active).toBe(false)
    expect(retired?.endedReason).toBe('deleted')
    expect(retired?.armedTaskId).toBeUndefined()
    expect((await engine.list()).tasks.map(task => task.id)).toEqual(['task-other'])
    // 退役后不能被切换复活。
    await expect(engine.setMode(SOURCE, 'task-user-del', 'new')).rejects.toMatchObject({ code: 'unknown-task' })
  })

  it('retires the policy when the native catalog is confirmed empty (the user deleted every task)', async () => {
    const { engine, fake, store } = makeEngine()
    const seeded = fake.seed({ id: 'task-empty', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    expect(store.find('task-empty', SOURCE)?.armedTaskId).toBeDefined()
    // 用户在原生自动化页把任务删光：目录持续为空（二次读取仍是空）→ 判定为删除，退役。
    fake.rows = []
    await engine.reconcile()
    const retired = store.find('task-empty', SOURCE)
    expect(retired?.active).toBe(false)
    expect(retired?.endedReason).toBe('deleted')
    expect(retired?.armedTaskId).toBeUndefined()
    // 不再复活：没有新会话、没有新副本。
    expect(fake.createdSessions).toEqual(['run-1'])
    expect(fake.rows).toHaveLength(0)
  })

  it('keeps the policy when an empty catalog read is not confirmed yet', async () => {
    const { engine, fake, store } = makeEngine()
    const seeded = fake.seed({ id: 'task-race', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    // 首次读到空（启动瞬间），再读已经就绪 → 视为未确认，保留策略。
    let reads = 0
    const live = { ...seeded }
    const racing = new ScheduleModeEngine(store, {
      ...fake.ports,
      listTasks: async () => {
        reads += 1
        return reads === 1 ? [] : [live]
      },
    })
    await racing.reconcile()
    const kept = store.find('task-race', SOURCE)
    expect(kept?.active).toBe(true)
    expect(kept?.endedReason).toBeUndefined()
    expect(reads).toBeGreaterThanOrEqual(2)
  })

  it('self-heals on the read path: list() retires a policy whose run copy is gone', async () => {
    const { engine, fake, store } = makeEngine()
    const seeded = fake.seed({ id: 'task-heal', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    fake.rows = []
    const listed = await engine.list()
    expect(listed.tasks).toHaveLength(0)
    expect(store.find('task-heal', SOURCE)?.endedReason).toBe('deleted')
  })

  it('resolves (runSessionId, logicalId) for setMode and deleteTask', async () => {
    const { engine, fake, store } = makeEngine()
    const seeded = fake.seed({ id: 'task-logical', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    const back = await engine.setMode('run-1', 'task-logical', 'original')
    expect(back.id).toBe('task-logical')
    expect(back.sessionId).toBe(SOURCE)
    expect(back.mode).toBe('original')
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]?.sessionId).toBe(SOURCE)
    expect(store.list()).toHaveLength(1)

    await engine.setMode(SOURCE, seeded.id, 'new')
    const runSessionId = store.find('task-logical', SOURCE)?.runSessionId as string
    expect(await engine.deleteTask(runSessionId, 'task-logical')).toBe(true)
    expect(fake.rows).toHaveLength(0)
    expect(store.list()).toHaveLength(0)
  })

  it('does not retire policies when the native catalog cannot be read', async () => {
    const { engine, fake, store } = makeEngine()
    const seeded = fake.seed({ id: 'task-blind', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    const blind = new ScheduleModeEngine(store, {
      ...fake.ports,
      listTasks: async () => { throw new Error('catalog down') },
    })
    await blind.reconcile()
    expect(store.find('task-blind', SOURCE)?.active).toBe(true)
    expect(fake.createdSessions).toEqual(['run-1'])
  })

  it('retains the rotation intent and blocks retry after an unknown session create outcome', async () => {
    const { engine, fake, store } = makeEngine()
    const seeded = fake.seed({ id: 'task-flag', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    const armed = fake.rows[0] as NativeTaskView
    fake.deliver(armed.id, '2026-10-09T01:00:00.000Z')
    // 第二条运行会话建不出来：旧副本已删、新副本未挂，标记必须已落盘。
    const failing = new ScheduleModeEngine(store, {
      ...fake.ports,
      createSession: async () => { throw new Error('session service down') },
    })
    await failing.reconcile()
    expect(fake.rows).toHaveLength(0)
    const stuck = store.find('task-flag', SOURCE)
    expect(stuck?.active).toBe(true)
    expect(stuck?.transition?.kind).toBe('rotate')
    expect(stuck?.transition?.phase).toBe('creating-session')
    expect(stuck?.runs).toHaveLength(1)
    await engine.reconcile()
    expect(fake.rows).toHaveLength(0)
    const blocked = store.find('task-flag', SOURCE)
    expect(blocked?.transition?.phase).toBe('recovery-required')
    expect(blocked?.runs).toHaveLength(1)
  })

  it('deletes by (runSessionId, armedTaskId) and does not rebuild afterwards', async () => {
    const { engine, fake, store } = makeEngine()
    const seeded = fake.seed({ id: 'task-run-del', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    const armed = fake.rows[0] as NativeTaskView
    expect(armed.sessionId).toBe('run-1')
    expect(await engine.deleteTask('run-1', armed.id)).toBe(true)
    expect(fake.rows).toHaveLength(0)
    expect(store.list()).toHaveLength(0)
    await engine.reconcile()
    expect(fake.createdSessions).toEqual(['run-1'])
    expect(fake.rows).toHaveLength(0)
    expect((await engine.list()).tasks).toHaveLength(0)
  })

  it('accepts (sourceSessionId, armedTaskId) and (runSessionId, armedTaskId) for setMode and delete', async () => {
    const { engine, fake } = makeEngine()
    const seeded = fake.seed({ id: 'task-ids', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    const armedId = (fake.rows[0] as NativeTaskView).id
    const back = await engine.setMode('run-1', armedId, 'original')
    expect(back.id).toBe('task-ids')
    expect(back.sessionId).toBe(SOURCE)
    expect(back.mode).toBe('original')
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]?.sessionId).toBe(SOURCE)

    await engine.setMode(SOURCE, seeded.id, 'new')
    const rotatedId = (fake.rows[0] as NativeTaskView).id
    expect(await engine.deleteTask(SOURCE, rotatedId)).toBe(true)
    expect(fake.rows).toHaveLength(0)
  })

  it('deletes a managed task together with its run copy', async () => {
    const { engine, fake } = makeEngine()
    const seeded = fake.seed({ id: 'task-del', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    expect(await engine.deleteTask(SOURCE, seeded.id)).toBe(true)
    expect(fake.rows).toHaveLength(0)
    const listed = await engine.list()
    expect(listed.tasks).toHaveLength(0)
  })

  it('deletes a plain native task through the same entry', async () => {
    const { engine, fake } = makeEngine()
    fake.seed({ id: 'task-plain', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    expect(await engine.deleteTask(SOURCE, 'task-plain')).toBe(true)
    expect(fake.rows).toHaveLength(0)
    expect(await engine.deleteTask(SOURCE, 'task-missing')).toBe(false)
  })

  it('stops managed tasks when their original conversation is archived', async () => {
    const { engine, fake } = makeEngine()
    const seeded = fake.seed({ id: 'task-stop', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    await engine.stopSession(SOURCE)
    expect(fake.rows).toHaveLength(0)
    const view = (await engine.list()).tasks.find(task => task.id === 'task-stop')
    expect(view?.status).toBe('ended')
  })

  it('reports the native service as unavailable instead of failing the list', async () => {
    const store = new ScheduleModeStore(tempStorePath('dsh-schedule-mode-unavailable-'))
    const engine = new ScheduleModeEngine(store, {
      listTasks: async () => { throw new Error('no schedule service') },
      createTask: async () => { throw new Error('unused') },
      deleteTask: async () => {},
      inspectSession: async () => ({}),
      createSession: async () => 'run',
      now: () => 0,
      log: () => {},
    })
    expect(await engine.list()).toEqual({ tasks: [], available: false })
  })

  it('trims run history to the configured limit', async () => {
    const { engine, fake } = makeEngine()
    const seeded = fake.seed({ id: 'task-trim', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 3600 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    for (let index = 0; index < 8; index += 1) {
      const armed = fake.rows[0]
      fake.deliver(armed?.id as string, new Date(Date.parse('2026-10-09T01:00:00.000Z') + index * 3_600_000).toISOString())
      await engine.reconcile()
    }
    const view = (await engine.list()).tasks.find(task => task.id === 'task-trim')
    expect(view?.runs.length).toBe(5)
  })

  it('adopts a native-side interval edit so the next rotation keeps it', async () => {
    const { engine, fake } = makeEngine()
    const seeded = fake.seed({ id: 'task-edit', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 120 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    // 用户在原生任务页把间隔改成 600 秒（原生 update 同时会重排时点）。
    fake.editArmed(fake.rows[0]?.id as string, {
      rule: { kind: 'every', everySeconds: 600 },
      scheduledAt: '2026-10-09T05:00:00.000Z',
    })

    await engine.reconcile()
    const adopted = (await engine.list()).tasks.find(task => task.id === 'task-edit')
    expect(adopted?.rule).toEqual({ kind: 'every', everySeconds: 600 })

    // 下一次投递后的轮转副本仍保持新间隔（不再被策略快照覆盖）。
    fake.deliver(fake.rows[0]?.id as string, '2026-10-09T05:00:01.000Z')
    await engine.reconcile()
    expect(fake.rows[0]?.rule).toEqual({ kind: 'every', everySeconds: 600 })
    const after = (await engine.list()).tasks.find(task => task.id === 'task-edit')
    expect(after?.rule).toEqual({ kind: 'every', everySeconds: 600 })
  })

  it('does not rotate or open a new session for a native-side edit alone', async () => {
    const { engine, fake } = makeEngine()
    const seeded = fake.seed({ id: 'task-nochurn', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 120 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    const sessionsBefore = fake.createdSessions.length
    const armedId = fake.rows[0]?.id as string

    fake.editArmed(armedId, {
      title: '改过的标题',
      rule: { kind: 'every', everySeconds: 900 },
      scheduledAt: '2026-10-09T06:00:00.000Z',
    })
    await engine.reconcile()

    // 编辑本身不是投递：不新建运行会话、不换掉当前副本。
    expect(fake.createdSessions.length).toBe(sessionsBefore)
    expect(fake.rows[0]?.id).toBe(armedId)
    const view = (await engine.list()).tasks.find(task => task.id === 'task-nochurn')
    expect(view?.title).toBe('改过的标题')
    expect(view?.rule).toEqual({ kind: 'every', everySeconds: 900 })
  })

  it('restores the edited rule when switching back to the original conversation', async () => {
    const { engine, fake } = makeEngine()
    const seeded = fake.seed({ id: 'task-back-edit', sessionId: SOURCE, rule: { kind: 'every', everySeconds: 120 } })
    await engine.setMode(SOURCE, seeded.id, 'new')
    fake.editArmed(fake.rows[0]?.id as string, { rule: { kind: 'every', everySeconds: 1800 } })

    const view = await engine.setMode(SOURCE, seeded.id, 'original')
    expect(view.mode).toBe('original')
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]?.sessionId).toBe(SOURCE)
    expect(fake.rows[0]?.rule).toEqual({ kind: 'every', everySeconds: 1800 })
  })
})

describe('schedule-mode native decoding', () => {
  it('decodes every native rule kind', () => {
    expect(ruleFromRecord({ kind: 'after', afterSeconds: 60 })).toEqual({ kind: 'after', afterSeconds: 60 })
    expect(ruleFromRecord({ kind: 'at', scheduledAt: '2026-10-09T00:00:00.000Z' })).toEqual({ kind: 'at', at: '2026-10-09T00:00:00.000Z' })
    expect(ruleFromRecord({ kind: 'every', everySeconds: 120 })).toEqual({ kind: 'every', everySeconds: 120 })
    expect(ruleFromRecord({ kind: 'daily', time: '09:00:00.000', timeZone: 'Asia/Shanghai' })).toEqual({ kind: 'daily', time: '09:00:00.000', timeZone: 'Asia/Shanghai' })
    expect(ruleFromRecord({ kind: 'weekly', time: '09:00:00.000', timeZone: 'UTC', weekdays: [1, 3] })).toEqual({ kind: 'weekly', time: '09:00:00.000', timeZone: 'UTC', weekdays: [1, 3] })
    expect(ruleFromRecord({ kind: 'cron', expression: '*/5 * * * *', timeZone: 'UTC' })).toEqual({ kind: 'cron', expression: '*/5 * * * *', timeZone: 'UTC' })
  })

  it('ignores unknown or incomplete records instead of throwing', () => {
    expect(ruleFromRecord({ kind: 'lunar-cycle' })).toBeUndefined()
    expect(ruleFromRecord({ kind: 'weekly', time: '09:00:00.000', timeZone: 'UTC', weekdays: [] })).toBeUndefined()
    expect(ruleFromRecord(null)).toBeUndefined()
  })

  it('survives a native catalog that gains unknown shapes', async () => {
    const store = new ScheduleModeStore(tempStorePath('dsh-schedule-mode-shapes-'))
    const engine = new ScheduleModeEngine(store, {
      listTasks: async () => [{
        sessionId: 's', id: 't1', status: 'active', title: 'T', prompt: 'P',
        scheduledAt: '2026-10-09T00:00:00.000Z', rule: { kind: 'daily', time: '09:00:00.000', timeZone: 'UTC' },
      }],
      createTask: async () => ({ id: 'x', scheduledAt: '2026-10-09T00:00:00.000Z' }),
      deleteTask: async () => {},
      inspectSession: async () => ({}),
      createSession: async () => 'run',
      now: () => 0,
      log: () => {},
    })
    const listed = await engine.list()
    expect(listed.available).toBe(true)
    expect(listed.tasks).toHaveLength(1)
  })
})
