import { spawn as spawnProcess } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  codexTurnArgv,
  createCodexAdapter,
  summarizeCodexStream,
} from '../src/host/services/external-session/providers/codex.ts'
import type {
  ExternalAdapterDeps,
  ExternalProcessHandle,
  ExternalProcessPort,
  ExternalSpawnSpec,
  TurnOutcome,
} from '../src/core/external-session/adapters.ts'

/**
 * Codex adapter tests.
 *
 * The exec event stream is decoded from the CLI's documented JSONL vocabulary
 * (`thread.started`, `turn.*`, `item.*`) plus the app-server dialect that newer
 * builds emit. Real CLI evidence is gated behind
 * `DSH_EXT_SESSION_REAL_CODEX=1` because this suite cannot assume a logged-in
 * Codex on the host.
 */

const THREAD_ID = '0199a213-81c0-7800-8aa1-bbab2a035a53'

/** One documented turn: reasoning, a command, then the answer. */
const EXEC_STREAM = [
  { type: 'thread.started', thread_id: THREAD_ID },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc cat f', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc cat f', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'reasoning', text: 'planning' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'READY-3f7' } },
  { type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 } },
]

const jsonl = (events: unknown[]): string => events.map(event => JSON.stringify(event)).join('\n') + '\n'

interface ScriptedTurn {
  stdout: string
  stderr: string
  exitCode: number | null
  signal?: string | null
  spawnFailure?: Error
}

interface ScriptedPort extends ExternalProcessPort {
  readonly calls: ExternalSpawnSpec[]
}

/** Scripted process port: records the spec and replays one turn. */
function scriptedPort(turn: ScriptedTurn, executable: string | null = '/usr/local/bin/codex'): ScriptedPort {
  const calls: ExternalSpawnSpec[] = []
  const reader = (full: string) => ({ readFrom: (from: number) => ({ text: full.slice(from), nextOffset: full.length, lossy: false }) })
  return {
    calls,
    async resolveExecutable() { return executable },
    spawn(spec) {
      calls.push(spec)
      const handle: ExternalProcessHandle = {
        collected: { stdout: reader(turn.stdout), stderr: reader(turn.stderr) },
        done: turn.spawnFailure === undefined
          ? Promise.resolve({ exitCode: turn.exitCode, signal: turn.signal ?? null })
          : Promise.reject(turn.spawnFailure),
        terminate() {},
        async waitForExit() { return true },
      }
      return handle
    },
  }
}

/** Deps with a pinned clock; Codex reads its own login state, so no settings file. */
function deps(port: ExternalProcessPort): ExternalAdapterDeps {
  const clock = [1000, 2500]
  return {
    process: port,
    readTextFile: async () => null,
    homeDir: '/home/example',
    now: () => clock.length > 0 ? clock.shift() as number : 2500,
    cancelGraceMs: 3000,
  }
}

const adapterFor = (port: ExternalProcessPort) => createCodexAdapter(deps(port), { bin: 'codex' })

/** Every outcome carries only settled-turn fields. */
function failureCode(outcome: TurnOutcome): string | null {
  return outcome.status === 'failed' ? outcome.error?.code ?? null : null
}

/**
 * Streams recorded from codex-cli 0.166.0-alpha.6 on this host, kept verbatim so
 * the decoder is tested against what the CLI really emits rather than a guess.
 */
const RECORDED_SUCCESS_STREAM = [
  { type: 'thread.started', thread_id: '01a1a6b6-f0ae-7a32-af40-3dcdf666bf03' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'CODEX-OK' } },
  {
    type: 'turn.completed',
    usage: { input_tokens: 17607, cached_input_tokens: 12160, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 0 },
  },
]

