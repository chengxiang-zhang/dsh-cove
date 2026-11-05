/**
 * The model-facing tool surface of the external-session capability.
 *
 * Two delegation tools keep the native spellings (`subagent_claude_code`,
 * `subagent_codex`) so preset prompts and habits carry over; two control tools
 * report state and close sessions. All four block until their work settles,
 * because a tool result is the only channel that reaches the conversation
 * without a message-injection API the plugin does not have.
 *
 * Registration is not done here: the preset decides which tools a session sees,
 * so `src/preset-tools.ts` owns the row and this module only builds definitions.
 * @module dsh-web-all/host/services/external-session/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  defineTool,
  type GenericCallView,
  type OneOfValueSchemaSpec,
  type ParameterPropertySpec,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { EXTERNAL_ERROR_CODES, type ExternalError } from '../../../core/external-session/errors.ts'
import type { ExternalSessionGateway } from '../../../core/external-session/gateway.ts'
import {
  EXTERNAL_PROVIDERS, EXTERNAL_SESSION_STATUSES,
  type ExternalModelOption, type ExternalProvider, type ExternalSessionStatus,
} from '../../../core/external-session/types.ts'
import { NATIVE_PROVIDER_ROWS, NATIVE_TOOL_ROWS } from './mutex.ts'
import type { ResolvedExternalSessionConfig } from './config.ts'

/** Default tool names, matching the native external providers. */
export const DELEGATION_TOOL_NAMES: Readonly<Record<ExternalProvider, string>> = {
  claude: 'subagent_claude_code',
  codex: 'subagent_codex',
}

/** Control tool names. */
export const EXTERNAL_SESSION_LIST_TOOL = 'external_session_list'
export const EXTERNAL_SESSION_STOP_TOOL = 'external_session_stop'

/** Resolves the mounted engine; undefined while the host service is absent. */
export type GatewayLookup = () => ExternalSessionGateway | undefined

/** Structural slice of the tool execution context the cwd default needs. */
interface SessionContext {
  agent?: { session?: { header?: { cwd?: string } } }
}

/** The working directory a call runs in: the session's, then the host process's. */
function callCwd(exec: unknown): string {
  const cwd = (exec as SessionContext).agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', enum: EXTERNAL_ERROR_CODES, required: true },
    message: { type: 'string', required: true },
  },
} as const

const TURN_STATUS_SCHEMA = { type: 'string', enum: ['completed', 'failed', 'aborted'] } as const

const TURN_RESULT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: { type: 'string', required: true },
        turn: { type: 'integer', required: true },
        status: TURN_STATUS_SCHEMA,
        result: { type: 'string', required: true },
        usage: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                input: { type: 'integer', required: true },
                output: { type: 'integer', required: true },
              },
            },
            { type: 'null' },
          ],
          required: true,
        },
        cost_usd: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
        can_continue: { type: 'boolean', required: true },
      },
    },
    ERROR_SCHEMA,
  ],
} as const

const OVERVIEW_LIST_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessions: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              provider: { type: 'string', enum: EXTERNAL_PROVIDERS, required: true },
              title: { type: 'string', required: true },
              status: { type: 'string', enum: EXTERNAL_SESSION_STATUSES, required: true },
              cwd: { type: 'string', required: true },
              createdAt: { type: 'string', required: true },
              lastTurnAt: { type: 'string', required: true },
              canContinue: { type: 'boolean', required: true },
              turnCount: { type: 'integer', required: true },
              lastTurn: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      n: { type: 'integer', required: true },
                      status: TURN_STATUS_SCHEMA,
                      durationMs: { type: 'number', required: true },
                      usage: {
                        oneOf: [
                          {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                              input: { type: 'integer', required: true },
                              output: { type: 'integer', required: true },
                            },
                          },
                          { type: 'null' },
                        ],
                        required: true,
                      },
                      costUsd: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                    },
                  },
                  { type: 'null' },
                ],
                required: true,
              },
            },
          },
        },
      },
    },
    ERROR_SCHEMA,
  ],
} as const

