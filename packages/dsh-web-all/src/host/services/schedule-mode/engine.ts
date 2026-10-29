/**
 * 「会话模式」引擎：把原生 schedule 任务在 `original` / `new` 两种运行目标之间
 * 切换，并在 `new` 模式下按次轮转运行副本。
 *
 * 引擎不实现计时：`new` 模式照样用原生 `schedule.create` 按原规则挂一把副本，
 * 副本到点由原生运行时投递进运行会话；引擎只负责「投递确认后开下一条会话并
 * 换挂副本」。因此 cron / 每日 / 每周的时点语义与原生完全一致。
 *
 * 一致性：
 *   - 所有写操作走同一条串行队列，和原生 schedule 服务的 FIFO 语义对齐；
 *   - `reconcile()` 以「副本的下一次时点是否已经推进」为主判据、原生投递回执为
 *     辅助判据。已持久化的精确任务关联可以恢复；原生 create 无幂等键，
 *     未保存返回 ID 的窗口只能标记 recovery-required，不能承诺 exactly-once。
 *
 * 全部外部副作用通过 {@link ScheduleModePorts} 注入，纯逻辑可脱离 DSH 运行时
 * 在单测里用假件驱动。
 *
 * 身份约定：策略的 `logicalId` 是用户最初创建的那条原生任务 id，永不改变
 * （面板据此稳定定位）；`armedTaskId` 指向当前真正挂在原生调度上的那一行
 * （`new` 模式是轮转副本；切回 `original` 后是还原出来的新行）。
 */
import type { NativeTaskView } from '../../../core/schedule-mode/native.ts'
import {
  appendRun, isRecurringRule, policyKey, ruleCanArm, runSessionTitle, timingArgs,
  type NativeCreateRequest, type ScheduleModePolicy, type ScheduleModeRule, type ScheduleModeRun, type ScheduleModeTransition,
} from '../../../core/schedule-mode/types.ts'
import type { ScheduleModeListValue, ScheduleModeTaskView } from '../../../core/schedule-mode/view.ts'
import type { ScheduleModeStore } from './store.ts'

/** 原生 schedule 面：只声明用到的三个方法。 */
export interface ScheduleModePorts {
  /** 原生任务目录（`ctx.schedule.catalog()` 的已解码投影）。 */
  listTasks(): Promise<NativeTaskView[]>
  /** 在原会话或运行会话上挂一把任务；返回 id 与首次时点。 */
  createTask(sessionId: string, request: NativeCreateRequest): Promise<{ id: string; scheduledAt: string }>
  /** 删除一条原生任务（必须带正确绑定会话）。 */
  deleteTask(sessionId: string, id: string): Promise<void>
  /** 读取会话的 cwd / preset，用于新建运行会话时继承。 */
  inspectSession(sessionId: string): Promise<{ cwd?: string; agentPreset?: string }>
  /** 新建一条运行会话。创建时**不**请求工作区归属（见 `session-create.ts`）。 */
  createSession(input: { cwd?: string; agentPreset?: string }): Promise<string>
  /**
   * 运行会话投递出第一轮后把它挂回所属工作区。
   * 待运行期间不挂：工作区里的空会话会被 DSH 的「新建会话」复用。
   */
  attachSession?(sessionId: string, cwd?: string): Promise<void>
  /** 给运行会话命名；失败不影响运行。 */
  renameSession?(sessionId: string, title: string): Promise<void>
  now(): number
  log(message: string, error?: unknown): void
  /** 运行记录保留条数。 */
  runHistoryLimit?: number
}

/** 稳定的引擎错误码（路由与工具据此回稳定文案）。 */
export type ScheduleModeErrorCode = 'unknown-task' | 'task-ended' | 'invalid-request' | 'recovery-required'

/** 引擎可预期的失败。 */
export class ScheduleModeError extends Error {
  constructor(readonly code: ScheduleModeErrorCode, message: string) {
    super(message)
    this.name = 'ScheduleModeError'
  }
}

/** 规则结构比较（忽略对象键序）。 */
function sameRule(left: ScheduleModeRule, right: ScheduleModeRule): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'after': return right.kind === 'after' && left.afterSeconds === right.afterSeconds
    case 'at': return right.kind === 'at' && left.at === right.at
    case 'every': return right.kind === 'every' && left.everySeconds === right.everySeconds
    case 'daily': return right.kind === 'daily' && left.time === right.time && left.timeZone === right.timeZone
    case 'weekly':
      return right.kind === 'weekly' && left.time === right.time && left.timeZone === right.timeZone
        && left.weekdays.length === right.weekdays.length && left.weekdays.every((day, index) => day === right.weekdays[index])
    case 'cron': return right.kind === 'cron' && left.expression === right.expression && left.timeZone === right.timeZone
  }
}

