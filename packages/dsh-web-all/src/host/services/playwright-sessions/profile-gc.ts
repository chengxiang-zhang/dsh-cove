/**
 * Disk GC for per-session Playwright profiles under `sessionsRoot`.
 *
 * Process-level idle eviction already stops Chromium/MCP children; this module
 * reclaims the leftover profile directories (cookies, cache, screenshots) that
 * otherwise grow without bound under `$DSH_HOME/playwright-sessions/`.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizePlaywrightSessionKey } from '../../../core/playwright-sessions/names.ts'

export interface PruneProfilesOptions {
  /** Absolute root that holds one directory per session. */
  sessionsRoot: string
  /**
   * Delete a profile directory when its mtime is older than this many ms.
   * `0` disables age-based pruning.
   */
  maxAgeMs: number
  /** Session ids whose live browsers must not be deleted. */
  keepSessionIds?: Iterable<string>
  /** Optional clock for tests. */
  now?: () => number
}

export interface PruneProfilesResult {
  removed: string[]
  skippedLive: string[]
  errors: string[]
}

/** Resolve the on-disk profile directory for one durable session id. */
export function profileDirFor(sessionsRoot: string, sessionId: string): string {
  return join(sessionsRoot, sanitizePlaywrightSessionKey(sessionId))
}

/** Best-effort recursive remove of one session profile directory. */
export function removeProfileDir(sessionsRoot: string, sessionId: string): boolean {
  const dir = profileDirFor(sessionsRoot, sessionId)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * Delete stale profile directories under `sessionsRoot`.
 *
 * A directory is removed when:
 * - it is a direct child of `sessionsRoot`, and
 * - its mtime is older than `maxAgeMs` (when maxAgeMs > 0), and
 * - its basename is not the sanitized key of any id in `keepSessionIds`.
 */
export function pruneStaleProfiles(options: PruneProfilesOptions): PruneProfilesResult {
  const removed: string[] = []
  const skippedLive: string[] = []
  const errors: string[] = []
  const now = options.now ?? Date.now
  const keep = new Set(
    [...(options.keepSessionIds ?? [])].map((id) => sanitizePlaywrightSessionKey(id)),
  )

  if (!existsSync(options.sessionsRoot)) {
    return { removed, skippedLive, errors }
  }
  if (options.maxAgeMs <= 0) {
    return { removed, skippedLive, errors }
  }

  const cutoff = now() - options.maxAgeMs
  let entries: string[]
  try {
    entries = readdirSync(options.sessionsRoot)
  } catch (err) {
    errors.push(String(err))
    return { removed, skippedLive, errors }
  }

  for (const name of entries) {
    if (keep.has(name)) {
      skippedLive.push(name)
      continue
    }
    const full = join(options.sessionsRoot, name)
    try {
      const st = statSync(full)
      if (!st.isDirectory()) continue
      if (st.mtimeMs >= cutoff) continue
      rmSync(full, { recursive: true, force: true })
      removed.push(name)
    } catch (err) {
      errors.push(`${name}: ${String(err)}`)
    }
  }

  return { removed, skippedLive, errors }
}
