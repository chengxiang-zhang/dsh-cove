import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ExternalSessionEngine } from './engine.ts'
import { resolveExternalSessionConfig } from './config.ts'
import { ExternalSessionStore } from './store.ts'
import { FakeAdapter, MemoryStoreFileSystem } from './test-doubles.ts'
import { EXTERNAL_ERROR_CODES } from '../../../core/external-session/errors.ts'
import { EXTERNAL_SESSION_API, externalSessionStatusFor, makeExternalSessionRoutes } from './routes.ts'

const PATH = '/tmp/dsh-external-session-routes.json'

/** Wait until `predicate` holds, for state the engine reaches asynchronously. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

interface Captured {
  status: number
  body: unknown
}

/** The engine plus a route table over an in-memory store. */
async function harness(options: { trusted?: boolean } = {}) {
  const fs = new MemoryStoreFileSystem()
  const config = resolveExternalSessionConfig({ storePath: PATH, maxConcurrentTurns: 2 }, '/tmp/home')
  const store = new ExternalSessionStore({ storePath: PATH, maxSessions: 100, fs })
  const claude = new FakeAdapter('claude')
  claude.autoOutcome = () => ({ status: 'completed', result: '42', durationMs: 5, providerSessionId: 'cli-1' })
  // Mutable so a test can make the CLI disappear or the directory stop existing
  // between two calls, which is how the preflight refusals are reached.
  const adapters: { claude?: FakeAdapter } = { claude }
  const state = { dirOk: true }
  const engine = new ExternalSessionEngine({
    config,
    store,
    adapters,
    directoryProbe: async () => state.dirOk,
    newId: (() => { let n = 0; return () => `ext-${++n}` })(),
  })
  const trusted = options.trusted ?? true
  const routes = makeExternalSessionRoutes({ gateway: engine, isTrusted: () => trusted })
  // `WebRoute` is one interface with a `kind` field rather than a union, so the
  // handler is read straight off the first table entry.
  const handler: WebRoute['handler'] = routes[0].handler
  return {
    engine,
    store,
    claude,
    adapters,
    state,
    fs,
    call: (method: string, url: string, body?: unknown) => invoke(handler, method, url, body),
  }
}

/** Call one route with a real request stream and capture the response. */
async function invoke(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  method: string,
  url: string,
  body?: unknown,
): Promise<Captured> {
  const payload = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const request = Object.assign(Readable.from(payload), { method, url, headers: {} }) as unknown as IncomingMessage
  const captured: Captured = { status: 0, body: undefined }
  const response = {
    writeHead(status: number) { captured.status = status },
    end(text?: string) { captured.body = typeof text === 'string' ? JSON.parse(text) as unknown : undefined },
  } as unknown as ServerResponse
  await handler(request, response)
  return captured
}

/** The `{ ok, value }` payload of a successful call. */
function valueOf(captured: Captured): Record<string, unknown> {
  expect(captured.status).toBe(200)
  const body = captured.body as { ok: boolean; value: Record<string, unknown> }
  expect(body.ok).toBe(true)
  return body.value
}

/** The `{ ok: false, error }` payload of a refused call. */
function errorOf(captured: Captured): { code: string; message: string } {
  const body = captured.body as { ok: boolean; error: { code: string; message: string } }
  expect(body.ok).toBe(false)
  return body.error
}

