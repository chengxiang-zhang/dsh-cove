/**
 * Host-side criterion verification for the desk chain (13 验收, 10 验证执行隔离).
 *
 * An executor's `ready` report is a candidate, and a green exit code inside the
 * executor's own session does not prove the verdict is uncontaminated. The host
 * therefore re-runs the criterion itself: the command `done_when` names, in an
 * isolated child with a minimal environment, a wall-clock limit and an output cap.
 *
 * Because the command text can come from a model, only a single read-only command is
 * ever run: no chaining, redirection, substitution or shell program, and no program
 * that can execute code or write. Anything else is refused by name and the verdict
 * becomes `inconclusive` — never `pass`.
 */

import { spawn } from 'node:child_process'

/** One criterion run as the host observed it. */
export interface CriterionRun {
  command: string
  /** Exit code the criterion names. */
  expectedExit: number
  /** Exit code the host observed, or null when the command never ran. */
  actualExit: number | null
  stdout: string
  stderr: string
  /** Why the host refused or failed to run it; present only when it did not run. */
  refused?: string
}

export type CriterionVerdictKind = 'pass' | 'fail' | 'inconclusive'

export interface CriterionVerdict {
  verdict: CriterionVerdictKind
  run: CriterionRun
  /** One line for the journal: what the host saw, or why it could not check. */
  note: string
}

/** Runs one already-vetted argv. Injected so tests never spawn a real process. */
export interface CommandRunner {
  run(argv: string[], cwd: string, timeoutMs: number): Promise<{ exit: number | null; stdout: string; stderr: string }>
}

/** Read-only programs. Anything that can execute code or write is absent on purpose. */
const PROGRAMS: ReadonlySet<string> = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'cut', 'sort',
  'uniq', 'tr', 'stat', 'file', 'find', 'md5', 'md5sum', 'sha256sum', 'shasum', 'jq', 'echo', 'pwd',
  'basename', 'dirname', 'realpath', 'diff', 'comm', 'xxd', 'od', 'du', 'df', 'date', 'which', 'git',
])

/** `git` subcommands that only read; the rest are refused by name. */
const GIT_READ_ONLY: ReadonlySet<string> = new Set([
  'status', 'log', 'show', 'diff', 'rev-parse', 'ls-files', 'branch', 'remote', 'blame', 'describe',
  'cat-file', 'grep', 'shortlog', 'tag',
])

/** `git config` reads with these flags and writes without them. */
const GIT_CONFIG_READ: ReadonlySet<string> = new Set(['--get', '--get-all', '--get-regexp', '-l', '--list'])

/** `find` predicates that write or execute. */
const FIND_DENIED: ReadonlySet<string> = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls',
])

export type ParsedCommand = { argv: string[] } | { refused: string }

/** Shell syntax the host never interprets: it would hide what actually runs. */
const SHELL_SYNTAX = /[;|&<>`\n\r]/

/**
 * Splits one command line into argv without a shell, then checks it against the
 * read-only policy. Quotes group words; a metacharacter inside quotes is data, so
 * `grep -c '| A '` is a pattern, while the same character outside quotes is chaining.
 */
export function parseCriterion(command: string): ParsedCommand {
  const text = command.trim()
  if (text === '') return { refused: 'empty command' }
  const chars = Array.from(text)
  const argv: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] as string
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '$' && chars[i + 1] === '(') {
      return { refused: 'chaining, redirection, globbing and substitution are not checked' }
    }
    if (SHELL_SYNTAX.test(char)) {
      return { refused: 'chaining, redirection, globbing and substitution are not checked' }
    }
    if (/\s/.test(char)) {
      if (current !== '') {
        argv.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (quote !== undefined) return { refused: 'unbalanced quote' }
  if (current !== '') argv.push(current)
  if (argv.length === 0) return { refused: 'empty command' }
  const program = argv[0] as string
  if (!PROGRAMS.has(program)) return { refused: `${program} is not a read-only program` }
  if (program === 'git') {
    const sub = argv[1] ?? ''
    if (!GIT_READ_ONLY.has(sub)) return { refused: `git ${sub === '' ? '(none)' : sub} is not a read-only subcommand` }
    if (sub === 'config' && !argv.slice(2).some(arg => GIT_CONFIG_READ.has(arg))) {
      return { refused: 'git config without a read flag can write' }
    }
  }
  if (program === 'find' && argv.some(arg => FIND_DENIED.has(arg))) {
    return { refused: 'find predicates that write or execute are not checked' }
  }
  return { argv }
}

/** The real runner: no shell, a fixed minimal environment, a hard time and output cap. */
export function createSpawnRunner(): CommandRunner {
  return {
    run(argv, cwd, timeoutMs) {
      return new Promise((resolve) => {
        const child = spawn(argv[0] as string, argv.slice(1), {
          cwd,
          env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const stdout: Buffer[] = []
        let stdoutBytes = 0
        let stderr = ''
        let done = false
        const finish = (exit: number | null): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve({ exit, stdout: Buffer.concat(stdout).toString('utf8').slice(0, 65_536), stderr: stderr.slice(-8_192) })
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          finish(null)
        }, timeoutMs)
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBytes += chunk.length
          if (stdoutBytes <= 262_144) stdout.push(chunk)
          else {
            child.kill('SIGKILL')
            finish(null)
          }
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-8_192)
        })
        child.once('error', () => finish(null))
        child.once('close', (code) => finish(code))
      })
    },
  }
}

export interface CriterionVerifier {
  /** Re-runs the criterion's command and compares its exit code. */
  verify(command: string, expectedExit: number, cwd: string): Promise<CriterionVerdict>
}

export function createCriterionVerifier(deps: { runner?: CommandRunner; timeoutMs?: number } = {}): CriterionVerifier {
  const runner = deps.runner ?? createSpawnRunner()
  const timeoutMs = deps.timeoutMs ?? 15_000
  return {
    async verify(command, expectedExit, cwd) {
      const parsed = parseCriterion(command)
      if ('refused' in parsed) {
        return { verdict: 'inconclusive', run: { command, expectedExit, actualExit: null, stdout: '', stderr: '', refused: parsed.refused }, note: `criterion not checkable: ${parsed.refused}` }
      }
      const result = await runner.run(parsed.argv, cwd, timeoutMs)
      const run: CriterionRun = { command, expectedExit, actualExit: result.exit, stdout: result.stdout, stderr: result.stderr }
      if (result.exit === null) return { verdict: 'fail', run, note: 'criterion command did not finish' }
      if (result.exit === expectedExit) return { verdict: 'pass', run, note: `criterion exited ${expectedExit}` }
      return { verdict: 'fail', run, note: `criterion exited ${String(result.exit)}, expected ${expectedExit}` }
    },
  }
}