export class ScheduleModeEngine {
  private pending = 0
  private disposed = false
  private enabled = true
  private epoch = 0
  private executingEpoch: number | undefined

  dispose(): void { this.disposed = true; this.epoch++ }
  setEnabled(value: boolean): void { this.enabled = value; if (!value) this.epoch++ }

  private assertActive(): void {
    if (this.disposed || !this.enabled || (this.executingEpoch !== undefined && this.executingEpoch !== this.epoch)) throw new ScheduleModeError('recovery-required', 'schedule engine is stopped; pending effects require recovery')
  }

  constructor(
    private readonly store: ScheduleModeStore,
    private readonly ports: ScheduleModePorts,
  ) {}

  /** 串行化所有写操作（与原生 schedule 的 FIFO 对齐）。 */
  private serialize<T>(work: () => Promise<T>, cancellation = false): Promise<T> {
    this.assertActive()
    // Cancellation on this engine queues normally. An independent engine cannot
    // claim success while another owner is paused inside an external create.
    const rejectBusy = cancellation && this.pending === 0
    this.pending++
    const epoch = this.epoch
    return this.store.coordinate(async () => {
      this.executingEpoch = epoch
      try { this.assertActive(); return await work() } finally { this.executingEpoch = undefined }
    }, rejectBusy).finally(() => { this.pending-- })
  }

  private async nativeTasks(): Promise<NativeTaskView[]> {
    const tasks = await this.ports.listTasks()
    if (!Array.isArray(tasks) || tasks.some(task => !task || !task.id?.trim() || !task.sessionId?.trim()
      || (task.status !== 'active' && task.status !== 'inactive') || !Number.isFinite(Date.parse(task.scheduledAt)))) {
      throw new Error('native schedule catalog schema is invalid; absence is unconfirmed')
    }
    if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('native schedule catalog identity is ambiguous')
    return tasks
  }

  private get historyLimit(): number {
    return this.ports.runHistoryLimit ?? 50
  }

  /** 原生侧（自动化任务页/原生工具）对副本的编辑是否与策略快照不一致。 */
  private isCopyEdited(policy: ScheduleModePolicy, armed: NativeTaskView): boolean {
    return armed.title !== policy.title
      || armed.prompt !== policy.prompt
      || !sameRule(armed.rule, policy.rule)
  }

  /**
   * 把原生侧对副本的编辑并入策略并落盘，返回更新后的策略。
   * 编辑会重排副本时点，所以同时把 `nextScheduledAt` 对齐到副本，避免
   * 「编辑造成的时点变化」被误判成一次投递而触发无意义轮转。
   */
  private adoptCopyEdits(policy: ScheduleModePolicy, armed: NativeTaskView): ScheduleModePolicy {
    const adopted: ScheduleModePolicy = {
      ...policy,
      rule: armed.rule,
      title: armed.title,
      prompt: armed.prompt,
      // 必须一并回传给调用方：否则调用方手里的策略仍是旧时点，
      // 「编辑重排时点」会被当成一次投递而触发无意义轮转。
      nextScheduledAt: armed.scheduledAt,
      updatedAt: this.ports.now(),
    }
    this.store.upsert(adopted)
    this.ports.log(`schedule-mode: adopted native-side edits for ${policy.logicalId}`)
    return adopted
  }

  /**
   * 合并视图：`new` 模式的一条逻辑任务 + 其余原生任务。
   * 原生 schedule 不可用时返回 `available: false`（面板给出提示），不抛错。
   */
  async list(): Promise<ScheduleModeListValue> {
    let tasks: NativeTaskView[]
    try {
      tasks = await this.nativeTasks()
    } catch (error) {
      this.ports.log('schedule-mode: native schedule catalog unavailable', error)
      return { tasks: [], available: false }
    }
    let policies: ScheduleModePolicy[]
    try { policies = this.store.list() } catch (error) {
      this.ports.log('schedule-mode: policy store unavailable', error)
      return { tasks: [], available: false }
    }
    // 读路径自愈：策略认为有副本、但目录里找不到 → 先收敛一次，再按最新状态返回。
    // 这样「用户在原生页把任务删光」能立刻反映到工具与接口，而不是一直停在 active。
    if (policies.some(policy => policy.active && policy.transition === undefined && policy.armedTaskId !== undefined
      && !tasks.some(task => task.id === policy.armedTaskId))) {
      await this.reconcile()
      policies = this.store.list()
      try {
        tasks = await this.nativeTasks()
      } catch {
        /* 二次读取失败：沿用上面的快照，照常返回 */
      }
    }
    const owned = new Set<string>()
    for (const policy of policies) {
      owned.add(policy.logicalId)
      for (const ref of policy.transition?.deleteTasks ?? []) owned.add(ref.id)
      if (policy.transition?.created !== undefined) owned.add(policy.transition.created.id)
      if (policy.armedTaskId !== undefined) owned.add(policy.armedTaskId)
    }
    // 用户在原生页删掉的任务已退役（策略仅留作历史），不再出现在面板里。
    const rows: ScheduleModeTaskView[] = policies
      .filter(policy => policy.endedReason !== 'deleted')
      .map(policy => this.viewForPolicy(policy, tasks))
    for (const task of tasks) {
      if (owned.has(task.id)) continue
      rows.push(this.viewForNative(task))
    }
    rows.sort((left, right) => (left.scheduledAt ?? '').localeCompare(right.scheduledAt ?? '') || left.title.localeCompare(right.title))
    return { tasks: rows, available: true }
  }

