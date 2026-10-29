/**
 * Unit tests for the workspace-model host half: canonical path handling and
 * the manager's store behavior. The manager is exercised WITHOUT the settings
 * service mounted, so it runs in its in-memory degrade mode — exactly the
 * pure-path + in-memory semantics that are safe to assert in CI. The
 * settings-namespace persistence path is covered by type contracts and the
 * manual GUI round-trip, not by a DB-backed fixture here.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { canonicalWorkspacePath, WorkspaceModelManager } from '../src/host/services/worktree/workspace-model.ts'
import type { WorkspaceModelPreset } from '../src/core/worktree/workspace-model.ts'

describe('canonicalWorkspacePath', () => {
  it('strips a trailing separator', () => {
    expect(canonicalWorkspacePath('/a/b/')).toBe('/a/b')
  })

  it('normalizes backslashes to forward slashes (non-existent path)', () => {
    const out = canonicalWorkspacePath('C:\\foo\\bar\\')
    expect(out.endsWith('/foo/bar')).toBe(true)
    expect(out.includes('\\')).toBe(false)
    // Windows-style drive prefix is kept uppercased by the lexical fallback.
    expect(out).toBe('C:/foo/bar')
  })

  it('passes through a plain existing path unchanged', () => {
    expect(canonicalWorkspacePath('/')).toBe('/')
  })
})

describe('WorkspaceModelManager (in-memory degrade, no settings service)', () => {
  function makeManager(): WorkspaceModelManager {
    return new WorkspaceModelManager(new Context())
  }

  it('releases its pending settings injection when registration rolls back', () => {
    const dispose = vi.fn()
    const manager = new WorkspaceModelManager({ inject: () => ({ dispose }) } as unknown as Context)
    manager.dispose()
    manager.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('starts empty', () => {
    expect(makeManager().list()).toEqual({})
  })

  it('get returns undefined for an unknown path', () => {
    expect(makeManager().get('/nope')).toBeUndefined()
  })

  it('set stores and returns the preset keyed by canonical path', async () => {
    const manager = makeManager()
    const preset: WorkspaceModelPreset = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }
    const stored = await manager.set('/ws/a', preset)
    expect(stored).toEqual(preset)
    expect(manager.get('/ws/a')).toEqual(preset)
    expect(manager.list()).toEqual({ '/ws/a': preset })
  })

  it('set canonicalizes the key so trailing-slash lookups match', async () => {
    const manager = makeManager()
    await manager.set('/ws/b/', { provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(manager.get('/ws/b/')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(manager.get('/ws/b')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  })

  it('set without effort omits the effort key', async () => {
    const manager = makeManager()
    await manager.set('/ws/c', { provider: 'deepseek', model: 'deepseek-chat' })
    const stored = manager.get('/ws/c')
    expect(stored).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect('reasoningEffort' in (stored as WorkspaceModelPreset)).toBe(false)
  })

  it('clear removes the preset and reports whether it existed', async () => {
    const manager = makeManager()
    expect(await manager.clear('/ws/d')).toBe(false)
    await manager.set('/ws/d', { provider: 'deepseek', model: 'm' })
    expect(await manager.clear('/ws/d')).toBe(true)
    expect(manager.get('/ws/d')).toBeUndefined()
  })

  it('set overrides an existing preset for the same path', async () => {
    const manager = makeManager()
    await manager.set('/ws/e', { provider: 'a', model: 'm1' })
    await manager.set('/ws/e/', { provider: 'b', model: 'm2', reasoningEffort: 'low' })
    expect(manager.get('/ws/e')).toEqual({ provider: 'b', model: 'm2', reasoningEffort: 'low' })
  })
})