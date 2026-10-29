/**
 * schedule-mode 持久化：`$DSH_HOME/dsh-schedule-mode.json`（原子写）。
 *
 * 存的是「每次新建会话」策略本身，不存调度时点：时点由原生 schedule 任务持有，
 * 本文件只在副本轮转/投递确认时更新策略。读取或结构损坏显式失败，不能把
 * 未知策略当作空表覆盖。进程内多实例通过相同路径协调；不提供跨进程锁。
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  DEFAULT_RUN_HISTORY_LIMIT,
  isRecurringRule,
  policyKey,
  type ScheduleModePolicy,
  type ScheduleModeRule,
  type ScheduleModeRun,
  type ScheduleModeTransition,
} from '../../../core/schedule-mode/types.ts'

/** 存储格式版本。 */
export const SCHEDULE_MODE_FORMAT_VERSION = 1

/** 默认存储路径。 */
export function defaultScheduleModeStorePath(): string {
  return join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'dsh-schedule-mode.json')
}

/** 存储文件形状。 */
export interface ScheduleModeStoreFile {
  formatVersion: number
  policies: Record<string, ScheduleModePolicy>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asRule(value: unknown): ScheduleModeRule | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  switch (record.kind) {
    case 'after': {
      const afterSeconds = asNumber(record.afterSeconds)
      return afterSeconds === undefined ? undefined : { kind: 'after', afterSeconds }
    }
    case 'at': {
      const at = asString(record.at)
      return at === undefined ? undefined : { kind: 'at', at }
    }
    case 'every': {
      const everySeconds = asNumber(record.everySeconds)
      return everySeconds === undefined ? undefined : { kind: 'every', everySeconds }
    }
    case 'daily': {
      const time = asString(record.time)
      const timeZone = asString(record.timeZone)
      return time === undefined || timeZone === undefined ? undefined : { kind: 'daily', time, timeZone }
    }
    case 'weekly': {
      const time = asString(record.time)
      const timeZone = asString(record.timeZone)
      const weekdays = Array.isArray(record.weekdays)
        ? record.weekdays.filter((day): day is number => typeof day === 'number' && Number.isInteger(day))
        : []
      return time === undefined || timeZone === undefined || weekdays.length === 0
        ? undefined
        : { kind: 'weekly', time, timeZone, weekdays }
    }
    case 'cron': {
      const expression = asString(record.expression)
      const timeZone = asString(record.timeZone)
      return expression === undefined || timeZone === undefined ? undefined : { kind: 'cron', expression, timeZone }
    }
    default:
      return undefined
  }
}

function asRun(value: unknown): ScheduleModeRun | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const scheduledAt = asString(record.scheduledAt)
  const deliveredAt = asString(record.deliveredAt)
  const sessionId = asString(record.sessionId)
  const taskId = asString(record.taskId)
  if (scheduledAt === undefined || deliveredAt === undefined || sessionId === undefined || taskId === undefined) return undefined
  return { scheduledAt, deliveredAt, sessionId, taskId }
}

/** Malformed journals must not silently become a retryable legacy pending arm. */
function asTransition(value: unknown): ScheduleModeTransition | undefined {
  if (value === undefined) return undefined
  const blocked: ScheduleModeTransition = { kind: 'stop', phase: 'recovery-required', deleteTasks: [], reason: 'invalid transition journal' }
  if (value === null || typeof value !== 'object') return blocked
  const record = value as Record<string, unknown>
  const kind = record.kind
  const phase = record.phase
  if (kind !== 'new' && kind !== 'original' && kind !== 'rotate' && kind !== 'stop' && kind !== 'delete' && kind !== 'complete') return blocked
  if (phase !== 'deleting' && phase !== 'prepare' && phase !== 'creating-session' && phase !== 'creating-task' && phase !== 'created' && phase !== 'recovery-required') return blocked
  if (!Array.isArray(record.deleteTasks)) return blocked
  const deleteTasks: Array<{ sessionId: string; id: string }> = []
  for (const raw of record.deleteTasks) {
    if (raw === null || typeof raw !== 'object') return blocked
    const ref = raw as Record<string, unknown>
    const sessionId = asString(ref.sessionId)
    const id = asString(ref.id)
    if (sessionId === undefined || id === undefined) return blocked
    deleteTasks.push({ sessionId, id })
  }
  let created: ScheduleModeTransition['created']
  if (record.created !== undefined) {
    if (record.created === null || typeof record.created !== 'object') return blocked
    const ref = record.created as Record<string, unknown>
    const sessionId = asString(ref.sessionId)
    const id = asString(ref.id)
    const scheduledAt = asString(ref.scheduledAt)
    if (sessionId === undefined || id === undefined || scheduledAt === undefined) return blocked
    created = { sessionId, id, scheduledAt }
  }
  const cleanup = kind === 'stop' || kind === 'delete' || kind === 'complete'
  if (cleanup && phase !== 'deleting' && phase !== 'prepare' && phase !== 'recovery-required') return blocked
  if (phase === 'created' && created === undefined) return blocked
  if ((phase === 'prepare' || phase === 'creating-session' || phase === 'creating-task') && deleteTasks.length > 0) return blocked
  if (phase !== 'created' && phase !== 'recovery-required' && created !== undefined) return blocked
  if (record.sessionId !== undefined && asString(record.sessionId) === undefined) return blocked
  if (phase === 'creating-task' && asString(record.sessionId) === undefined) return blocked
  if (phase === 'creating-session' && (kind === 'original' || cleanup)) return blocked
  if (new Set(deleteTasks.map(ref => policyKey(ref.sessionId, ref.id))).size !== deleteTasks.length) return blocked
  return { kind, phase, deleteTasks, ...(created === undefined ? {} : { created }),
    ...(asString(record.sessionId) === undefined ? {} : { sessionId: asString(record.sessionId) }),
    ...(asString(record.reason) === undefined ? {} : { reason: asString(record.reason) }) }
}

