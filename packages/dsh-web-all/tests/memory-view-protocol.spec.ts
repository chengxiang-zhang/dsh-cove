/**
 * memory-view wire contract.
 *
 * The expected values are written out here rather than derived from the
 * implementation: this spec is the second, independent copy of the contract the
 * host proxy and the browser panel both build against. The peer case pins the
 * live namespace of this repository, because a wrong peer silently reads an
 * empty directory instead of failing.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_RELATIVE_PATH_LENGTH,
  MEMORY_SCOPES,
  MEMORY_VIEW_API_PREFIX,
  VIKING_SCHEME,
  compareMemoryNodes,
  isMemoryScope,
  isPlaceholderDirectoryAbstract,
  isSafeVikingUri,
  isUriUnder,
  isVikingUri,
  joinMemoryPath,
  memoryRoot,
  memoryRoots,
  normalizeGitRemote,
  parentUri,
  peerMemoriesUri,
  sanitizePeerId,
  sanitizeSegment,
  uriName,
  uriRelativeTo,
  userMemoriesUri,
  workspacePeerFromRemote,
  workspacePeerFromRoot,
  type MemoryNode,
} from '../src/core/memory-view/protocol.ts'

const ROOT = 'viking://user/admin/memories'
const PEER_ROOT = 'viking://user/admin/peers/github.com-chengxiang-zhang-dsh-cove/memories'

describe('memory-view constants', () => {
  it('keeps the documented prefix and scope set', () => {
    expect(MEMORY_VIEW_API_PREFIX).toBe('/api/dsh-memory')
    expect(VIKING_SCHEME).toBe('viking://')
    expect([...MEMORY_SCOPES]).toEqual(['global', 'workspace'])
  })
})

describe('scope guard', () => {
  it('accepts only the two scopes', () => {
    expect(isMemoryScope('global')).toBe(true)
    expect(isMemoryScope('workspace')).toBe(true)
    for (const value of ['all', '', 'Global', 'workspace ', null, undefined, 0, 1, {}, []]) {
      expect(isMemoryScope(value)).toBe(false)
    }
  })
})

describe('uri safety', () => {
  it('accepts ordinary memory uris', () => {
    expect(isSafeVikingUri('viking://user/admin/memories')).toBe(true)
    expect(isSafeVikingUri('viking://user/admin/memories/profile.md')).toBe(true)
    expect(isSafeVikingUri('viking://user/admin/memories/')).toBe(true)
    expect(isSafeVikingUri('viking://user/admin/peers/github.com-a-b/memories/x/y.md')).toBe(true)
  })

  it('rejects traversal, alternate schemes and control bytes', () => {
    const rejected = [
      'viking://',
      'viking:///user/admin',
      'viking://user//admin',
      'viking://user/../admin/memories',
      'viking://user/./admin',
      'file:///etc/passwd',
      'https://example.com/x',
      'viking://user/admin/memories?x=1',
      'viking://user/admin/memories#frag',
      'viking://user/admin/mem\\ories',
      'viking://user/admin/mem\nories',
      'viking://user/admin/mem\u0000ories',
      '',
    ]
    for (const uri of rejected) expect(isSafeVikingUri(uri)).toBe(false)
  })

  it('rejects over-long uris', () => {
    expect(isSafeVikingUri(`viking://user/admin/memories/${'a'.repeat(1024)}`)).toBe(false)
  })

  it('checks the viking scheme independently of safety', () => {
    expect(isVikingUri('viking://x')).toBe(true)
    expect(isVikingUri('Viking://x')).toBe(false)
    expect(isVikingUri(42)).toBe(false)
  })
})

describe('root containment', () => {
  it('accepts the root itself and its descendants', () => {
    expect(isUriUnder(ROOT, ROOT)).toBe(true)
    expect(isUriUnder(`${ROOT}/profile.md`, ROOT)).toBe(true)
    expect(isUriUnder(`${ROOT}/memoir/dsh-web/work/a.md`, ROOT)).toBe(true)
    expect(isUriUnder(ROOT, `${ROOT}/`)).toBe(true)
  })

  it('is segment aware, not a string prefix', () => {
    expect(isUriUnder('viking://user/admin/memories-evil/x', ROOT)).toBe(false)
    expect(isUriUnder('viking://user/admin/other', ROOT)).toBe(false)
    expect(isUriUnder(`${PEER_ROOT}/entities`, ROOT)).toBe(false)
    expect(isUriUnder(`${PEER_ROOT}/entities`, PEER_ROOT)).toBe(true)
  })

  it('refuses to compare an unsafe uri', () => {
    expect(isUriUnder(`${ROOT}/../secrets`, ROOT)).toBe(false)
    expect(isUriUnder(ROOT, `${ROOT}/../x`)).toBe(false)
  })
})

describe('relative path joining', () => {
  it('joins a validated relative path', () => {
    expect(joinMemoryPath(ROOT, '')).toBe(ROOT)
    expect(joinMemoryPath(ROOT, '   ')).toBe(ROOT)
    expect(joinMemoryPath(ROOT, 'memoir')).toBe(`${ROOT}/memoir`)
    expect(joinMemoryPath(ROOT, 'memoir/dsh-web')).toBe(`${ROOT}/memoir/dsh-web`)
    expect(joinMemoryPath(ROOT, 'memoir/dsh-web/')).toBe(`${ROOT}/memoir/dsh-web`)
    expect(joinMemoryPath(`${ROOT}/`, 'x')).toBe(`${ROOT}/x`)
  })

  it('rejects absolute, traversing and malformed relative paths', () => {
    const rejected = [
      '/etc',
      '../x',
      '..',
      '.',
      'a/../b',
      'a/./b',
      'a//b',
      'a\\b',
      'a?x=1',
      'a#frag',
      'a\nb',
      'a\u0000b',
      `${'a'.repeat(101)}`,
      `${'a/'.repeat(MAX_RELATIVE_PATH_LENGTH)}`,
    ]
    for (const path of rejected) expect(joinMemoryPath(ROOT, path)).toBeNull()
  })

  it('rejects an unsafe root', () => {
    expect(joinMemoryPath('file:///tmp', 'x')).toBeNull()
    expect(joinMemoryPath(`${ROOT}/../x`, 'y')).toBeNull()
  })
})

describe('uri naming and navigation', () => {
  it('names a uri by its last segment', () => {
    expect(uriName(`${ROOT}/profile.md`)).toBe('profile.md')
    expect(uriName(`${ROOT}/memoir`)).toBe('memoir')
    expect(uriName('viking://user/admin/memories/')).toBe('memories')
  })

  it('walks up one level and stops', () => {
    expect(parentUri(`${ROOT}/profile.md`)).toBe(ROOT)
    expect(parentUri(`${ROOT}/memoir/dsh-web`)).toBe(`${ROOT}/memoir`)
    expect(parentUri('viking://user/admin')).toBeNull()
    expect(parentUri('https://example.com/x')).toBeNull()
  })

  it('computes the path relative to a root', () => {
    expect(uriRelativeTo(`${ROOT}/memoir/dsh-web`, ROOT)).toBe('memoir/dsh-web')
    expect(uriRelativeTo(ROOT, ROOT)).toBe('')
    expect(uriRelativeTo(`${ROOT}/`, ROOT)).toBe('')
    expect(uriRelativeTo('viking://user/admin/other/x', ROOT)).toBeNull()
  })

  it('sanitizes a single segment to the server identifier alphabet', () => {
    expect(sanitizeSegment('a b/c')).toBe('a-b-c')
    expect(sanitizeSegment('--a--')).toBe('a')
    expect(sanitizeSegment('.hidden.')).toBe('hidden')
    expect(sanitizeSegment('admin')).toBe('admin')
  })
})

describe('peer derivation', () => {
  it('converges every remote spelling to host/path', () => {
    const expected = 'github.com/chengxiang-zhang/dsh-cove'
    expect(normalizeGitRemote('git@github.com:chengxiang-zhang/dsh-cove.git')).toBe(expected)
    expect(normalizeGitRemote('https://github.com/chengxiang-zhang/dsh-cove.git')).toBe(expected)
    expect(normalizeGitRemote('https://github.com/chengxiang-zhang/dsh-cove')).toBe(expected)
    expect(normalizeGitRemote('ssh://git@github.com/chengxiang-zhang/dsh-cove')).toBe(expected)
    expect(normalizeGitRemote('https://github.com/ChengXiang-Zhang/DSH-Cove.git')).toBe(expected)
    expect(normalizeGitRemote('  git@github.com:chengxiang-zhang/dsh-cove.git  ')).toBe(expected)
  })

  it('drops userinfo so a token cannot become a peer', () => {
    expect(normalizeGitRemote('https://oauth2:ghp_secret@github.com/a/b.git')).toBe('github.com/a/b')
  })

  it('refuses values that are not a remote identity', () => {
    expect(normalizeGitRemote('')).toBe('')
    expect(normalizeGitRemote('   ')).toBe('')
    expect(normalizeGitRemote('C:\\src\\repo')).toBe('')
    expect(normalizeGitRemote('C:/src/repo')).toBe('')
  })

  it('pins the live peer of this repository', () => {
    // The deployment already writes workspace memory here; a change to this
    // value means the panel starts reading an empty namespace.
    expect(workspacePeerFromRemote('git@github.com:chengxiang-zhang/dsh-cove.git'))
      .toBe('github.com-chengxiang-zhang-dsh-cove')
    expect(workspacePeerFromRemote('https://github.com/chengxiang-zhang/dsh-cove.git'))
      .toBe('github.com-chengxiang-zhang-dsh-cove')
  })

  it('falls back to a root-path peer without producing dashes at the edges', () => {
    expect(workspacePeerFromRoot('/Users/leo/code/dsh-web')).toBe('Users-leo-code-dsh-web')
    expect(workspacePeerFromRemote('')).toBe('')
  })

  it('keeps the reserved and edge cases of the plugin rule', () => {
    expect(sanitizePeerId('ext-abc')).toBe('x-ext-abc')
    expect(sanitizePeerId('__self')).toBe('self')
    expect(sanitizePeerId('.')).toBe('')
    expect(sanitizePeerId('..')).toBe('')
  })
})

describe('scope roots', () => {
  it('builds the global and peer roots', () => {
    expect(userMemoriesUri('admin')).toBe(ROOT)
    expect(peerMemoriesUri('admin', 'github.com-a-b')).toBe('viking://user/admin/peers/github.com-a-b/memories')
    expect(memoryRoot('global', 'admin', 'github.com-a-b')).toBe(ROOT)
    expect(memoryRoot('workspace', 'admin', 'github.com-a-b'))
      .toBe('viking://user/admin/peers/github.com-a-b/memories')
  })

  it('falls back to the user space when a workspace has no peer', () => {
    expect(memoryRoot('workspace', 'admin', null)).toBe(ROOT)
    expect(memoryRoot('workspace', 'admin', '')).toBe(ROOT)
    expect(memoryRoots('workspace', 'admin', null)).toEqual([ROOT])
  })

  it('lists both roots for a peer workspace so the host can fence either', () => {
    expect(memoryRoots('workspace', 'admin', 'github.com-a-b')).toEqual([
      ROOT,
      'viking://user/admin/peers/github.com-a-b/memories',
    ])
  })
})

describe('placeholder directory abstracts', () => {
  it('recognises the not-ready marker OpenViking returns for directories', () => {
    expect(isPlaceholderDirectoryAbstract('# viking://user/admin/memories/cases [Directory abstract is not ready]')).toBe(true)
    expect(isPlaceholderDirectoryAbstract('  # viking://user/admin/peers/a-b/memories/events [Directory abstract is not ready]  ')).toBe(true)
  })

  it('keeps every real summary', () => {
    expect(isPlaceholderDirectoryAbstract('用户级偏好：热更与重启')).toBe(false)
    expect(isPlaceholderDirectoryAbstract('# 标题不是占位串')).toBe(false)
    expect(isPlaceholderDirectoryAbstract('')).toBe(false)
    expect(isPlaceholderDirectoryAbstract('# viking://user/admin/memories/cases [Directory abstract is ready]')).toBe(false)
  })
})

describe('listing order', () => {
  const node = (name: string, isDir: boolean): MemoryNode => ({ uri: `${ROOT}/${name}`, name, isDir, size: 0, modTime: '' })

  it('puts directories first and sorts each group by name', () => {
    const nodes = [node('b.md', false), node('z', true), node('a.md', false), node('a', true)]
    expect([...nodes].sort(compareMemoryNodes).map(entry => entry.name)).toEqual(['a', 'z', 'a.md', 'b.md'])
  })
})