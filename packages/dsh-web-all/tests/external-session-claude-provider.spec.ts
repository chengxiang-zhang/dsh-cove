import { spawn as spawnProcess } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_CREDENTIAL_KEYS,
  claudeTurnArgv,
  createClaudeAdapter,
  readClaudeSettingsEnv,
  summarizeClaudeStream,
} from '../src/host/services/external-session/providers/claude.ts'
import type {
  ExternalAdapterDeps,
  ExternalProcessHandle,
  ExternalProcessPort,
  ExternalSpawnSpec,
  TurnOutcome,
} from '../src/core/external-session/adapters.ts'

/**
 * Claude Code adapter tests.
 *
 * Three evidence classes, in increasing cost:
 * - stream reduction over recorded frames, no process at all;
 * - adapter classification through a scripted process port, so argv, the
 *   injected environment and every error mapping are asserted without a call;
 * - one real CLI turn pair, gated by `DSH_EXT_SESSION_REAL_CLI=1`, which writes a
 *   file, reads it back and then asks to continue the same conversation.
 */

const SESSION_ID = 'c862275c-4af2-4871-8a77-0c0ea7be42f6'

const INIT_FRAME = {
  type: 'system',
  subtype: 'init',
  session_id: SESSION_ID,
  cwd: '/tmp/example',
  permissionMode: 'auto',
  model: 'example-model',
  tools: ['Bash', 'Write'],
  apiKeySource: 'none',
}

const HOOK_RESPONSE = { type: 'system', subtype: 'hook_response', session_id: 'hook-run', hook_name: 'SessionStart' }

const RESULT_FRAME = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 5410,
  num_turns: 2,
  result: 'READY-3f7',
  session_id: SESSION_ID,
  total_cost_usd: 0.0312,
  usage: { input_tokens: 4351, output_tokens: 9, cache_creation_input_tokens: 76217 },
}

/** The recorded shape of a print-mode run that never authenticated. */
const AUTH_FRAME_LINES = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: '5429b08a-7a5b-47d8-a4f0-6db4a1c987a6', apiKeySource: 'none' }),
  JSON.stringify({
    type: 'assistant',
    error: 'authentication_failed',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'Not logged in · Please run /login',
    session_id: '5429b08a-7a5b-47d8-a4f0-6db4a1c987a6',
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  }),
]

/** Record one turn's frames as the CLI writes them. */
function stream(...frames: unknown[]): string {
  return frames.map(frame => JSON.stringify(frame)).join('\n') + '\n'
}

interface ScriptedTurn {
  stdout: string
  stderr: string
  exitCode: number | null
  signal?: string | null
  /** Rejection the host port reports instead of exit facts. */
  spawnFailure?: Error
}

interface ScriptedPort extends ExternalProcessPort {
  readonly calls: ExternalSpawnSpec[]
}

/** Scripted process port: records the spec and replays one turn. */
function scriptedPort(turn: ScriptedTurn, executable: string | null = '/usr/local/bin/claude'): ScriptedPort {
  const calls: ExternalSpawnSpec[] = []
  const reader = (full: string) => ({
    readFrom: (fromByte: number) => ({ text: full.slice(fromByte), nextOffset: full.length, lossy: false }),
    // Accumulating semantics: reading from 0 twice yields the same text.
  })
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

/** Deps with a deterministic clock and scripted settings, so nothing real is read. */
function deps(
  port: ExternalProcessPort,
  settings: string | null = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_AUTH_TOKEN: 'token-value' } }),
): ExternalAdapterDeps {
  const clock = [1000, 2500]
  return {
    process: port,
    readTextFile: async () => settings,
    homeDir: '/home/example',
    now: () => clock.length > 0 ? clock.shift() as number : 2500,
    cancelGraceMs: 3000,
  }
}

/** The adapter under test, wired to a scripted port. */
function adapterFor(port: ExternalProcessPort, settings?: string | null) {
  return createClaudeAdapter(deps(port, settings), { bin: 'claude' })
}

/** Every outcome carries only settled-turn fields. */
function failureCode(outcome: TurnOutcome): string | null {
  return outcome.status === 'failed' ? outcome.error?.code ?? null : null
}