/** 解码一条策略；结构不符返回 undefined。 */
export function parsePolicy(value: unknown): ScheduleModePolicy | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const sourceSessionId = asString(record.sourceSessionId)
  const logicalId = asString(record.logicalId)
  const title = asString(record.title)
  const prompt = asString(record.prompt)
  const rule = asRule(record.rule)
  const createdAt = asNumber(record.createdAt)
  const updatedAt = asNumber(record.updatedAt)
  if (sourceSessionId === undefined || logicalId === undefined || title === undefined || prompt === undefined
    || rule === undefined || createdAt === undefined || updatedAt === undefined) return undefined
  const runs = Array.isArray(record.runs) ? record.runs.map(asRun).filter((run): run is ScheduleModeRun => run !== undefined) : []
  const cwd = asString(record.cwd)
  const agentPreset = asString(record.agentPreset)
  const armedTaskId = asString(record.armedTaskId)
  const runSessionId = asString(record.runSessionId)
  const nextScheduledAt = asString(record.nextScheduledAt)
  const lastDeliveredAt = asString(record.lastDeliveredAt)
  const endedReason = record.endedReason === 'completed' || record.endedReason === 'ended' || record.endedReason === 'deleted'
    ? record.endedReason
    : undefined
  let transition = asTransition(record.transition)
  if (transition !== undefined && transition.phase !== 'recovery-required') {
    const allowedSessions = new Set([sourceSessionId, runSessionId, transition.sessionId].filter((id): id is string => id !== undefined))
    const cleanup = transition.kind === 'stop' || transition.kind === 'delete' || transition.kind === 'complete'
    const invalidRef = !cleanup && transition.deleteTasks.some(ref => !allowedSessions.has(ref.sessionId))
    const invalidCreated = transition.created !== undefined && (transition.kind === 'original'
      ? transition.created.sessionId !== sourceSessionId
      : transition.sessionId !== undefined && transition.created.sessionId !== transition.sessionId)
    const invalidSession = transition.kind === 'original' && transition.sessionId !== undefined && transition.sessionId !== sourceSessionId
    if (invalidRef || invalidCreated || invalidSession) transition = { ...transition, phase: 'recovery-required', reason: 'inconsistent transition ownership' }
  }
  return {
    key: asString(record.key) ?? policyKey(sourceSessionId, logicalId),
    sourceSessionId, logicalId, title, prompt, rule, runs,
    active: record.active === true,
    createdAt, updatedAt,
    ...(cwd === undefined ? {} : { cwd }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(armedTaskId === undefined ? {} : { armedTaskId }),
    ...(runSessionId === undefined ? {} : { runSessionId }),
    ...(nextScheduledAt === undefined ? {} : { nextScheduledAt }),
    ...(lastDeliveredAt === undefined ? {} : { lastDeliveredAt }),
    ...(endedReason === undefined ? {} : { endedReason }),
    ...(record.rotationInFlight === true ? { rotationInFlight: true } : {}),
    ...(transition === undefined ? {} : { transition }),
  }
}