  /** 读取一条逻辑任务的当前视图（找不到返回 undefined）。 */
  async task(sessionId: string, id: string): Promise<ScheduleModeTaskView | undefined> {
    const listed = await this.list()
    return listed.tasks.find(task => task.sessionId === sessionId && task.id === id)
  }

  /**
   * 切换运行目标。
   * - `original`：撤下轮转副本并把任务还原到原会话（规则仍可挂时）。
   * - `new`：把原任务轮转到一条新建运行会话上，原会话不再接收投递。
   */
  async setMode(sessionId: string, id: string, mode: 'original' | 'new'): Promise<ScheduleModeTaskView> {
    if (sessionId === '' || id === '') throw new ScheduleModeError('invalid-request', 'sessionId and id are required')
    return this.serialize(async () => {
      const tasks = await this.nativeTasks()
      // 已因用户在原生页删除而退役的策略视同不存在，不允许被切换复活。
      const found = this.resolvePolicy(sessionId, id)
      let policy = found?.endedReason === 'deleted' ? undefined : found
      if (policy?.transition !== undefined || policy?.rotationInFlight === true || (policy?.active === true
        && (policy.armedTaskId === undefined || !tasks.some(task => task.id === policy?.armedTaskId)))) {
        await this.reconcileOne(policy, tasks, tasks.length === 0)
        policy = this.store.get(policy.key)
        if (policy?.endedReason === 'deleted') throw new ScheduleModeError('unknown-task', 'the run copy was deleted')
        if (policy?.transition !== undefined) throw new ScheduleModeError('recovery-required', policy.transition.reason ?? 'schedule transition needs recovery')
        // Recovery can change the native row association. Never use the stale catalog below.
        tasks.splice(0, tasks.length, ...await this.nativeTasks())
      }
      const logicalId = policy?.logicalId ?? id
      // 策略一旦确定，原会话以策略为准（调用方给的可能是运行会话）。
      const sourceSessionId = policy?.sourceSessionId ?? sessionId
      let currentRow = policy?.armedTaskId === undefined
        ? tasks.find(task => task.sessionId === sourceSessionId && task.id === logicalId)
        : tasks.find(task => task.id === policy?.armedTaskId)
      if (policy?.active && currentRow?.lastDelivery !== undefined
        && (!isRecurringRule(policy.rule) || currentRow.lastDelivery.deliveredAt !== policy.lastDeliveredAt)) {
        await this.reconcileOne(policy, tasks)
        policy = this.store.get(policy.key)
        tasks.splice(0, tasks.length, ...await this.nativeTasks())
        currentRow = tasks.find(task => task.id === policy?.armedTaskId)
        if (policy !== undefined && !isRecurringRule(policy.rule)) return this.viewForPolicy(policy, tasks)
        if (policy?.transition !== undefined) throw new ScheduleModeError('recovery-required', 'delivery reconciliation remains pending')
      }
      if (mode === 'original') {
        if (policy === undefined || !policy.active) {
          if (currentRow === undefined) throw new ScheduleModeError('unknown-task', `no task ${logicalId} in session ${sourceSessionId}`)
          return this.viewForNative(currentRow, policy)
        }
        return await this.disarm(policy, tasks)
      }
      if (policy !== undefined && policy.active && policy.armedTaskId !== undefined) {
        return this.viewForPolicy(policy, tasks)
      }
      const rule = policy?.rule ?? currentRow?.rule
      const title = policy?.title ?? currentRow?.title
      const prompt = policy?.prompt ?? currentRow?.prompt
      if (rule === undefined || title === undefined || prompt === undefined) {
        throw new ScheduleModeError('unknown-task', `no task ${logicalId} in session ${sourceSessionId}`)
      }
      if (currentRow !== undefined && currentRow.status !== 'active') {
        throw new ScheduleModeError('task-ended', `task ${logicalId} is no longer active`)
      }
      const inspection = await this.inspect(sourceSessionId)
      const header = policy !== undefined && (policy.cwd !== undefined || policy.agentPreset !== undefined)
        ? { cwd: policy.cwd, agentPreset: policy.agentPreset }
        : inspection
      // 旧策略里已经建好、但从未投递过的运行会话可以直接复用：它已经占了一轮空会话，
      // 复用比再建一条更干净（重建副本时同理）。
      const reusableRunSession = policy === undefined ? undefined : this.pendingRunSession(policy)
      if (!ruleCanArm(rule, this.ports.now())) throw new ScheduleModeError('task-ended', 'the task deadline has passed; the existing task was not removed')
      const base: ScheduleModePolicy = {
        key: policyKey(sourceSessionId, logicalId),
        sourceSessionId,
        logicalId,
        title,
        prompt,
        rule,
        runs: policy?.runs ?? [],
        active: true,
        createdAt: policy?.createdAt ?? this.ports.now(),
        updatedAt: this.ports.now(),
        ...(reusableRunSession === undefined ? {} : { runSessionId: reusableRunSession }),
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
        ...(policy?.lastDeliveredAt === undefined ? {} : { lastDeliveredAt: policy.lastDeliveredAt }),
      }
      const pending = this.store.upsert({ ...base, nextScheduledAt: currentRow?.scheduledAt,
        transition: { kind: 'new', phase: 'deleting', deleteTasks: currentRow === undefined ? [] : [{ sessionId: currentRow.sessionId, id: currentRow.id }],
          ...(reusableRunSession === undefined ? {} : { sessionId: reusableRunSession }) } })
      await this.resumeTransition(pending)
      return this.viewForPolicy(this.store.get(pending.key)!, await this.nativeTasks())
    })
  }