/** Recorded 401 turn: reconnects, an error item, then turn.failed. */
const RECORDED_AUTH_FAILURE_STREAM = [
  { type: 'thread.started', thread_id: '01a1a6b8-88f5-7aa3-89a7-e82052548216' },
  { type: 'turn.started' },
  { type: 'error', message: 'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)' },
  { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized' } },
  { type: 'error', message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses' },
  { type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } },
]

describe('codex recorded real streams', () => {
  it('reduces a recorded successful turn', () => {
    const summary = summarizeCodexStream(jsonl(RECORDED_SUCCESS_STREAM), '')
    expect(summary.threadId).toBe('01a1a6b6-f0ae-7a32-af40-3dcdf666bf03')
    expect(summary.finalMessage).toBe('CODEX-OK')
    expect(summary.usage).toEqual({ input: 17607, output: 8 })
    expect(summary.settled).toBe(true)
  })

  it('reduces a recorded unauthenticated turn without treating the error item as the answer', () => {
    const summary = summarizeCodexStream(jsonl(RECORDED_AUTH_FAILURE_STREAM), '')
    expect(summary.threadId).toBe('01a1a6b8-88f5-7aa3-89a7-e82052548216')
    expect(summary.finalMessage).toBe('')
    expect(summary.failed).toBe(true)
    expect(summary.authFailure).toBe(true)
  })

  it('classifies the recorded 401 as auth-required while keeping the thread id', async () => {
    const outcome = await adapterFor(scriptedPort({ stdout: jsonl(RECORDED_AUTH_FAILURE_STREAM), stderr: '', exitCode: 1 }))
      .runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(failureCode(outcome)).toBe('auth-required')
    expect(outcome.providerSessionId).toBe('01a1a6b8-88f5-7aa3-89a7-e82052548216')
  })
})

describe('codex argv', () => {
  it('submits the first turn through exec and the continuation through resume', () => {
    expect(codexTurnArgv('do the thing')).toEqual([
      'exec', '--json', '--approve-for-me', '--skip-git-repo-check', 'do the thing',
    ])
    expect(codexTurnArgv('next', THREAD_ID)).toEqual([
      'exec', 'resume', '--json', '--skip-git-repo-check', THREAD_ID, 'next',
    ])
  })
})

describe('codex stream reduction', () => {
  it('reads the thread id from the first event, the answer from the last agent message and the usage from turn.completed', () => {
    const summary = summarizeCodexStream(jsonl(EXEC_STREAM), '')
    expect(summary.threadId).toBe(THREAD_ID)
    expect(summary.finalMessage).toBe('READY-3f7')
    expect(summary.usage).toEqual({ input: 24763, output: 122 })
    expect(summary.settled).toBe(true)
    expect(summary.failed).toBe(false)
    expect(summary.damagedLines).toBe(0)
  })

  it('keeps the last agent message rather than the first', () => {
    const events = [
      { type: 'thread.started', thread_id: THREAD_ID },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'draft' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'final' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
    ]
    expect(summarizeCodexStream(jsonl(events), '').finalMessage).toBe('final')
  })

  it('decodes the app-server dialect that names events in a method field', () => {
    const events = [
      { method: 'thread/started', params: { thread: { id: THREAD_ID } } },
      { method: 'item/completed', params: { item: { id: 'msg_1', type: 'agentMessage', text: 'ANSWER' } } },
      { method: 'turn/completed', params: { turn: { id: 'turn_123', status: 'completed' }, usage: { input_tokens: 5, output_tokens: 1 } } },
    ]
    const summary = summarizeCodexStream(jsonl(events), '')
    expect(summary.threadId).toBe(THREAD_ID)
    expect(summary.finalMessage).toBe('ANSWER')
    expect(summary.usage).toEqual({ input: 5, output: 1 })
    expect(summary.settled).toBe(true)
  })

  it('reports a turn.failed event with its message', () => {
    const events = [
      { type: 'thread.started', thread_id: THREAD_ID },
      { type: 'turn.failed', error: { message: 'stream disconnected before completion' } },
    ]
    const summary = summarizeCodexStream(jsonl(events), '')
    expect(summary.failed).toBe(true)
    expect(summary.failureMessage).toContain('stream disconnected')
    expect(summary.settled).toBe(false)
  })

  it('counts non-JSON lines without treating them as a verdict', () => {
    const summary = summarizeCodexStream(`noise\n${jsonl(EXEC_STREAM)}`, '')
    expect(summary.damagedLines).toBe(1)
    expect(summary.settled).toBe(true)
  })
})

describe('codex adapter classification', () => {
  it('reports provider-missing when the host cannot resolve the binary', async () => {
    const port = scriptedPort({ stdout: '', stderr: '', exitCode: 0 }, null)
    const outcome = await adapterFor(port).runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(failureCode(outcome)).toBe('provider-missing')
    expect(port.calls).toHaveLength(0)
  })

  it('completes a turn and reports thread id, answer and usage', async () => {
    const port = scriptedPort({ stdout: jsonl(EXEC_STREAM), stderr: '', exitCode: 0 })
    const outcome = await adapterFor(port).runTurn({ prompt: 'do it', cwd: '/tmp' })
    expect(outcome.status).toBe('completed')
    expect(outcome.result).toBe('READY-3f7')
    expect(outcome.providerSessionId).toBe(THREAD_ID)
    expect(outcome.usage).toEqual({ input: 24763, output: 122 })
    expect(outcome.durationMs).toBe(1500)
    expect(port.calls[0]?.graceMs).toBe(3000)
  })

  it('leaves the conversation id absent when the stream never reports a thread', async () => {
    // The engine turns this absence into `session-unresumable`; the adapter must
    // never invent an id, because that would silently promise a continuation.
    const events = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'answer without a thread' } },
      { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } },
    ]
    const outcome = await adapterFor(scriptedPort({ stdout: jsonl(events), stderr: '', exitCode: 0 }))
      .runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(outcome.status).toBe('completed')
    expect(outcome.providerSessionId).toBeUndefined()
    expect('providerSessionId' in outcome).toBe(false)
  })

  it('maps a failed login to auth-required from the exit code', async () => {
    const outcome = await adapterFor(scriptedPort({ stdout: '', stderr: 'codex: authentication failed', exitCode: 2 }))
      .runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(failureCode(outcome)).toBe('auth-required')
  })

  it('maps a login complaint in the stream to auth-required', async () => {
    const outcome = await adapterFor(scriptedPort({ stdout: jsonl([{ type: 'error', message: 'Not logged in · run codex login' }]), stderr: '', exitCode: 1 }))
      .runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(failureCode(outcome)).toBe('auth-required')
  })

  it('reports session-unresumable when a continuation finds no session', async () => {
    const outcome = await adapterFor(scriptedPort({ stdout: '', stderr: 'Error: no such session: 0199', exitCode: 1 }))
      .runTurn({ prompt: 'hi', cwd: '/tmp', providerSessionId: THREAD_ID })
    expect(failureCode(outcome)).toBe('session-unresumable')
  })

  it('maps a quota failure to limit', async () => {
    const events = [
      { type: 'thread.started', thread_id: THREAD_ID },
      { type: 'turn.failed', error: { message: 'You have hit your usage limit' } },
    ]
    const outcome = await adapterFor(scriptedPort({ stdout: jsonl(events), stderr: '', exitCode: 1 }))
      .runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(failureCode(outcome)).toBe('limit')
  })

  it('treats a stream without turn.completed as failed and keeps the exit facts', async () => {
    const outcome = await adapterFor(scriptedPort({ stdout: jsonl([{ type: 'thread.started', thread_id: THREAD_ID }]), stderr: 'boom', exitCode: 1 }))
      .runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(outcome.status).toBe('failed')
    expect(failureCode(outcome)).toBe('provider-error')
    expect(outcome.result).toContain('exit 1')
    expect(outcome.result).toContain('boom')
  })

  it('keeps the thread id on a failed turn so the session stays continuable', async () => {
    const events = [
      { type: 'thread.started', thread_id: THREAD_ID },
      { type: 'turn.failed', error: { message: 'stream disconnected' } },
    ]
    const outcome = await adapterFor(scriptedPort({ stdout: jsonl(events), stderr: '', exitCode: 1 }))
      .runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(outcome.status).toBe('failed')
    expect(outcome.providerSessionId).toBe(THREAD_ID)
  })

  it('resolves a host spawn rejection as a failed turn rather than throwing', async () => {
    const outcome = await adapterFor(scriptedPort({
      stdout: '',
      stderr: '',
      exitCode: null,
      spawnFailure: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
    })).runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(outcome.status).toBe('failed')
    expect(failureCode(outcome)).toBe('provider-error')
    expect(outcome.result).toContain('ENOENT')
  })

  it('reports a cancelled turn as aborted and keeps the thread id', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await adapterFor(scriptedPort({ stdout: jsonl(EXEC_STREAM), stderr: '', exitCode: null, signal: 'SIGTERM' }))
      .runTurn({ prompt: 'hi', cwd: '/tmp', signal: controller.signal })
    expect(outcome.status).toBe('aborted')
    expect(outcome.providerSessionId).toBe(THREAD_ID)
  })
})

