/**
 * Mutual-exclusion check against the native external subagent providers.
 *
 * Two paths to the same CLI is the failure this check exists for: the native
 * `@deepseek-ai/dsh-subagent-claude-code` provider and this capability would
 * both spawn the same binary, both bill the same account, and a model or a user
 * could pick either. The design therefore refuses to start while a native
 * external provider is still registered, and names the switch to turn off.
 *
 * The probe is structural on purpose. `@deepseek-ai/dsh-subagent` is not a
 * dependency of this package, so `subagents` cannot be imported as a type — and
 * more importantly, a host that simply does not have that service is a valid
 * deployment, not a failure. Absence therefore passes, a shape this build does
 * not recognize passes, and only a positive identification of `claude-code` or
 * `codex` refuses.
 * @module dsh-web-all/host/services/external-session/mutex
 */
import type { Context } from '@deepseek-ai/cordis'

/** Subagent provider names the native external plugins register. */
export const NATIVE_SUBAGENT_PROVIDERS: readonly string[] = ['claude-code', 'codex']

/** Settings lines that toggle the native external providers. */
const TOGGLE_HINT = 'Turn off the native external subagent providers '
  + '(the `tool-subagent-claude-code` and `tool-subagent-codex` rows in the DSH profile, or the two '
  + 'external-provider switches in Settings) and reload; the external-session capability already '
  + 'provides those CLIs, and running both would spawn the same binary twice.'

/** One positive identification. */
export interface NativeProviderConflict {
  /** Provider names found in the subagent registry. */
  providers: string[]
}

type ContextWithGet = Context & { get?: (id: string, strict?: boolean) => unknown }

interface SubagentsLike {
  list?: () => unknown
}

/** Optional service lookup that never throws. */
function optionalService<T>(ctx: Context, name: string): T | undefined {
  const get = (ctx as ContextWithGet).get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, name, false) as T | undefined
  } catch {
    return undefined
  }
}

/** Provider names out of one registry entry: a string or an object naming itself. */
function providerName(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as { name?: unknown; provider?: unknown }
  if (typeof record.provider === 'string') return record.provider
  if (typeof record.name === 'string') return record.name
  return null
}

/**
 * Identify native external providers still registered on this host.
 *
 * Never throws and never guesses: an unreadable registry reads as no conflict,
 * because refusing to start on an inspection failure would take the whole entity
 * down over something the user cannot act on.
 * @param ctx - the context the service is mounting on.
 * @returns the identified providers, empty when the path is free.
 */
export function findNativeProviderConflict(ctx: Context): NativeProviderConflict {
  const subagents = optionalService<SubagentsLike>(ctx, 'subagents')
  if (subagents === undefined || typeof subagents.list !== 'function') return { providers: [] }
  let entries: unknown
  try {
    entries = subagents.list()
  } catch {
    return { providers: [] }
  }
  if (!Array.isArray(entries)) return { providers: [] }
  const found = new Set<string>()
  for (const entry of entries) {
    const name = providerName(entry)
    if (name !== null && NATIVE_SUBAGENT_PROVIDERS.includes(name)) found.add(name)
  }
  return { providers: [...found] }
}

/** The message an operator needs to fix the conflict. */
export function describeConflict(conflict: NativeProviderConflict): string {
  return `[web-all] external-session refuses to mount: the native external subagent provider(s) `
    + `${conflict.providers.join(', ')} are still registered. ${TOGGLE_HINT}`
}

/**
 * Refuse to mount while a native external provider is registered.
 * @param ctx - the context the service is mounting on.
 * @throws with an operator-facing message naming the switches when a conflict exists.
 */
export function assertNoNativeProvider(ctx: Context, onWarning?: (message: string) => void): void {
  let conflict: NativeProviderConflict
  try {
    conflict = findNativeProviderConflict(ctx)
  } catch (error) {
    // A probe that cannot answer is not a conflict; report it and carry on so a
    // host without the subagent service still gets its session store.
    onWarning?.(`[web-all] external-session could not inspect the subagent registry: ${String(error)}`)
    return
  }
  if (conflict.providers.length > 0) throw new Error(describeConflict(conflict))
}