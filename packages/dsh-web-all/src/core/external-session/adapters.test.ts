import { describe, expect, it, vi } from 'vitest'
import {
  outcomeSessionId, turnOutcomeError,
  type ExternalAdapter, type ExternalAdapterDeps, type ExternalOutputReader, type ExternalProcessHandle,
  type ExternalProcessPort, type ExternalSpawnSpec, type TurnOutcome,
} from './adapters.ts'
import { externalError } from './errors.ts'

/** Stand-in for a collected stream: the whole retained text, no cursor. */
function reader(text: string): ExternalOutputReader {
  return {
    readFrom(fromByte: number) {
      const offset = Math.min(fromByte, text.length)
      return { text: text.slice(offset), nextOffset: text.length, lossy: false }
    },
  }
}

interface ScriptedSpawn {
  spec: ExternalSpawnSpec
  handle: ExternalProcessHandle
  settled(): void
}

/** A process port whose one spawn resolves when the test settles it. */
function scriptedPort(stdout: string, exitCode: number | null = 0) {
  let release: ((value: { exitCode: number | null; signal: string | null }) => void) | undefined
  const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => { release = resolve })
  const spawns: ScriptedSpawn[] = []
  const terminate = vi.fn()
  const port: ExternalProcessPort = {
    spawn(spec) {
      const handle: ExternalProcessHandle = {
        done,
        collected: { stdout: reader(stdout), stderr: reader('') },
        terminate,
        async waitForExit() { return true },
      }
      spawns.push({ spec, handle, settled: () => release?.({ exitCode, signal: null }) })
      return handle
    },
    async resolveExecutable(command) { return command === 'claude' ? '/fake/bin/claude' : null },
  }
  return { port, spawns, terminate, release: () => release?.({ exitCode, signal: null }) }
}

function deps(port: ExternalProcessPort): ExternalAdapterDeps {
  return {
    process: port,
    readTextFile: async () => null,
    homeDir: '/tmp/home',
    now: () => 1_000,
    cancelGraceMs: 3_000,
  }
}

/** A minimal adapter: proves the contract is implementable end to end. */
function fakeAdapter(port: ExternalProcessPort): ExternalAdapter {
  const depsValue = deps(port)
  return {
    provider: 'claude',
    async resolveExecutable() { return depsValue.process.resolveExecutable('claude') },
    async runTurn(request) {
      const started = depsValue.now()
      const handle = depsValue.process.spawn({
        argv: ['claude', '-p', request.prompt],
        cwd: request.cwd,
        graceMs: depsValue.cancelGraceMs,
        signal: request.signal,
        stdoutMaxBytes: 1 << 20,
        stderrMaxBytes: 1 << 20,
      })
      const outcome = await handle.done
      const text = handle.collected.stdout?.readFrom(0).text ?? ''
      return {
        status: outcome.exitCode === 0 ? 'completed' : 'failed',
        result: text,
        providerSessionId: 'cli-1',
        durationMs: depsValue.now() - started,
        ...(outcome.exitCode === 0 ? {} : { error: externalError('provider-missing') }),
      } as TurnOutcome
    },
  }
}

describe('external-session adapter contract', () => {
  it('is implementable against the process port alone', async () => {
    const { port, release } = scriptedPort('{"result":42}\n')
    const adapter = fakeAdapter(port)
    expect(await adapter.resolveExecutable()).toBe('/fake/bin/claude')
    const pending = adapter.runTurn({ prompt: 'remember 42', cwd: '/tmp' })
    release()
    const outcome = await pending
    expect(outcome.status).toBe('completed')
    expect(outcome.result).toContain('42')
    expect(outcome.providerSessionId).toBe('cli-1')
  })

  it('passes the configured cancellation grace through to the spawn', async () => {
    const { port, spawns, release } = scriptedPort('done')
    const pending = fakeAdapter(port).runTurn({ prompt: 'x', cwd: '/tmp' })
    expect(spawns[0]?.spec.graceMs).toBe(3_000)
    expect(spawns[0]?.spec.cwd).toBe('/tmp')
    expect(spawns[0]?.spec.argv[0]).toBe('claude')
    release()
    await pending
  })

  it('reports a missing binary as null instead of throwing', async () => {
    const { port } = scriptedPort('')
    const adapter: ExternalAdapter = { ...fakeAdapter(port), async resolveExecutable() { return null } }
    await expect(adapter.resolveExecutable()).resolves.toBeNull()
  })

  it('reads collected output from a whole-stream offset, not a cursor', () => {
    const stream = reader('abcdef')
    expect(stream.readFrom(0).text).toBe('abcdef')
    // Re-reading the same offset yields the same text: offsets belong to the caller.
    expect(stream.readFrom(0).text).toBe('abcdef')
    expect(stream.readFrom(3)).toEqual({ text: 'def', nextOffset: 6, lossy: false })
    expect(stream.readFrom(99)).toEqual({ text: '', nextOffset: 6, lossy: false })
  })

  describe('outcome projection', () => {
    const base = { result: 'r', durationMs: 1 }

    it('projects the error of a failed turn and nothing else', () => {
      const failed: TurnOutcome = { ...base, status: 'failed', error: externalError('auth-required') }
      expect(turnOutcomeError(failed)?.code).toBe('auth-required')
      expect(turnOutcomeError({ ...base, status: 'completed' })).toBeNull()
      expect(turnOutcomeError({ ...base, status: 'aborted' })).toBeNull()
    })

    it('treats an empty or missing CLI conversation id as absent', () => {
      expect(outcomeSessionId({ ...base, status: 'completed', providerSessionId: 'cli-1' })).toBe('cli-1')
      expect(outcomeSessionId({ ...base, status: 'completed', providerSessionId: '' })).toBeUndefined()
      expect(outcomeSessionId({ ...base, status: 'completed' })).toBeUndefined()
    })
  })
})