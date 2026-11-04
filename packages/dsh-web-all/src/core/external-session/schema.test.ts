import { describe, expect, it } from 'vitest'
import {
  emptyExternalStore, parseExternalStore, parseExternalStoreText, serializeExternalStore,
} from './schema.ts'
import type { ExternalSessionRecord, ExternalStoreFile } from './types.ts'

const AT = '2026-11-04T12:00:00Z'

function session(overrides: Partial<ExternalSessionRecord> = {}): ExternalSessionRecord {
  return {
    id: 'ext-1',
    provider: 'claude',
    providerSessionId: 'cli-abc',
    cwd: '/Users/leo/code/dsh-web',
    title: 'fix the login bug',
    status: 'idle',
    createdAt: AT,
    lastTurnAt: AT,
    turns: [{
      n: 1,
      prompt: 'remember 42',
      status: 'completed',
      startedAt: AT,
      durationMs: 42_000,
      usage: { input: 1234, output: 567 },
      costUsd: 0.03,
      result: '42',
    }],
    ...overrides,
  }
}

function store(...sessions: ExternalSessionRecord[]): ExternalStoreFile {
  return { version: 1, sessions }
}

/** Write the store through JSON so the test exercises the persisted shape. */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

describe('external-session store schema', () => {
  it('accepts the empty store', () => {
    expect(parseExternalStore(emptyExternalStore())).toEqual({ ok: true, value: { version: 1, sessions: [] } })
  })

  it('accepts a full record and keeps every field', () => {
    const result = parseExternalStore(roundTrip(store(session())))
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.sessions).toHaveLength(1)
    expect(result.value.sessions[0]).toEqual(session())
  })

  it('round-trips through the serialized text', () => {
    const text = serializeExternalStore(store(session()))
    const result = parseExternalStoreText(text)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.sessions[0]?.turns[0]?.result).toBe('42')
  })

  it('accepts a session with no CLI conversation id and no turns', () => {
    const result = parseExternalStore(roundTrip(store(session({ providerSessionId: undefined, turns: [] }))))
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.sessions[0]?.providerSessionId).toBeUndefined()
  })

  it('ignores keys this version does not define', () => {
    const withExtras = roundTrip({ ...store(session()), futureField: true })
    expect(parseExternalStore(withExtras).ok).toBe(true)
  })

  describe('rejects an illegal record', () => {
    const rejections: Array<[string, unknown]> = [
      ['a non-object store', []],
      ['an unknown version', { version: 2, sessions: [] }],
      ['a missing version', { sessions: [] }],
      ['sessions that are not an array', { version: 1, sessions: {} }],
      ['an unknown provider', roundTrip(store(session({ provider: 'gemini' as never })))],
      ['an unknown session status', roundTrip(store(session({ status: 'paused' as never })))],
      ['an empty session id', roundTrip(store(session({ id: '' })))],
      ['a relative cwd', roundTrip(store(session({ cwd: '' })))],
      ['a non-instant createdAt', roundTrip(store(session({ createdAt: 'yesterday' })))],
      ['a non-string title', roundTrip(store(session({ title: 7 as never })))],
      ['an empty providerSessionId', roundTrip(store(session({ providerSessionId: '' })))],
      ['turn numbers that skip', roundTrip(store(session({ turns: [
        { n: 2, prompt: 'x', status: 'completed', startedAt: AT, durationMs: 1, result: 'x' },
      ] as never })))],
      ['an unknown turn status', roundTrip(store(session({ turns: [
        { n: 1, prompt: 'x', status: 'running' as never, startedAt: AT, durationMs: 1, result: 'x' },
      ] })))],
      ['a negative duration', roundTrip(store(session({ turns: [
        { n: 1, prompt: 'x', status: 'completed', startedAt: AT, durationMs: -1, result: 'x' },
      ] })))],
      ['a non-numeric usage', roundTrip(store(session({ turns: [
        { n: 1, prompt: 'x', status: 'completed', startedAt: AT, durationMs: 1, result: 'x', usage: { input: 'many' } },
      ] as never })))],
      ['duplicate session ids', roundTrip(store(session(), session()))],
      ['turns that are not an array', roundTrip(store(session({ turns: {} as never })))],
    ]

    it.each(rejections)('rejects %s', (_label, input) => {
      const result = parseExternalStore(input)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).not.toBe('')
    })
  })

  it('names the failing path in the rejection reason', () => {
    const result = parseExternalStore(roundTrip(store(session({ status: 'paused' as never }))))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('sessions[0].status')
  })

  it('reports malformed JSON as a rejection instead of throwing', () => {
    const result = parseExternalStoreText('{"version":1,')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not valid JSON')
  })
})