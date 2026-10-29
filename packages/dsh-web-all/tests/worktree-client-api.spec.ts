/**
 * Browser API surface: failure kinds and deadlines.
 *
 * The panel renders a fence refusal, a git failure and "no registered git
 * repository workspaces" differently, and a host stalled on `git fetch` must
 * fail visibly instead of leaving the panel loading. Before this contract a
 * 403 was reported as "malformed envelope" and an errored envelope as the
 * empty state, so both cases are pinned here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeApi, WorktreeApiError } from '../src/client/conversation/worktree/api.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubFetch(handler: () => Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(handler)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => { vi.unstubAllGlobals() })

describe('WorktreeApi failure kinds', () => {
  it('returns null only for a host half that does not serve /worktree/tree', async () => {
    stubFetch(async () => new Response('not found', { status: 404 }))
    expect(await new WorktreeApi().tree()).toBeNull()
  })

  it('reports a fence refusal as a permission failure, not as a broken envelope', async () => {
    stubFetch(async () => jsonResponse({ error: 'forbidden: loopback-only' }, 403))
    await expect(new WorktreeApi().tree()).rejects.toMatchObject({ kind: 'permission', status: 403 })
  })

  it('reports an envelope failure instead of rendering the empty state', async () => {
    stubFetch(async () => jsonResponse({ ok: false, code: 'git-failed', message: 'git exploded' }, 500))
    await expect(new WorktreeApi().tree()).rejects.toMatchObject({ kind: 'domain', code: 'git-failed' })
  })

  it('keeps the domain code so the panel can localize the refusal', async () => {
    stubFetch(async () => jsonResponse({ ok: false, code: 'not-merged', message: 'not merged' }, 400))
    await expect(new WorktreeApi().cleanup({ repoPath: '/r', name: 'x', force: false }))
      .rejects.toMatchObject({ kind: 'domain', code: 'not-merged' })
  })

  it('turns a stalled request into a transport failure with the deadline in the text', async () => {
    stubFetch(async () => { throw new DOMException('The operation was aborted', 'TimeoutError') })
    const error = await new WorktreeApi().tree().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(WorktreeApiError)
    expect((error as WorktreeApiError).kind).toBe('transport')
    expect((error as WorktreeApiError).message).toMatch(/did not answer/)
  })

  it('keeps the lane lookup degrading to null for the header chip', async () => {
    stubFetch(async () => jsonResponse({ error: 'forbidden: loopback-only' }, 403))
    expect(await new WorktreeApi().lane({ sessionId: 's1' })).toBeNull()
  })

  it('hands each request a deadline signal', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ ok: true, value: { projects: [] } }))
    await new WorktreeApi().tree()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
})