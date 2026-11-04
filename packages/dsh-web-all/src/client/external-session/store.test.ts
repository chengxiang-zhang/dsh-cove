import { describe, expect, it, vi } from 'vitest'
import { createExternalSessionStore, isForbidden, normalizeOperationResult } from './store.ts'
import { ExternalSessionApiError, type ExternalSessionApi } from './api.ts'
import type { ExternalSessionView } from './types.ts'

function api(overrides: Partial<ExternalSessionApi> = {}): ExternalSessionApi {
  return {
    list: async () => [],
    continueTurn: async () => [],
    cancelTurn: async () => [],
    closeSession: async () => [],
    ...overrides,
  }
}

const session: ExternalSessionView = {
  id: 'ext-1',
  provider: 'claude',
  title: 't',
  status: 'idle',
  cwd: '/tmp',
  createdAt: '2026-11-04T09:00:00Z',
  lastTurnAt: '2026-11-04T09:01:00Z',
  canContinue: true,
  turns: [],
}

describe('external-session store', () => {
  it('publishes loading then ready, and notifies subscribers', async () => {
    const store = createExternalSessionStore(api({ list: async () => [session] }))
    const seen: string[] = []
    const unsubscribe = store.subscribe(() => { seen.push(store.getSnapshot().state) })
    await store.refresh()
    unsubscribe()
    expect(seen).toEqual(['loading', 'ready'])
    expect(store.getSnapshot().sessions).toHaveLength(1)
  })

  it('keeps the previous rows and exposes the error when a read fails', async () => {
    const failure = new ExternalSessionApiError('nope', 'forbidden', 403)
    const store = createExternalSessionStore(api({ list: async () => { throw failure } }))
    await store.refresh()
    const snapshot = store.getSnapshot()
    expect(snapshot.state).toBe('error')
    expect(snapshot.error).toBe(failure)
    expect(isForbidden(snapshot.error)).toBe(true)
  })

  it('coalesces concurrent refreshes into one request', async () => {
    let release: (() => void) | undefined
    const list = vi.fn(() => new Promise<readonly ExternalSessionView[]>(resolve => {
      release = () => { resolve([session]) }
    }))
    const store = createExternalSessionStore(api({ list: list as never }))
    const first = store.refresh()
    const second = store.refresh()
    release?.()
    await Promise.all([first, second])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('replaces the snapshot with whatever an action returns', async () => {
    const store = createExternalSessionStore(api())
    await store.apply(async () => [{ ...session, status: 'closed' }])
    expect(store.getSnapshot().state).toBe('ready')
    expect(store.getSnapshot().sessions[0]?.status).toBe('closed')
  })

  it('normalizes an unknown operation payload into rows', () => {
    expect(normalizeOperationResult({ sessions: [session] })).toHaveLength(1)
    expect(normalizeOperationResult(undefined)).toEqual([])
  })

  it('does not treat a plain error as forbidden', () => {
    expect(isForbidden(new Error('boom'))).toBe(false)
    expect(isForbidden(undefined)).toBe(false)
  })
})