/**
 * Strict gate: needs a real Codex that can both run and persist a thread, so it
 * requires a signed-in, writable CLI home as well as the switch. Verified end to
 * end on a host whose `~/.codex` is writable; a read-only home fails earlier, at
 * the CLI's own app-server initialization, which is an environment fact rather
 * than an adapter one.
 */
const REAL_CODEX = process.env.DSH_EXT_SESSION_REAL_CODEX === '1' && process.env.DSH_EXT_SESSION_CODEX_HOME !== undefined
const CODEX_BIN = process.env.DSH_EXT_SESSION_CODEX_BIN ?? 'codex'
const PROBE_DIR = join(tmpdir(), 'dsh-ext-session-real-codex')
const PROBE_FILE = join(PROBE_DIR, 'codex-probe.txt')
/** CLI config directory for the real turn; must be writable for a thread store. */
const PROBE_CODEX_HOME = process.env.DSH_EXT_SESSION_CODEX_HOME ?? join(PROBE_DIR, 'codex-home')

/**
 * Real process port: host-shaped spawn with offset readers over collected text.
 *
 * `extraEnv` points this CLI's config directory at a writable temp path: the
 * session store and the app-server scratch files both live under it, so a host
 * whose home directory is read-only to the test process can still run a real
 * turn. The adapter under test is untouched by this.
 */