  /** 删除一条逻辑任务（`new` 模式一并撤下轮转副本），返回是否删除成功。 */
  async deleteTask(sessionId: string, id: string): Promise<boolean> {
    if (sessionId === '' || id === '') throw new ScheduleModeError('invalid-request', 'sessionId and id are required')
    return this.serialize(async () => {
      // 接受 (原会话, 逻辑 id) / (原会话, 副本 id) / (运行会话, 副本 id)：原生页只看得到运行会话上的副本。
      const policy = this.resolvePolicy(sessionId, id)
      if (policy !== undefined) {
        await this.beginCleanup(policy, 'delete')
        return true
      }
      const logicalId = id
      const row = (await this.nativeTasks()).find(task => task.sessionId === sessionId && task.id === logicalId)
      if (row === undefined) return false
      await this.ports.deleteTask(sessionId, logicalId)
      return true
    })
  }

  /**
   * 与原生目录对齐的幂等收敛：记录已完成的新会话运行，并把副本轮转到下一条会话。
   * 由 `schedule/changed`、Host 启动、以及面板显式刷新触发。
   */
  async reconcile(): Promise<void> {
    return this.serialize(async () => {
      let policies: ScheduleModePolicy[]
      try { policies = this.store.list().filter(policy => policy.active || policy.transition !== undefined) } catch (error) {
        this.ports.log('schedule-mode: policy store invalid; refusing reconcile', error)
        return
      }
      if (policies.length === 0) return
      // 目录读不到时整体跳过：把「读不到」当成「副本被删」会误退役策略。
      let tasks: NativeTaskView[]
      try {
        tasks = await this.nativeTasks()
      } catch (error) {
        this.ports.log('schedule-mode: native schedule catalog unavailable; skipping reconcile', error)
        return
      }
      // 目录整表为空多半是原生 catalog 启动瞬间的空表：此时不据此退役任何策略（重建仍照常）。
      const catalogEmpty = tasks.length === 0
      for (const policy of policies) {
        try {
          await this.reconcileOne(policy, tasks, catalogEmpty)
        } catch (error) {
          this.ports.log(`schedule-mode: reconcile failed for ${policy.key}`, error)
        }
      }
    })
  }

  /** 原会话被归档/停止时撤下轮转副本（原生只清理绑定在原会话上的任务）。 */
  async stopSession(sourceSessionId: string): Promise<void> {
    return this.serialize(async () => {
      const policies = this.store.list().filter(policy => (policy.active || policy.transition !== undefined) && policy.sourceSessionId === sourceSessionId)
      const errors: unknown[] = []
      for (const policy of policies) {
        try { await this.beginCleanup(policy, 'stop') } catch (error) { errors.push(error) }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'schedule-mode stop cleanup remains pending')
    }, true)
  }