describe('external-session routes', () => {
  it('serves the prefix the panel uses', () => {
    expect(EXTERNAL_SESSION_API).toBe('/api/external-session')
  })

  it('refuses an untrusted caller before revealing which routes exist', async () => {
    const { call } = await harness({ trusted: false })
    for (const [method, url] of [
      ['GET', `${EXTERNAL_SESSION_API}/list`],
      ['GET', `${EXTERNAL_SESSION_API}/nope`],
      ['POST', `${EXTERNAL_SESSION_API}/continue`],
    ] as const) {
      const captured = await call(method, url, { sessionId: 'ext-1', prompt: 'x' })
      expect(captured.status).toBe(403)
      expect(errorOf(captured).code).toBe('forbidden')
    }
  })

  it('lists an empty store as an empty session array', async () => {
    const { call } = await harness()
    const value = valueOf(await call('GET', `${EXTERNAL_SESSION_API}/list`))
    expect(value).toEqual({ sessions: [] })
  })

  it('reports an unknown session as 404 session-unknown', async () => {
    const { call } = await harness()
    const missing = await call('GET', `${EXTERNAL_SESSION_API}/session?id=ext-nope`)
    expect(missing.status).toBe(404)
    expect(errorOf(missing).code).toBe('session-unknown')

    const continuation = await call('POST', `${EXTERNAL_SESSION_API}/continue`, { sessionId: 'ext-nope', prompt: 'go' })
    expect(continuation.status).toBe(404)
    expect(errorOf(continuation).code).toBe('session-unknown')
  })

  it('refuses malformed bodies with 400 and unknown routes with 404', async () => {
    const { call } = await harness()
    const bad = await call('POST', `${EXTERNAL_SESSION_API}/continue`, { prompt: 'no session id' })
    expect(bad.status).toBe(400)
    expect(errorOf(bad).code).toBe('bad-request')

    const unknown = await call('GET', `${EXTERNAL_SESSION_API}/nothing-here`)
    expect(unknown.status).toBe(404)
    expect(errorOf(unknown).code).toBe('not-found')
  })

  it('continues a session and answers immediately with the running snapshot', async () => {
    const { engine, claude, call } = await harness()
    const first = await engine.runTurn({ provider: 'claude', prompt: 'remember 42', cwd: '/tmp' })
    if ('code' in first) throw new Error('first turn failed')

    claude.autoOutcome = undefined
    const captured = await call('POST', `${EXTERNAL_SESSION_API}/continue`, { sessionId: first.session_id, prompt: 'which number?' })
    const value = valueOf(captured) as { sessions: Array<{ id: string; status: string; turns: Array<{ status: string; n: number }> }> }
    // The route returned while the turn is still running: that is what makes the
    // panel's cancel button meaningful.
    expect(value.sessions[0]?.status).toBe('running')
    expect(value.sessions[0]?.turns.map(turn => turn.status)).toEqual(['completed', 'running'])

    await waitFor(() => claude.inFlight === 1, 'the continued turn to reach the adapter')
    claude.settle({ status: 'completed', result: '42' })
    await new Promise(resolve => setTimeout(resolve, 5))
    const settled = valueOf(await call('GET', `${EXTERNAL_SESSION_API}/list`)) as { sessions: Array<{ status: string }> }
    expect(settled.sessions[0]?.status).toBe('idle')
  })

  it('cancels the running turn and reports the aborted record', async () => {
    const { engine, claude, call } = await harness()
    claude.autoOutcome = undefined
    await engine.startTurn({ provider: 'claude', prompt: 'long', cwd: '/tmp' })
    await waitFor(() => claude.inFlight === 1, 'the turn to reach the adapter')
    const signal = claude.lastSignal

    const cancelling = call('POST', `${EXTERNAL_SESSION_API}/cancel`, { sessionId: 'ext-1' })
    // The cancellation reaches the process signal, and the double's turn settles
    // as aborted the way a real CLI would.
    const value = valueOf(await cancelling) as { sessions: Array<{ status: string; turns: Array<{ status: string }> }> }
    expect(signal?.aborted).toBe(true)
    expect(value.sessions[0]?.status).toBe('idle')
    expect(value.sessions[0]?.turns[0]?.status).toBe('aborted')
  })

  it('closes a session and refuses to continue it', async () => {
    const { engine, call } = await harness()
    const first = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
    if ('code' in first) throw new Error('first turn failed')

    const closed = valueOf(await call('POST', `${EXTERNAL_SESSION_API}/close`, { sessionId: first.session_id })) as {
      sessions: Array<{ status: string; canContinue: boolean }>
    }
    expect(closed.sessions[0]?.status).toBe('closed')
    expect(closed.sessions[0]?.canContinue).toBe(false)

    const refused = await call('POST', `${EXTERNAL_SESSION_API}/continue`, { sessionId: first.session_id, prompt: 'again' })
    expect(refused.status).toBe(409)
    expect(errorOf(refused).code).toBe('session-closed')
  })

  it('serves one session with its turns', async () => {
    const { engine, call } = await harness()
    const first = await engine.runTurn({ provider: 'claude', prompt: 'remember 42', cwd: '/tmp' })
    if ('code' in first) throw new Error('first turn failed')
    const value = valueOf(await call('GET', `${EXTERNAL_SESSION_API}/session?id=${first.session_id}`)) as {
      session: { id: string; turns: Array<{ prompt: string; result: string }> }
    }
    expect(value.session.id).toBe(first.session_id)
    expect(value.session.turns[0]?.prompt).toBe('remember 42')
    expect(value.session.turns[0]?.result).toBe('42')
  })

  it('reports a busy gate as 429', async () => {
    const { engine, claude, call } = await harness()
    claude.autoOutcome = undefined
    // Two turns saturate the configured bound of two.
    await engine.startTurn({ provider: 'claude', prompt: 'a', cwd: '/tmp' })
    await engine.startTurn({ provider: 'claude', prompt: 'b', cwd: '/tmp' })
    const captured = await call('POST', `${EXTERNAL_SESSION_API}/continue`, { sessionId: 'ext-1', prompt: 'c' })
    expect(captured.status).toBe(429)
    expect(errorOf(captured).code).toBe('busy')
    claude.settle({ status: 'completed' })
    claude.settle({ status: 'completed' })
    await waitFor(() => claude.inFlight === 0, 'both turns to settle')
  })

  it('keeps the view shape the panel consumes', async () => {
    const { engine, call } = await harness()
    await engine.runTurn({ provider: 'claude', prompt: 'remember 42', cwd: '/tmp' })
    const value = valueOf(await call('GET', `${EXTERNAL_SESSION_API}/list`)) as {
      sessions: Array<Record<string, unknown>>
    }
    const session = value.sessions[0] ?? {}
    expect(Object.keys(session).sort()).toEqual([
      'canContinue', 'createdAt', 'cwd', 'id', 'lastTurnAt', 'provider', 'status', 'title', 'turns',
    ])
    // The panel never needs the CLI's own conversation id.
    expect(session).not.toHaveProperty('providerSessionId')
  })

  describe('failure codes map to their own statuses', () => {
    it('maps provider-missing to 501 when the CLI is gone', async () => {
      const { engine, adapters, call } = await harness()
      const first = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
      if ('code' in first) throw new Error('first turn failed')
      adapters.claude = undefined
      const captured = await call('POST', `${EXTERNAL_SESSION_API}/continue`, { sessionId: first.session_id, prompt: 'again' })
      expect(captured.status).toBe(501)
      expect(errorOf(captured).code).toBe('provider-missing')
    })

    it('maps cwd-invalid to 400', async () => {
      const { engine, state, call } = await harness()
      const first = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
      if ('code' in first) throw new Error('first turn failed')
      state.dirOk = false
      const captured = await call('POST', `${EXTERNAL_SESSION_API}/continue`, { sessionId: first.session_id, prompt: 'again' })
      expect(captured.status).toBe(400)
      expect(errorOf(captured).code).toBe('cwd-invalid')
    })

    it('maps session-unresumable to 409', async () => {
      const { engine, claude, call } = await harness()
      claude.autoOutcome = () => ({ status: 'completed', result: 'ok', durationMs: 1 })
      const first = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
      if ('code' in first) throw new Error('first turn failed')
      const captured = await call('POST', `${EXTERNAL_SESSION_API}/continue`, { sessionId: first.session_id, prompt: 'again' })
      expect(captured.status).toBe(409)
      expect(errorOf(captured).code).toBe('session-unresumable')
    })

    it('reports a turn-level failure as a record, not as an HTTP status', async () => {
      const { engine, claude, call } = await harness()
      const first = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
      if ('code' in first) throw new Error('first turn failed')
      claude.autoOutcome = undefined
      const captured = await call('POST', `${EXTERNAL_SESSION_API}/continue`, { sessionId: first.session_id, prompt: 'again' })
      expect(captured.status).toBe(200)
      await waitFor(() => claude.inFlight === 1, 'the continued turn to reach the adapter')
      claude.settle({
        status: 'failed', result: 'the CLI is not signed in',
        error: { code: 'auth-required', message: 'not signed in' },
      })
      await waitFor(() => claude.inFlight === 0, 'the failed turn to settle')
      await new Promise(resolve => setTimeout(resolve, 5))
      const value = valueOf(await call('GET', `${EXTERNAL_SESSION_API}/list`)) as {
        sessions: Array<{ status: string; turns: Array<{ status: string }> }>
      }
      // The panel learns the turn failed from the timeline, which is why the
      // request that started it did not fail as well.
      expect(value.sessions[0]?.status).toBe('failed')
      expect(value.sessions[0]?.turns[1]?.status).toBe('failed')
    })

    it('maps every code to a distinct status, including the defensive branches', () => {
      const table = Object.fromEntries(EXTERNAL_ERROR_CODES.map(code => [code, externalSessionStatusFor(code)]))
      expect(table).toEqual({
        'provider-missing': 501,
        'cwd-invalid': 400,
        'session-unknown': 404,
        'session-closed': 409,
        'session-unresumable': 409,
        busy: 429,
        limit: 409,
        'auth-required': 409,
        'provider-error': 502,
        'store-unavailable': 503,
        'turn-stalled': 502,
        'turn-timeout': 502,
      })
    })

    it('has no route that can reach the retention limit, by design', () => {
      // `limit` is a creation failure and creation is tool-only, so the panel
      // cannot surface it: the engine covers that code (engine.test.ts).
      expect(externalSessionStatusFor('limit')).toBe(409)
    })
  })

  describe('request body handling', () => {
    it('answers 400 for a body that is not a JSON object', async () => {
      const { call } = await harness()
      const notJson = await call('POST', `${EXTERNAL_SESSION_API}/cancel`, '{not json')
      expect(notJson.status).toBe(400)
      expect(errorOf(notJson).code).toBe('bad-request')

      // Valid JSON that is not an object is the caller's mistake too.
      const array = await call('POST', `${EXTERNAL_SESSION_API}/cancel`, '[]')
      expect(array.status).toBe(400)
      expect(errorOf(array).code).toBe('bad-request')
    })

    it('answers 413 only when the body exceeds the size limit', async () => {
      const { call } = await harness()
      const huge = await call('POST', `${EXTERNAL_SESSION_API}/cancel`, `{"sessionId":"${'x'.repeat(1_100_000)}"}`)
      expect(huge.status).toBe(413)
      expect(errorOf(huge).code).toBe('bad-request')
    })
  })

  it('reports an unwritable host as 503, not as an unknown session', async () => {
    const { engine, fs, call } = await harness()
    const first = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
    if ('code' in first) throw new Error('first turn failed')

    // Closing has to write, so it is the one route that surfaces a storage
    // failure synchronously. The session exists and the id is right; only the
    // host's disk is broken.
    fs.failAllWrites = new Error('EACCES: permission denied')
    const captured = await call('POST', `${EXTERNAL_SESSION_API}/close`, { sessionId: first.session_id })
    expect(captured.status).toBe(503)
    expect(errorOf(captured).code).toBe('store-unavailable')
    expect(String(errorOf(captured).message)).not.toContain('EACCES')
  })

  describe('panel path on a broken host', () => {
    it('answers store-unavailable from continue instead of swallowing it', async () => {
      const { engine, fs, call } = await harness()
      const first = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
      if ('code' in first) throw new Error('first turn failed')

      fs.failAllWrites = new Error('EACCES: permission denied')
      const captured = await call('POST', `${EXTERNAL_SESSION_API}/continue`, { sessionId: first.session_id, prompt: 'again' })
      // Same code, same status as the tool path: storage is the host's problem.
      expect(captured.status).toBe(503)
      expect(errorOf(captured).code).toBe('store-unavailable')
    })

    it('keeps the record durable when continue returns', async () => {
      const { engine, claude, store, call } = await harness()
      const first = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
      if ('code' in first) throw new Error('first turn failed')
      claude.autoOutcome = undefined

      const captured = await call('POST', `${EXTERNAL_SESSION_API}/continue`, { sessionId: first.session_id, prompt: 'again' })
      expect(captured.status).toBe(200)
      // Cancel immediately after the response: the record is already on disk, so
      // this is the same tick the panel's cancel button lives in.
      expect(store.get(first.session_id)?.status).toBe('running')
      const cancelling = call('POST', `${EXTERNAL_SESSION_API}/cancel`, { sessionId: first.session_id })
      const value = valueOf(await cancelling) as { sessions: Array<{ status: string; turns: Array<{ status: string }> }> }
      expect(value.sessions[0]?.status).toBe('idle')
      expect(value.sessions[0]?.turns[1]?.status).toBe('aborted')
      expect(claude.inFlight).toBe(0)
    })
  })
})
