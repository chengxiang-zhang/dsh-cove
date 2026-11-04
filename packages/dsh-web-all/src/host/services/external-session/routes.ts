/**
 * The panel's data plane: `/api/external-session/*`.
 *
 * Four operations over one JSON envelope (`{ok, value}` / `{ok, error}`), and
 * one rule that shapes all of them: read and mutate through the same fence every
 * privileged host route family uses, then answer with the whole session list.
 * A panel that refreshed only one session could show a count that disagrees with
 * the list behind it, so every successful operation returns the same snapshot
 * shape the list does.
 *
 * `continue` deliberately does not wait for the turn it starts. The panel exists
 * to show a turn running and to offer cancellation, so the route finishes
 * preflight, launches, and returns the snapshot that already says `running`; the
 * turn's outcome arrives in a later read.
 *
 * There is deliberately no create route: a session starts when a model-facing
 * delegation tool omits `session_id`, so the panel only continues, cancels and
 * closes what a tool created. The panel shows state; the tools decide work.
 * @module dsh-web-all/host/services/external-session/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ExternalError, ExternalErrorCode } from '../../../core/external-session/errors.ts'
import type { ExternalSessionGateway } from '../../../core/external-session/gateway.ts'
import { accessTrustOf } from '../access-trust/index.ts'
import { registerResources } from '../resources.ts'

/** Route prefix. Changing it breaks the panel and is a contract change. */
export const EXTERNAL_SESSION_API = '/api/external-session'

/** Prompt body cap. A prompt may carry a file; anything larger is a mistake. */
const MAX_BODY_BYTES = 1 << 20

/** Route dependencies. */
export interface ExternalSessionRoutesDeps {
  gateway: ExternalSessionGateway
  /** Host access fence; defaults to the shared one resolved by the registrar. */
  isTrusted?(request: IncomingMessage): boolean
  logger?: { warn(message: string): void }
}

/**
 * HTTP status for one failure code.
 *
 * The client keys off `code`, never off the status; these exist so an operator
 * reading a log sees the difference between "the panel asked wrong" (400), "the
 * host cannot do this at all" (501) and "try again later" (429).
 *
 * `store-unavailable` answers 503 rather than 500: the host cannot serve this
 * request right now, and the retry is a host fix rather than a code change.
 *
 * Two of these are defensive: `auth-required` and `provider-error` describe a
 * turn that already started, and this route family never waits for a turn, so
 * they reach the panel inside the turn record rather than as a status. The
 * mapping stays total so a future blocking route cannot silently inherit a
 * wrong status.
 */
