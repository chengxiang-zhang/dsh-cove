/**
 * Host workspace-model manager: owns the workspace-granularity model preset
 * document. Presets are stored in a plugin-own settings namespace
 * (`workspace-model`) as a `{ [canonicalPath]: { provider, model, effort? } }`
 * map, so a single user-editable document is the source of truth across
 * machines and reloads.
 *
 * The settings service is optional: when no settings provider is mounted the
 * manager degrades to an in-memory-only store (model presets still apply for
 * the process lifetime, just not durable) rather than failing to mount.
 * @module dsh-client-ui-worktree/host/workspace-model
 */

import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { familyNamespace, registerFamilyNamespace, updateFamilyNamespace } from '../family-config.ts'
import z from 'schemastery'
import type {
  WorkspaceModelPreset, WorkspacePresetMap,
} from '../../../core/worktree/workspace-model.ts'

/** Settings namespace unique to this plugin. */
export const WORKSPACE_MODEL_NS = 'workspace-model'

/** Schemastery schema for the preset document (a path -> preset map). */
export const WorkspacePresetSchema = z.dict(z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
})).default({}) as unknown as z<WorkspacePresetMap>

/** Face over the settings service the manager talks to (settings optional). */
interface SettingsFace {
  get(): WorkspacePresetMap
  replace(section: WorkspacePresetMap): Promise<void>
}

/** Canonicalize a workspace path for use as a document key. Follows symlinks
 *  via realpath and strips a trailing separator, matching how the workspace
 *  registry records paths and how sessions record `cwd`. The root path `/`
 *  is preserved (and is the only case where stripping the trailing separator
 *  is a no-op, because paths must be non-empty when used as a key). */
export function canonicalWorkspacePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) return path
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch {
    canonical = path.replace(/\\/g, '/')
  }
  // Strip trailing separator(s) but preserve the root.
  const stripped = canonical.replace(/[\\/]+$/, '')
  return stripped === '' ? canonical : stripped
}

registerFamilyNamespace(WORKSPACE_MODEL_NS, WorkspacePresetSchema)

/** Public surface used by `routes.ts` and the agent wiring. */
export class WorkspaceModelManager {
  private settings: SettingsFace | null = null
  private memory = new Map<string, WorkspaceModelPreset>()
  private settingsFiber: { dispose(): void | Promise<void> } | undefined

  dispose(): void {
    this.settings = null
    void this.settingsFiber?.dispose()
    this.settingsFiber = undefined
  }

  /** Optional settings service; safe to call with an unmounted provider. */
  constructor(private readonly ctx: Context) {
    this.installSettings()
  }

  /** Wire the workspace-model namespace to the 0.2 settings document. */
  private installSettings(): void {
    this.settingsFiber = this.ctx.inject(['settings'], (sctx) => {
      const ns = WORKSPACE_MODEL_NS
      this.settings = {
        get: () => (familyNamespace<WorkspacePresetMap>(ns) ?? {}),
        replace: async (section) => {
          await updateFamilyNamespace(sctx, ns, section as unknown as Record<string, unknown>)
        },
      }
      this.seedMemory(this.settings.get())
    })
  }

  /** Replace the in-memory mirror from a resolved document. */
  private seedMemory(map: WorkspacePresetMap): void {
    this.memory = new Map(Object.entries(map ?? {}))
  }

  /** All stored presets keyed by canonical path (read snapshot). */
  list(): Record<string, WorkspaceModelPreset> {
    return Object.fromEntries(this.memory)
  }

  /** The preset for one workspace path, or undefined when none. */
  get(path: string): WorkspaceModelPreset | undefined {
    return this.memory.get(canonicalWorkspacePath(path))
  }

  /** Store a preset for one workspace path. Returns the stored preset. */
  async set(path: string, preset: WorkspaceModelPreset): Promise<WorkspaceModelPreset> {
    const key = canonicalWorkspacePath(path)
    if (this.settings !== null) {
      const next = { ...this.settings.get(), [key]: { ...preset } }
      await this.settings.replace(next)
      this.seedMemory(next)
    } else {
      this.memory.set(key, { ...preset })
    }
    return { ...preset }
  }

  /** Remove a workspace's preset if present. Returns true when removed. */
  async clear(path: string): Promise<boolean> {
    const key = canonicalWorkspacePath(path)
    const existed = this.memory.has(key)
    if (this.settings !== null) {
      const next = { ...this.settings.get() }
      delete next[key]
      await this.settings.replace(next)
      this.seedMemory(next)
    } else {
      this.memory.delete(key)
    }
    return existed
  }
}
