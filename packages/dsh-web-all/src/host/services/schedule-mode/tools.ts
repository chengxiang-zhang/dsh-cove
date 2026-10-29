/**
 * schedule-mode agent 工具：让模型在会话内查看/切换自动化任务的运行目标。
 *
 * 工具是全局注册（与 ssh_* / memoir_* 同层），`session_id` 缺省取调用方会话；
 * 因此「把这个任务改成每次新会话」在对话里就能完成，不需要打开面板。
 */
import { defineTool, type GenericCallView, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ScheduleModeTaskView } from '../../../core/schedule-mode/view.ts'
import type { ScheduleModeEngine } from './engine.ts'
import { ScheduleModeError } from './engine.ts'
import { registerResources } from '../resources.ts'

/** 调用方会话面（工具运行上下文里的 agent 结构子集）。 */
interface CallerAgentFace {
  session?: { id?: unknown }
}

function callerSessionId(agent: unknown): string | undefined {
  const id = (agent as CallerAgentFace | undefined)?.session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 模型视图形状（与工具 output schema 一一对应）。 */
interface TaskWire {
  id: string
  sessionId: string
  title: string
  mode: 'original' | 'new'
  status: 'active' | 'inactive' | 'ended'
  scheduledAt: string
  runSessionId: string
  runCount: number
  recovery: string
}

/** 模型视图：字段少而稳定，不泄漏内部副本 id。 */
function taskView(task: ScheduleModeTaskView): TaskWire {
  return {
    id: task.id,
    sessionId: task.sessionId,
    title: task.title,
    mode: task.mode,
    status: task.status,
    scheduledAt: task.scheduledAt ?? '',
    runSessionId: task.runSessionId ?? '',
    runCount: task.runs.length,
    recovery: task.recovery === undefined ? '' : `${task.recovery.phase}: ${task.recovery.reason ?? 'transition pending'}`,
  }
}

const ERROR_CODES = ['unknown-task', 'task-ended', 'invalid-request', 'recovery-required', 'schedule-unavailable'] as const

function errorView(error: unknown): { code: (typeof ERROR_CODES)[number]; message: string } {
  if (error instanceof ScheduleModeError) return { code: error.code, message: error.message }
  return { code: 'schedule-unavailable', message: error instanceof Error ? error.message : String(error) }
}

/** 创建两个 schedule_mode_* 工具定义。 */
export function createScheduleModeTools(engine: ScheduleModeEngine): ToolDefinition[] {
  return [
    defineTool({
      name: 'schedule_mode_list',
      description: 'List automation tasks with their run target: "original" keeps delivering into the conversation that created the task, '
        + '"new" starts a fresh session for every run. Use this to tell the user where each task will run — this run target has no settings page. '
        + 'Omit session_id to list every task; pass it to filter one conversation.',
      parameters: {
        session_id: { type: 'string', description: 'Only list tasks created in this session (the original conversation).' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false, properties: {
            tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
              id: { type: 'string', required: true }, sessionId: { type: 'string', required: true },
              title: { type: 'string', required: true }, mode: { type: 'string', required: true, enum: ['original', 'new'] },
              status: { type: 'string', required: true, enum: ['active', 'inactive', 'ended'] },
              scheduledAt: { type: 'string', required: true }, runSessionId: { type: 'string', required: true },
              runCount: { type: 'integer', required: true },
              recovery: { type: 'string', required: true },
            } } },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const listed = await engine.list()
        if (!listed.available) return { tasks: [], error: 'the native schedule service is unavailable in this profile' }
        const tasks = args.session_id === undefined || args.session_id === ''
          ? listed.tasks
          : listed.tasks.filter(task => task.sessionId === args.session_id || task.runSessionId === args.session_id)
        return { tasks: tasks.map(taskView) }
      },
      presentCall(args): GenericCallView {
        return { card: 'generic', title: 'List automation task run targets', kind: 'read', rawInput: args }
      },
    }),
    defineTool({
      name: 'schedule_mode_set',
      description: 'Set where an automation task delivers, chosen when the task is created. There is no settings page for this: when the user creates a reminder and says it should run in a new conversation each time ("每次新对话/新会话", "new chat every run"), call schedule_create first and then call this with mode="new". '
        + 'mode="new" gives every run its own fresh session and keeps the original conversation clean; mode="original" (the native default) delivers into the conversation that created the task. '
        + 'Pass the id returned by schedule_create (or from schedule_mode_list); session_id defaults to the calling session and is only needed from a run session.',
      parameters: {
        id: { type: 'string', required: true, description: 'Task id returned by schedule_create.' },
        mode: { type: 'string', required: true, enum: ['original', 'new'], description: 'Run target: original conversation, or a fresh session for every run.' },
        session_id: { type: 'string', description: 'Original conversation holding the task; defaults to the calling session.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false, properties: {
            task: { type: 'object', additionalProperties: false, properties: {
              id: { type: 'string', required: true }, sessionId: { type: 'string', required: true },
              title: { type: 'string', required: true }, mode: { type: 'string', required: true, enum: ['original', 'new'] },
              status: { type: 'string', required: true, enum: ['active', 'inactive', 'ended'] },
              scheduledAt: { type: 'string', required: true }, runSessionId: { type: 'string', required: true },
              runCount: { type: 'integer', required: true },
              recovery: { type: 'string', required: true },
            } },
            code: { type: 'string' }, message: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const sessionId = args.session_id !== undefined && args.session_id !== ''
          ? args.session_id
          : callerSessionId(exec.agent)
        if (sessionId === undefined) {
          return { code: 'invalid-request' as const, message: 'session_id is required outside a conversation' }
        }
        try {
          const task = await engine.setMode(sessionId, args.id, args.mode)
          return { task: taskView(task) }
        } catch (error) {
          return errorView(error)
        }
      },
      presentCall(args): GenericCallView {
        return {
          card: 'generic',
          title: args.mode === 'new' ? 'Run each time in a new session' : 'Restore the original conversation',
          kind: 'other',
          rawInput: args,
        }
      },
    }),
  ]
}

/** 注册工具；tools 服务不可用时静默跳过（与 ssh/memoir 约定一致）。 */
export function registerScheduleModeTools(ctx: import('@deepseek-ai/cordis').Context, engine: ScheduleModeEngine): () => void {
  return registerResources(own => {
    for (const tool of createScheduleModeTools(engine)) own(ctx.tools.register(tool))
  })
}
