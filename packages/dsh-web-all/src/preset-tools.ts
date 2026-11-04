/**
 * Preset-level tool entry for the external-session capability.
 *
 * The entity package owns one Cordis lifecycle (`web-all`), so a tool that must
 * appear only when a preset asks for it cannot live in the host assembly — it
 * would reach every session and the per-provider switches in the settings UI
 * would stop meaning anything. This module is the thin row a preset mounts
 * instead: one row per provider, carrying the provider and the tool name, which
 * resolves the mounted engine from the context and registers the matching tool.
 *
 * The engine itself is mounted unconditionally by the host assembly, because
 * the panel reads it whether or not a session may delegate. The two control
 * tools travel with this entry for the same visibility reason: whether a model
 * may list or close external sessions is a preset decision, not a host one.
 *
 * A missing engine makes the row inert: it registers no tool and logs one line.
 * That is deliberate. The host settings may still declare a native tool under the
 * same name, and a duplicate that wins the registration would replace a working
 * tool with one that can only answer `provider-missing`; standing down leaves the
 * operator with what they already had.
 * @module dsh-web-all/preset-tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { EXTERNAL_SESSION_SERVICE, type ExternalSessionGateway } from './core/external-session/gateway.ts'
import type { ExternalProvider } from './core/external-session/types.ts'
import {
  makeDelegationTool, makeListTool, makeStopTool, registerToolTolerantly,
} from './host/services/external-session/tools.ts'

/** Stable cordis plugin name. */
export const name = 'web-all-external-session-tools'

/** The tool registry is the only service this row needs. */
export const inject = ['tools']

/** One preset row: which CLI, under which tool name. */
export interface Config extends Record<string, unknown> {
  /** Provider this row delegates to; defaults to `claude`. */
  provider?: ExternalProvider
  /** Model-visible tool name; defaults to the native spelling for the provider. */
  toolName?: string
  /**
   * Whether this row also registers `external_session_list` and
   * `external_session_stop`. Defaults to true; set false on extra rows so the
   * control tools are declared once.
   */
  control?: boolean
}

type ContextWithGet = Context & { get?: (id: string, strict?: boolean) => unknown }

/**
 * Resolve the mounted engine. Read per call rather than captured, so a host
 * mount that happens after this row still reaches the tools.
 * @param ctx - the context this row was applied on.
 * @param onMissing - called the first time the service is absent, for one warning.
 * @returns the gateway, or undefined while the host service is not mounted.
 */
function gatewayOf(ctx: Context, onMissing: () => void): ExternalSessionGateway | undefined {
  const get = (ctx as ContextWithGet).get
  if (typeof get !== 'function') {
    onMissing()
    return undefined
  }
  try {
    const service = get.call(ctx, EXTERNAL_SESSION_SERVICE, false) as ExternalSessionGateway | undefined
    if (service === undefined) {
      onMissing()
      return undefined
    }
    return service
  } catch {
    onMissing()
    return undefined
  }
}

/**
 * The one warning this row emits when it stands down.
 *
 * Named so the build artifact can be grepped for the stand-down branch: a
 * deployment that mounts the row without the engine should leave exactly this
 * line in its log and no tools in the catalogue.
 */
export const NO_ENGINE_NOTICE = '[web-all] external-session tools are not registered: '
  + 'the host service is not mounted (the row stays inert rather than shadowing same-named tools)'

/** Report the stand-down once, through the host logger when there is one. */
function reportStandDown(ctx: Context): void {
  try { ctx.logger('web-all:external-session').warn(NO_ENGINE_NOTICE) } catch { console.warn(NO_ENGINE_NOTICE) }
}

/**
 * Mount one preset row.
 *
 * Stands down entirely when the engine cannot be resolved. Registering anyway
 * would be worse than doing nothing: the host's own settings may still declare a
 * native tool under the same name, and a duplicate registration that "wins"
 * would shadow a working tool with one that can only answer `provider-missing`.
 * An inert row costs the operator one log line; the alternative costs them the
 * tool they are using today.
 * @param ctx - host plugin context.
 * @param config - the row's provider, tool name and control toggle.
 */
export function apply(ctx: Context, config?: Config): void {
  const provider: ExternalProvider = config?.provider === 'codex' ? 'codex' : 'claude'
  const lookup = (): ExternalSessionGateway | undefined => gatewayOf(ctx, () => {})

  if (lookup() === undefined) {
    reportStandDown(ctx)
    return
  }

  ctx.effect(() => {
    const disposers = [registerToolTolerantly(ctx, makeDelegationTool(provider, lookup, config?.toolName))]
    if (config?.control !== false) {
      disposers.push(registerToolTolerantly(ctx, makeListTool(lookup)))
      disposers.push(registerToolTolerantly(ctx, makeStopTool(lookup)))
    }
    return () => { for (const dispose of disposers) dispose() }
  }, 'web-all: external-session preset tools')
}