export function externalSessionStatusFor(code: ExternalErrorCode): number {
  switch (code) {
    case 'cwd-invalid':
      return 400
    case 'session-unknown':
      return 404
    case 'busy':
      return 429
    case 'provider-missing':
      return 501
    case 'provider-error':
      return 502
    case 'store-unavailable':
      return 503
    case 'auth-required':
    case 'session-closed':
    case 'session-unresumable':
    case 'limit':
      return 409
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function ok(response: ServerResponse, value: unknown): void {
  writeJson(response, 200, { ok: true, value })
}

function fail(response: ServerResponse, status: number, code: string, message: string): void {
  writeJson(response, status, { ok: false, error: { code, message } })
}

/** Report one engine refusal with the status its code implies. */
function refuse(response: ServerResponse, error: ExternalError): void {
  fail(response, externalSessionStatusFor(error.code), error.code, error.message)
}

/** One parsed body, or why it could not be used. */
type BodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: 'too-large' | 'malformed' }

/**
 * Read one JSON body.
 *
 * The two failure modes get different answers on purpose: an oversized body is
 * 413, while anything the caller can fix by sending different JSON is 400. Both
 * used to collapse into 413, which told a caller that a syntax error was a size
 * error.
 */
async function readJsonBody(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<BodyResult> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) return { ok: false, reason: 'too-large' }
    chunks.push(bytes)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'malformed' }
    return { ok: true, body: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

/** Report a body the route could not use. */
function refuseBody(response: ServerResponse, result: Extract<BodyResult, { ok: false }>): void {
  if (result.reason === 'too-large') {
    fail(response, 413, 'bad-request', `request body exceeds ${MAX_BODY_BYTES} bytes`)
    return
  }
  fail(response, 400, 'bad-request', 'request body must be a JSON object')
}

/** Non-empty string body field. */
function stringField(body: Record<string, unknown> | null, key: string): string | null {
  const value = body?.[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Build the route table.
 * @param deps - the gateway plus the admission decision.
 * @returns the routes to register, in registration order.
 */
export function makeExternalSessionRoutes(deps: ExternalSessionRoutesDeps): WebRoute[] {
  const { gateway } = deps
  const log = (message: string): void => deps.logger?.warn(message)

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // The fence comes first, before any parse: an untrusted caller must not
    // learn which routes exist by the shape of an error.
    if (deps.isTrusted !== undefined && !deps.isTrusted(request)) {
      fail(response, 403, 'forbidden', 'forbidden: this route family is not exposed to this caller')
      return
    }
    const url = new URL(request.url ?? '/', 'http://dsh.local')
    const path = url.pathname
    try {
      if (request.method === 'GET' && path === `${EXTERNAL_SESSION_API}/list`) {
        ok(response, await gateway.listViews())
        return
      }

      if (request.method === 'GET' && path === `${EXTERNAL_SESSION_API}/session`) {
        const id = url.searchParams.get('id')
        if (id === null || id === '') {
          fail(response, 400, 'bad-request', 'expected ?id=<session_id>')
          return
        }
        const snapshot = await gateway.listViews()
        const session = snapshot.sessions.find(entry => entry.id === id)
        if (session === undefined) {
          fail(response, 404, 'session-unknown', 'no external session has that id')
          return
        }
        ok(response, { session })
        return
      }

      if (request.method === 'POST' && path === `${EXTERNAL_SESSION_API}/continue`) {
        const parsedBody = await readJsonBody(request)
        if (!parsedBody.ok) {
          refuseBody(response, parsedBody)
          return
        }
        const sessionId = stringField(parsedBody.body, 'sessionId')
        const prompt = stringField(parsedBody.body, 'prompt')
        if (sessionId === null || prompt === null) {
          fail(response, 400, 'bad-request', 'expected { sessionId, prompt }')
          return
        }
        // The session's own provider is the one that knows this conversation:
        // a CLI session cannot be resumed by a different CLI.
        const snapshot = await gateway.listViews()
        const existing = snapshot.sessions.find(entry => entry.id === sessionId)
        if (existing === undefined) {
          fail(response, 404, 'session-unknown', 'no external session has that id')
          return
        }
        const refusal = await gateway.startTurn({
          provider: existing.provider,
          prompt,
          sessionId,
          // A continuation runs where the CLI conversation started.
          cwd: existing.cwd,
        })
        if (refusal !== null) {
          refuse(response, refusal)
          return
        }
        ok(response, await gateway.listViews())
        return
      }

      if (request.method === 'POST' && path === `${EXTERNAL_SESSION_API}/cancel`) {
        const parsedBody = await readJsonBody(request)
        if (!parsedBody.ok) {
          refuseBody(response, parsedBody)
          return
        }
        const sessionId = stringField(parsedBody.body, 'sessionId')
        if (sessionId === null) {
          fail(response, 400, 'bad-request', 'expected { sessionId }')
          return
        }
        const refusal = await gateway.cancel(sessionId)
        if (refusal !== null) {
          refuse(response, refusal)
          return
        }
        ok(response, await gateway.listViews())
        return
      }

      if (request.method === 'POST' && path === `${EXTERNAL_SESSION_API}/close`) {
        const parsedBody = await readJsonBody(request)
        if (!parsedBody.ok) {
          refuseBody(response, parsedBody)
          return
        }
        const sessionId = stringField(parsedBody.body, 'sessionId')
        if (sessionId === null) {
          fail(response, 400, 'bad-request', 'expected { sessionId }')
          return
        }
        const result = await gateway.close(sessionId)
        if ('code' in result) {
          refuse(response, result)
          return
        }
        ok(response, await gateway.listViews())
        return
      }

      fail(response, 404, 'not-found', `unknown route: ${request.method} ${path}`)
    } catch (error) {
      // Engine failures that escape are bugs; they must not read as a panel
      // problem, and the message must not leak a stack to the browser.
      log(`external-session route failed: ${String(error)}`)
      fail(response, 500, 'internal', 'the external-session service failed to answer')
    }
  }

  return [{ kind: 'prefix', path: EXTERNAL_SESSION_API, handler }]
}

/**
 * Mount the route family under the shared admission fence.
 * @param ctx - host plugin context.
 * @param gateway - the mounted engine.
 * @returns the disposer releasing the routes.
 */
export function registerExternalSessionRoutes(ctx: Context, gateway: ExternalSessionGateway): () => void {
  const routes = makeExternalSessionRoutes({
    gateway,
    isTrusted: request => accessTrustOf(ctx).isTrusted(request),
    logger: {
      warn: (message: string) => {
        try { ctx.logger('web-all:external-session').warn(message) } catch { console.warn(message) }
      },
    },
  })
  return registerResources(own => {
    for (const route of routes) own(ctx.webServer.register(route))
  })
}