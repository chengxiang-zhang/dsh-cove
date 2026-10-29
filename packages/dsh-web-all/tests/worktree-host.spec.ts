/**
 * Unit tests for the host-side domain helpers. These run without a cordis
 * context, a git binary, or a disk tree, so they are safe in CI without
 * any external services. The integration path (manager + routes) gets
 * tested through the manager's per-repo lock + worktree path helpers.
 */

import { describe, expect, it } from 'vitest'
import { WorktreeError, defaultMessage, isValidBranchName } from '../src/core/worktree/invariant.ts'
import { displayPath, githubCompareUrl, githubOwnerRepo, samePath, shortSha, worktreeDir, worktreeRoot } from '../src/core/worktree/paths.ts'
import { emptyManifest, parseManifest } from '../src/core/worktree/manifest.ts'
import { parseBranchList, stripOriginPrefix } from '../src/host/services/worktree/git.ts'

describe('isValidBranchName', () => {
  it('accepts plain ASCII names', () => {
    expect(isValidBranchName('main')).toBe(true)
    expect(isValidBranchName('feature/login')).toBe(true)
    expect(isValidBranchName('v1.0.0-rc.1')).toBe(true)
    expect(isValidBranchName('user/jane/feature_a')).toBe(true)
  })

  it('rejects empty / whitespace / pathological names', () => {
    expect(isValidBranchName('')).toBe(false)
    expect(isValidBranchName('   ')).toBe(false)
    expect(isValidBranchName('HEAD')).toBe(false)
    expect(isValidBranchName('@')).toBe(false)
    expect(isValidBranchName('.hidden')).toBe(false)
    expect(isValidBranchName('-dash')).toBe(false)
    expect(isValidBranchName('a..b')).toBe(false)
    expect(isValidBranchName('a.lock')).toBe(false)
    expect(isValidBranchName('a/')).toBe(false)
    expect(isValidBranchName('a.')).toBe(false)
    expect(isValidBranchName('a~b')).toBe(false)
    expect(isValidBranchName('a^b')).toBe(false)
    expect(isValidBranchName('a:b')).toBe(false)
    expect(isValidBranchName('a b')).toBe(false)
    expect(isValidBranchName('a\\b')).toBe(false)
  })

  it('rejects names over 100 chars', () => {
    expect(isValidBranchName('a'.repeat(101))).toBe(false)
    expect(isValidBranchName('a'.repeat(100))).toBe(true)
  })
})

describe('WorktreeError', () => {
  it('carries the code and optional details', () => {
    const error = new WorktreeError('invalid-branch', 'bad name', { name: 'foo..bar' })
    expect(error.code).toBe('invalid-branch')
    expect(error.message).toBe('bad name')
    expect(error.details).toEqual({ name: 'foo..bar' })
    expect(error.name).toBe('WorktreeError')
  })

  it('defaultMessage matches the code', () => {
    expect(defaultMessage('not-a-repository')).toContain('not a git repository')
    expect(defaultMessage('worktree-exists')).toContain('already exists')
    expect(defaultMessage('worktree-busy')).toContain('running session')
  })
})

describe('paths', () => {
  it('worktreeRoot composes the well-known path', () => {
    expect(worktreeRoot('/repos/dsh-cove')).toBe('/repos/dsh-cove/.dsh/workspaces')
    expect(worktreeRoot('/repos/dsh-cove/')).toBe('/repos/dsh-cove/.dsh/workspaces')
  })

  it('worktreeDir composes the per-branch path', () => {
    expect(worktreeDir('/repos/dsh-cove', 'main')).toBe('/repos/dsh-cove/.dsh/workspaces/main')
    expect(worktreeDir('/repos/dsh-cove', 'feature/login')).toBe('/repos/dsh-cove/.dsh/workspaces/feature/login')
  })

  it('worktreeDir rejects invalid branch names', () => {
    expect(() => worktreeDir('/repos/dsh-cove', '..')).toThrow()
    expect(() => worktreeDir('/repos/dsh-cove', '')).toThrow()
  })

  it('shortSha returns null for empty input', () => {
    expect(shortSha(null)).toBe(null)
    expect(shortSha(undefined)).toBe(null)
    expect(shortSha('')).toBe(null)
  })

  it('shortSha truncates to 7 chars', () => {
    expect(shortSha('abcdef1234567890')).toBe('abcdef1')
    expect(shortSha('abc')).toBe('abc')
  })

  it('displayPath replaces .dsh/workspaces/ with the visual marker', () => {
    expect(displayPath('/repos/dsh-cove/.dsh/workspaces/main')).toBe('.dsh/workspaces/main')
    expect(displayPath('/repos/dsh-cove/.dsh/workspaces/feature/login'))
      .toBe('.dsh/workspaces/feature/login')
    expect(displayPath('/elsewhere')).toBe('/elsewhere')
  })

  it('samePath normalizes separators and trailing slashes', () => {
    expect(samePath('/a/b', '/a/b')).toBe(true)
    expect(samePath('/a/b', '/a/b/')).toBe(true)
    expect(samePath('C:\\a\\b', 'C:/a/b')).toBe(true)
    expect(samePath('/a/b', '/a/c')).toBe(false)
  })
})

