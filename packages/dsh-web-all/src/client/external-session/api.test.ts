import { describe, expect, it, vi } from 'vitest'
import {
  EXTERNAL_SESSION_ROUTES,
  ExternalSessionApiError,
  classifyStatus,
  createExternalSessionApi,
  failureCopyKey,
} from './api.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const oneSession = { id: 'ext-1', provider: 'claude', title: 't', status: 'idle' }

describe('external-session api client', () => {
  it('reads the list from the session route and unwraps the envelope', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, value: { sessions: [oneSession] } }))
    const api = createExternalSessionApi(fetchImpl as never)
    const sessions = await api.list()
    expect(sessions.map(session => session.id)).toEqual(['ext-1'])
    expect(fetchImpl).toHaveBeenCalledWith(EXTERNAL_SESSION_ROUTES.list, expect.objectContaining({ credentials: 'same-origin' }))
  })

  it('posts the session id and prompt when continuing a turn', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json({ ok: true, value: { sessions: [oneSession] } }))
    const api = createExternalSessionApi(fetchImpl as never)
    await api.continueTurn('ext-1', '再改一处')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(EXTERNAL_SESSION_ROUTES.continueTurn)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ sessionId: 'ext-1', prompt: '再改一处' })
  })

  it('posts only the session id for cancel and close', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json({ ok: true, value: { sessions: [oneSession] } }))
    const api = createExternalSessionApi(fetchImpl as never)
    await api.cancelTurn('ext-1')
    await api.closeSession('ext-1')
    const calls = fetchImpl.mock.calls
    expect(calls[0]?.[0]).toBe(EXTERNAL_SESSION_ROUTES.cancelTurn)
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ sessionId: 'ext-1' })
    expect(calls[1]?.[0]).toBe(EXTERNAL_SESSION_ROUTES.closeSession)
  })

  it('separates a refused request from a missing route', async () => {
    const forbidden = createExternalSessionApi((async () => json({ ok: false, error: { code: 'forbidden', message: 'loopback same-origin access only' } }, 403)) as never)
    await expect(forbidden.list()).rejects.toMatchObject({ failure: 'forbidden', status: 403 })

    const missing = createExternalSessionApi((async () => new Response('not found', { status: 404 })) as never)
    await expect(missing.list()).rejects.toMatchObject({ failure: 'unavailable', status: 404 })
  })

  it('treats a 200 HTML answer as a missing route, not as data', async () => {
    const api = createExternalSessionApi((async () => new Response('<!doctype html>', { status: 200 })) as never)
    const error = await api.list().catch(cause => cause)
    expect(error).toBeInstanceOf(ExternalSessionApiError)
    expect((error as ExternalSessionApiError).failure).toBe('unavailable')
  })

  it('surfaces the host message for other failures', async () => {
    const api = createExternalSessionApi((async () => json({ ok: false, error: { code: 'busy', message: 'too many sessions' } }, 429)) as never)
    await expect(api.list()).rejects.toMatchObject({ failure: 'failed', status: 429, message: 'too many sessions' })
  })

  it('passes an abort through instead of reporting a failure', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const api = createExternalSessionApi((async () => { throw abort }) as never)
    await expect(api.list()).rejects.toBe(abort)
  })

  it('maps statuses and copy keys', () => {
    expect(classifyStatus(401)).toBe('forbidden')
    expect(classifyStatus(403)).toBe('forbidden')
    expect(classifyStatus(404)).toBe('unavailable')
    expect(classifyStatus(405)).toBe('unavailable')
    expect(classifyStatus(501)).toBe('unavailable')
    expect(classifyStatus(500)).toBe('failed')
    expect(failureCopyKey('forbidden')).toBe('state.forbidden')
    expect(failureCopyKey('unavailable')).toBe('state.unavailable')
    expect(failureCopyKey('failed')).toBe('state.failed')
  })
})