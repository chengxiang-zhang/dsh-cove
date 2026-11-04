import { describe, expect, it } from 'vitest'
import {
  blockedReason,
  closable,
  continueAllowed,
  formatAge,
  formatCost,
  formatCount,
  formatDuration,
  formatUsage,
  orderedTurns,
  pickSession,
  sortSessions,
  summarize,
  turnInFlight,
} from './view.ts'
import type { ExternalSessionView } from './types.ts'

const NOW = Date.parse('2026-11-04T12:00:00Z')

function session(overrides: Partial<ExternalSessionView> & { id: string }): ExternalSessionView {
  return {
    provider: 'claude',
    title: overrides.id,
    status: 'idle',
    cwd: '/tmp',
    createdAt: '2026-11-04T09:00:00Z',
    lastTurnAt: '',
    canContinue: true,
    turns: [],
    ...overrides,
  }
}

describe('view formatting', () => {
  it('formats durations across the three ranges and refuses negatives', () => {
    expect(formatDuration(420)).toBe('420ms')
    expect(formatDuration(42_000)).toBe('42.0s')
    expect(formatDuration(62_000)).toBe('1m 02s')
    expect(formatDuration(3_930_000)).toBe('1h 05m')
    expect(formatDuration(undefined)).toBeUndefined()
    expect(formatDuration(-1)).toBeUndefined()
  })

  it('compacts token counts and usage pairs', () => {
    expect(formatCount(987)).toBe('987')
    expect(formatCount(1_234)).toBe('1.2k')
    expect(formatCount(4_700_000)).toBe('4.7M')
    expect(formatUsage({ input: 1234, output: 567 })).toEqual({ input: '1.2k', output: '567' })
    expect(formatUsage(undefined)).toBeUndefined()
  })

  it('keeps zero cost visible but distinct from a missing cost', () => {
    expect(formatCost(0)).toBe('$0')
    expect(formatCost(0.0032)).toBe('$0.0032')
    expect(formatCost(0.03)).toBe('$0.03')
    expect(formatCost(undefined)).toBeUndefined()
  })

  it('renders relative ages from the injected clock', () => {
    expect(formatAge('2026-11-04T11:59:40Z', NOW)).toBe('now')
    expect(formatAge('2026-11-04T11:51:00Z', NOW)).toBe('9m')
    expect(formatAge('2026-11-04T08:00:00Z', NOW)).toBe('4h')
    expect(formatAge('2026-11-02T12:00:00Z', NOW)).toBe('2d')
    expect(formatAge('not-a-date', NOW)).toBe('')
    expect(formatAge(undefined, NOW)).toBe('')
  })

  it('flattens and truncates summaries', () => {
    expect(summarize('a\n\n b   c')).toBe('a b c')
    expect(summarize('abcdef', 4)).toBe('abc…')
    expect(summarize(undefined)).toBe('')
  })
})

describe('session selection and ordering', () => {
  it('sorts the most recently active session first and stays stable on ties', () => {
    const sorted = sortSessions([
      session({ id: 'old', lastTurnAt: '2026-11-04T10:00:00Z' }),
      session({ id: 'new', lastTurnAt: '2026-11-04T12:00:00Z' }),
      session({ id: 'b', createdAt: '2026-11-04T11:00:00Z' }),
      session({ id: 'a', createdAt: '2026-11-04T11:00:00Z' }),
    ])
    expect(sorted.map(item => item.id)).toEqual(['new', 'a', 'b', 'old'])
  })

  it('prefers the requested session and falls back to the most recent one', () => {
    const list = [session({ id: 'a', lastTurnAt: '2026-11-04T10:00:00Z' }), session({ id: 'b', lastTurnAt: '2026-11-04T12:00:00Z' })]
    expect(pickSession(list, 'a')?.id).toBe('a')
    expect(pickSession(list, 'missing')?.id).toBe('b')
    expect(pickSession(list, undefined)?.id).toBe('b')
    expect(pickSession([], 'a')).toBeUndefined()
  })

  it('orders turns by turn number regardless of payload order', () => {
    const turns = orderedTurns(session({ id: 'a', turns: [{ n: 2, prompt: '', status: 'completed' }, { n: 1, prompt: '', status: 'completed' }] }))
    expect(turns.map(turn => turn.n)).toEqual([1, 2])
    expect(orderedTurns(undefined)).toEqual([])
  })
})

describe('action gating', () => {
  it('explains why continuation is blocked', () => {
    expect(continueAllowed(undefined)).toBe(false)
    expect(blockedReason(undefined)).toBeUndefined()
    expect(blockedReason(session({ id: 'a', status: 'closed' }))).toBe('closed')
    expect(blockedReason(session({ id: 'a', status: 'idle', canContinue: false }))).toBe('unresumable')
    expect(blockedReason(session({ id: 'a', status: 'idle', turns: [{ n: 1, prompt: '', status: 'completed' }] }))).toBeUndefined()
  })

  it('offers cancel only while a turn is in flight', () => {
    expect(turnInFlight(session({ id: 'a', status: 'running' }))).toBe(true)
    expect(turnInFlight(session({ id: 'a', turns: [{ n: 1, prompt: '', status: 'running' }] }))).toBe(true)
    expect(turnInFlight(session({ id: 'a', status: 'idle' }))).toBe(false)
    expect(turnInFlight(undefined)).toBe(false)
  })

  it('offers close for every session that is not already closed', () => {
    expect(closable(session({ id: 'a', status: 'idle' }))).toBe(true)
    expect(closable(session({ id: 'a', status: 'closed' }))).toBe(false)
    expect(closable(undefined)).toBe(false)
  })
})