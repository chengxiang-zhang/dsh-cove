/**
 * Optional BrowserAuth bypass service domain.
 *
 * This capability is deliberately inert unless `enabled: true` is supplied by
 * the central web-all assembly/profile. It patches only BrowserAuth's token
 * decision; the connection service continues to enforce its Host/Origin fence,
 * and the shared host access fence treats a deployment-declared trusted
 * authority as admitted in this mode, so only enable it behind an
 * authenticating reverse proxy or an equivalent network gate.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  BrowserConnectionLike,
  NoBrowserAuthConfig,
} from '../../../core/no-browser-auth/contract.ts'

export type {
  BrowserAuthLike,
  BrowserConnectionLike,
  NoBrowserAuthConfig,
} from '../../../core/no-browser-auth/contract.ts'

/** Replace the private authentication method and return an exact restoration. */
export function bypassBrowserAuthentication(connection: BrowserConnectionLike): () => void {
  const auth = connection.browserAuth
  if (auth === undefined || typeof auth.isAuthenticated !== 'function') {
    throw new Error(
      'dsh-no-browser-auth: connection.browserAuth.isAuthenticated is missing; the SDK connection shape changed — refuse to mount',
    )
  }
  const original = auth.isAuthenticated
  auth.isAuthenticated = () => true
  return () => {
    auth.isAuthenticated = original
  }
}

function resolveConnection(ctx: Context): BrowserConnectionLike {
  const get = (ctx as Context & { get?: (id: string) => unknown }).get
  const service = typeof get === 'function' ? get.call(ctx, 'connection') : undefined
  if (service !== undefined) return service as BrowserConnectionLike
  const direct = (ctx as Context & { connection?: BrowserConnectionLike }).connection
  if (direct !== undefined) return direct
  throw new Error('dsh-no-browser-auth: connection service not available on context')
}

/**
 * Mount the service domain. The web-all central assembler must pass an explicit
 * `enabled: true`; omission is a safe no-op.
 */
export function register(ctx: Context, config: NoBrowserAuthConfig = {}): () => void {
  if (config.enabled !== true) {
    ctx.logger?.info?.('dsh-no-browser-auth: disabled (web-all requires explicit opt-in)')
    return () => {}
  }

  const restore = bypassBrowserAuthentication(resolveConnection(ctx))
  ctx.logger?.warn?.(
    'dsh-no-browser-auth: BrowserAuth skipped; Host/Origin fence still applies. Only use behind an authenticating reverse proxy or equivalent network gate. Host-side panels (Git, Agent Browser, worktree, SSH, memoir, run-target, workbench) admit a deployment-declared trusted authority by Host/Origin alone in this mode, so any peer that can reach the listener may drive them.',
  )
  return restore
}