  /**
   * 解析策略：面板与工具给的是 (原会话, 逻辑 id)；原生页给的是副本 id，且副本挂在
   * 运行会话上，所以副本 id 不再要求会话与原会话一致，但**必须**是这个策略自己的
   * 会话（原会话或运行会话）。任务 id 不是凭证：外部只要枚举到 id 就能凭它操作别的
   * 会话的任务，因此这条回退只在调用方属于同一策略时生效。
   */
  private resolvePolicy(sessionId: string, id: string): ScheduleModePolicy | undefined {
    const direct = this.store.find(id, sessionId)
    if (direct !== undefined) return direct
    const byArmed = this.store.findArmed(id)
    if (byArmed !== undefined) {
      if (byArmed.sourceSessionId === sessionId || byArmed.runSessionId === sessionId) return byArmed
      return undefined
    }
    return this.store.list().find(policy => {
      if (policy.logicalId === id && (policy.runSessionId === sessionId || policy.transition?.sessionId === sessionId)) return true
      const refs = [...(policy.transition?.deleteTasks ?? []), ...(policy.transition?.created === undefined ? [] : [policy.transition.created])]
      return refs.some(ref => ref.id === id && (sessionId === policy.sourceSessionId || sessionId === ref.sessionId))
    })
  }

  /**
   * 空目录二次确认：再读一次，只有确实仍为空才算「原生侧被删光了」。
   * 读失败视为未确认（宁可暂时保留策略，也不误退役一个还在跑的任务）。
   */
  private async catalogConfirmedEmpty(): Promise<boolean> {
    try {
      const again = await this.nativeTasks()
      return again.length === 0
    } catch (error) {
      this.ports.log('schedule-mode: catalog recheck failed; treating the empty read as unconfirmed', error)
      return false
    }
  }

  /**
   * 待运行会话：已经建好、但还没有投递过的那条运行会话（`runSessionId` 尚未出现在
   * `runs` 里）。它已经占用了一轮 `#N`，重建副本时复用它可以避免同一轮留下两条同名
   * 会话、以及被弃用的那条以空会话身份留在会话列表里。已投递过的会话不算待运行会话。
   */
  private pendingRunSession(policy: ScheduleModePolicy): string | undefined {
    const runSessionId = policy.runSessionId
    if (runSessionId === undefined) return undefined
    return policy.runs.some(run => run.sessionId === runSessionId) ? undefined : runSessionId
  }

  /** 投递已确认的运行会话挂回工作区（待运行期间它一直留在工作区之外）。 */
  private async attachRunSession(sessionId: string, cwd?: string): Promise<void> {
    if (this.ports.attachSession === undefined) return
    await this.ports.attachSession(sessionId, cwd)
      .catch(error => this.ports.log('schedule-mode: attaching the delivered run session failed', error))
  }

  private async reconcileOne(policy: ScheduleModePolicy, tasks: NativeTaskView[], catalogEmpty = false): Promise<void> {
    if (policy.transition !== undefined) {
      await this.resumeTransition(policy)
      return
    }
    // v1 has no reliable intent/create-result association. Even a missing row can
    // mean create succeeded before its ID was saved. Never guess or recreate it.
    if (policy.rotationInFlight === true || policy.armedTaskId === undefined) {
      this.blockRecovery(policy, 'legacy v1 interrupted transition has no reliable native create association')
      return
    }
    const armed = tasks.find(task => task.id === policy.armedTaskId)
    if (armed === undefined) {
      if (catalogEmpty && !(await this.catalogConfirmedEmpty())) return
      this.store.upsert({ ...policy, active: false, endedReason: 'deleted', armedTaskId: undefined,
        nextScheduledAt: undefined, updatedAt: this.ports.now() })
      return
    }
    // 原生侧（自动化任务页/原生工具）可能改过副本：轮转前先把改动并入策略，
    // 否则下一轮会按策略快照重建、把这次修改覆盖掉。
    if (this.isCopyEdited(policy, armed)) {
      policy = this.adoptCopyEdits(policy, armed)
    }
    const receipt = armed.lastDelivery
    const isNewDelivery = receipt !== undefined
      && (policy.lastDeliveredAt === undefined || receipt.deliveredAt > policy.lastDeliveredAt)
    // 副本时点已推进即代表它投递过一次（原生在投递提交后推进时点）。
    const advanced = policy.nextScheduledAt !== undefined && armed.scheduledAt !== policy.nextScheduledAt
    const completedOneShot = !isRecurringRule(policy.rule) && armed.status === 'inactive' && receipt !== undefined
    if (!isNewDelivery && !advanced && !completedOneShot) return
    const alreadyRecorded = policy.lastDeliveredAt !== undefined
      && receipt !== undefined
      && policy.lastDeliveredAt === receipt.deliveredAt
    const runs = isNewDelivery
      ? appendRun(policy.runs, {
        scheduledAt: receipt.scheduledAt,
        deliveredAt: receipt.deliveredAt,
        sessionId: armed.sessionId,
        taskId: armed.id,
      }, this.historyLimit)
      : (alreadyRecorded
        ? [...policy.runs]
        : appendRun(policy.runs, {
          scheduledAt: policy.nextScheduledAt ?? armed.scheduledAt,
          deliveredAt: receipt?.deliveredAt ?? new Date(this.ports.now()).toISOString(),
          sessionId: armed.sessionId,
          taskId: armed.id,
        }, this.historyLimit))
    const lastDeliveredAt = receipt?.deliveredAt ?? policy.lastDeliveredAt
    // 投递已确认：这条运行会话从此是真实对话，挂回工作区；待运行期间它一直不挂。
    await this.attachRunSession(armed.sessionId, policy.cwd)
    const pending = this.store.upsert({ ...policy, runs,
      ...(lastDeliveredAt === undefined ? {} : { lastDeliveredAt }),
      rotationInFlight: undefined,
      transition: { kind: armed.status === 'active' ? 'rotate' : 'complete', phase: 'deleting',
        deleteTasks: [{ sessionId: armed.sessionId, id: armed.id }] }, updatedAt: this.ports.now() })
    await this.resumeTransition(pending)
  }

