/**
 * `mainWorkspaceId` resolution when the registered workspace path and git's
 * canonical path differ. git reports `/private/tmp/...` on macOS while the
 * workspace store holds `/tmp/...`, and the panel disables the main row's
 * Open / New session buttons when the id is unknown.
 */

import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitRunResult, GitRunner } from '../src/host/services/worktree/git-runner.ts'
import { WorktreeManager } from '../src/host/services/worktree/manager.ts'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Only the commands `getIndex` needs. */
function runnerFor(canonicalRoot: string): GitRunner {
  const run = vi.fn(async (argv: readonly string[]): Promise<GitRunResult> => {
    const joined = argv.join(' ')
    const ok = (stdout = ''): GitRunResult => ({ exitCode: 0, stdout, stderr: '' })
    if (joined.includes('--git-common-dir')) return ok(canonicalRoot)
    if (joined.includes('worktree list')) return ok(`worktree ${canonicalRoot}\nHEAD deadbeef\nbranch refs/heads/main\n\n`)
    if (joined.includes('symbolic-ref')) return ok('main')
    if (joined.includes('status --porcelain')) return ok('')
    if (joined.includes('for-each-ref')) return ok('')
    return ok()
  })
  return { run } as unknown as GitRunner
}

describe('mainWorkspaceId over a symlinked workspace path', () => {
  it('falls back to comparing realpaths when the literal lookup misses', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-wt-symlink-'))
    tempRoots.push(base)
    const real = join(base, 'real-repo')
    const link = join(base, 'link-repo')
    await mkdir(real, { recursive: true })
    await symlink(real, link)

    // git canonicalizes the worktree path; the workspace store keeps the symlink.
    const canonical = await realpath(real)
    const listed = [{ id: 'ws-1', path: link }]
    const ctx = {
      workspaceRegistry: {
        list: () => listed,
        resolveByPath: async (path: string) => path === link ? listed[0] : undefined,
      },
    }
    const manager = new WorktreeManager(ctx as never, { runner: runnerFor(canonical) })

    const index = await manager.getIndex()

    expect(index.projects).toHaveLength(1)
    expect(index.projects[0]?.mainWorkspaceId).toBe('ws-1')
  })

  it('still resolves a workspace whose path matches literally', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-wt-plain-'))
    tempRoots.push(base)
    const repo = join(base, 'repo')
    await mkdir(repo, { recursive: true })
    const canonical = await realpath(repo)
    const listed = [{ id: 'ws-2', path: canonical }]
    let resolveCalls = 0
    const ctx = {
      workspaceRegistry: {
        list: () => listed,
        resolveByPath: async (path: string) => {
          resolveCalls += 1
          return path === canonical ? listed[0] : undefined
        },
      },
    }
    const manager = new WorktreeManager(ctx as never, { runner: runnerFor(canonical) })

    const index = await manager.getIndex()

    expect(index.projects[0]?.mainWorkspaceId).toBe('ws-2')
    expect(resolveCalls).toBeGreaterThan(0)
  })
})