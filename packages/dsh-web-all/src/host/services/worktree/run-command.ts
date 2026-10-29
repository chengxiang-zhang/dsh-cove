/**
 * Injectable argv-only command runner for the worktree service.
 *
 * Commands are executed with execFile, never a shell. Keeping this seam small
 * lets route tests assert the exact executable, argv, cwd, and timeout.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RunCommandOptions {
  cwd: string
  timeoutMs: number
  maxBuffer?: number
}

export interface RunCommandResult {
  stdout: string
  stderr: string
}

export type RunCommand = (
  executable: string,
  argv: readonly string[],
  options: RunCommandOptions,
) => Promise<RunCommandResult>

/** Production command runner. Node's execFile passes argv directly to the executable. */
export const runCommand: RunCommand = async (executable, argv, options) => {
  const { stdout, stderr } = await execFileAsync(executable, [...argv], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    windowsHide: true,
  })
  return { stdout, stderr }
}

export interface CommandFailure extends Error {
  code?: string | number
  errno?: number
  killed?: boolean
  signal?: NodeJS.Signals | null
  stdout?: string | Buffer
  stderr?: string | Buffer
}

/** Narrow unknown exec failures without coupling callers to Node's private error type. */
export function commandFailure(error: unknown): CommandFailure | undefined {
  return error instanceof Error ? error as CommandFailure : undefined
}

/** execFile reports timeout as killed/SIGTERM and commonly as code ETIMEDOUT. */
export function isCommandTimeout(error: unknown): boolean {
  const failure = commandFailure(error)
  return failure?.code === 'ETIMEDOUT' || failure?.killed === true || failure?.signal === 'SIGTERM'
}

export function commandFailureText(error: unknown): string {
  const failure = commandFailure(error)
  if (failure === undefined) return String(error)
  const stderr = typeof failure.stderr === 'string' ? failure.stderr : failure.stderr?.toString('utf8')
  const stdout = typeof failure.stdout === 'string' ? failure.stdout : failure.stdout?.toString('utf8')
  return [stderr, stdout, failure.message].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join('\n')
}
