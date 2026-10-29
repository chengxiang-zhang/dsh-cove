/**
 * Loopback fence for the server-mode plugin surfaces.
 *
 * The loopback webServer keeps privileged routes local-only - the public
 * gateway listener is the only door for remote clients - and this predicate
 * guards the admin account surface.
 *
 * It used to test the socket and the Host header alone. A web page satisfies
 * both by itself: a cross-site simple request (no preflight) to
 * `http://127.0.0.1:<port>` arrives on a loopback socket with a loopback Host,
 * so any page a browser can be made to fetch could reach account management and
 * create an admin. The rule therefore comes from the shared fence, which the
 * deployment contract requires on every privileged surface: loopback socket,
 * loopback Host, AND same-origin markers (see docs/remote-access.md, invariant
 * 2, and access-trust/trust.ts).
 */

import type { IncomingMessage } from 'node:http'
import { isLoopbackRequest } from '../../access-trust/trust.ts'

/**
 * Whether a request may use the loopback admin surface (account management).
 * Marker-aware on purpose: see the module comment.
 */
export function isLoopbackAdmin(request: IncomingMessage): boolean {
  return isLoopbackRequest(request)
}