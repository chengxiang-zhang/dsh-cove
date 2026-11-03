/**
 * Right-workbench addressing: in DSH 0.2 the framework injects the session id
 * (`sessions.list` no longer exposes `current`), so this module only resolves
 * relative paths for an already-resolved scope.
 */
import { describe, expect, it } from 'vitest'
import { workspaceRelative } from '../src/client/sidebar/scope.ts'

describe('right-workbench addressing', () => {
  it('keeps a produced file relative to the session workspace', () => {
    expect(workspaceRelative({ cwd: '/repo' }, '/repo/src/index.ts')).toBe('src/index.ts')
    expect(workspaceRelative({ cwd: '/repo/' }, '/repo/src/index.ts')).toBe('src/index.ts')
    expect(workspaceRelative({ cwd: '/repo' }, './src/index.ts')).toBe('src/index.ts')
    expect(workspaceRelative({}, '/elsewhere/file.ts')).toBe('/elsewhere/file.ts')
  })
})