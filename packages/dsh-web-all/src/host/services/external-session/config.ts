/**
 * Configuration for the external-session service domain.
 *
 * The defaults are the design's numbers, not tuning knobs: two concurrent
 * turns, a hundred retained sessions, and a three-second grace between `SIGTERM`
 * and `SIGKILL`. The only deployment-specific values are the two binary names,
 * because a CLI installed somewhere outside PATH must be named explicitly — the
 * design forbids guessing another location for a missing binary.
 * @module dsh-web-all/host/services/external-session/config
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExternalModelOption, ExternalProvider } from '../../../core/external-session/types.ts'

/** Store file name inside the DSH home directory. */
export const EXTERNAL_SESSION_STORE_FILE = 'dsh-external-session.json'

/** Defaults stated by the design. */
export const EXTERNAL_SESSION_DEFAULTS = {
  /** Turns running at once across every session. */
  maxConcurrentTurns: 2,
  /** Sessions the store keeps before new ones are refused. */
  maxSessions: 100,
  /** Grace the `SIGTERM → SIGKILL` ladder gives one cancelled turn. */
  cancelGraceMs: 3_000,
  /** Binary names resolved through the configured override, then PATH. */
  claudeBin: 'claude',
  codexBin: 'codex',
} as const

/** One provider's delegation-tool surface. */
export interface ExternalDelegationConfig {
  /** Whether this provider's delegation tool is registered. Defaults to true. */
  enabled?: boolean
  /**
   * Model the tool runs on when the caller omits `model`. Absent leaves the choice
   * to the CLI's own configured model.
   */
  default?: string
  /**
   * Models the tool may select at call time, in the order the model should weigh
   * them. Empty leaves the choice to the CLI's own configured model.
   */
  models?: ExternalModelOption[]
}

/** Deployment overrides; every field falls back to {@link EXTERNAL_SESSION_DEFAULTS}. */
export interface ExternalSessionConfig {
  /** Maximum turns running at once across all sessions. */
  maxConcurrentTurns?: number
  /** Maximum sessions retained in the store file. */
  maxSessions?: number
  /** Grace between `SIGTERM` and `SIGKILL` for a cancelled turn. */
  cancelGraceMs?: number
  /** Claude Code binary: an absolute path or a name resolved on PATH. */
  claudeBin?: string
  /** Codex binary: an absolute path or a name resolved on PATH. */
  codexBin?: string
  /** Store file path; defaults to `<dshHome>/dsh-external-session.json`. */
  storePath?: string
  /** Delegation-tool surface; one entry per provider, both enabled by default. */
  tools?: { claude?: ExternalDelegationConfig; codex?: ExternalDelegationConfig }
}

/** Configuration with every value decided. */
export interface ResolvedExternalSessionConfig {
  maxConcurrentTurns: number
  maxSessions: number
  cancelGraceMs: number
  claudeBin: string
  codexBin: string
  storePath: string
  /** Decided delegation surface, one entry per provider. */
  delegation: Record<ExternalProvider, { enabled: boolean; models: ExternalModelOption[]; default?: string }>
}

/** The DSH home directory this deployment uses. */
export function resolveDshHome(dshHome?: string): string {
  return dshHome ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

/**
 * Decide every configuration value.
 * @param config - deployment overrides.
 * @param dshHome - DSH home directory; defaults to `$DSH_HOME` or `~/.dsh`.
 * @returns the resolved configuration.
 */
export function resolveExternalSessionConfig(
  config: ExternalSessionConfig = {},
  dshHome?: string,
): ResolvedExternalSessionConfig {
  return {
    maxConcurrentTurns: positiveInteger(config.maxConcurrentTurns, EXTERNAL_SESSION_DEFAULTS.maxConcurrentTurns),
    maxSessions: positiveInteger(config.maxSessions, EXTERNAL_SESSION_DEFAULTS.maxSessions),
    cancelGraceMs: positiveInteger(config.cancelGraceMs, EXTERNAL_SESSION_DEFAULTS.cancelGraceMs),
    claudeBin: nonEmpty(config.claudeBin, EXTERNAL_SESSION_DEFAULTS.claudeBin),
    codexBin: nonEmpty(config.codexBin, EXTERNAL_SESSION_DEFAULTS.codexBin),
    storePath: resolve(config.storePath ?? join(resolveDshHome(dshHome), EXTERNAL_SESSION_STORE_FILE)),
    delegation: {
      claude: delegationOf(config.tools?.claude),
      codex: delegationOf(config.tools?.codex),
    },
  }
}

/** The configured binary for one provider. */
export function binaryFor(config: ResolvedExternalSessionConfig, provider: ExternalProvider): string {
  return provider === 'claude' ? config.claudeBin : config.codexBin
}

/** Decide one provider's delegation surface. */
function delegationOf(config: ExternalDelegationConfig | undefined): { enabled: boolean; models: ExternalModelOption[]; default?: string } {
  const models = Array.isArray(config?.models)
    ? config.models.filter(option => typeof option?.id === 'string' && option.id.trim() !== '')
      .map(option => ({ id: option.id.trim(), description: typeof option.description === 'string' ? option.description : '' }))
    : []
  const chosen = typeof config?.default === 'string' ? config.default.trim() : ''
  return { enabled: config?.enabled !== false, models, ...chosen === '' ? {} : { default: chosen } }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function nonEmpty(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}