  private blockRecovery(policy: ScheduleModePolicy, reason: string): void {
    this.store.upsert({ ...policy, transition: { ...(policy.transition ?? { kind: 'new', deleteTasks: [] }),
      phase: 'recovery-required', reason }, updatedAt: this.ports.now() })
    this.ports.log(`schedule-mode: recovery required for ${policy.key}: ${reason}`)
  }

  /** Write-ahead journal driver. Only exact saved row IDs may be deleted/adopted. */
  private async resumeTransition(initial: ScheduleModePolicy): Promise<void> {
    this.assertActive()
    let policy = initial
    let transition = policy.transition!
    const save = (next: ScheduleModeTransition): void => {
      policy = this.store.upsert({ ...policy, transition: next, updatedAt: this.ports.now() })
      transition = next
    }
    if (transition.phase === 'recovery-required') return
    if (transition.phase === 'creating-session' || transition.phase === 'creating-task') {
      this.blockRecovery(policy, `${transition.phase}: external create outcome is unknown; automatic retry disabled`)
      return
    }
    const cleanup = transition.kind === 'stop' || transition.kind === 'delete' || transition.kind === 'complete'
    const requireFutureDeadline = (): void => {
      if (cleanup || ruleCanArm(policy.rule, this.ports.now())) return
      const reason = 'task deadline passed during transition; delivery outcome is unknown; automatic recreation disabled'
      this.blockRecovery(policy, reason)
      throw new ScheduleModeError('recovery-required', reason)
    }
    if (transition.phase === 'deleting') {
      // A failed catalog is not an empty catalog. Keep every cleanup association.
      const tasks = await this.nativeTasks()
      if (tasks.length === 0 && transition.deleteTasks.length > 0 && !(await this.catalogConfirmedEmpty())) return
      const deleted = new Set<string>()
      for (const ref of transition.deleteTasks) {
        const key = policyKey(ref.sessionId, ref.id)
        if (deleted.has(key)) continue
        deleted.add(key)
        if (tasks.some(task => task.id === ref.id && task.sessionId === ref.sessionId)) {
          requireFutureDeadline()
          if (!cleanup) await this.inspect(policy.sourceSessionId)
          this.assertActive()
          const snapshot = tasks.find(task => task.id === ref.id && task.sessionId === ref.sessionId)!
          await this.ports.deleteTask(ref.sessionId, ref.id)
          this.assertActive()
          // The native delete port returns no delivery receipt/CAS token. If its
          // scheduled instant passed during deletion, an unseen delivery may have
          // committed: keep the journal rather than replaying or inventing runs.
          if (!cleanup && Number.isFinite(Date.parse(snapshot.scheduledAt))
            && this.ports.now() >= Date.parse(snapshot.scheduledAt)) {
            const reason = 'task deadline passed during transition; delivery outcome is unknown; automatic recreation disabled'
            this.blockRecovery(policy, reason)
            throw new ScheduleModeError('recovery-required', reason)
          }
        }
      }
      save({ ...transition, phase: 'prepare', deleteTasks: [] })
    }
    if (cleanup) {
      if (transition.kind === 'delete') { this.store.remove(policy.key); return }
      this.store.upsert({ ...policy, transition: undefined, rotationInFlight: undefined, active: false,
        endedReason: transition.kind === 'complete' ? 'completed' : 'ended', armedTaskId: undefined,
        nextScheduledAt: undefined, updatedAt: this.ports.now() })
      return
    }
    if (transition.phase === 'prepare') {
      this.assertActive()
      requireFutureDeadline()
      let sessionId = transition.kind === 'original' ? policy.sourceSessionId : transition.sessionId
      if (sessionId === undefined) {
        await this.inspect(policy.sourceSessionId)
        this.assertActive()
        save({ ...transition, phase: 'creating-session' })
        sessionId = await this.ports.createSession({
          ...(policy.cwd === undefined ? {} : { cwd: policy.cwd }),
          ...(policy.agentPreset === undefined ? {} : { agentPreset: policy.agentPreset }),
        })
        // A crash or failed save here is ambiguous too: do not create another empty session.
        if (typeof sessionId !== 'string' || sessionId.trim() === '') {
          this.blockRecovery(policy, 'session creation returned an invalid identity')
          throw new ScheduleModeError('recovery-required', 'session creation identity is unknown')
        }
        save({ ...transition, phase: 'prepare', sessionId })
        this.assertActive()
      }
      // Session creation can outlast a one-shot deadline too. Never replay a possibly delivered reminder.
      requireFutureDeadline()
      await this.inspect(policy.sourceSessionId)
      this.assertActive()
      save({ ...transition, phase: 'creating-task', sessionId })
      const created = await this.ports.createTask(sessionId, {
        prompt: policy.prompt, title: policy.title, selector: timingArgs(policy.rule),
      })
      // Record the returned ID before any optional effect or final mode commit.
      if (typeof created.id !== 'string' || created.id.trim() === '' || !Number.isFinite(Date.parse(created.scheduledAt))) {
        this.blockRecovery(policy, 'task creation returned an invalid identity or scheduled instant')
        throw new ScheduleModeError('recovery-required', 'task creation identity is unknown')
      }
      save({ ...transition, phase: 'created', created: { sessionId, ...created } })
      this.assertActive()
    }
    if (transition.phase === 'created') {
      const created = transition.created!
      let tasks: NativeTaskView[]
      try { tasks = await this.nativeTasks() } catch (error) {
        if (error instanceof Error && /identity is ambiguous/.test(error.message)) this.blockRecovery(policy, 'native catalog identity is ambiguous after task creation')
        throw error
      }
      if (tasks.filter(task => task.id === created.id).length > 1) {
        this.blockRecovery(policy, 'native catalog returned a duplicate task identity')
        throw new ScheduleModeError('recovery-required', 'native task identity is ambiguous')
      }
      if (!tasks.some(task => task.id === created.id && task.sessionId === created.sessionId)) {
        if (tasks.length === 0 && !(await this.catalogConfirmedEmpty())) return
        // A user deleting the newly created copy means stop, not rebuild.
        this.store.upsert({ ...policy, active: false, endedReason: 'deleted', transition: undefined,
          rotationInFlight: undefined, armedTaskId: undefined, nextScheduledAt: undefined, updatedAt: this.ports.now() })
        return
      }
      this.assertActive()
      const isNew = transition.kind !== 'original'
      this.store.upsert({ ...policy, active: isNew, endedReason: isNew ? undefined : 'ended',
        transition: undefined, rotationInFlight: undefined, armedTaskId: created.id,
        ...(isNew ? { runSessionId: created.sessionId } : {}), nextScheduledAt: created.scheduledAt,
        updatedAt: this.ports.now() })
      if (isNew && this.ports.renameSession !== undefined) {
        await this.ports.renameSession(created.sessionId, runSessionTitle(policy.title, policy.runs.length + 1))
          .catch(error => this.ports.log('schedule-mode: run session rename failed', error))
      }
    }
  }

