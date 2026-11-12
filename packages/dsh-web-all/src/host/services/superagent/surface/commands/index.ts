/**
 * Host commands: the five entry points a person drives from a terminal (02, 09).
 *
 * A command is a thin dispatcher over facts other modules own. It parses
 * arguments, calls one injected function, maps the outcome to an exit code and
 * renders a short text form next to the JSON one. It never writes the ledger
 * itself: `stop` reaches the judgment module's release path, `doc add` reaches the
 * memory module's `DocArea`, and `brief --now` reaches the timing module's Brief,
 * all injected by the composition root so that `surface` imports neither.
 *
 * Exit codes are the contract (02, F31): 0 success, 1 failure, 2 argument or IO
 * error, 3 no data. The four values are the only ones any command returns.
 */

import type { IncomingMessage } from 'node:http'
import type { DocIndexRow } from '../../protocol/objects.ts'
import type { LedgerReader } from '../../protocol/db.ts'
import { briefCommand } from './brief.ts'
import { calibrationCommand } from './calibration.ts'
import { docCommand } from './doc.ts'
import { statusCommand } from './status.ts'
import { stopCommand } from './stop.ts'

export const EXIT_OK = 0
export const EXIT_FAIL = 1
export const EXIT_USAGE = 2
export const EXIT_NODATA = 3

export type ExitCode = 0 | 1 | 2 | 3

export const COMMAND_NAMES = ['status', 'stop', 'brief', 'calibration', 'doc'] as const
export type CommandName = (typeof COMMAND_NAMES)[number]

export interface CommandResult {
  /** The machine form; the panel and `--json` read this. */
  json: unknown
  /** The human form; already rendered here so the line cap is one place. */
  text: string
  exitCode: ExitCode
}

export interface Commands {
  run(name: CommandName, args: string[]): Promise<CommandResult>
}

/**
 * The shared access fence as the route family needs it.
 *
 * Declared here rather than next to the routes for two reasons: `surface` may not
 * import the access-trust service (dependency table), and the static fence gate
 * matches a fence call in a route-owning file - keeping the declaration out of
 * that file means only a real call can satisfy the gate, not a type signature.
 */
export interface CommandTrust {
  isTrusted(request: IncomingMessage): boolean
}

/** What the judgment module's release host path reports back. */
export interface ReleaseOutcome {
  ok: boolean
  reason?: 'missing' | 'terminal'
}

/** What the timing module's Brief build-and-submit reports back. */
export interface BriefOutcome {
  body: string
  items: readonly unknown[]
}

/**
 * Everything a command may reach, injected rather than imported.
 *
 * `read` is the ledger reader; the three functions are the owning modules'
 * host paths (`06`'s calibration, `05`'s document area, `09`'s brief).
 */
export interface CommandDeps {
  read: LedgerReader
  now(): number
  /** Which executor transport this process composes; the status probe reads it. */
  runtime?: () => { transport: string; build: string }
  release(commitmentId: string): ReleaseOutcome
  briefNow(): Promise<BriefOutcome | null>
  docs: {
    add(path: string): string
    list(q?: string): DocIndexRow[]
  }
}

export function isCommandName(raw: string): raw is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(raw)
}

/**
 * Builds the dispatcher.
 *
 * `run` is async because `brief --now` builds and submits a message; every other
 * command answers synchronously and is awaited anyway.
 */
export function createCommands(deps: CommandDeps): Commands {
  return {
    async run(name: CommandName, args: string[]): Promise<CommandResult> {
      switch (name) {
        case 'status': return statusCommand(deps, args)
        case 'stop': return stopCommand(deps, args)
        case 'brief': return briefCommand(deps, args)
        case 'calibration': return calibrationCommand(deps, args)
        case 'doc': return docCommand(deps, args)
      }
    },
  }
}

/** A usage error: the caller gets the message it typed wrong, and EXIT_USAGE. */
export function usage(text: string, error: string): CommandResult {
  return { json: { error }, text, exitCode: EXIT_USAGE }
}