describe('emptyManifest / parseManifest', () => {
  it('starts empty for a fresh repo', () => {
    const m = emptyManifest('/repos/foo')
    expect(m.version).toBe(2)
    expect(m.repoPath).toBe('/repos/foo')
    expect(m.worktrees).toEqual([])
  })

  it('parses a v2 manifest with PR metadata', () => {
    const m = parseManifest(JSON.stringify({
      version: 2,
      repoPath: '/repos/foo',
      baseBranch: 'dev',
      worktrees: [{
        name: 'feature/x',
        path: '/repos/foo/.dsh/workspaces/feature/x',
        baseCommit: 'abc',
        createdAt: '2026-01-01T00:00:00.000Z',
        detached: false,
        prUrl: 'https://github.com/o/r/compare/dev...feature%2Fx',
        prNumber: 12,
        remoteBranch: 'origin',
        baseRef: 'dev',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }],
    }))
    expect(m.version).toBe(2)
    expect(m.baseBranch).toBe('dev')
    expect(m.worktrees[0].prUrl).toContain('compare')
    expect(m.worktrees[0].prNumber).toBe(12)
    expect(m.worktrees[0].remoteBranch).toBe('origin')
    expect(m.worktrees[0].baseRef).toBe('dev')
  })

  it('normalizes a v1 manifest (no PR metadata allowed) to v2', () => {
    const m = parseManifest(JSON.stringify({
      version: 1,
      repoPath: '/repos/foo',
      worktrees: [{
        name: 'main',
        path: '/repos/foo/.dsh/workspaces/main',
        baseCommit: 'abc',
        createdAt: '2026-01-01T00:00:00.000Z',
        detached: false,
      }],
    }))
    expect(m.version).toBe(2)
    expect(m.baseBranch).toBeUndefined()
    expect(m.worktrees[0].prUrl).toBeUndefined()
    expect(m.worktrees[0].remoteBranch).toBeUndefined()
  })

  it('rejects corrupt manifests loudly', () => {
    expect(() => parseManifest('not json')).toThrow()
    expect(() => parseManifest('{"version":3,"repoPath":"/x","worktrees":[]}')).toThrow()
    expect(() => parseManifest('{"version":1,"repoPath":"/x"}')).toThrow()
    expect(() => parseManifest('{"version":1,"repoPath":"/x","worktrees":[{}]}')).toThrow()
  })
})

describe('githubOwnerRepo / githubCompareUrl', () => {
  it('parses https remotes', () => {
    expect(githubOwnerRepo('https://github.com/chengxiang-zhang/dsh-cove.git')).toEqual({ owner: 'chengxiang-zhang', repo: 'dsh-cove' })
    expect(githubOwnerRepo('https://github.com/chengxiang-zhang/dsh-cove')).toEqual({ owner: 'chengxiang-zhang', repo: 'dsh-cove' })
  })

  it('parses ssh scp-like remotes', () => {
    expect(githubOwnerRepo('git@github.com:chengxiang-zhang/dsh-cove.git')).toEqual({ owner: 'chengxiang-zhang', repo: 'dsh-cove' })
  })

  it('parses ssh url-style remotes', () => {
    expect(githubOwnerRepo('ssh://git@github.com/chengxiang-zhang/dsh-cove.git')).toEqual({ owner: 'chengxiang-zhang', repo: 'dsh-cove' })
  })

  it('rejects non-GitHub remotes', () => {
    expect(githubOwnerRepo('git@gitlab.com:chengxiang-zhang/dsh-cove.git')).toBeNull()
    expect(githubOwnerRepo('https://example.com/chengxiang-zhang/dsh-cove.git')).toBeNull()
  })

  it('builds the compare URL with encoded segments', () => {
    expect(githubCompareUrl('git@github.com:chengxiang-zhang/dsh-cove.git', 'dev', 'feature/login'))
      .toBe('https://github.com/chengxiang-zhang/dsh-cove/compare/dev...feature%2Flogin?expand=1')
    expect(githubCompareUrl('https://example.com/x/y.git', 'dev', 'f')).toBeNull()
  })
})

describe('parseBranchList / stripOriginPrefix', () => {
  it('strips a leading origin/ prefix', () => {
    expect(stripOriginPrefix('origin/dev')).toBe('dev')
    expect(stripOriginPrefix('dev')).toBe('dev')
    expect(stripOriginPrefix('origin/feature/x')).toBe('feature/x')
  })

  it('lists local branches first, then remote branches, deduplicated', () => {
    const out = parseBranchList([
      'dev',
      'main',
      'origin/HEAD',
      'origin/dev',
      'origin/feature/x',
      'origin/main',
    ].join('\n') + '\n')
    expect(out).toEqual(['dev', 'main', 'feature/x'])
  })

  it('ignores blank lines and origin/HEAD', () => {
    expect(parseBranchList('\norigin/HEAD\n\n')).toEqual([])
  })
})
