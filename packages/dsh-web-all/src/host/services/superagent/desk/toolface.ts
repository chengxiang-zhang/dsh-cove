/**
 * Desk tool face (07, T20): three mechanical layers, none of them a prompt.
 *
 * 1. `restrict({ allow: [] })` on the desk session's agent scope hides every
 *    inherited (host-plane) tool.
 * 2. The nine desk tools are registered scoped on that same layer.
 * 3. A guard refuses any execution that is neither a desk tool nor a dispatch tool;
 *    no guard can overturn another guard's refusal (F11).
 *
 * Dispatch (2026-11-06 owner decision): the secretary hands work out itself, so the
 * agent-plane dispatch set (`subagent`, the Agent Team set) runs. Writing and
 * executing stay closed: those tools are not in the allow set, and a visible one
 * fails the self-check (`DENIED_VISIBLE_*`).
 *
 * S1 reading (fails, but not for scope access): `restrict` only filters inherited
 * tools, so tools the agent plane itself registers (today: `subagent`) stay
 * visible; the dedicated `superagent-desk` preset is what keeps the agent plane
 * empty. Execution scope is `exec.agent`, not the caller ctx, so a host-side
 * tool execution without an agent runs the global view: hence the global guard
 * below, keyed on the session id carried by `exec.agent`, and the rule that no
 * host route may call execute directly.
 */

import { defineTool, type ParameterSchemaSpec, type ToolDefinition, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { DESK_TOOL_NAMES } from '../protocol/tools.ts'
import { isDeniedVisible } from './self-check.ts'

export const DESK_REFUSAL = 'desk-has-no-such-tool'

/**
 * Agent-plane dispatch tools the desk may see and run: one-off work to `subagent`,
 * standing work to an agent team (`spawn_teammate` + `team_task_*`) and the
 * messaging/wait/interrupt tools that steer it. None writes or executes itself.
 */
export const DISPATCH_TOOLS: readonly string[] = Object.freeze(['subagent', 'spawn_teammate', 'send_message', 'wait_agent', 'list_agents',
  'interrupt_agent', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update'])
/** @deprecated kept for readers of the S1 name; the set is DISPATCH_TOOLS. */
export const AGENT_FACE_TOOLS: readonly string[] = DISPATCH_TOOLS
const leaked = DISPATCH_TOOLS.filter(isDeniedVisible)
if (leaked.length) throw new Error(`dispatch set must not hold write/execute tools: ${leaked.join(', ')}`)

/** What the model sees of a value the tool returns: the host validates it against `schema`, then renders it. */
export interface ToolOutputSpec {
  schema: ValueSchemaSpec
  render(args: unknown, value: unknown): { type: 'text'; text: string }[]
}

/**
 * A host tool before compilation. `parameters` is the host's property table
 * (`{ field: { type, description, required? } }`), not a JSON Schema object;
 * `hostToolOf` compiles it with `defineTool`, which also validates arguments.
 */
export interface HostToolSpec {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  output: ToolOutputSpec
  execute(input: unknown, context: { sessionId: string }): Promise<unknown> | unknown
}

export type DeskTool = HostToolSpec

/** Every value renders as its JSON text: the model reads exactly what the tool returned. */
export const renderJson = (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [{ type: 'text', text: JSON.stringify(value) }]

/**
 * The definition `ctx.tools.register` accepts (dsh-tools: output { schema, render }
 * is mandatory, and the parameter table becomes the model-facing JSON Schema).
 */
export function hostToolOf(tool: HostToolSpec, sessionId: string): ToolDefinition {
  // The spec is data, not a literal, so the inferred arg/value types widen; the host
  // validates both at run time against the compiled schemas.
  const options = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: { schema: tool.output.schema, render: (args: unknown, value: unknown) => tool.output.render(args, value) },
    execute: async (args: unknown) => tool.execute(args, { sessionId }),
  }
  const compile = defineTool as unknown as (o: typeof options) => ToolDefinition
  return compile(options)
}

export interface ToolExecutionLike { name: string; agent?: unknown }
export type Guard = (exec: ToolExecutionLike) => string | undefined

/** The agent-scope surface the composition root adapts from the DSH agent ctx. */
export interface AgentScopeLike {
  restrict(options: { allow: readonly string[] }): () => void
  register(tool: DeskTool): () => void
  guard(fn: Guard): () => void
  visible(): string[]
}

export interface ToolFacePort { scope(sessionId: string): Promise<AgentScopeLike> }

export interface ToolFace {
  apply(sessionId: string, tools: readonly DeskTool[]): Promise<() => void>
  visible(sessionId: string): Promise<string[]>
}

const DESK = new Set<string>(DESK_TOOL_NAMES)
/** What a desk session may execute: the nine desk tools and the dispatch set, nothing else. */
const ALLOWED = new Set<string>([...DESK_TOOL_NAMES, ...DISPATCH_TOOLS])
export const deskMayRun = (name: string): boolean => ALLOWED.has(name) && !isDeniedVisible(name)

/** Layer 3 on the desk scope. */
export const deskGuard: Guard = exec => (deskMayRun(exec.name) ? undefined : DESK_REFUSAL)

/** Session id carried by a tool execution: a string, or an object with `sessionId`/`id`. */
export function sessionOfExec(agent: unknown): string | undefined {
  if (typeof agent === 'string') return agent
  if (typeof agent === 'object' && agent !== null) {
    const a = agent as { sessionId?: unknown; id?: unknown }
    if (typeof a.sessionId === 'string') return a.sessionId
    if (typeof a.id === 'string') return a.id
  }
  return undefined
}

/**
 * Global guard (N3 branch): a desk session may run desk and dispatch tools only; any other
 * session may not run desk tools. An execution with no agent is the global view
 * and may not run desk tools either.
 */
export function globalDeskGuard(roleOf: (sessionId: string) => string | undefined): Guard {
  return exec => {
    const sid = sessionOfExec(exec.agent)
    const isDesk = sid !== undefined && (roleOf(sid)?.startsWith('desk:') ?? false)
    if (isDesk) return deskMayRun(exec.name) ? undefined : DESK_REFUSAL
    return DESK.has(exec.name) ? 'desk tools run only on desk sessions' : undefined
  }
}

export function createToolFace(port: ToolFacePort): ToolFace {
  return {
    async apply(sessionId, tools) {
      const scope = await port.scope(sessionId)
      const undo: (() => void)[] = [scope.restrict({ allow: [] })]
      for (const tool of tools) undo.push(scope.register(tool))
      undo.push(scope.guard(deskGuard))
      return () => { for (const fn of undo.reverse()) fn() }
    },
    async visible(sessionId) {
      return (await port.scope(sessionId)).visible()
    },
  }
}
