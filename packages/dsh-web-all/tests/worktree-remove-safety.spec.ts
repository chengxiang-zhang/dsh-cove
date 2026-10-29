import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('worktree destructive remove safety', () => {
  it('derives targets from validated managed names instead of arbitrary browser paths', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/host/services/worktree/manager.ts'), 'utf8')
    expect(source).toContain('isValidBranchName(input.name)')
    expect(source).toContain('worktreeDir(root, input.name)')
    expect(source).not.toMatch(/worktreeRemoveArgv\(input\.(?:path|repoPath)/u)
  })
  it('does not expose raw path fields on the remove wire contract', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/core/worktree/types.ts'), 'utf8')
    const body = source.match(/export interface RemoveWorktreeInput \{([^]*?)\n\}/u)?.[1] ?? ''
    expect(body).toContain('repoPath: string')
    expect(body).toContain('name: string')
    expect(body).not.toMatch(/\bpath\s*:/u)
  })
})
