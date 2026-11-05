/**
 * Mount the external-session service domain.
 *
 * The engine is provided unconditionally, because the panel reads it whether or
 * not a session may delegate; the model-facing tools are not registered here at
 * all. They belong to the preset-level entry (`preset-tools`), which is what
 * keeps a preset's two provider switches meaningful. See `docs/external-session.md`.
 * @module dsh-web-all/host/services/external-session
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  EXTERNAL_SESSION_SERVICE, type ExternalSessionGateway,
} from '../../../core/external-session/gateway.ts'
import type { ExternalAdapter } from '../../../core/external-session/adapters.ts'
import type { ExternalProvider } from '../../../core/external-session/types.ts'
import { resolveExternalSessionConfig, type ExternalSessionConfig } from './config.ts'
import { ExternalSessionEngine } from './engine.ts'
import { assertNoNativeProvider, watchNativeProviders } from './mutex.ts'
import { registerDelegationTools } from './tools.ts'
import { createAdapterRegistry } from './registry.ts'
import { registerExternalSessionRoutes } from './routes.ts'
import { ExternalSessionStore, isDirectory, type StoreFileSystem } from './store.ts'

export { EXTERNAL_SESSION_SERVICE } from '../../../core/external-session/gateway.ts'
export { resolveExternalSessionConfig, EXTERNAL_SESSION_DEFAULTS, binaryFor } from './config.ts'
export type { ExternalSessionConfig, ResolvedExternalSessionConfig } from './config.ts'
export { ExternalSessionEngine } from './engine.ts'
export { ExternalSessionStore } from './store.ts'
export { assertNoNativeProvider, findNativeProviderConflict, describeConflict, watchNativeProviders } from './mutex.ts'
export { EXTERNAL_SESSION_API, registerExternalSessionRoutes } from './routes.ts'

/** Service-domain options; every field has a production default. */
export interface ExternalSessionServiceDeps {
  /** Deployment overrides for the design defaults. */
  config?: ExternalSessionConfig
  /** DSH home directory holding the store file. */
  dshHome?: string
  /** Replace the built adapters (tests, or a host with its own adapter set). */
  adapters?: Partial<Record<ExternalProvider, ExternalAdapter>>
  /** Replace the store filesystem (tests). */
  fileSystem?: StoreFileSystem
}

/** Warning outlet that never throws, whatever the logger's own state. */
function warnVia(ctx: Context): (message: string) => void {
  return (message: string) => {
    try {
      ctx.logger('web-all:external-session').warn(message)
    } catch {
      console.warn(message)
    }
  }
}

/**
 * Mount the domain.
 * @param ctx - host plugin context.
 * @param deps - deployment overrides and test seams.
 * @returns the disposer releasing the provided service and its routes.
 */
export function register(ctx: Context, deps: ExternalSessionServiceDeps = {}): () => void {
  const warn = warnVia(ctx)
  const config = resolveExternalSessionConfig(deps.config, deps.dshHome)

  // Refuses to mount while a native external provider is still registered, so
  // two paths to the same CLI can never run at once. A host without the subagent
  // service passes: absence is a valid deployment, not a conflict.
  assertNoNativeProvider(ctx, warn)

  const store = new ExternalSessionStore({
    storePath: config.storePath,
    maxSessions: config.maxSessions,
    ...(deps.fileSystem === undefined ? {} : { fs: deps.fileSystem }),
    onWarning: warn,
  })
  const adapters = deps.adapters ?? createAdapterRegistry(ctx, config)
  const engine = new ExternalSessionEngine({
    config,
    store,
    adapters,
    directoryProbe: isDirectory,
    logger: { warn },
  })
  const gateway: ExternalSessionGateway = engine
  const disposeService = ctx.provide(EXTERNAL_SESSION_SERVICE, gateway)
  const disposeRoutes = registerExternalSessionRoutes(ctx, gateway)
  // The probe above is a snapshot of the registry at this instant. A profile
  // that mounts the native external bundles after this entity passes it with an
  // empty registry and then gets both paths a moment later, so the same
  // identification runs again on every later provider registration.
  const disposeWatch = watchNativeProviders(ctx, warn)
  // The delegation tools belong to this Loader entry, not to a preset row: a preset
  // mounts its plugin outside the Loader, and a module imported from there can never
  // be replaced without a restart.
  const disposeTools = registerDelegationTools(ctx, gateway, config.delegation, warn)

  // The first read is eager so the panel and the tools see the persisted
  // sessions immediately; a failure here degrades to an empty store with a
  // warning rather than leaving the domain unmounted.
  void store.load().catch((error: unknown) => {
    warn(`external-session store could not be read at startup: ${String(error)}`)
  })

  return () => {
    try { disposeTools() } catch { /* tolerant */ }
    try { disposeWatch() } catch { /* tolerant */ }
    try { disposeRoutes() } catch { /* tolerant */ }
    try { disposeService() } catch { /* tolerant */ }
  }
}