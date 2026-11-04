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
 * A missing engine is not an error here. The entry keeps its tools registered so
 * the tool catalogue matches what the preset declared, and each call reports
 * `provider-missing` instead of failing the plugin load.
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
 * Mount one preset row.
 * @param ctx - host plugin context.
 * @param config - the row's provider, tool name and control toggle.
 */
export function apply(ctx: Context, config?: Config): void {
  const provider: ExternalProvider = config?.provider === 'codex' ? 'codex' : 'claude'
  let warned = false
  const lookup = (): ExternalSessionGateway | undefined => gatewayOf(ctx, () => {
    if (warned) return
    warned = true
    const text = '[web-all] external-session tools are registered but the host service is not mounted; '
      + 'every call will report provider-missing'
    try { ctx.logger('web-all:external-session').warn(text) } catch { console.warn(text) }
  })

  ctx.effect(() => {
    const disposers = [registerToolTolerantly(ctx, makeDelegationTool(provider, lookup, config?.toolName))]
    if (config?.control !== false) {
      disposers.push(registerToolTolerantly(ctx, makeListTool(lookup)))
      disposers.push(registerToolTolerantly(ctx, makeStopTool(lookup)))
    }
    return () => { for (const dispose of disposers) dispose() }
  }, 'web-all: external-session preset tools')
}