const STOP_RESULT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: { type: 'string', required: true },
        status: { type: 'string', enum: ['closed'], required: true },
      },
    },
    ERROR_SCHEMA,
  ],
} as const

/**
 * The one failure these tools report on their own: the host service is not
 * mounted. It is typed explicitly because an inline literal widens `code` to
 * `string` and would stop matching the declared output schema.
 */
const SERVICE_UNMOUNTED: ExternalError = {
  code: 'provider-missing',
  message: 'The external-session host service is not mounted in this deployment.',
}

function jsonText(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * The `model` parameter for one provider tool.
 *
 * A configured catalogue becomes an exact-one `oneOf` so every model carries its
 * own description in the schema the model reads; without a catalogue the
 * parameter stays a free string, because refusing an id this plugin cannot
 * enumerate would leave the operator unable to name a model the CLI accepts.
 * @param models - the row’s catalogue for this provider.
 * @returns the parameter schema.
 */
function modelChoiceParameter(models: readonly ExternalModelOption[]): ParameterPropertySpec {
  if (models.length === 0) {
    return {
      type: 'string',
      description:
        'Exact model id for this turn. Leave it out unless the operator named one: '
        + 'this provider has no configured catalogue, and the CLI’s own setting decides.',
    }
  }
  if (models.length === 1) {
    // `oneOf` needs at least two branches, so a single-model catalogue is an enum.
    const only = models[0] as ExternalModelOption
    return { type: 'string', enum: [only.id], description: only.description }
  }
  const choices = models.map(option => ({
    type: 'string' as const,
    const: option.id,
    description: option.description,
  }))
  // The enforced subset wants a non-empty tuple of branches; the outer cast is what
  // carries the mapped array, because its length is known only at runtime.
  return { oneOf: choices } as unknown as ParameterPropertySpec
}

/**
 * Build one delegation tool for a provider.
 *
 * One tool per provider, each carrying only its own CLI's guidance and only its
 * own selectable models: a model choosing between Claude Code and Codex reads two
 * different tools, and a shared catalogue would invite it to hand Claude's model
 * ids to Codex.
 * @param provider - which CLI the tool drives.
 * @param lookup - resolves the mounted engine.
 * @param toolName - model-visible tool name; defaults to the native spelling.
 * @param models - operator-configured catalogue of models this tool may select.
 * @returns the tool definition to register.
 */
export function makeDelegationTool(
  provider: ExternalProvider,
  lookup: GatewayLookup,
  toolName: string = DELEGATION_TOOL_NAMES[provider],
  models: readonly ExternalModelOption[] = [],
  defaultModel?: string,
): ToolDefinition {
  const label = provider === 'claude' ? 'Claude Code' : 'Codex'
  const defaultLine = defaultModel === undefined
    ? 'Omit model to keep the CLI\u2019s own configured model. '
    : 'Omit model to use ' + defaultModel + ', the configured default for this tool. '
  const catalogue = models.length === 0
    ? 'This tool exposes no model choice: ' + defaultLine
    : 'Pass model to pin this turn\u2019s model; ' + defaultLine
      + 'A continuation may switch models, and every turn records the model it ran on. '
      + 'Allowed models: ' + models.map(option => option.id + ' (' + option.description + ')').join('; ') + '. '
  // The parameter schema is the only place the catalogue reaches the model, so
  // the per-model descriptions ride on the oneOf branches rather than a bare enum.
  const modelParameter: ParameterPropertySpec = modelChoiceParameter(models)
  return defineTool({
    name: toolName,
    description:
      'Delegate exactly one turn to the ' + label + ' CLI running on this host, and return its result. '
      + 'Omit session_id to start a new external session: this is the one-shot shape, and it is '
      + 'the right call for a single self-contained job. '
      + 'Pass the session_id a previous ' + label + ' call returned to continue that same CLI conversation: '
      + 'the follow-up runs in the CLI session that already holds the earlier context, so it need not '
      + 'be restated and the prior work is still there. '
      + catalogue
      + 'The call blocks until the turn finishes. A returned can_continue of false means the CLI did '
      + 'not report a conversation id, so start a new session for further work. '
      + 'Failures come back as a code and one sentence, never as raw CLI output.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'The task or follow-up message for the external CLI.',
      },
      session_id: {
        type: 'string',
        description:
          'External session id from a previous call. Omit to start a new session and run its first turn.',
      },
      cwd: {
        type: 'string',
        description:
          'Working directory for a new session. Omit to use this conversation\u2019s directory. '
          + 'Ignored when continuing: a CLI conversation keeps the directory it started in.',
      },
      title: {
        type: 'string',
        description: 'Short title for a new session, shown in the panel. Ignored when continuing.',
      },
      model: modelParameter,
    },
    output: {
      schema: TURN_RESULT_SCHEMA,
      render: (_args, value) => jsonText(value),
    },
    async execute(args, exec) {
      const gateway = lookup()
      if (gateway === undefined) {
        return SERVICE_UNMOUNTED
      }
      const request: Parameters<ExternalSessionGateway['runTurn']>[0] = {
        provider,
        prompt: args.prompt,
        cwd: args.cwd ?? callCwd(exec),
        signal: exec.signal,
      }
      if (args.session_id !== undefined) request.sessionId = args.session_id
      if (args.title !== undefined) request.title = args.title
      const rawModel = (args as { model?: unknown }).model
      const chosen = typeof rawModel === 'string' ? rawModel.trim() : ''
      if (chosen.length > 0) request.model = chosen
      else if (defaultModel !== undefined) request.model = defaultModel
      return gateway.runTurn(request)
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: 'Delegate to ' + label + (args.session_id === undefined ? '' : ' (continue)')
          + (typeof (args as { model?: unknown }).model === 'string'
            ? ' \u00b7 ' + String((args as { model?: unknown }).model)
            : ''),
        kind: 'other',
        rawInput: args,
      }
    },
  })
}

