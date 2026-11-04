import { describe, expect, it } from 'vitest'
import { ExternalSessionEngine } from './engine.ts'
import { resolveExternalSessionConfig, type ExternalSessionConfig } from './config.ts'
import { ExternalSessionStore } from './store.ts'
import { FakeAdapter, MemoryStoreFileSystem } from './test-doubles.ts'
import { externalError } from '../../../core/external-session/errors.ts'
import type { TurnOutcome } from '../../../core/external-session/adapters.ts'

const PATH = '/tmp/dsh-external-session.json'

/**
 * Wait until `predicate` holds. The engine writes its `running` record only
 * after preflight's awaits, so a test that inspects state must wait for the
 * state it is asserting on rather than for a fixed number of ticks.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** The same wait over a predicate that must await the engine. */
async function waitForAsync(predicate: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

interface SetupOptions extends ExternalSessionConfig {
  directoryProbe?: (path: string) => Promise<boolean>
  /** A codex adapter to expose, for the provider-missing case. */
  codex?: FakeAdapter
}

/** One engine over an in-memory store and a scripted Claude adapter. */
async function setup(options: SetupOptions = {}) {
  const fs = new MemoryStoreFileSystem()
  const config = resolveExternalSessionConfig({ storePath: PATH, ...options }, '/tmp/home')
  const store = new ExternalSessionStore({ storePath: PATH, maxSessions: config.maxSessions, fs })
  const claude = new FakeAdapter('claude')
  claude.autoOutcome = () => ({ status: 'completed', result: '42', durationMs: 5, providerSessionId: 'cli-1' })
  const adapters = { claude, ...(options.codex === undefined ? {} : { codex: options.codex }) }
  let clock = Date.parse('2026-11-04T12:00:00Z')
  const engine = new ExternalSessionEngine({
    config,
    store,
    adapters,
    directoryProbe: options.directoryProbe ?? (async () => true),
    now: () => clock,
    newId: (() => { let n = 0; return () => `ext-${++n}` })(),
  })
  return { engine, store, claude, fs, advance: (ms: number) => { clock += ms } }
}

describe('external-session engine', () => {
  it('runs a first turn on a new session and reports the tool shape', async () => {
    const { engine, store } = await setup()
    const result = await engine.runTurn({ provider: 'claude', prompt: 'remember 42', cwd: '/tmp' })
    expect(result).toMatchObject({
      session_id: 'ext-1', turn: 1, status: 'completed', result: '42', can_continue: true,
    })
    expect(result).not.toHaveProperty('code')
    const session = store.get('ext-1')
    expect(session?.providerSessionId).toBe('cli-1')
    expect(session?.status).toBe('idle')
    expect(session?.turns).toHaveLength(1)
  })

  it('continues the CLI conversation with the stored session id', async () => {
    const { engine, claude } = await setup()
    const first = await engine.runTurn({ provider: 'claude', prompt: 'remember 42', cwd: '/tmp' })
    if ('code' in first) throw new Error('first turn failed')
    await engine.runTurn({ provider: 'claude', prompt: 'which number?', sessionId: first.session_id })
    expect(claude.calls[1]?.providerSessionId).toBe('cli-1')
    expect(claude.calls[1]?.prompt).toBe('which number?')
  })

  it('keeps a continuation in the directory the conversation started in', async () => {
    const { engine, claude } = await setup()
    const first = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
    if ('code' in first) throw new Error('first turn failed')
    await engine.runTurn({ provider: 'claude', prompt: 'again', sessionId: first.session_id, cwd: '/var' })
    expect(claude.calls[1]?.cwd).toBe('/tmp')
  })

  it('numbers turns in settle order', async () => {
    const { engine, store } = await setup()
    const first = await engine.runTurn({ provider: 'claude', prompt: 'one', cwd: '/tmp' })
    if ('code' in first) throw new Error('first turn failed')
    await engine.runTurn({ provider: 'claude', prompt: 'two', sessionId: first.session_id })
    await engine.runTurn({ provider: 'claude', prompt: 'three', sessionId: first.session_id })
    expect(store.get('ext-1')?.turns.map(turn => turn.n)).toEqual([1, 2, 3])
  })

  it('reports an unknown session id instead of starting a turn', async () => {
    const { engine, claude } = await setup()
    const result = await engine.runTurn({ provider: 'claude', prompt: 'go', sessionId: 'ext-nope' })
    expect(result).toMatchObject({ code: 'session-unknown' })
    expect(claude.calls).toHaveLength(0)
  })

  it('refuses a closed session', async () => {
    const { engine, claude } = await setup()
    const first = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
    if ('code' in first) throw new Error('first turn failed')
    await engine.close(first.session_id)
    const result = await engine.runTurn({ provider: 'claude', prompt: 'again', sessionId: first.session_id })
    expect(result).toMatchObject({ code: 'session-closed' })
    expect(claude.calls).toHaveLength(1)
  })

  it('refuses a continuation when the CLI never reported a conversation id', async () => {
    const { engine, claude } = await setup()
    claude.autoOutcome = () => ({ status: 'completed', result: 'ok', durationMs: 1 })
    const first = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
    if ('code' in first) throw new Error('first turn failed')
    expect(first.can_continue).toBe(false)
    const result = await engine.runTurn({ provider: 'claude', prompt: 'again', sessionId: first.session_id })
    expect(result).toMatchObject({ code: 'session-unresumable' })
    expect(claude.calls).toHaveLength(1)
  })

  it('refuses the third simultaneous turn with busy', async () => {
    const { engine, claude } = await setup({ maxConcurrentTurns: 2 })
    claude.autoOutcome = undefined
    const a = engine.runTurn({ provider: 'claude', prompt: 'a', cwd: '/tmp' })
    const b = engine.runTurn({ provider: 'claude', prompt: 'b', cwd: '/tmp' })
    const c = await engine.runTurn({ provider: 'claude', prompt: 'c', cwd: '/tmp' })
    expect(c).toMatchObject({ code: 'busy' })
    // Exactly two processes exist; the third was refused before the adapter.
    await waitFor(() => claude.inFlight === 2, 'two adapter turns in flight')
    expect(claude.inFlight).toBe(2)
    claude.settle({ status: 'completed' })
    claude.settle({ status: 'completed' })
    await Promise.all([a, b])
  })

  it('refuses a second turn on a session that is already running one', async () => {
    const { engine, claude, store } = await setup({ maxConcurrentTurns: 4 })
    claude.autoOutcome = undefined
    const first = engine.runTurn({ provider: 'claude', prompt: 'long', cwd: '/tmp' })
    await waitFor(() => store.get('ext-1')?.status === 'running', 'the session to report running')

    // Same session, second turn: refused by the state gate, not by the global bound.
    const second = await engine.runTurn({ provider: 'claude', prompt: 'interrupt', sessionId: 'ext-1' })
    expect(second).toMatchObject({ code: 'busy' })
    expect(claude.inFlight).toBe(1)
    // A second session is a different question and is allowed under the bound.
    const other = engine.runTurn({ provider: 'claude', prompt: 'elsewhere', cwd: '/tmp' })
    await waitFor(() => claude.inFlight === 2, 'the second session to reach the adapter')
    claude.settle({ status: 'completed' })
    claude.settle({ status: 'completed' })
    await Promise.all([first, other])
  })

  it('releases the concurrency slot when a turn settles', async () => {
    const { engine, claude } = await setup({ maxConcurrentTurns: 1 })
    claude.autoOutcome = undefined
    const first = engine.runTurn({ provider: 'claude', prompt: 'a', cwd: '/tmp' })
    await waitFor(() => claude.inFlight === 1, 'the first turn to reach the adapter')
    expect(await engine.runTurn({ provider: 'claude', prompt: 'b', cwd: '/tmp' })).toMatchObject({ code: 'busy' })
    claude.settle({ status: 'completed' })
    await first
    claude.autoOutcome = () => ({ status: 'completed', result: 'ok', durationMs: 1 })
    const after = await engine.runTurn({ provider: 'claude', prompt: 'c', cwd: '/tmp' })
    expect(after).toMatchObject({ status: 'completed' })
  })

  it('reports provider-missing when no adapter exists for the provider', async () => {
    const { engine } = await setup()
    expect(await engine.runTurn({ provider: 'codex', prompt: 'go', cwd: '/tmp' })).toMatchObject({ code: 'provider-missing' })
  })

  it('reports provider-missing when the binary cannot be resolved', async () => {
    const { engine, claude } = await setup()
    claude.executable = null
    expect(await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })).toMatchObject({ code: 'provider-missing' })
  })

  it('reports cwd-invalid before starting a process', async () => {
    const { engine, claude } = await setup({ directoryProbe: async () => false })
    const result = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/nope' })
    expect(result).toMatchObject({ code: 'cwd-invalid' })
    expect(claude.calls).toHaveLength(0)
  })

  it('refuses a new session at the retention limit', async () => {
    const { engine } = await setup({ maxSessions: 1 })
    expect(await engine.runTurn({ provider: 'claude', prompt: 'one', cwd: '/tmp' })).toMatchObject({ status: 'completed' })
    expect(await engine.runTurn({ provider: 'claude', prompt: 'two', cwd: '/tmp' })).toMatchObject({ code: 'limit' })
  })

  it('records a failed turn and keeps the session continuable', async () => {
    const { engine, claude, store } = await setup()
    claude.autoOutcome = () => ({
      status: 'failed', result: '', durationMs: 2, providerSessionId: 'cli-1',
      error: externalError('auth-required', { provider: 'claude' }),
    })
    const result = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
    expect(result).toMatchObject({ code: 'auth-required' })
    expect(store.get('ext-1')?.status).toBe('failed')
    expect(store.get('ext-1')?.turns[0]?.status).toBe('failed')
    // A failed session is still continuable: the caller decides.
    claude.autoOutcome = () => ({ status: 'completed', result: 'ok', durationMs: 1, providerSessionId: 'cli-1' })
    expect(await engine.runTurn({ provider: 'claude', prompt: 'retry', sessionId: 'ext-1' })).toMatchObject({ status: 'completed' })
  })

  it('records a failed turn when the adapter throws, without leaking the error', async () => {
    const { engine, claude, store } = await setup()
    claude.throws = new Error('spawn blew up: secret-ish detail')
    const result = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
    expect(result).toMatchObject({ code: 'provider-missing' })
    expect(JSON.stringify(result)).not.toContain('secret-ish detail')
    expect(store.get('ext-1')?.status).toBe('failed')
  })

  it('cancels a running turn: aborted record, idle session, still continuable', async () => {
    const { engine, claude, store } = await setup()
    claude.autoOutcome = undefined
    const running = engine.runTurn({ provider: 'claude', prompt: 'long', cwd: '/tmp' })
    await waitFor(() => claude.inFlight === 1, 'the turn to reach the adapter')
    const signal = claude.lastSignal
    expect(signal?.aborted).toBe(false)

    const cancelled = engine.cancel('ext-1')
    claude.settle({ status: 'aborted', result: 'cancelled' })
    expect(await cancelled).toBeNull()
    await running

    expect(signal?.aborted).toBe(true)
    expect(store.get('ext-1')?.status).toBe('idle')
    expect(store.get('ext-1')?.turns[0]?.status).toBe('aborted')
  })

  it('closes a session and cancels its running turn', async () => {
    const { engine, claude, store } = await setup()
    claude.autoOutcome = undefined
    const running = engine.runTurn({ provider: 'claude', prompt: 'long', cwd: '/tmp' })
    await waitFor(() => claude.inFlight === 1, 'the turn to reach the adapter')
    const closing = engine.close('ext-1')
    claude.settle({ status: 'aborted' })
    expect(await closing).toEqual({ session_id: 'ext-1', status: 'closed' })
    await running
    expect(store.get('ext-1')?.status).toBe('closed')
  })

  it('reports unknown ids from close and cancel', async () => {
    const { engine } = await setup()
    expect(await engine.close('nope')).toMatchObject({ code: 'session-unknown' })
    expect(await engine.cancel('nope')).toMatchObject({ code: 'session-unknown' })
  })

  it('cancelling an idle session is not an error', async () => {
    const { engine } = await setup()
    await engine.runTurn({ provider: 'claude', prompt: 'one', cwd: '/tmp' })
    expect(await engine.cancel('ext-1')).toBeNull()
  })

  it('shows the running turn in the panel snapshot before it settles', async () => {
    const { engine, claude } = await setup()
    claude.autoOutcome = undefined
    const running = engine.runTurn({ provider: 'claude', prompt: 'long one', cwd: '/tmp' })
    await waitFor(() => claude.inFlight === 1, 'the turn to reach the adapter')
    const snapshot = await engine.listViews()
    expect(snapshot.sessions[0]?.status).toBe('running')
    expect(snapshot.sessions[0]?.turns).toEqual([
      { n: 1, prompt: 'long one', status: 'running', startedAt: '2026-11-04T12:00:00.000Z' },
    ])
    claude.settle({ status: 'completed' })
    await running
    expect((await engine.listViews()).sessions[0]?.turns[0]?.status).toBe('completed')
  })

  it('startTurn returns before the turn settles and leaves it running', async () => {
    const { engine, claude } = await setup()
    claude.autoOutcome = undefined
    const refusal = await engine.startTurn({ provider: 'claude', prompt: 'long', cwd: '/tmp' })
    expect(refusal).toBeNull()
    await waitFor(() => claude.inFlight === 1, 'the started turn to reach the adapter')
    expect((await engine.listViews()).sessions[0]?.status).toBe('running')

    claude.settle({ status: 'completed' })
    await waitFor(() => claude.inFlight === 0, 'the started turn to settle')
    await waitForAsync(async () => (await engine.listViews()).sessions[0]?.status === 'idle', 'the session to report idle')
  })

  it('startTurn still reports every refusal synchronously', async () => {
    const { engine } = await setup()
    expect(await engine.startTurn({ provider: 'codex', prompt: 'go', cwd: '/tmp' })).toMatchObject({ code: 'provider-missing' })
    expect(await engine.startTurn({ provider: 'claude', prompt: 'go', sessionId: 'nope' })).toMatchObject({ code: 'session-unknown' })
  })

  it('lists overviews filtered by status', async () => {
    const { engine } = await setup()
    await engine.runTurn({ provider: 'claude', prompt: 'one', cwd: '/tmp' })
    expect((await engine.listOverviews()).sessions).toHaveLength(1)
    expect((await engine.listOverviews('idle')).sessions).toHaveLength(1)
    expect((await engine.listOverviews('closed')).sessions).toHaveLength(0)
  })

  it('persists across an engine restart', async () => {
    const { engine, store, fs } = await setup()
    await engine.runTurn({ provider: 'claude', prompt: 'remember 42', cwd: '/tmp' })

    // A fresh engine over the same durable bytes is what a host restart looks like.
    const cold = new ExternalSessionStore({ storePath: PATH, maxSessions: 100, fs })
    const claude = new FakeAdapter('claude')
    claude.autoOutcome = (request: { providerSessionId?: string }) => ({
      status: 'completed', result: `resumed ${String(request.providerSessionId)}`, durationMs: 1, providerSessionId: 'cli-1',
    })
    const restarted = new ExternalSessionEngine({
      config: resolveExternalSessionConfig({ storePath: PATH }, '/tmp/home'),
      store: cold,
      adapters: { claude },
      directoryProbe: async () => true,
    })
    const listed = await restarted.listOverviews()
    expect(listed.sessions.map(session => session.id)).toEqual(['ext-1'])
    const result = await restarted.runTurn({ provider: 'claude', prompt: 'which number?', sessionId: 'ext-1' })
    expect(result).toMatchObject({ status: 'completed', result: 'resumed cli-1', turn: 2 })
    expect(store.size).toBe(1)
  })

  it('projects usage and cost with null when the CLI reported none', async () => {
    const { engine } = await setup()
    const result = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
    if ('code' in result) throw new Error('turn failed')
    expect(result.usage).toBeNull()
    expect(result.cost_usd).toBeNull()
  })

  it('carries usage and cost through when the CLI reported them', async () => {
    const { engine, claude } = await setup()
    claude.autoOutcome = (): TurnOutcome => ({
      status: 'completed', result: 'ok', durationMs: 3, providerSessionId: 'cli-1',
      usage: { input: 10, output: 4 }, costUsd: 0.02,
    })
    const result = await engine.runTurn({ provider: 'claude', prompt: 'go', cwd: '/tmp' })
    if ('code' in result) throw new Error('turn failed')
    expect(result.usage).toEqual({ input: 10, output: 4 })
    expect(result.cost_usd).toBe(0.02)
  })
})