describe('claude stream reduction', () => {
  it('reads the session id from the init frame and the usage from the result frame', () => {
    const summary = summarizeClaudeStream(stream(INIT_FRAME, RESULT_FRAME), '')
    expect(summary.providerSessionId).toBe(SESSION_ID)
    expect(summary.resultText).toBe('READY-3f7')
    expect(summary.isError).toBe(false)
    expect(summary.usage).toEqual({ input: 4351, output: 9 })
    expect(summary.costUsd).toBe(0.0312)
    expect(summary.cliDurationMs).toBe(5410)
    expect(summary.resultFrames).toBe(1)
  })

  it('tolerates frames before the init frame', () => {
    const hook = { type: 'system', subtype: 'hook_started', session_id: 'hook-run', hook_name: 'SessionStart' }
    const summary = summarizeClaudeStream(stream(hook, INIT_FRAME, HOOK_RESPONSE, RESULT_FRAME), '')
    expect(summary.providerSessionId).toBe(SESSION_ID)
    expect(summary.damagedLines).toBe(0)
  })

  it('falls back to the result frame when a truncated head lost the init frame', () => {
    const summary = summarizeClaudeStream(stream(RESULT_FRAME), '')
    expect(summary.providerSessionId).toBe(SESSION_ID)
    expect(summary.resultFrames).toBe(1)
  })

  it('recognizes the recorded unauthenticated turn as an auth failure', () => {
    const summary = summarizeClaudeStream(AUTH_FRAME_LINES.join('\n'), '')
    expect(summary.authFailure).toBe(true)
    expect(summary.isError).toBe(true)
  })

  it('recognizes a resume miss from the CLI diagnostic', () => {
    const frames = stream({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: '11111111-2222-3333-4444-555555555555',
      total_cost_usd: 0,
    })
    const summary = summarizeClaudeStream(frames, 'No conversation found with session ID: 11111111-2222-3333-4444-555555555555')
    expect(summary.resumeMissing).toBe(true)
  })

  it('reports a turn with no result frame as unsettled and counts damaged lines', () => {
    const summary = summarizeClaudeStream('not json\n', 'Error: Input must be provided either through stdin or as a prompt argument')
    expect(summary.resultFrames).toBe(0)
    expect(summary.damagedLines).toBe(1)
  })

  it('ignores an empty usage block instead of reporting a zero-token turn', () => {
    const summary = summarizeClaudeStream(stream(INIT_FRAME, { ...RESULT_FRAME, usage: { input_tokens: 0, output_tokens: 0 } }), '')
    expect(summary.usage).toBeUndefined()
  })
})

describe('claude argv', () => {
  it('uses the pinned unattended flags and appends the resume flag for a continuation', () => {
    expect(claudeTurnArgv('do the thing')).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'auto', 'do the thing',
    ])
    expect(claudeTurnArgv('next', 'abc')).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'auto', '--resume', 'abc', 'next',
    ])
  })

  it('keeps a dash-leading prompt a positional value after every flag', () => {
    expect(claudeTurnArgv('-3 items')).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'auto', '--', '-3 items',
    ])
  })
})

describe('claude settings env', () => {
  it('reads the credential entries from the CLI settings file', async () => {
    const env = await readClaudeSettingsEnv({
      homeDir: '/home/example',
      readTextFile: async () => JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_AUTH_TOKEN: 'token-value' } }),
    })
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('token-value')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.invalid')
    expect(CLAUDE_CREDENTIAL_KEYS).toEqual(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'])
  })

  it('returns an empty env for a missing or malformed settings file', async () => {
    await expect(readClaudeSettingsEnv({ homeDir: '/home/example', readTextFile: async () => null })).resolves.toEqual({})
    await expect(readClaudeSettingsEnv({ homeDir: '/home/example', readTextFile: async () => '{' })).resolves.toEqual({})
  })
})

