/**
 * Behaviour the non-blocking contract adds: a bounded wait, the running
 * identity, live progress, partial text and the two deadlines.
 *
 * These are the assertions that keep a delegation from answering with an empty
 * string after a thirty-minute run, so they pin the contract rather than the
 * implementation: what a caller can see while a turn runs, and what it gets
 * back when the turn is cut short.
 */
import { describe, expect, it } from 'vitest'
import { ExternalSessionEngine } from './engine.ts'
import { resolveExternalSessionConfig } from './config.ts'
import { ExternalSessionStore } from './store.ts'
import { FakeAdapter, MemoryStoreFileSystem } from './test-doubles.ts'
import type { TurnProgress } from '../../../core/external-session/adapters.ts'
import { externalError } from '../../../core/external-session/errors.ts'

const PATH = '/tmp/dsh-external-session.json'

/** One engine over an in-memory store and a scripted adapter. */
function setup(options: { stallMs?: number; maxTurnMs?: number } = {}) {
  const fs = new MemoryStoreFileSystem()
  const config = resolveExternalSessionConfig({ storePath: PATH, ...options }, '/tmp/home')
  const store = new ExternalSessionStore({ storePath: PATH, maxSessions: config.maxSessions, fs })
  const claude = new FakeAdapter('claude')
  claude.autoOutcome = () => ({ status: 'completed', result: 'done', durationMs: 5, providerSessionId: 'cli-1' })
  let clock = Date.parse('2026-11-04T12:00:00Z')
  const engine = new ExternalSessionEngine({
    config,
    store,
    adapters: { claude },
    directoryProbe: async () => true,
    now: () => clock,
    newId: (() => { let n = 0; return () => `ext-${++n}` })(),
  })
  return { engine, store, claude, advance: (ms: number) => { clock += ms } }
}

/** Progress a well-behaved adapter publishes while it reads its child. */
function progressAt(idleFromNowMs: number, now: number): TurnProgress {
  return { frames: 4, toolCalls: 1, chars: 120, lastFrameAt: now - idleFromNowMs, tail: 'the answer so far' }
}

describe('bounded wait', () => {
  it('returns the settled result when the turn finishes inside the window', async () => {
    const { engine, claude } = setup()
    claude.autoOutcome = () => ({ status: 'completed', result: '42', durationMs: 5, providerSessionId: 'cli-1' })
    const started = await engine.startTurn({ provider: 'claude', prompt: 'short', cwd: '/tmp' })
    expect('code' in started).toBe(false)
    if ('code' in started) return
    expect(await engine.awaitTurn(started.session_id, 5_000)).toMatchObject({ status: 'completed', result: '42' })
  })

  it('returns the running turn with its progress when the window closes first', async () => {
    const { engine, claude, advance } = setup()
    claude.autoOutcome = undefined
    const started = await engine.startTurn({ provider: 'claude', prompt: 'long', cwd: '/tmp' })
    if ('code' in started) throw new Error('the turn should have started')
    advance(1_200)
    claude.reportProgress(progressAt(1_100, Date.parse('2026-11-04T12:00:00Z') + 1_200))

    const waiting = await engine.awaitTurn(started.session_id, 0)
    expect(waiting).toMatchObject({
      session_id: 'ext-1',
      turn: 1,
      status: 'running',
      progress: { frames: 4, tool_calls: 1, chars: 120, tail: 'the answer so far', idle_ms: 1_100 },
    })
  })

  it('answers with the last settled turn when the session is already quiet', async () => {
    const { engine } = setup()
    await engine.runTurn({ provider: 'claude', prompt: 'one', cwd: '/tmp' })
    expect(await engine.awaitTurn('ext-1', 5_000)).toMatchObject({ turn: 1, status: 'completed', result: 'done' })
    expect(await engine.awaitTurn('missing', 0)).toMatchObject({ code: 'session-unknown' })
  })
})

describe('partial results', () => {
  it('returns text plus the partial marker instead of a refusal', async () => {
    const { engine, claude } = setup()
    claude.autoOutcome = () => ({ status: 'aborted', result: 'half an answer', partial: true, durationMs: 5 })
    // A cancelled turn that got this far is the work, not an error: the caller
    // must see the text, or a long dispatch ends up worthless.
    expect(await engine.runTurn({ provider: 'claude', prompt: 'long', cwd: '/tmp' }))
      .toMatchObject({ status: 'aborted', result: 'half an answer', partial: true })
  })

  it('still reports a failure that produced no text', async () => {
    const { engine, claude } = setup()
    claude.autoOutcome = () => ({ status: 'failed', result: '', durationMs: 5, error: externalError('provider-error') })
    expect(await engine.runTurn({ provider: 'claude', prompt: 'long', cwd: '/tmp' })).toMatchObject({ code: 'provider-error' })
  })
})

describe('deadlines', () => {
  it('cancels a turn that has gone quiet, keeping its partial text', async () => {
    const { engine, claude, advance } = setup({ stallMs: 1_000 })
    claude.autoOutcome = undefined
    // A killed CLI still reports the text it had already written.
    claude.cancelOutcome = { result: 'partial text', partial: true }
    const started = await engine.startTurn({ provider: 'claude', prompt: 'stuck', cwd: '/tmp' })
    if ('code' in started) throw new Error('the turn should have started')
    advance(2_000)
    engine.sweepDeadlines()
    // The sweep aborts the signal; the adapter answers with what it had produced.
    expect(await engine.awaitTurn(started.session_id, 1_000))
      .toMatchObject({ status: 'aborted', result: 'partial text', partial: true })
  })

  it('does not cancel a turn that keeps producing frames', async () => {
    const { engine, claude, advance } = setup({ stallMs: 1_000 })
    claude.autoOutcome = undefined
    const started = await engine.startTurn({ provider: 'claude', prompt: 'busy', cwd: '/tmp' })
    if ('code' in started) throw new Error('the turn should have started')
    advance(2_000)
    claude.reportProgress(progressAt(10, Date.parse('2026-11-04T12:00:00Z') + 2_000))
    engine.sweepDeadlines()
    expect(claude.lastSignal?.aborted).toBe(false)
  })
})

describe('model-facing list', () => {
  it('carries the running turn and its progress', async () => {
    const { engine, claude, advance } = setup()
    claude.autoOutcome = undefined
    const started = await engine.startTurn({ provider: 'claude', prompt: 'long', cwd: '/tmp' })
    if ('code' in started) throw new Error('the turn should have started')
    advance(900)
    claude.reportProgress(progressAt(300, Date.parse('2026-11-04T12:00:00Z') + 900))
    const overview = (await engine.listOverviews()).sessions[0]
    expect(overview?.running).toMatchObject({ turn: 1, frames: 4, chars: 120, idle_ms: 300, elapsed_ms: 900 })
  })
})
