import { describe, expect, it, vi } from 'vitest'
import {
  EXTERNAL_SESSION_ERROR_CODES,
  EXTERNAL_SESSION_ROUTES,
  ExternalSessionApiError,
  classifyFailure,
  createExternalSessionApi,
  failureCopyKey,
  isExternalSessionErrorCode,
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

  it('classifies by the host code first and the status second', () => {
    // 围栏拒绝永远是权限问题。
    expect(classifyFailure(401)).toBe('forbidden')
    expect(classifyFailure(403)).toBe('forbidden')
    expect(classifyFailure(403, 'forbidden')).toBe('forbidden')
    // 「这族路由不存在」只认没有已知 code 的 404/405/501。
    expect(classifyFailure(404)).toBe('unavailable')
    expect(classifyFailure(405)).toBe('unavailable')
    expect(classifyFailure(501)).toBe('unavailable')
    // 同一个状态码带上已知 code，就是会话级失败，不能再说成「宿主没这个能力」。
    expect(classifyFailure(404, 'session-unknown')).toBe('failed')
    expect(classifyFailure(501, 'provider-missing')).toBe('failed')
    expect(classifyFailure(429, 'busy')).toBe('failed')
    expect(classifyFailure(409, 'session-closed')).toBe('failed')
    expect(classifyFailure(400, 'cwd-invalid')).toBe('failed')
    expect(classifyFailure(500)).toBe('failed')
    expect(failureCopyKey('forbidden')).toBe('state.forbidden')
    expect(failureCopyKey('unavailable')).toBe('state.unavailable')
    expect(failureCopyKey('failed')).toBe('state.failed')
  })

  it('keeps the host code on the error and rejects codes it does not know', async () => {
    const api = createExternalSessionApi((async () => json({ ok: false, error: { code: 'session-unknown', message: 'gone' } }, 404)) as never)
    await expect(api.list()).rejects.toMatchObject({ failure: 'failed', status: 404, code: 'session-unknown' })

    const noisy = createExternalSessionApi((async () => json({ ok: false, error: { code: 'made-up-code', message: 'huh' } }, 404)) as never)
    const error = await noisy.list().catch(cause => cause) as ExternalSessionApiError
    expect(error.failure).toBe('unavailable')
    expect(error.code).toBeUndefined()
  })

  it('covers every code the host contract can return', () => {
    // 设计稿 §7 的固定一组；新增码要两边一起改。
    expect([...EXTERNAL_SESSION_ERROR_CODES].sort()).toEqual([
      'auth-required', 'busy', 'cwd-invalid', 'limit', 'provider-error',
      'provider-missing', 'session-closed', 'session-unknown', 'session-unresumable',
    ])
    expect(isExternalSessionErrorCode('busy')).toBe(true)
    expect(isExternalSessionErrorCode('nope')).toBe(false)
  })
})