describe('claude adapter classification', () => {
  it('reports provider-missing when the host cannot resolve the binary', async () => {
    const port = scriptedPort({ stdout: '', stderr: '', exitCode: 0 }, null)
    const outcome = await adapterFor(port).runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(outcome.status).toBe('failed')
    expect(failureCode(outcome)).toBe('provider-missing')
    expect(outcome.result).toBe('')
    expect(port.calls).toHaveLength(0)
  })

  it('refuses to spawn when a credential entry is missing from the settings env', async () => {
    const port = scriptedPort({ stdout: '', stderr: '', exitCode: 0 })
    const outcome = await adapterFor(port, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'only-the-token' } }))
      .runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(failureCode(outcome)).toBe('auth-required')
    expect(outcome.status === 'failed' ? outcome.error?.message ?? '' : '').toContain('ANTHROPIC_BASE_URL')
    expect(port.calls).toHaveLength(0)
  })

  it('injects both credential entries and passes the configured cancellation grace', async () => {
    const port = scriptedPort({ stdout: stream(INIT_FRAME, RESULT_FRAME), stderr: '', exitCode: 0 })
    const outcome = await adapterFor(port).runTurn({ prompt: 'do it', cwd: '/tmp' })
    expect(outcome.status).toBe('completed')
    const spec = port.calls[0]
    expect(spec?.argv.slice(1)).toEqual(claudeTurnArgv('do it'))
    expect(spec?.env).toEqual({ ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_AUTH_TOKEN: 'token-value' })
    expect(spec?.graceMs).toBe(3000)
    expect(spec?.stdoutMaxBytes).toBeGreaterThan(0)
    expect(outcome.usage).toEqual({ input: 4351, output: 9 })
    expect(outcome.costUsd).toBe(0.0312)
    expect(outcome.durationMs).toBe(1500)
    expect(outcome.result).toBe('READY-3f7')
    expect(outcome.providerSessionId).toBe(SESSION_ID)
  })

  it('passes the resume flag and reports the continuation session id', async () => {
    const port = scriptedPort({ stdout: stream(INIT_FRAME, RESULT_FRAME), stderr: '', exitCode: 0 })
    const outcome = await adapterFor(port).runTurn({ prompt: 'next', cwd: '/tmp', providerSessionId: 'prev-session' })
    const argv = port.calls[0]?.argv ?? []
    expect(argv[argv.indexOf('--resume') + 1]).toBe('prev-session')
    expect(outcome.providerSessionId).toBe(SESSION_ID)
  })

  it('maps a recorded unauthenticated stream to auth-required without leaking its text', async () => {
    const outcome = await adapterFor(scriptedPort({ stdout: AUTH_FRAME_LINES.join('\n'), stderr: '', exitCode: 0 }))
      .runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(failureCode(outcome)).toBe('auth-required')
    expect(outcome.result).toBe('')
    expect(outcome.result).not.toContain('Not logged in')
  })

  it('reports session-unresumable instead of silently starting a fresh conversation', async () => {
    const frames = stream({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: '11111111-2222-3333-4444-555555555555',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    const outcome = await adapterFor(scriptedPort({ stdout: frames, stderr: 'No conversation found with session ID: x', exitCode: 0 }))
      .runTurn({ prompt: 'hi', cwd: '/tmp', providerSessionId: 'gone-session' })
    expect(failureCode(outcome)).toBe('session-unresumable')
  })

  it('treats an exit-0 turn with no result frame as failed and keeps the exit facts', async () => {
    const outcome = await adapterFor(scriptedPort({ stdout: '', stderr: 'Error: Input must be provided', exitCode: 0 }))
      .runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(outcome.status).toBe('failed')
    expect(failureCode(outcome)).toBe('provider-error')
    expect(outcome.result).toContain('exit 0')
    expect(outcome.result).toContain('Input must be provided')
  })

  it('maps a limit subtype to limit', async () => {
    const frames = stream(INIT_FRAME, { ...RESULT_FRAME, is_error: true, subtype: 'error_max_turns', result: '' })
    const outcome = await adapterFor(scriptedPort({ stdout: frames, stderr: '', exitCode: 0 })).runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(failureCode(outcome)).toBe('limit')
  })

  it('resolves a host spawn rejection as a failed turn rather than throwing', async () => {
    const outcome = await adapterFor(scriptedPort({
      stdout: '',
      stderr: '',
      exitCode: null,
      spawnFailure: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
    })).runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(outcome.status).toBe('failed')
    expect(failureCode(outcome)).toBe('provider-error')
    expect(outcome.result).toContain('ENOENT')
  })

  it('reports an aborted turn as aborted and keeps the session id', async () => {
    const controller = new AbortController()
    const port = scriptedPort({ stdout: stream(INIT_FRAME, RESULT_FRAME), stderr: '', exitCode: null, signal: 'SIGTERM' })
    const adapter = adapterFor(port)
    controller.abort()
    const outcome = await adapter.runTurn({ prompt: 'hi', cwd: '/tmp', signal: controller.signal })
    expect(outcome.status).toBe('aborted')
    expect(outcome.providerSessionId).toBe(SESSION_ID)
  })
})

