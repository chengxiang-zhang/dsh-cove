/**
 * HTTP boundary of the remote-access domain: the per-request Host-ownership
 * boot script and the credential-free authority posture readout.
 *
 * Both routes exist for the documented reverse-proxy topology
 * (browser -> `http://dsh.<machine>/` -> nginx -> `127.0.0.1:3080`), where the
 * optional server-mode gateway is not in the request path:
 *
 * - `GET /web-all/remote-access/boot.js` is referenced by a parser-blocking
 *   `<script src>` row in every served index document. The handler runs the
 *   same shared host access fence the privileged panels use and answers with
 *   either a script that claims Host ownership or a no-op, so a remote page
 *   keeps a host-backed settings plane without granting that claim to an
 *   undeclared Host.
 * - `GET /api/dsh-access/session` reports whether this deployment declares the
 *   requesting Host (`authority.declared`), whether a browser session is
 *   present (`session`), and the full fence decision (`owners`). It needs no
 *   session, which is what lets the fleet audit detect a machine whose running
 *   process carries no `--trusted-host` for its canonical authority
 *   (docs/remote-access.md invariant 6); `authority` is therefore public and
 *   carries no canonical list or token, while the `session` bit is only
 *   computed for a caller the fence already admits.
 * @module dsh-web-all/host/services/remote-access/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { hostUrlOf, isLoopbackHostname, matchesTrustedAuthority } from '../access-trust/trust.ts'
import {
  HOST_ACCESS_BOOT_PATH,
  HOST_ACCESS_MARKER_COOKIE,
  HOST_ACCESS_MARKER_MAX_AGE_SECONDS,
  HOST_ACCESS_MARKER_VALUE,
  HOST_ACCESS_SESSION_PATH,
  hostAccessBootScript,
} from './boot-scripts.ts'

/** Admission inputs the remote-access routes read per request. */
export interface RemoteAccessDeps {
  /** The shared host access fence decision for one request. */
  isTrusted(request: IncomingMessage): boolean
  /** Authorities this deployment declares as its browser entries. */
  trustedAuthorities(): readonly string[]
  /** Whether the request carries an authenticated browser session. */
  isAuthenticated(request: IncomingMessage): boolean
}

/** Whether the request reached the plugin over TLS, directly or through a proxy. */
function requestIsSecure(request: IncomingMessage): boolean {
  const forwarded = request.headers['x-forwarded-proto']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof value === 'string' && value.split(',')[0]?.trim().toLowerCase() === 'https') return true
  return (request.socket as { encrypted?: boolean } | undefined)?.encrypted === true
}

/**
 * Host-only provenance marker; `Secure` is appended only when the request
 * arrived over TLS, so a plain-HTTP entry can still read it back.
 */
function markerCookie(request: IncomingMessage): string {
  const secure = requestIsSecure(request) ? '; Secure' : ''
  return `${HOST_ACCESS_MARKER_COOKIE}=${HOST_ACCESS_MARKER_VALUE}; Path=/; SameSite=Lax; Max-Age=${String(HOST_ACCESS_MARKER_MAX_AGE_SECONDS)}${secure}`
}

function writeScript(response: ServerResponse, body: string, cookies: readonly string[] = []): void {
  const headers: Record<string, string | string[]> = {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'no-store',
  }
  if (cookies.length > 0) headers['set-cookie'] = [...cookies]
  response.writeHead(200, headers)
  response.end(body)
}

function writeJson(response: ServerResponse, status: number, body: unknown, cookies: readonly string[] = []): void {
  const headers: Record<string, string | string[]> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  if (cookies.length > 0) headers['set-cookie'] = [...cookies]
  response.writeHead(status, headers)
  response.end(JSON.stringify(body))
}

function methodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
  response.end()
}

/**
 * Build the remote-access routes.
 * @param deps - admission inputs, read live on every request.
 * @returns the routes to register on the web server.
 */
export function makeRemoteAccessRoutes(deps: RemoteAccessDeps): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: HOST_ACCESS_BOOT_PATH,
      handler: (request, response) => {
        if (request.method !== 'GET') { methodNotAllowed(response); return }
        const hostUrl = hostUrlOf(request)
        const loopback = hostUrl !== undefined && isLoopbackHostname(hostUrl.hostname)
        const admitted = deps.isTrusted(request)
        const cookies = admitted && !loopback ? [markerCookie(request)] : []
        writeScript(response, hostAccessBootScript(admitted), cookies)
      },
    },
    {
      kind: 'exact',
      path: HOST_ACCESS_SESSION_PATH,
      handler: (request, response) => {
        if (request.method !== 'GET') { methodNotAllowed(response); return }
        const hostUrl = hostUrlOf(request)
        const loopback = hostUrl !== undefined && isLoopbackHostname(hostUrl.hostname)
        const declared = loopback
          || (hostUrl !== undefined && matchesTrustedAuthority(hostUrl, deps.trustedAuthorities()))
        const owners = deps.isTrusted(request)
        const cookies = owners && !loopback ? [markerCookie(request)] : []
        writeJson(response, 200, {
          authority: {
            host: hostUrl?.host ?? '',
            loopback,
            declared,
          },
          // The browser-session predicate is only consulted for a caller the
          // fence already admits: an unadmitted caller must not be able to
          // spend the host's session lookup, and its session bit is false by
          // construction anyway.
          session: owners ? deps.isAuthenticated(request) : false,
          owners,
        }, cookies)
      },
    },
  ]
}