  /** Persist cancellation before reading the directory, including during a failed switch. */
  private async beginCleanup(policy: ScheduleModePolicy, kind: 'stop' | 'delete'): Promise<void> {
    const prior = policy.transition
    // Unknown create outcomes cannot be safely forgotten, including after stop.
    if (prior?.phase === 'creating-session' || prior?.phase === 'creating-task' || prior?.phase === 'recovery-required'
      || policy.rotationInFlight === true || (policy.active && policy.armedTaskId === undefined && prior === undefined)) {
      this.blockRecovery(policy, `${kind} requested, but an external create outcome is unknown; manual recovery required`)
      throw new ScheduleModeError('recovery-required', `${kind} is not confirmed: external create outcome unknown`)
    }
    const refs = [...(prior?.deleteTasks ?? [])]
    if (policy.armedTaskId !== undefined) refs.push({ id: policy.armedTaskId, sessionId: policy.active ? policy.runSessionId ?? policy.sourceSessionId : policy.sourceSessionId })
    if (prior?.created !== undefined) refs.push(prior.created)
    const pending = this.store.upsert({ ...policy, transition: { kind, phase: 'deleting', deleteTasks: refs }, updatedAt: this.ports.now() })
    await this.resumeTransition(pending)
    if (this.store.get(policy.key)?.transition !== undefined) {
      throw new ScheduleModeError('recovery-required', `${kind} cleanup is still pending catalog confirmation`)
    }
  }