/**
 * Real process port for the gated CLI test.
 *
 * Same shape as the host port, with the host's credential scrub applied, so the
 * injected environment is the only credential source the child can see. It also
 * mirrors the host's accumulation semantics: `readFrom(0)` always returns the
 * whole stream collected so far.
 *
 * `extraEnv` lets the gated test point the CLI's config directory at a writable
 * temp path. A transcript has to land somewhere the process may write, and that
 * directory is the only variable here: the adapter under test is untouched.
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
      const search = (env?.PATH ?? process.env.PATH ?? '').split(delimiter)
      for (const directory of search) {
        if (directory.length === 0) continue
        const candidate = join(directory, command)
        if (isExecutable(candidate)) return candidate
      }
      return null
    },
    spawn(spec) {
      const scrubbed: NodeJS.ProcessEnv = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (/TOKEN|KEY|SECRET|PASSWORD/i.test(key)) continue
        scrubbed[key] = value
      }
      Object.assign(scrubbed, extraEnv, spec.env ?? {})
      const child = spawnProcess(spec.argv[0] as string, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: scrubbed,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: spec.signal,
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', chunk => { stdout += String(chunk) })
      child.stderr?.on('data', chunk => { stderr += String(chunk) })
      const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
        child.on('error', error => reject(error))
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      const reader = (read: () => string) => ({
        readFrom: (fromByte: number) => {
          const full = read()
          return { text: full.slice(fromByte), nextOffset: full.length, lossy: false }
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

const REAL_CLI = process.env.DSH_EXT_SESSION_REAL_CLI === '1'
const CLAUDE_BIN = process.env.DSH_EXT_SESSION_CLAUDE_BIN ?? join(process.env.HOME ?? '', '.local', 'bin', 'claude')
const PROBE_TOKEN = 'READY-3f7'
const PROBE_NUMBER = '42'
const PROBE_DIR = join(tmpdir(), 'dsh-ext-session-real-cli')
const PROBE_FILE = join(PROBE_DIR, 'e1-probe.txt')
/** CLI config directory: transcripts must be writable for `--resume` to exist. */
const PROBE_CONFIG_DIR = process.env.DSH_EXT_SESSION_CLAUDE_CONFIG_DIR ?? join(PROBE_DIR, 'claude-config')

/** Real-turn deps: the CLI's own settings, a real clock and the design grace. */
function realDeps(): ExternalAdapterDeps {
  return {
    process: realPort({ CLAUDE_CONFIG_DIR: PROBE_CONFIG_DIR }),
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
  }
}

describe('real process port resolution', () => {
  it('resolves a configured absolute path and reports a missing binary as null', async () => {
    const port = realPort()
    await expect(port.resolveExecutable('/nonexistent/claude')).resolves.toBeNull()
    await expect(port.resolveExecutable('claude', { PATH: '/nonexistent' })).resolves.toBeNull()
    if (existsSync(CLAUDE_BIN)) await expect(port.resolveExecutable(CLAUDE_BIN)).resolves.toBe(CLAUDE_BIN)
  })
})

