/**
 * schedule-mode host 服务域：在**原生**自动化任务之上叠加「运行目标」选择。
 *
 * 原生 `@deepseek-ai/dsh-schedule` 把任务绑定到创建它的会话，到期就地投递；
 * 本服务域不替换原生调度，而是把任务在两种目标间切换：
 *
 *   - `original`（默认、零改动）：不建策略，原生投递照旧；
 *   - `new`：按原规则在一条**新建的运行会话**上挂一把轮转副本，并撤掉原会话上
 *     的那行；副本每次投递完成后，再开下一条会话并把副本换挂过去。于是原会话
 *     永远不再收到投递，每次运行都落在一条全新会话里。
 *
 * 计时完全由原生负责（副本自身按原规则推进时点），本域只在投递确认后轮转，
 * 所以 cron / 每日 / 每周的语义与原生逐字一致，也不需要自己实现时区计算。
 *
 * 原生 schedule 是可选 bundle：本域用结构化面 + 非严格 `ctx.get` 读取它，
 * 缺服务时列表返回 `available: false`、工具给出明确错误，绝不让 web-all 加载失败。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { nativeTaskView, type NativeTaskView } from '../../../core/schedule-mode/native.ts'
import type { NativeCreateRequest } from '../../../core/schedule-mode/types.ts'
import { familyNamespace, onFamilyConfigChange } from '../family-config.ts'
import { SCHEDULE_MODE_SETTINGS_NAMESPACE, type ScheduleModeConfig } from './config.ts'
import { ScheduleModeEngine, type ScheduleModePorts } from './engine.ts'
import { ScheduleModeStore, defaultScheduleModeStorePath } from './store.ts'
import { buildSessionCreateRequest } from './session-create.ts'
import { registerScheduleModeRoutes } from './routes.ts'
import { registerScheduleModeTools } from './tools.ts'
import { registerResources } from '../resources.ts'

export { ScheduleModeStore, defaultScheduleModeStorePath } from './store.ts'
export { buildSessionCreateRequest, type ScheduleModeSessionCreateRequest, type ScheduleModeSessionInput } from './session-create.ts'
export { ScheduleModeEngine, ScheduleModeError, type ScheduleModePorts, type ScheduleModeErrorCode } from './engine.ts'
export { SCHEDULE_MODE_SETTINGS_NAMESPACE, type ScheduleModeConfig } from './config.ts'

/** 原生 schedule 服务面（只声明用到的成员）。 */
interface ScheduleFace {
  catalog(): Promise<unknown[]>
  create(sessionId: string, request: Record<string, unknown>): Promise<Record<string, unknown>>
  delete(request: { sessionId: string; id: string }): Promise<unknown>
}

/** 会话控制器面。 */
interface SessionControllerFace {
  inspect(sessionId: string): Promise<{ meta?: { cwd?: unknown; agentPreset?: unknown } }>
  create(request: { cwd?: string; agentPreset?: string }): Promise<{ sessionId?: unknown }>
  rename(request: { sessionId: string; title: string }): Promise<unknown>
}

/** 工作区实体面（只用到挂载会话）。 */
interface WorkspaceEntityFace {
  attachSession?(sessionId: string): Promise<unknown>
}

/** 工作区注册表面。 */
interface WorkspaceRegistryFace {
  list(): Array<{ id?: unknown; path?: unknown }>
  get?(id: string): WorkspaceEntityFace | undefined
}

/** 服务域依赖。 */
export interface ScheduleModeServiceDeps {
  /** 策略存储路径（默认 $DSH_HOME/dsh-schedule-mode.json）。 */
  storePath?: string
  logger?: { warn(error: unknown): void }
}

/** 非严格读取可选服务（缺失返回 undefined，不抛错）。 */
function optionalService<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx.get as unknown as (id: string, strict?: boolean) => unknown)(name, false) as T | undefined
  } catch {
    return undefined
  }
}

/** 订阅一个可能不存在的插件事件（事件名不在宿主类型面内时也不抛错）。 */
function onEvent(ctx: Context, event: string, listener: (...args: unknown[]) => void): () => void {
  return (ctx as unknown as { on(name: string, fn: (...args: unknown[]) => void): () => void }).on(event, listener)
}

/** 会话 cwd 对应的已注册工作区：投递完成的运行会话据此挂回工作区。 */
function workspaceIdFor(ctx: Context, cwd: string): string | undefined {
  const registry = optionalService<WorkspaceRegistryFace>(ctx, 'workspaceRegistry')
  const match = registry?.list().find(workspace => typeof workspace.path === 'string' && workspace.path === cwd)
  return match?.id === undefined ? undefined : String(match.id)
}

