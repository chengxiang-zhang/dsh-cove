/**
 * Remote-access service domain: the two pieces every reverse-proxied
 * deployment needs regardless of whether the optional server-mode gateway is
 * mounted.
 *
 * - the per-request Host-ownership boot script and the authority posture
 *   readout (`./routes.ts`);
 * - the index boot rows every entry shares: the parser-blocking ownership
 *   script, the `crypto.randomUUID` polyfill and the `navigator.clipboard`
 *   shim (`./boot-scripts.ts`).
 *
 * The ownership decision is the shared host access fence, so this domain can
 * never claim more than the privileged panels already allow. Fail-closed: when
 * the fence service is missing, `accessTrustOf` falls back to the strict
 * loopback rule and only a loopback page (which already owns the Host) is
 * admitted.
 * @module dsh-web-all/host/services/remote-access
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { accessTrustOf, browserSessionPredicateOf, trustedAuthoritiesOf } from '../access-trust/index.ts'
import { CLIPBOARD_SHIM_SCRIPT, HOST_ACCESS_BOOT_PATH, UUID_POLYFILL_SCRIPT } from './boot-scripts.ts'
import { makeRemoteAccessRoutes, type RemoteAccessDeps } from './routes.ts'
import { registerResources } from '../resources.ts'

export {
  CLIPBOARD_SHIM_SCRIPT,
  HOST_ACCESS_BOOT_PATH,
  HOST_ACCESS_MARKER_COOKIE,
  HOST_ACCESS_MARKER_MAX_AGE_SECONDS,
  HOST_ACCESS_MARKER_VALUE,
  HOST_ACCESS_SESSION_PATH,
  UUID_POLYFILL_SCRIPT,
  hostAccessBootScript,
} from './boot-scripts.ts'
export { makeRemoteAccessRoutes, type RemoteAccessDeps } from './routes.ts'

/**
 * Mount the service domain.
 * @param ctx - host plugin context.
 * @returns the disposer releasing the routes and the injection rows.
 */
export function register(ctx: Context): () => void {
  const deps: RemoteAccessDeps = {
    isTrusted: (request: IncomingMessage): boolean => accessTrustOf(ctx).isTrusted(request),
    trustedAuthorities: () => trustedAuthoritiesOf(ctx),
    isAuthenticated: (request: IncomingMessage): boolean => browserSessionPredicateOf(ctx)?.(request) === true,
  }
  return registerResources(own => {
  for (const route of makeRemoteAccessRoutes(deps)) own(ctx.webServer.register(route))

  // Row order is execution order: the parser-blocking ownership script runs
  // first, then the two inline shims the plain-HTTP origin needs.
  own(ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script-src', placement: 'head', src: HOST_ACCESS_BOOT_PATH })
    table.push({ kind: 'script', placement: 'head', text: UUID_POLYFILL_SCRIPT })
    table.push({ kind: 'script', placement: 'head', text: CLIPBOARD_SHIM_SCRIPT })
  }))
  })
}