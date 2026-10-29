/**
 * Workspace-scoped model presets: domain types shared between the host
 * half and the browser half. Everything crossing the HTTP boundary lands
 * here first so the JSON contract is one source of truth.
 *
 * The granularity is **workspace**: a preset is keyed by the canonical
 * workspace directory path (the same value the DSH session header records
 * as `cwd` at session creation). Each workspace — a plain directory or a
 * worktree — carries one `{ provider, model, reasoningEffort? }` selection
 * that overrides the session's otherwise-resolved model from its very first
 * request.
 * @module @dsh-cove/dsh-client-ui-worktree/core/workspace-model
 */

/** One workspace's model preset. `reasoningEffort` is adapter-owned and
 *  optional — absent means the selected model's provider default applies. */
export interface WorkspaceModelPreset {
  /** Registered provider route id. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort id, or provider default when absent. */
  reasoningEffort?: string
}

/** The stored document: a map from canonical workspace path to preset. */
export type WorkspacePresetMap = Record<string, WorkspaceModelPreset>

/** A read of one workspace's effective model selection. */
export interface WorkspaceModelView {
  /** Canonical workspace path the preset is keyed by. */
  path: string
  /** Explicit preset when registered; undefined when none. */
  preset?: WorkspaceModelPreset
}

/** Mutation input: set/clear a preset for one canonical workspace path. */
export interface SetWorkspaceModelInput {
  /** Canonical workspace path (the preset key). */
  path: string
  /** The preset to store. */
  preset: WorkspaceModelPreset
}

/** Domain error shape returned over HTTP (status >= 400). */
export interface WorkspaceModelErrorView {
  ok: false
  code: 'bad-request' | 'forbidden'
  message: string
}

/** Discriminated union for HTTP responses. */
export type WorkspaceModelResponse<T = void> =
  | { ok: true; value: T }
  | WorkspaceModelErrorView