/**
 * Build the state tool.
 * @param lookup - resolves the mounted engine.
 * @param toolName - model-visible tool name.
 * @returns the tool definition to register.
 */
export function makeListTool(
  lookup: GatewayLookup,
  toolName: string = EXTERNAL_SESSION_LIST_TOOL,
): ToolDefinition {
  return defineTool({
    name: toolName,
    description:
      'List the external CLI sessions this host keeps, newest activity last, with each session\u2019s '
      + 'status and its last turn. Use it to find the session_id to continue, or to check whether '
      + 'an earlier delegation is still running, failed, or was closed.',
    parameters: {
      status: {
        type: 'string',
        enum: EXTERNAL_SESSION_STATUSES,
        description: 'Only list sessions in this state.',
      },
    },
    output: {
      schema: OVERVIEW_LIST_SCHEMA,
      render: (_args, value) => jsonText(value),
    },
    async execute(args) {
      const gateway = lookup()
      if (gateway === undefined) {
        return SERVICE_UNMOUNTED
      }
      const filter = args.status as ExternalSessionStatus | undefined
      return gateway.listOverviews(filter)
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: 'External sessions', kind: 'read', rawInput: args }
    },
  })
}

/**
 * Build the close tool.
 * @param lookup - resolves the mounted engine.
 * @param toolName - model-visible tool name.
 * @returns the tool definition to register.
 */
export function makeStopTool(
  lookup: GatewayLookup,
  toolName: string = EXTERNAL_SESSION_STOP_TOOL,
): ToolDefinition {
  return defineTool({
    name: toolName,
    description:
      'Close an external CLI session. A running turn is cancelled first. '
      + 'A closed session keeps its record but takes no further turns; start a new session to '
      + 'continue the work.',
    parameters: {
      session_id: {
        type: 'string',
        required: true,
        description: 'External session id to close.',
      },
    },
    output: {
      schema: STOP_RESULT_SCHEMA,
      render: (_args, value) => jsonText(value),
    },
    async execute(args) {
      const gateway = lookup()
      if (gateway === undefined) {
        return SERVICE_UNMOUNTED
      }
      return gateway.close(args.session_id)
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: 'Close external session', kind: 'other', rawInput: args }
    },
  })
}