/** 服务域注册入口；返回统一 disposer。 */
export function register(ctx: Context, deps: ScheduleModeServiceDeps = {}): () => void {
  const logger = deps.logger ?? { warn: (error: unknown) => { console.warn('[web-all:schedule-mode]', error) } }
  const settings = (): ScheduleModeConfig => familyNamespace<ScheduleModeConfig>(SCHEDULE_MODE_SETTINGS_NAMESPACE) ?? {}

  const scheduleFace = (): ScheduleFace | undefined => optionalService<ScheduleFace>(ctx, 'schedule')
  const controllerFace = (): SessionControllerFace | undefined => optionalService<SessionControllerFace>(ctx, 'sessionController')

  const ports: ScheduleModePorts = {
    async listTasks(): Promise<NativeTaskView[]> {
      const schedule = scheduleFace()
      if (schedule === undefined) throw new Error('the native schedule service is unavailable in this profile')
      const entries = await schedule.catalog()
      if (!Array.isArray(entries)) throw new Error('native schedule catalog is malformed')
      const tasks = entries.map(nativeTaskView)
      if (tasks.some(task => task === undefined)) throw new Error('native schedule catalog schema is unsupported; absence is unconfirmed')
      const rows = tasks as NativeTaskView[]
      if (new Set(rows.map(task => task.id)).size !== rows.length) throw new Error('native schedule catalog contains duplicate task IDs')
      return rows
    },
    async createTask(sessionId: string, request: NativeCreateRequest): Promise<{ id: string; scheduledAt: string }> {
      const schedule = scheduleFace()
      if (schedule === undefined) throw new Error('the native schedule service is unavailable in this profile')
      const record = await schedule.create(sessionId, {
        prompt: request.prompt,
        title: request.title,
        ...request.selector,
      })
      const id = typeof record['id'] === 'string' ? record['id'] : undefined
      const scheduledAt = typeof record['scheduledAt'] === 'string' ? record['scheduledAt'] : undefined
      if (id === undefined || scheduledAt === undefined) throw new Error('schedule.create returned an unexpected record')
      return { id, scheduledAt }
    },
    async deleteTask(sessionId: string, id: string): Promise<void> {
      const schedule = scheduleFace()
      if (schedule === undefined) throw new Error('the native schedule service is unavailable in this profile')
      await schedule.delete({ sessionId, id })
    },
    async inspectSession(sessionId: string): Promise<{ cwd?: string; agentPreset?: string }> {
      const controller = controllerFace()
      if (controller === undefined) throw new Error('the session controller is unavailable')
      const inspection = await controller.inspect(sessionId)
      const meta = inspection?.meta
      return {
        ...(typeof meta?.cwd === 'string' && meta.cwd !== '' ? { cwd: meta.cwd } : {}),
        ...(typeof meta?.agentPreset === 'string' && meta.agentPreset !== '' ? { agentPreset: meta.agentPreset } : {}),
      }
    },
    async createSession(input: { cwd?: string; agentPreset?: string }): Promise<string> {
      const controller = controllerFace()
      if (controller === undefined) throw new Error('the session controller is unavailable')
      const value = await controller.create(buildSessionCreateRequest(input))
      const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : undefined
      if (sessionId === undefined) throw new Error('session creation returned no session id')
      return sessionId
    },
    /**
     * 运行会话跑出第一轮后挂回它所属的工作区。待运行期间刻意不挂：工作区里的空会话
     * 会被 DSH 的「新建会话」复用，新对话就会被认领成这条自动化待运行会话。
     */
    async attachSession(sessionId: string, cwd?: string): Promise<void> {
      if (cwd === undefined) return
      const workspaceId = workspaceIdFor(ctx, cwd)
      if (workspaceId === undefined) return
      const workspace = optionalService<WorkspaceRegistryFace>(ctx, 'workspaceRegistry')?.get?.(workspaceId)
      if (workspace?.attachSession === undefined) return
      await workspace.attachSession(sessionId)
    },
    async renameSession(sessionId: string, title: string): Promise<void> {
      if ((settings().nameRunSessions ?? true) === false) return
      const controller = controllerFace()
      if (controller === undefined) throw new Error('the session controller is unavailable')
      await controller.rename({ sessionId, title })
    },
    get runHistoryLimit(): number {
      return settings().runHistoryLimit ?? 50
    },
    now: () => Date.now(),
    log: (message: string, error?: unknown) => {
      if (error === undefined) { logger.warn(message); return }
      logger.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`)
    },
  }

  const store = new ScheduleModeStore(deps.storePath ?? defaultScheduleModeStorePath())
  const engine = new ScheduleModeEngine(store, ports)

  let disposed = false
  let disposeSurfaces: (() => void) | undefined
  const sync = (): void => {
    if (disposed) return
    // Stop pending work before removing the old admission surfaces. Enabling
    // later resumes through its persisted intent, never through a late callback.
    engine.setEnabled(false)
    disposeSurfaces?.()
    disposeSurfaces = undefined
    if ((settings().enabled ?? true) === false) return
    try {
      disposeSurfaces = registerResources(own => {
        own(registerScheduleModeRoutes(ctx, { engine, logger }))
        own(registerScheduleModeTools(ctx, engine))
        own(onEvent(ctx, 'schedule/changed', () => {
          if (!disposed) void engine.reconcile().catch(error => logger.warn(error))
        }))
        own(onEvent(ctx, 'workspace/session-stop', (...args: unknown[]) => {
          const payload = args[0] as { sessionId?: unknown } | undefined
          if (disposed || typeof payload?.sessionId !== 'string' || payload.sessionId === '') return
          void engine.stopSession(payload.sessionId).catch(error => logger.warn(error))
        }))
      })
      engine.setEnabled(true)
      void engine.reconcile().catch(error => logger.warn(error))
    } catch (error) {
      engine.setEnabled(false)
      throw error
    }
  }

  return registerResources(own => {
    own(() => { disposed = true; engine.dispose() })
    own(() => { disposeSurfaces?.() })
    own(onFamilyConfigChange(() => sync()))
    sync()
  })
}
