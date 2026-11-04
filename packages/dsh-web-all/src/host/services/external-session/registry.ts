/**
 * Wiring from the host's real capabilities to the adapter contract.
 *
 * The adapters themselves know nothing about Cordis, so this module is the one
 * place that connects them to `ctx.subprocess`, the filesystem and the clock.
 * It also narrows the subprocess service to the port an adapter is allowed to
 * use, which keeps "what an adapter may do to a process" visible in one place.
 * @module dsh-web-all/host/services/external-session/registry
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {
  ExternalAdapter, ExternalAdapterDeps, ExternalProcessHandle, ExternalProcessPort,
} from '../../../core/external-session/adapters.ts'
import type { ExternalProvider } from '../../../core/external-session/types.ts'
import type { ResolvedExternalSessionConfig } from './config.ts'
import { createClaudeAdapter } from './providers/claude.ts'

/**
 * The subprocess service, narrowed to the adapter port.
 *
 * Two translations happen here and nowhere else: a missing executable becomes
 * `null` instead of a throw, so `provider-missing` is an ordinary outcome; and
 * the provider's exit facts are normalized so an adapter never touches a Node
 * signal type.
 */
export function subprocessPort(ctx: Context): ExternalProcessPort {
  const subprocess = ctx.subprocess
  return {
    spawn(spec) {
      const handle = subprocess.spawn({
        argv: [...spec.argv],
        cwd: spec.cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: spec.stdoutMaxBytes },
          stderr: { maxBytes: spec.stderrMaxBytes },
        },
        graceMs: spec.graceMs,
        signal: spec.signal,
        env: spec.env as NodeJS.ProcessEnv | undefined,
      })
      const port: ExternalProcessHandle = {
        done: handle.done.then(outcome => ({ exitCode: outcome.exitCode, signal: outcome.signal ?? null })),
        collected: {
          ...(handle.collected.stdout === undefined
            ? {}
            : { stdout: { readFrom: (offset: number) => handle.collected.stdout!.readFrom(offset) } }),
          ...(handle.collected.stderr === undefined
            ? {}
            : { stderr: { readFrom: (offset: number) => handle.collected.stderr!.readFrom(offset) } }),
        },
        terminate: () => handle.terminate(),
        waitForExit: signal => handle.waitForExit(signal),
      }
      return port
    },
    async resolveExecutable(command) {
      try {
        return await subprocess.resolveExecutable(command)
      } catch {
        return null
      }
    },
  }
}

/** Inputs an adapter receives from this host. */
export function adapterDeps(ctx: Context, config: ResolvedExternalSessionConfig): ExternalAdapterDeps {
  return {
    process: subprocessPort(ctx),
    readTextFile: async (path: string) => {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return null
      }
    },
    homeDir: homedir(),
    now: () => Date.now(),
    cancelGraceMs: config.cancelGraceMs,
  }
}

/**
 * Build every adapter this build ships.
 *
 * Codex has no adapter yet: its row stays disabled in the preset until its
 * adapter passes the codex acceptance run, so this registry holds one provider
 * and a codex call reports `provider-missing` rather than silently re-dispatching.
 * @param ctx - host context.
 * @param config - resolved configuration, supplying the binary overrides.
 * @returns the adapters available on this host.
 */
export function createAdapterRegistry(
  ctx: Context,
  config: ResolvedExternalSessionConfig,
): Partial<Record<ExternalProvider, ExternalAdapter>> {
  const deps = adapterDeps(ctx, config)
  return {
    claude: createClaudeAdapter(deps, { bin: config.claudeBin }),
  }
}