/**
 * Register one tool, tolerating a registry that is absent or already holds the
 * name. A second preset row for the same capability must not fail the plugin.
 *
 * The duplicate case is the one that needs a voice. The registry rejects a name
 * that is already taken, and whoever registered first keeps it, so a leftover
 * native row silently wins and the delegation this capability owns disappears
 * from the tool catalogue with nothing in the log to explain it. The caller
 * therefore receives `onSkip` and reports the stand-down.
 * @param ctx - the context to register on.
 * @param tool - the definition to register.
 * @param onSkip - called with the definition and the registry error when the name is taken.
 * @returns the disposer, or a no-op when nothing was registered.
 */
export function registerToolTolerantly(
  ctx: Context,
  tool: ToolDefinition,
  onSkip?: (tool: ToolDefinition, error: unknown) => void,
): () => void {
  try {
    const dispose = ctx.tools.register(tool)
    return () => { try { dispose() } catch { /* tolerant */ } }
  } catch (error) {
    try {
      onSkip?.(tool, error)
    } catch {
      // Reporting a skip must not become the failure the skip was avoiding.
    }
    return () => {}
  }
}
/**
 * The notice a tool reports when another row already owns its name.
 *
 * The registry rejects a taken name and keeps the first registrant, so a leftover
 * native row silently wins and the delegation this capability owns disappears
 * from the catalogue with nothing in the log to explain it.
 */
export function nameTakenNotice(toolName: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `[web-all] external-session tool "${toolName}" was not registered: ${detail}. `
    + 'Another row owns that name — normally the native external providers still being mounted. '
    + `Turn off the ${NATIVE_PROVIDER_ROWS.map(row => `\`${row}\``).join(' and ')} provider rows and `
    + `the ${NATIVE_TOOL_ROWS.map(row => `\`${row}\``).join(' and ')} tool rows `
    + '(docs/external-session.md §13) and reload so this capability serves the name.'
}

/**
 * Install the delegation surface on the host service domain.
 *
 * The tools are part of the entity's own Loader entry. A preset row that mounted a
 * separate entry would instantiate this module from a plugin the Loader does not
 * own, and HMR can only replace modules whose every live importer is a Loader
 * entry — which is what turned every change here into a restart.
 * @param ctx - the host context the domain mounted on.
 * @param gateway - the mounted engine.
 * @param delegation - decided surface per provider, with each provider's catalogue.
 * @param warn - warning outlet for a shadowed tool name.
 * @returns the disposer releasing every registered tool.
 */
export function registerDelegationTools(
  ctx: Context,
  gateway: ExternalSessionGateway,
  delegation: ResolvedExternalSessionConfig['delegation'],
  warn: (message: string) => void,
): () => void {
  const lookup: GatewayLookup = () => gateway
  const onSkip = (tool: ToolDefinition, error: unknown): void => {
    warn(nameTakenNotice(tool.name, error))
  }
  const disposers: Array<() => void> = []
  for (const provider of EXTERNAL_PROVIDERS) {
    const surface = delegation[provider]
    if (!surface.enabled) continue
    disposers.push(registerToolTolerantly(
      ctx,
      makeDelegationTool(provider, lookup, DELEGATION_TOOL_NAMES[provider], surface.models, surface.default),
      onSkip,
    ))
  }
  // The control tools describe the store, not one CLI: they are registered once.
  disposers.push(registerToolTolerantly(ctx, makeListTool(lookup), onSkip))
  disposers.push(registerToolTolerantly(ctx, makeStopTool(lookup), onSkip))
  return () => { for (const dispose of disposers) dispose() }
}
