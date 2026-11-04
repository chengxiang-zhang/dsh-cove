/**
 * The provider adapter contract, and the process seam it runs on.
 *
 * An adapter owns everything that differs between Claude Code and Codex: which
 * binary to resolve, how one turn is launched, how the CLI's event stream is
 * decoded, and which of the eight error codes a CLI failure maps to. The engine
 * owns everything that is the same for both: session records, the concurrency
 * gate, cancellation bookkeeping and persistence. The two meet at this file and
 * nowhere else, so a new CLI is one new adapter and no engine change.
 *
 * The process seam is a narrow port rather than `ctx.subprocess` directly: the
 * host implements it over the real subprocess service, and tests implement it
 * with a scripted handle, so concurrency, cancellation and failure mapping are
 * all exercisable without launching a CLI.
 *
 * Two decisions are deliberately absent from the contract because the design
 * pins them for every provider: the permission mode is `auto` (§9 — `dontAsk`
 * would refuse every unprompted action), and the cancellation ladder is
 * `SIGTERM → grace → SIGKILL` on the process group (§10), expressed as the
 * `graceMs` an adapter must pass through to its spawn.
 *
 * "Auto" is each CLI's own equivalent rather than one shared flag: Claude Code
 * takes `--permission-mode auto`, while Codex reaches an unattended run through
 * `--approve-for-me` on the first turn and then inherits the thread's recorded
 * policy on `codex exec resume`, whose subcommand accepts no approval or sandbox
 * arguments. A resumed Codex session therefore runs under the permission the
 * first turn established.
 *
 * One consequence of both CLIs' behaviour is visible in this contract: an exit
 * code is not a verdict. An unauthenticated run, a rejected argv and a failed
 * resume all exit 0 on Claude Code, so an adapter decides the outcome from the
 * event stream and reports the code that fits, which is what `provider-error`
 * exists for when nothing else matches.
 * @module dsh-web-all/core/external-session/adapters
 */
import type { ExternalError } from './errors.ts'
import type { ExternalProvider, ExternalTurnStatus, ExternalUsage } from './types.ts'

/** Exit facts of one CLI process. */
export interface ExternalProcessOutcome {
  exitCode: number | null
  signal: string | null
}

/**
 * One incremental read of a captured stream.
 *
 * Offsets are whole-stream byte coordinates owned by the caller, so `readFrom`
 * never advances a cursor of its own: reading `0` twice yields the same text,
 * and reading `nextOffset` continues. That is what lets a long turn be parsed
 * while it runs and re-read whole once it exits.
 */
export interface ExternalOutputRead {
  /** Stream text from the requested offset. */
  text: string
  /** Whole-stream offset to resume from. */
  nextOffset: number
  /** True when the requested offset slid out of the retained window. */
  lossy: boolean
}

/** Offset-based reader for one captured stream. */
export interface ExternalOutputReader {
  readFrom(fromByte: number): ExternalOutputRead
}

/** One spawn request. Every field is explicit; the port applies no defaults. */
export interface ExternalSpawnSpec {
  /** Executable and arguments; `argv[0]` is the program. Never shell-interpreted. */
  argv: readonly string[]
  cwd: string
  /**
   * Grace the termination ladder gives the process group between `SIGTERM` and
   * `SIGKILL`. The host fills in the configured cancellation grace; an adapter
   * must pass it through unchanged.
   */
  graceMs: number
  /**
   * Explicit environment entries layered after the host's credential scrub.
   * This is how a CLI receives the credentials its own settings hold.
   */
  env?: Readonly<Record<string, string | undefined>>
  /** Aborting starts the same termination ladder as `terminate()`. */
  signal?: AbortSignal
  stdoutMaxBytes: number
  stderrMaxBytes: number
}

/** A live CLI process and the provider-managed process group behind it. */
export interface ExternalProcessHandle {
  /** Resolves with exit facts; rejects when the spawn itself failed. */
  readonly done: Promise<ExternalProcessOutcome>
  /** Collected streams, readable while the process runs and after it exits. */
  readonly collected: {
    readonly stdout?: ExternalOutputReader
    readonly stderr?: ExternalOutputReader
  }
  /** Begin the termination ladder on the managed process group. Idempotent. */
  terminate(): void
  /** Resolve once the managed group is empty, not merely the top-level process. */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

/**
 * The host's process capabilities, as an adapter sees them.
 *
 * `resolveExecutable` is the provider's execution world, so a configured
 * absolute path is verified and a bare name is looked up on the scrubbed PATH.
 * It resolves to null instead of throwing so a missing CLI is an ordinary
 * `provider-missing` rather than an exception path.
 */
export interface ExternalProcessPort {
  spawn(spec: ExternalSpawnSpec): ExternalProcessHandle
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>): Promise<string | null>
}

