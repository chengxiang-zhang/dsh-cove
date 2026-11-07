import { describe, expect, it } from 'vitest'
import {
  scopeSessionViews, toLiveTurnView, toSessionList, toSessionOverview, toSessionOverviewList, toSessionView, toTurnDigest, toTurnView,
} from './views.ts'
import type { ExternalSessionRecord, ExternalTurnRecord } from './types.ts'

const CREATED = '2026-11-04T12:00:00Z'
const LAST = '2026-11-04T12:03:00Z'

function turn(overrides: Partial<ExternalTurnRecord> = {}): ExternalTurnRecord {
  return {
    n: 1,
    prompt: 'remember 42',
    status: 'completed',
    startedAt: LAST,
    durationMs: 42_000,
    usage: { input: 1234, output: 567 },
    costUsd: 0.03,
    result: '42',
    ...overrides,
  }
}

function record(overrides: Partial<ExternalSessionRecord> = {}): ExternalSessionRecord {
  return {
    id: 'ext-1',
    provider: 'claude',
    providerSessionId: 'cli-abc',
    cwd: '/tmp',
    title: 'work',
    status: 'idle',
    createdAt: CREATED,
    lastTurnAt: LAST,
    turns: [turn()],
    ...overrides,
  }
}

describe('external-session views', () => {
  it('projects a settled turn with its result and duration', () => {
    expect(toTurnView(turn())).toEqual({
      n: 1,
      prompt: 'remember 42',
      status: 'completed',
      startedAt: LAST,
      durationMs: 42_000,
      result: '42',
      usage: { input: 1234, output: 567 },
      costUsd: 0.03,
    })
  })

  it('omits optional turn fields the CLI never reported rather than inventing zeros', () => {
    const view = toTurnView(turn({ usage: undefined, costUsd: undefined }))
    expect('usage' in view).toBe(false)
    expect('costUsd' in view).toBe(false)
  })

  it('projects a live turn as running with no result yet', () => {
    expect(toLiveTurnView({ n: 2, prompt: 'what number?', startedAt: LAST }))
      .toEqual({ n: 2, prompt: 'what number?', status: 'running', startedAt: LAST })
  })

  it('appends the live turn after the settled ones', () => {
    const view = toSessionView(record(), { n: 2, prompt: 'what number?', startedAt: LAST })
    expect(view.turns.map(entry => [entry.n, entry.status])).toEqual([[1, 'completed'], [2, 'running']])
    expect(view.status).toBe('idle')
  })

  it('reports canContinue from the CLI conversation id and the closed state', () => {
    expect(toSessionView(record()).canContinue).toBe(true)
    expect(toSessionView(record({ providerSessionId: undefined })).canContinue).toBe(false)
    expect(toSessionView(record({ status: 'closed' })).canContinue).toBe(false)
    // A failed session stays continuable: the design keeps it for the caller to retry.
    expect(toSessionView(record({ status: 'failed' })).canContinue).toBe(true)
  })

  it('lists every session and picks live turns by id', () => {
    const sessions = [record(), record({ id: 'ext-2', turns: [] })]
    const views = toSessionList(sessions, new Map([['ext-2', { n: 1, prompt: 'hi', startedAt: LAST }]]))
    expect(views.map(view => view.id)).toEqual(['ext-1', 'ext-2'])
    expect(views[0]?.turns).toHaveLength(1)
    expect(views[1]?.turns).toHaveLength(1)
    expect(views[1]?.turns[0]?.status).toBe('running')
  })

  it('keeps the panel list empty for a fresh store', () => {
    expect(toSessionList([])).toEqual([])
  })

  it('summarizes the last turn for the model-facing list', () => {
    const overview = toSessionOverview(record())
    expect(overview.turnCount).toBe(1)
    expect(overview.lastTurn).toEqual({
      n: 1, status: 'completed', durationMs: 42_000, usage: { input: 1234, output: 567 }, costUsd: 0.03,
    })
    expect(overview.canContinue).toBe(true)
  })

  it('reports a null last turn for a session that has not finished one', () => {
    expect(toSessionOverview(record({ turns: [] })).lastTurn).toBeNull()
  })

  it('uses null rather than undefined for usage and cost the CLI omitted', () => {
    const digest = toTurnDigest(turn({ usage: undefined, costUsd: undefined }))
    expect(digest.usage).toBeNull()
    expect(digest.costUsd).toBeNull()
  })

  it('projects the model-facing list', () => {
    expect(toSessionOverviewList([record()]).sessions).toHaveLength(1)
    expect(toSessionOverviewList([]).sessions).toEqual([])
  })
})
describe('session scoping', () => {
  const row = (id: string, origin?: string) => (origin === undefined ? { id } : { id, originSessionId: origin })
  const pool = [row('a', 'conv-1'), row('b', 'conv-2'), row('c'), row('d', 'conv-1')]

  it('shows a conversation only the rows it dispatched', () => {
    expect(scopeSessionViews(pool, 'conv-1').map(item => item.id)).toEqual(['a', 'd'])
    expect(scopeSessionViews(pool, 'conv-2').map(item => item.id)).toEqual(['b'])
    expect(scopeSessionViews(pool, 'conv-3')).toEqual([])
  })

  it('never shows one row in two conversations', () => {
    const conversations = ['conv-1', 'conv-2', 'conv-3', undefined]
    for (const left of conversations) {
      for (const right of conversations) {
        if (left === right) continue
        const seen = new Set(scopeSessionViews(pool, left).map(item => item.id))
        for (const item of scopeSessionViews(pool, right)) expect(seen.has(item.id)).toBe(false)
      }
    }
  })

  it('keeps unattributable history out of every conversation, including a pool with no origin at all', () => {
    const legacy = [row('x'), row('y')]
    for (const conversation of ['conv-1', 'conv-2', undefined]) {
      expect(scopeSessionViews(legacy, conversation)).toEqual([])
    }
    expect(scopeSessionViews(legacy, 'conv-1', { includeAll: true }).map(item => item.id)).toEqual(['x', 'y'])
  })

  it('scopes by nothing when the conversation is unknown', () => {
    expect(scopeSessionViews(pool, undefined)).toEqual([])
  })
})