/** Invalid persistence is not absence: leave the original bytes untouched. */
export function parseStoreFile(text: string): ScheduleModeStoreFile {
  const parsed = JSON.parse(text) as Partial<ScheduleModeStoreFile> | null
  if (parsed === null || parsed.formatVersion !== SCHEDULE_MODE_FORMAT_VERSION || parsed.policies === null
    || typeof parsed.policies !== 'object' || Array.isArray(parsed.policies)) throw new Error('invalid schedule-mode store')
  const policies: Record<string, ScheduleModePolicy> = Object.create(null) as Record<string, ScheduleModePolicy>
  for (const [key, raw] of Object.entries(parsed.policies)) {
    const policy = parsePolicy(raw)
    if (policy === undefined || key !== policy.key || policy.key !== policyKey(policy.sourceSessionId, policy.logicalId)) {
      throw new Error('invalid schedule-mode policy')
    }
    policies[key] = policy
  }
  return { formatVersion: SCHEDULE_MODE_FORMAT_VERSION, policies }
}

interface PathWork { queue: Promise<void>; busy: number }
const pathWork = new Map<string, PathWork>()

/** 策略存储（原子写 + 内存快照）。 */
export class ScheduleModeStore {
  private cache: ScheduleModeStoreFile | undefined

  constructor(private readonly file: string = defaultScheduleModeStorePath()) {}

  get identity(): string {
    try { return realpathSync(this.file) } catch {
      try { return join(realpathSync(dirname(this.file)), basename(this.file)) } catch { return resolve(this.file) }
    }
  }

  /** One FIFO per on-disk store in this process, not one FIFO per engine. */
  coordinate<T>(work: () => Promise<T>, rejectBusy = false): Promise<T> {
    const key = this.identity
    const state = pathWork.get(key) ?? { queue: Promise.resolve(), busy: 0 }
    pathWork.set(key, state)
    if (rejectBusy && state.busy > 0) return Promise.reject(new Error('schedule-mode store operation is pending; cancellation is not confirmed'))
    state.busy++
    const run = state.queue.then(() => { this.invalidate(); return work() })
    state.queue = run.then(() => undefined, () => undefined).finally(() => {
      if (--state.busy === 0 && pathWork.get(key) === state) pathWork.delete(key)
    })
    return run
  }

  load(): ScheduleModeStoreFile {
    // Reads always refresh. A cached absence must never erase another instance's policy.
    let loaded: ScheduleModeStoreFile
    try { loaded = parseStoreFile(readFileSync(this.file, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      loaded = { formatVersion: SCHEDULE_MODE_FORMAT_VERSION, policies: {} }
    }
    this.cache = loaded
    return loaded
  }

  private persist(store: ScheduleModeStoreFile): void {
    const dir = dirname(this.file)
    mkdirSync(dir, { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8')
    renameSync(temp, this.file)
    // Publish the snapshot only after the atomic rename succeeds.
    this.cache = store
  }

  list(): ScheduleModePolicy[] {
    return Object.values(this.load().policies)
  }

  get(key: string): ScheduleModePolicy | undefined {
    return this.load().policies[key]
  }

  /** 按任一原生任务 id（逻辑 id 或当前副本 id）找策略。 */
  find(logicalId: string, sourceSessionId: string): ScheduleModePolicy | undefined {
    return this.get(policyKey(sourceSessionId, logicalId))
  }

  findArmed(armedTaskId: string): ScheduleModePolicy | undefined {
    return this.list().find(policy => policy.armedTaskId === armedTaskId)
  }

  upsert(policy: ScheduleModePolicy): ScheduleModePolicy {
    const observed = this.cache !== undefined
    const previous = this.cache?.policies[policy.key]
    const store = this.load()
    if (observed && JSON.stringify(previous) !== JSON.stringify(store.policies[policy.key])) {
      throw new Error('schedule-mode policy changed concurrently; reload before retry')
    }
    const checked = parsePolicy(policy)
    if (checked === undefined || checked.key !== policyKey(checked.sourceSessionId, checked.logicalId)) throw new Error('invalid schedule-mode policy')
    this.persist({ formatVersion: store.formatVersion, policies: { ...store.policies, [checked.key]: checked } })
    return checked
  }

  remove(key: string): boolean {
    const observed = this.cache !== undefined
    const previous = this.cache?.policies[key]
    const store = this.load()
    if (observed && JSON.stringify(previous) !== JSON.stringify(store.policies[key])) throw new Error('schedule-mode policy changed concurrently; reload before retry')
    if (!(key in store.policies)) return false
    const next = { ...store.policies }
    delete next[key]
    this.persist({ formatVersion: store.formatVersion, policies: next })
    return true
  }

  /** 丢掉内存快照，强制下次从磁盘重读（测试/外改场景）。 */
  invalidate(): void {
    this.cache = undefined
  }
}

export { DEFAULT_RUN_HISTORY_LIMIT, isRecurringRule }
