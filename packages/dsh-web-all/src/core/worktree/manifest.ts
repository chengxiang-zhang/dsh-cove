/**
 * Manifest on-disk schema for `<repo>/.dsh/workspaces/manifest.json`. The
 * manifest records every worktree we ever created so the sidebar can
 * recover after the worktree directory is gone (orphan state) and so the
 * workspace registry can re-bind surviving paths. Since v1 it also records
 * PR metadata per worktree so the panel can show merged / not-merged state
 * across restarts.
 *
 * Version history:
 *  - v1: name/path/baseCommit/createdAt/detached per entry.
 *  - v2: adds optional `baseBranch` (repo-level PR target) and per-entry
 *    `prUrl` / `prNumber` / `remoteBranch` / `baseRef` / `updatedAt`.
 *    The reader accepts both versions (v1 entries simply carry no PR
 *    metadata) so an upgraded plugin never trips over an older manifest.
 *    v2 also carries the optional session binding (`sessionId` /
 *    `workspaceId`) and preset outcome used by session-bound lanes; these
 *    are additive optional fields, so the on-disk version stays 2.
 * @module @dsh-cove/dsh-client-ui-worktree/core
 */

import { MANIFEST_FILENAME, WORKSPACE_DIR } from './paths.ts'

/** Persisted entry for one worktree. */
export interface WorktreeManifestEntry {
  /** Branch name (== worktree dir name under `.dsh/workspaces/`). */
  name: string
  /** Absolute path. */
  path: string
  /** Commit the worktree was created from. */
  baseCommit: string
  /** ISO 8601 timestamp. */
  createdAt: string
  /** True when the worktree was created without a branch (detached). */
  detached: boolean
  /** PR page URL once a PR was created through this plugin. */
  prUrl?: string
  /** GitHub PR number when created via the REST API. */
  prNumber?: number
  /** The remote the branch was pushed to (`origin`). */
  remoteBranch?: string
  /** Base branch the PR targets. */
  baseRef?: string
  /** ISO 8601 timestamp of the last PR-related mutation. */
  updatedAt?: string
  /** DSH session bound to this lane (session-bound lanes only). */
  sessionId?: string
  /** DSH workspace id registered for the lane path, when known. */
  workspaceId?: string
  /** Whether the required lane permission preset was applied to its session. */
  permissionPresetApplied?: boolean
}

/** The full manifest file (current on-disk version). */
export interface WorktreeManifest {
  version: 2
  repoPath: string
  /** Repo-level PR target base branch; set on the first pr-create. */
  baseBranch?: string
  worktrees: WorktreeManifestEntry[]
}

/** A parsed manifest in the current (v2) shape; v1 input is normalized. */
export type ParsedWorktreeManifest = WorktreeManifest

/** Empty manifest for a fresh repo. */
export function emptyManifest(repoPath: string): WorktreeManifest {
  return { version: 2, repoPath, worktrees: [] }
}

/**
 * Parse manifest text into the current v2 shape. v1 manifests (or v2 with
 * missing optional fields) are normalized rather than rejected, so an
 * upgraded plugin keeps working with an old manifest. Throws a plain
 * `Error` on shapes that are not a manifest at all — the caller decides
 * how to surface corruption.
 */
export function parseManifest(text: string): ParsedWorktreeManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`worktree manifest is not valid JSON: ${String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('worktree manifest must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const version = record['version']
  if (version !== 1 && version !== 2) {
    throw new Error(`unsupported worktree manifest version: ${JSON.stringify(version)}`)
  }
  if (typeof record['repoPath'] !== 'string') {
    throw new Error('worktree manifest is missing repoPath')
  }
  if (!Array.isArray(record['worktrees'])) {
    throw new Error('worktree manifest is missing the worktrees array')
  }
  const baseBranch = typeof record['baseBranch'] === 'string' ? record['baseBranch'] : undefined
  const worktrees: WorktreeManifestEntry[] = (record['worktrees'] as unknown[]).map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('worktree manifest contains a malformed entry')
    }
    const e = entry as Record<string, unknown>
    for (const field of ['name', 'path', 'baseCommit', 'createdAt'] as const) {
      if (typeof e[field] !== 'string') throw new Error(`worktree manifest entry is missing '${field}'`)
    }
    if (typeof e['detached'] !== 'boolean') {
      throw new Error('worktree manifest entry is missing detached')
    }
    const out: WorktreeManifestEntry = {
      name: e['name'] as string,
      path: e['path'] as string,
      baseCommit: e['baseCommit'] as string,
      createdAt: e['createdAt'] as string,
      detached: e['detached'] as boolean,
    }
    if (typeof e['prUrl'] === 'string') out.prUrl = e['prUrl']
    if (typeof e['prNumber'] === 'number') out.prNumber = e['prNumber']
    if (typeof e['remoteBranch'] === 'string') out.remoteBranch = e['remoteBranch']
    if (typeof e['baseRef'] === 'string') out.baseRef = e['baseRef']
    if (typeof e['updatedAt'] === 'string') out.updatedAt = e['updatedAt']
    if (typeof e['sessionId'] === 'string') out.sessionId = e['sessionId']
    if (typeof e['workspaceId'] === 'string') out.workspaceId = e['workspaceId']
    if (typeof e['permissionPresetApplied'] === 'boolean') {
      out.permissionPresetApplied = e['permissionPresetApplied']
    }
    return out
  })
  return { version: 2, repoPath: record['repoPath'] as string, ...(baseBranch === undefined ? {} : { baseBranch }), worktrees }
}

/** Manifest path = `<repo>/.dsh/workspaces/manifest.json`. */
export function manifestPath(repoPath: string): string {
  return `${repoPath}/${WORKSPACE_DIR}/${MANIFEST_FILENAME}`
}