  /** Restore through the same journal as rotation; recovery retains the requested direction. */
  private async disarm(policy: ScheduleModePolicy, tasks: NativeTaskView[]): Promise<ScheduleModeTaskView> {
    const armed = tasks.find(task => task.id === policy.armedTaskId)
    if (armed === undefined) {
      this.store.upsert({ ...policy, active: false, endedReason: 'deleted', armedTaskId: undefined, nextScheduledAt: undefined, updatedAt: this.ports.now() })
      throw new ScheduleModeError('unknown-task', 'the run copy was deleted')
    }
    if (this.isCopyEdited(policy, armed)) policy = this.adoptCopyEdits(policy, armed)
    await this.inspect(policy.sourceSessionId)
    this.assertActive()
    if (!ruleCanArm(policy.rule, this.ports.now())) throw new ScheduleModeError('task-ended', 'the task deadline has passed; the existing task was not removed')
    const pending = this.store.upsert({ ...policy, transition: { kind: 'original', phase: 'deleting',
      deleteTasks: [{ id: armed.id, sessionId: armed.sessionId }] }, updatedAt: this.ports.now() })
    await this.resumeTransition(pending)
    return this.viewForPolicy(this.store.get(policy.key)!, await this.nativeTasks())
  }

  private async inspect(sessionId: string): Promise<{ cwd?: string; agentPreset?: string }> {
    this.assertActive()
    return this.ports.inspectSession(sessionId)
  }

  private viewForNative(task: NativeTaskView, policy?: ScheduleModePolicy): ScheduleModeTaskView {
    return {
      sessionId: task.sessionId,
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      mode: 'original',
      status: task.status === 'inactive' ? 'inactive' : 'active',
      rule: task.rule,
      ...(task.scheduledAt === '' ? {} : { scheduledAt: task.scheduledAt }),
      ...(policy?.runSessionId === undefined ? {} : { runSessionId: policy.runSessionId }),
      ...(policy?.lastDeliveredAt === undefined ? {} : { lastDeliveredAt: policy.lastDeliveredAt }),
      runs: policy?.runs ?? [],
      updatedAt: policy?.updatedAt ?? this.ports.now(),
    }
  }

  /**
   * 策略视图。逻辑 id 恒为 `logicalId`（面板据此稳定定位），`activeTaskId`
   * 指向当前真正挂在原生调度上的那一行；策略停止后任务回到 `original`，
   * 状态改由还原出来的原生行决定。
   */
  private viewForPolicy(policy: ScheduleModePolicy, tasks: NativeTaskView[]): ScheduleModeTaskView {
    const armed = policy.armedTaskId === undefined ? undefined : tasks.find(task => task.id === policy.armedTaskId)
    const status: ScheduleModeTaskView['status'] = policy.transition !== undefined ? 'inactive' : !policy.active
      ? (armed === undefined ? 'ended' : armed.status)
      : armed?.status === 'inactive' ? 'inactive' : 'active'
    const scheduledAt = armed?.scheduledAt ?? policy.nextScheduledAt
    return {
      sessionId: policy.sourceSessionId,
      id: policy.logicalId,
      ...(armed === undefined ? {} : { activeTaskId: armed.id }),
      title: policy.title,
      prompt: policy.prompt,
      mode: policy.active ? 'new' : 'original',
      status,
      rule: policy.rule,
      ...(scheduledAt === undefined || scheduledAt === '' ? {} : { scheduledAt }),
      ...(policy.runSessionId === undefined ? {} : { runSessionId: policy.runSessionId }),
      ...(policy.lastDeliveredAt === undefined ? {} : { lastDeliveredAt: policy.lastDeliveredAt }),
      runs: policy.runs,
      ...(policy.transition === undefined ? {} : { recovery: { phase: policy.transition.phase, reason: policy.transition.reason } }),
      updatedAt: policy.updatedAt,
    }
  }
}

export type { ScheduleModeRule, ScheduleModeRun }
