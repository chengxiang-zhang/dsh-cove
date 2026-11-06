import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_ERROR_CODES, externalError, isExternalError, isExternalErrorCode,
} from './errors.ts'

describe('external-session error vocabulary', () => {
  it('defines the eight design codes plus the CLI-failure and storage codes', () => {
    expect([...EXTERNAL_ERROR_CODES]).toEqual([
      'provider-missing', 'cwd-invalid', 'session-unknown', 'session-closed',
      'session-unresumable', 'busy', 'limit', 'auth-required', 'provider-error',
      // The two deadline codes describe a turn that started and was cut short;
      // they belong to the same vocabulary the model reads.
      'turn-stalled', 'turn-timeout', 'store-unavailable',
    ])
    expect(new Set(EXTERNAL_ERROR_CODES).size).toBe(EXTERNAL_ERROR_CODES.length)
  })

  it('gives every code a one-sentence explanation', () => {
    for (const code of EXTERNAL_ERROR_CODES) {
      const error = externalError(code)
      expect(error.code).toBe(code)
      expect(error.message.length).toBeGreaterThan(20)
      expect(error.message.trim().endsWith('.')).toBe(true)
      // One sentence: the model acts on a single instruction, not a paragraph.
      expect(error.message.match(/\. /g)?.length ?? 0).toBeLessThanOrEqual(2)
    }
  })

  it('names the CLI by provider in the messages that talk about a binary', () => {
    expect(externalError('provider-missing', { provider: 'claude' }).message).toContain('Claude Code')
    expect(externalError('provider-missing', { provider: 'codex' }).message).toContain('Codex')
    expect(externalError('provider-missing').message).toContain('external CLI')
    expect(externalError('auth-required', { provider: 'codex' }).message).toContain('Codex')
  })

  it('turns a missing credential into an actionable auth-required sentence', () => {
    const message = externalError('auth-required', { provider: 'claude' }).message
    expect(message).toContain('~/.claude/settings.json')
    expect(message).toContain('ANTHROPIC_BASE_URL')
    expect(message).toContain('ANTHROPIC_AUTH_TOKEN')
    expect(message).toContain('env')
  })

  it('recognizes exactly the defined codes', () => {
    for (const code of EXTERNAL_ERROR_CODES) expect(isExternalErrorCode(code)).toBe(true)
    for (const other of ['', 'FAILED', 'busy ', 'timeout', 7, null, undefined]) {
      expect(isExternalErrorCode(other)).toBe(false)
    }
  })

  it('recognizes a reportable error object', () => {
    expect(isExternalError(externalError('busy'))).toBe(true)
    expect(isExternalError({ code: 'busy' })).toBe(false)
    expect(isExternalError({ code: 'unknown-code', message: 'x' })).toBe(false)
    expect(isExternalError(null)).toBe(false)
    expect(isExternalError('busy')).toBe(false)
  })
})