/**
 * Inputs an adapter needs from the host, injected rather than reached for, so a
 * test can script a turn and freeze a clock.
 */
export interface ExternalAdapterDeps {
  readonly process: ExternalProcessPort
  /**
   * Read a UTF-8 text file, or null when it does not exist. Adapters read the
   * CLI's own settings through this, which is why no credential crosses this
   * contract.
   */
  readonly readTextFile: (path: string) => Promise<string | null>
  /** Home directory holding the CLI's own settings. */
  readonly homeDir: string
  /** Millisecond clock used to report `durationMs`; tests pin it. */
  readonly now: () => number
  /** Configured `SIGTERM → SIGKILL` grace for one cancelled turn. */
  readonly cancelGraceMs: number
}

/** Per-provider settings the host resolves before an adapter is built. */
export interface ExternalAdapterConfig {
  /** Binary to resolve: the configured override, else the design default. */
  readonly bin: string
}

/** One turn handed to an adapter. */
export interface TurnRequest {
  /** The prompt as the caller submitted it. */
  prompt: string
  cwd: string
  /**
   * CLI conversation id to continue. Absent means start a new CLI
   * conversation; the engine is what decides a continuation is legal.
   */
  providerSessionId?: string
  /** Aborting cancels this turn. */
  signal?: AbortSignal
}

/** Fields every settled turn reports. */
export interface TurnOutcomeBase {
  /** Final text of the turn; a diagnostic summary when the turn failed. */
  result: string
  /**
   * CLI conversation id for the next turn. Absent when the CLI did not report
   * one, which the engine turns into `session-unresumable` for later turns.
   */
  providerSessionId?: string
  durationMs: number
  usage?: ExternalUsage
  /** The CLI's own price-table estimate. Never a bill. */
  costUsd?: number
}

/**
 * How one turn ended.
 *
 * The union is discriminated so the engine must handle every ending, and a
 * cancellation is its own status rather than being folded into failure — the
 * design keeps a cancelled session continuable and counts its turn as
 * `aborted`.
 *
 * A failed turn's `error` is optional on purpose. The eight codes cover the
 * conditions a caller can act on; an ordinary non-zero exit that matches none of
 * them is still a `failed` turn whose diagnostics belong to the host log rather
 * than to the model. Requiring a code would force adapters to invent one.
 */
export type TurnOutcome =
  | (TurnOutcomeBase & { status: Extract<ExternalTurnStatus, 'completed'> })
  | (TurnOutcomeBase & { status: Extract<ExternalTurnStatus, 'aborted'> })
  | (TurnOutcomeBase & { status: Extract<ExternalTurnStatus, 'failed'>; error?: ExternalError })

/** What one provider must implement. */
export interface ExternalAdapter {
  readonly provider: ExternalProvider
  /**
   * Resolve this adapter's binary in the host's execution world.
   * @returns the resolved path, or null when the CLI is not installed here.
   */
  resolveExecutable(): Promise<string | null>
  /**
   * Run exactly one turn: one child process from start to exit.
   *
   * Must not throw for an expected CLI failure — an unauthenticated CLI, a
   * non-zero exit or a cancellation all resolve as a `TurnOutcome`, so the
   * engine's failure accounting stays in one place. Throwing is reserved for
   * programming errors.
   */
  runTurn(request: TurnRequest): Promise<TurnOutcome>
}

/** Factory shape each provider module exports. */
export type ExternalAdapterFactory = (deps: ExternalAdapterDeps, config: ExternalAdapterConfig) => ExternalAdapter

/** The code a failed turn reports, or null for any other ending. */
export function turnOutcomeError(outcome: TurnOutcome): ExternalError | null {
  return outcome.status === 'failed' ? outcome.error ?? null : null
}

/**
 * Whether a turn produced a usable CLI conversation id.
 * @param outcome - the settled turn.
 * @returns the id, or undefined when the CLI reported none.
 */
export function outcomeSessionId(outcome: TurnOutcome): string | undefined {
  const id = outcome.providerSessionId
  return typeof id === 'string' && id !== '' ? id : undefined
}