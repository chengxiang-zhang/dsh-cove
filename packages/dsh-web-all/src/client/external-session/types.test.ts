import { describe, expect, it } from 'vitest'
import {
  canContinueSession,
  readSessionList,
  readSessionView,
  readTurnView,
  type ExternalSessionView,
} from './types.ts'

/** The minimum a view must carry now that the panel contract is frozen. */
function view(overrides: Partial<ExternalSessionView> = {}): ExternalSessionView {
  return {
    id: 'a',
    provider: 'claude',
    title: 'a',
    status: 'idle',
    cwd: '/tmp',
    createdAt: '2026-11-04T09:00:00Z',
    lastTurnAt: '2026-11-04T09:00:00Z',
    canContinue: true,
    turns: [],
    ...overrides,
  }
}

describe('external-session view types', () => {
  it('reads a full session record including turns and usage', () => {
    const session = readSessionView({
      id: 'ext-1',
      provider: 'claude',
      title: '修登录 bug',
      status: 'idle',
      createdAt: '2026-11-04T12:00:00Z',
      lastTurnAt: '2026-11-04T12:03:00Z',
      turns: [{ n: 1, prompt: 'go', status: 'completed', durationMs: 42000, usage: { input: 1234, output: 567 }, costUsd: 0.03, result: 'done' }],
    })
    expect(session?.id).toBe('ext-1')
    expect(session?.turns?.[0]?.usage).toEqual({ input: 1234, output: 567 })
    expect(session?.turns?.[0]?.costUsd).toBe(0.03)
  })

  it('rejects a record without id or with an unknown status', () => {
    expect(readSessionView({ status: 'idle' })).toBeUndefined()
    expect(readSessionView({ id: 'x', status: 'zombie' })).toBeUndefined()
    expect(readTurnView({ n: 1, status: 'zombie' })).toBeUndefined()
  })

  it('drops malformed turns instead of failing the whole session', () => {
    const session = readSessionView({
      id: 'ext-2',
      status: 'failed',
      turns: [{ n: 1, prompt: 'a', status: 'failed' }, { prompt: 'no n', status: 'failed' }, null],
    })
    expect(session?.turns).toHaveLength(1)
  })

  it('accepts an array, a sessions wrapper and an items wrapper', () => {
    const record = { id: 'a', status: 'idle' }
    expect(readSessionList([record])).toHaveLength(1)
    expect(readSessionList({ sessions: [record] })).toHaveLength(1)
    expect(readSessionList({ items: [record] })).toHaveLength(1)
    expect(readSessionList(null)).toEqual([])
    expect(readSessionList({ sessions: 'nope' })).toEqual([])
  })

  it('treats a closed session as not continuable even when the host says it is', () => {
    expect(canContinueSession(view({ status: 'closed', canContinue: true }))).toBe(false)
  })

  it('trusts the host flag, and keeps a failed session continuable', () => {
    // 宿主的口径：failed 仍可续（只有 closed 与缺 CLI 会话号才不可续）。
    expect(canContinueSession(view({ status: 'failed', canContinue: true }))).toBe(true)
    expect(canContinueSession(view({ status: 'idle', canContinue: false }))).toBe(false)
  })
})