describe.skipIf(!REAL_CLI)('claude adapter against the real CLI', () => {
  it('writes a file, reads it back, then resumes the conversation and recovers a remembered number', async () => {
    expect(existsSync(CLAUDE_BIN)).toBe(true)
    rmSync(PROBE_DIR, { recursive: true, force: true })
    mkdirSync(PROBE_DIR, { recursive: true })
    const adapter = createClaudeAdapter(realDeps(), { bin: CLAUDE_BIN })

    const first = await adapter.runTurn({
      prompt: `Write the file ${PROBE_FILE} whose exact content is the single line ${PROBE_TOKEN}. `
        + `Then run: cat ${PROBE_FILE}. `
        + `Also remember the number ${PROBE_NUMBER} for my next message. Answer with the file content only.`,
      cwd: PROBE_DIR,
    })
    expect(first.status).toBe('completed')
    expect(existsSync(PROBE_FILE)).toBe(true)
    expect(readFileSync(PROBE_FILE, 'utf8').trim()).toBe(PROBE_TOKEN)
    expect(first.result).toContain(PROBE_TOKEN)
    expect(first.providerSessionId).toBeTruthy()
    expect(first.usage?.input).toBeGreaterThan(0)
    expect(first.costUsd).toBeGreaterThan(0)
    expect(first.durationMs).toBeGreaterThan(0)

    const second = await adapter.runTurn({
      prompt: 'What number did I ask you to remember? Reply with the number only.',
      cwd: PROBE_DIR,
      providerSessionId: first.providerSessionId,
    })
    expect(second.status).toBe('completed')
    expect(second.result).toContain(PROBE_NUMBER)
    expect(second.providerSessionId).toBe(first.providerSessionId)
    expect(second.durationMs).toBeGreaterThan(0)
  }, 240_000)

  it('reports session-unresumable for a conversation id the CLI does not have', async () => {
    expect(existsSync(CLAUDE_BIN)).toBe(true)
    mkdirSync(PROBE_DIR, { recursive: true })
    const adapter = createClaudeAdapter(realDeps(), { bin: CLAUDE_BIN })
    const outcome = await adapter.runTurn({
      prompt: 'Say OK.',
      cwd: PROBE_DIR,
      providerSessionId: '1f000000-0000-4000-8000-000000000000',
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.status === 'failed' ? outcome.error?.code ?? '' : '').toBe('session-unresumable')
    // The false continuation must never be papered over with a fresh session.
    expect(outcome.status === 'failed' ? outcome.error?.message ?? '' : '').toContain('no CLI conversation id')
  }, 120_000)
})
/**
 * The non-blocking contract against the real CLI.
 *
 * The defect these pin is measured, not hypothetical: a delegation blocked the
 * caller for the turn's whole runtime, and a cancelled turn answered with an
 * empty string because only the terminal frame was ever read. Both are checked
 * here against `claude` itself, not a scripted double.
 */
describe.skipIf(!REAL_CLI)('claude adapter: live progress and partial text', () => {
  it('publishes frames while the turn is still running', async () => {
    const adapter = createClaudeAdapter(realDeps(), { bin: CLAUDE_BIN })
    const seen: Array<{ frames: number; chars: number }> = []
    const outcome = await adapter.runTurn({
      prompt: 'Reply with exactly this text and nothing else: SMOKE-42',
      cwd: PROBE_DIR,
      report: progress => { seen.push({ frames: progress.frames, chars: progress.chars }) },
    })
    expect(outcome.status).toBe('completed')
    expect(outcome.result).toContain('SMOKE-42')
    // Progress is the liveness signal a polling caller judges a slow turn by:
    // without it a running dispatch is indistinguishable from a dead one.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]?.frames).toBeGreaterThan(0)
  }, 120_000)

  it('returns the text it had already produced when the caller aborts', async () => {
    const adapter = createClaudeAdapter(realDeps(), { bin: CLAUDE_BIN })
    const controller = new AbortController()
    let aborted = false
    const outcome = await adapter.runTurn({
      prompt: 'Write about 700 words on the history of the JSON Lines format. Then print DONE.',
      cwd: PROBE_DIR,
      signal: controller.signal,
      report: progress => {
        // Abort once the model has written something and before the CLI settles:
        // that is the window in which the old code answered with an empty string.
        if (!aborted && progress.chars > 0) {
          aborted = true
          controller.abort(new Error('test abort'))
        }
      },
    })
    expect(outcome.status).toBe('aborted')
    // The answer text survives the cancellation; an empty string here is the defect.
    expect(outcome.result.length).toBeGreaterThan(0)
    expect(outcome.partial === true || outcome.result.length > 0).toBe(true)
  }, 120_000)
})
