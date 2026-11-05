/**
 * Mutual-exclusion check against the native external subagent providers.
 *
 * Two paths to the same CLI is the failure this check exists for: the native
 * `@deepseek-ai/dsh-subagent-claude-code` provider and this capability would
 * both spawn the same binary, both bill the same account, and a model or a user
 * could pick either. The design therefore refuses to start while a native
 * external provider is still registered, and names the switch to turn off.
 *
 * The guard has two phases because one is not enough. {@link assertNoNativeProvider}
 * refuses the mount when a native provider is already registered, and
 * {@link watchNativeProviders} reports one that registers later — the ordering a
 * profile actually ships (this entity mounts before the native bundles) makes the
 * second phase the one that fires.
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

/**
 * Rows that register the native external providers.
 *
 * The probe reads the provider registry, so these rows — not the tool rows —
 * are what a refusal is about. They are named first because turning off only
 * the tool rows leaves the providers registered and the refusal in place, and
 * turning off only the provider rows leaves a tool that can answer nothing but
 * `provider-missing` while holding this capability's tool name.
 */
export const NATIVE_PROVIDER_ROWS: readonly string[] = ['subagent-claude-code', 'subagent-codex']

/** Rows that expose the native tool names over those providers. */
export const NATIVE_TOOL_ROWS: readonly string[] = ['tool-subagent-claude-code', 'tool-subagent-codex']

/** Settings lines that toggle the native external providers. */
const TOGGLE_HINT = 'Turn off the native external subagent providers '
  + `(the ${quoteRows(NATIVE_PROVIDER_ROWS)} provider rows in the DSH profile — or the same rows `
  + 'inside the `@deepseek-ai/dsh-subagent-claude-code` and `@deepseek-ai/dsh-subagent-codex` '
  + `bundle entries — together with the ${quoteRows(NATIVE_TOOL_ROWS)} tool rows) and reload; the `
  + 'external-session capability already provides those CLIs, and running both would spawn the '
  + 'same binary twice.'

/** One positive identification. */
export interface NativeProviderConflict {
  /** Provider names found in the subagent registry. */
  providers: string[]
}

type ContextWithGet = Context & { get?: (id: string, strict?: boolean) => unknown }

type ContextWithOn = Context & { on?: (event: string, listener: (payload: unknown) => void) => (() => void) | undefined }

interface SubagentsLike {
  list?: () => unknown
}

/** Backtick-quoted row list for operator-facing text. */
function quoteRows(rows: readonly string[]): string {
  return rows.map(row => `\`${row}\``).join(' and ')
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

/** The message an operator needs when a native provider arrives after the mount. */
export function describeLateConflict(providers: readonly string[]): string {
  return `[web-all] external-session is mounted, but the native external subagent provider(s) `
    + `${providers.join(', ')} registered afterwards. Both paths to the same CLI are now live: a `
    + 'delegation may spawn the same binary twice and bill the same account twice. '
    + TOGGLE_HINT
}

/**
 * Report native providers that register after this domain mounted.
 *
 * The mount-time probe reads the registry once, so a profile whose bundle order
 * puts the native packages *after* this entity slips past it: the check sees an
 * empty registry, passes, and the native providers appear a moment later. That
 * ordering is what the Web profile actually ships, so the identification has to
 * run a second time on the registration event as well.
 *
 * A late arrival reports instead of unmounting: once the store, the routes and
 * the engine are live, tearing them down because a neighbour arrived later would
 * take away the capability the operator kept. The report is the actionable half.
 * @param ctx - the context the service mounted on.
 * @param onConflict - receives the message once per newly identified provider set.
 * @returns a disposer that stops listening; harmless when the host has no events.
 */
export function watchNativeProviders(
  ctx: Context,
  onConflict: (message: string) => void,
): () => void {
  const on = (ctx as ContextWithOn).on
  if (typeof on !== 'function') return () => {}
  const reported = new Set<string>()
  let dispose: (() => void) | undefined
  try {
    dispose = on.call(ctx, 'subagent/provider-added', payload => {
      const name = providerName(payload)
      if (name === null || !NATIVE_SUBAGENT_PROVIDERS.includes(name) || reported.has(name)) return
      reported.add(name)
      try {
        onConflict(describeLateConflict([name]))
      } catch {
        // Reporting must never become a second failure of the mount.
      }
    })
  } catch {
    return () => {}
  }
  return () => {
    try { dispose?.() } catch { /* tolerant */ }
  }
}