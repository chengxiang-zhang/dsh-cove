/**
 * Right-workbench addressing: in DSH 0.2 the framework injects the session id
 * (`sessions.list` no longer exposes `current`), so this module only builds
 * URLs and relative paths for an already-resolved scope.
 */
import { describe, expect, it } from 'vitest'
import { workbenchUrl, workspaceRelative } from '../src/client/sidebar/scope.ts'

describe('right-workbench addressing', () => {
  it('addresses one host route with the resolved scope', () => {
    expect(workbenchUrl('git-status', { sessionId: 'session-a', cwd: '/repo', root: '/repo' }))
      .toBe('/api/workbench/git-status?root=%2Frepo&path=&session=session-a')
    expect(workbenchUrl('tree', { root: '/repo' }, 'src/index.ts', { depth: '1' }))
      .toBe('/api/workbench/tree?root=%2Frepo&path=src%2Findex.ts&depth=1')
  })

  it('keeps a produced file relative to the session workspace', () => {
    expect(workspaceRelative({ cwd: '/repo' }, '/repo/src/index.ts')).toBe('src/index.ts')
    expect(workspaceRelative({ cwd: '/repo/' }, '/repo/src/index.ts')).toBe('src/index.ts')
    expect(workspaceRelative({ cwd: '/repo' }, './src/index.ts')).toBe('src/index.ts')
    expect(workspaceRelative({}, '/elsewhere/file.ts')).toBe('/elsewhere/file.ts')
  })
})