function realPort(extraEnv: Record<string, string> = {}): ExternalProcessPort {
  return {
    async resolveExecutable(command, env) {
      const isExecutable = (candidate: string): boolean => {
        try {
          if (!statSync(candidate).isFile()) return false
          accessSync(candidate, constants.X_OK)
          return true
        } catch {
          return false
        }
      }
      if (command.includes('/')) return isExecutable(command) ? command : null
      for (const directory of (env?.PATH ?? process.env.PATH ?? '').split(delimiter)) {
        if (directory.length === 0) continue
        const candidate = join(directory, command)
        if (isExecutable(candidate)) return candidate
      }
      return null
    },
    spawn(spec) {
      const child = spawnProcess(spec.argv[0] as string, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...extraEnv, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: spec.signal,
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', chunk => { stdout += String(chunk) })
      child.stderr?.on('data', chunk => { stderr += String(chunk) })
      const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      const reader = (read: () => string) => ({
        readFrom: (from: number) => {
          const full = read()
          return { text: full.slice(from), nextOffset: full.length, lossy: false }
        },
      })
      return {
        done,
        collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) },
        terminate() { child.kill('SIGTERM') },
        waitForExit: () => done.then(() => true, () => true),
      }
    },
  }
}

describe.skipIf(!REAL_CODEX)('codex adapter against the real CLI', () => {
  it('writes a file, reads it back and continues the same thread', async () => {
    rmSync(PROBE_DIR, { recursive: true, force: true })
    mkdirSync(PROBE_DIR, { recursive: true })
    // The CLI refuses to start unless its config directory already exists.
    mkdirSync(PROBE_CODEX_HOME, { recursive: true })
    const adapter = createCodexAdapter({
      process: realPort({ CODEX_HOME: PROBE_CODEX_HOME }),
      readTextFile: async (path) => {
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return null
        }
      },
      homeDir: process.env.HOME ?? '',
      now: () => Date.now(),
      cancelGraceMs: 3000,
    }, { bin: CODEX_BIN })

    const first = await adapter.runTurn({
      prompt: `Write the file ${PROBE_FILE} whose exact content is the single line CODEX-READY. `
        + `Then run: cat ${PROBE_FILE}. Answer with the file content only.`,
      cwd: PROBE_DIR,
    })
    // A real turn is allowed to fail for environmental reasons; the outcome is
    // the diagnostic that makes the reason visible in the test log.
    if (first.status !== 'completed') console.error('real codex turn outcome:', JSON.stringify(first))
    expect(first.status).toBe('completed')
    expect(existsSync(PROBE_FILE)).toBe(true)
    expect(readFileSync(PROBE_FILE, 'utf8').trim()).toBe('CODEX-READY')
    expect(first.providerSessionId).toBeTruthy()
    expect(first.usage?.input).toBeGreaterThan(0)

    const second = await adapter.runTurn({
      prompt: 'What exact content did you write to that file? Reply with the content only.',
      cwd: PROBE_DIR,
      providerSessionId: first.providerSessionId,
    })
    expect(second.status).toBe('completed')
    expect(second.result).toContain('CODEX-READY')
  }, 300_000)
})