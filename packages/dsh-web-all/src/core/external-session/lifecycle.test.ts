import { describe, expect, it } from 'vitest'
import {
  applyTurn, checkTurnAllowed, closeSession, markRunning, nextTurnNumber, sessionStatusAfterTurn,
} from './lifecycle.ts'
import type { ExternalSessionRecord, ExternalTurnRecord } from './types.ts'

const AT = '2026-11-04T12:00:00Z'

function record(overrides: Partial<ExternalSessionRecord> = {}): ExternalSessionRecord {
  return {
    id: 'ext-1',
    provider: 'claude',
    providerSessionId: 'cli-abc',
    cwd: '/tmp',
    title: 'work',
    status: 'idle',
    createdAt: AT,
    lastTurnAt: AT,
    turns: [],
    ...overrides,
  }
}

function turn(overrides: Partial<ExternalTurnRecord> = {}): ExternalTurnRecord {
  return {
    n: 1,
    prompt: 'remember 42',
    status: 'completed',
    startedAt: '2026-11-04T12:03:00Z',
    durationMs: 4200,
    result: '42',
    ...overrides,
  }
}

describe('external-session lifecycle', () => {
  describe('checkTurnAllowed', () => {
    it('lets an idle session start a fresh turn', () => {
      expect(checkTurnAllowed(record(), { resume: false })).toBeNull()
    })

    it('lets an idle session continue when the CLI id is known', () => {
      expect(checkTurnAllowed(record(), { resume: true })).toBeNull()
    })

    it('lets a failed session continue, because a failure is a signal not a gate', () => {
      expect(checkTurnAllowed(record({ status: 'failed' }), { resume: true })).toBeNull()
    })

    it('refuses a closed session', () => {
      expect(checkTurnAllowed(record({ status: 'closed' }), { resume: false })?.code).toBe('session-closed')
      expect(checkTurnAllowed(record({ status: 'closed' }), { resume: true })?.code).toBe('session-closed')
    })

    it('reports busy while a turn is already running', () => {
      expect(checkTurnAllowed(record({ status: 'running' }), { resume: true })?.code).toBe('busy')
    })

    it('refuses a continuation when the CLI id was never captured', () => {
      const idle = record({ providerSessionId: undefined })
      expect(checkTurnAllowed(idle, { resume: true })?.code).toBe('session-unresumable')
      expect(checkTurnAllowed(idle, { resume: false })).toBeNull()
    })

    it('treats an empty CLI id as absent', () => {
      expect(checkTurnAllowed(record({ providerSessionId: '' }), { resume: true })?.code).toBe('session-unresumable')
    })

    it('prefers session-closed over session-unresumable', () => {
      const closed = record({ status: 'closed', providerSessionId: undefined })
      expect(checkTurnAllowed(closed, { resume: true })?.code).toBe('session-closed')
    })
  })

  describe('settle', () => {
    it('maps a completed turn to idle and a failed turn to failed', () => {
      expect(sessionStatusAfterTurn('completed')).toBe('idle')
      expect(sessionStatusAfterTurn('aborted')).toBe('idle')
      expect(sessionStatusAfterTurn('failed')).toBe('failed')
    })

    it('numbers turns from one and appends', () => {
      expect(nextTurnNumber(record())).toBe(1)
      const applied = applyTurn(record(), turn())
      expect(applied.turns).toHaveLength(1)
      expect(nextTurnNumber(applied)).toBe(2)
      const second = applyTurn(applied, turn({ n: 2, status: 'failed', result: 'boom' }))
      expect(second.turns.map(entry => entry.n)).toEqual([1, 2])
      expect(second.status).toBe('failed')
    })

    it('moves lastTurnAt to the settling turn', () => {
      const applied = applyTurn(record(), turn({ startedAt: '2026-11-04T13:00:00Z' }))
      expect(applied.lastTurnAt).toBe('2026-11-04T13:00:00Z')
    })

    it('does not mutate the stored record', () => {
      const before = record()
      const snapshot = JSON.stringify(before)
      applyTurn(before, turn())
      markRunning(before)
      closeSession(before)
      expect(JSON.stringify(before)).toBe(snapshot)
    })

    it('rejects a turn number that does not follow the last one', () => {
      expect(() => applyTurn(record(), turn({ n: 2 }))).toThrow('cannot settle')
      expect(() => applyTurn(applyTurn(record(), turn()), turn({ n: 1 }))).toThrow('cannot settle')
    })

    it('marks a session running once', () => {
      const running = markRunning(record())
      expect(running.status).toBe('running')
      expect(markRunning(running)).toBe(running)
    })

    it('closes a session terminally and is idempotent', () => {
      const closed = closeSession(record())
      expect(closed.status).toBe('closed')
      expect(closeSession(closed)).toBe(closed)
      expect(checkTurnAllowed(closed, { resume: true })?.code).toBe('session-closed')
    })
  })
})