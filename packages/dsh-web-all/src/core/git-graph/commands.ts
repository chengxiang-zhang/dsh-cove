/** Pure Git argv construction, branch-name validation, and failure classification. */
import type { GitError } from './protocol.ts'

export const topLevelArgv = (): string[] => ['rev-parse', '--show-toplevel']
export const headBranchArgv = (): string[] => ['rev-parse', '--abbrev-ref', 'HEAD']
export const headShortArgv = (): string[] => ['rev-parse', '--short', 'HEAD']
export const statusPorcelainArgv = (): string[] => ['status', '--porcelain']
export const unmergedArgv = (): string[] => ['diff', '--name-only', '--diff-filter=U']
export const worktreeListArgv = (): string[] => ['worktree', 'list', '--porcelain']
export const verifyRefArgv = (branch: string): string[] => ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]
export const checkRefFormatArgv = (branch: string): string[] => ['check-ref-format', '--branch', branch]
export const switchArgv = (branch: string): string[] => ['switch', '--no-guess', '--', branch]
export const createBranchArgv = (branch: string): string[] => ['switch', '--no-guess', '-c', branch]
export const forEachRefArgv = (): string[] => ['for-each-ref', 'refs/heads', '--format=%(refname:short)%00%(HEAD)%00%(objectname)']
export const diffArgv = (path?: string, staged = false): string[] => ['diff', ...(staged ? ['--cached'] : []), '--', ...(path ? [path] : [])]
export const stageArgv = (path?: string): string[] => ['add', '--', ...(path ? [path] : ['.'])]
export const unstageArgv = (path?: string): string[] => ['restore', '--staged', '--', ...(path ? [path] : ['.'])]
export const commitArgv = (message: string): string[] => ['commit', '-m', message]
export const graphLogArgv = (limit: number, skip = 0): string[] => [
  'log', '--branches', '--tags', '--remotes', '--topo-order', '--parents',
  '--format=%H%x00%P%x00%an%x00%at%x00%D%x00%s%x1e', '--max-count', String(limit), '--skip', String(skip),
]
export const commitDiffArgv = (oid: string): string[] => [
  'show', '--format=fuller', '--stat', '--patch', '--no-ext-diff', '--no-color', '--find-renames', oid, '--',
]
export const verifyCommitArgv = (oid: string): string[] => ['cat-file', '-e', `${oid}^{commit}`]
export const verifyTrackedPathArgv = (path: string): string[] => ['ls-files', '--error-unmatch', '--', path]
export const discardFileArgv = (path: string): string[] => ['restore', '--source=HEAD', '--staged', '--worktree', '--', path]
export const revertArgv = (oid: string): string[] => ['revert', '--no-edit', '--', oid]
export const cherryPickArgv = (oid: string): string[] => ['cherry-pick', '--', oid]

export const OPERATION_MARKERS = [
  'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG',
  'rebase-merge', 'rebase-apply', 'sequencer',
] as const
export const gitPathArgv = (marker: string): string[] => ['rev-parse', '--git-path', marker]
export const operationMarkersArgv = (): string[] => ['rev-parse', ...OPERATION_MARKERS.flatMap((marker) => ['--git-path', marker])]

export function validateObjectId(value: string): string | null {
  if (value === '') return 'empty'
  if (value.startsWith('-')) return 'leading-dash'
  if (!/^[0-9a-f]{7,64}$/i.test(value)) return 'not-hex-object-id'
  return null
}

export function validateRepoRelativePath(value: string): string | null {
  if (value === '') return 'empty'
  if (value.includes('\0')) return 'nul-byte'
  if (/^[\\/]/.test(value) || /^[a-z]:[\\/]/i.test(value)) return 'absolute-path'
  const components = value.replace(/\\/g, '/').split('/')
  if (components.some((part) => part === '' || part === '.' || part === '..')) return 'unsafe-component'
  return null
}

export function validateBranchName(name: string): string | null {
  if (name === '') return 'empty'
  if (name === '@') return 'at-sign'
  if (name.startsWith('-')) return 'leading-dash'
  if (name.endsWith('.')) return 'trailing-dot'
  if (name.endsWith('.lock')) return 'lock-suffix'
  if (name.includes('..')) return 'double-dot'
  if (name.includes('@{')) return 'at-brace'
  if (name.includes('//')) return 'double-slash'
  if (/[ ~^:?*[\\]/.test(name)) return 'forbidden-char'
  for (const character of name) {
    const code = character.codePointAt(0)
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return 'control-char'
  }
  for (const component of name.split('/')) {
    if (component === '') return 'empty-component'
    if (component.startsWith('.')) return 'dot-component'
    if (component.endsWith('.lock')) return 'lock-suffix'
  }
  return name.length > 1000 ? 'too-long' : null
}

export function extractBlockedPaths(stderr: string, header: RegExp): { paths: string[]; moreFiles: number } {
  const firstNewline = stderr.indexOf('\n', stderr.search(header))
  if (firstNewline < 0) return { paths: [], moreFiles: 0 }
  const paths: string[] = []
  for (const line of stderr.slice(firstNewline + 1).split('\n')) {
    if (!line.startsWith('\t')) break
    const trimmed = line.trim()
    if (trimmed === '') break
    const quoted = /^"(.+)"$/.exec(trimmed)
    paths.push((quoted?.[1] ?? trimmed).replace(/\\(.)/g, '$1'))
  }
  return { paths: paths.slice(0, 2), moreFiles: Math.max(0, paths.length - 2) }
}

export function classifySwitchFailure(stderr: string): GitError {
  const first = stderr.trim().split('\n')[0] ?? ''
  const patterns = [
    { code: 'tracked-changes-would-be-overwritten' as const, header: /Your local changes to the following files would be overwritten by (?:checkout|merge)/ },
    { code: 'untracked-changes-would-be-overwritten' as const, header: /The following untracked working tree files would be overwritten by checkout/ },
  ]
  for (const pattern of patterns) {
    if (pattern.header.test(stderr)) return { code: pattern.code, message: first, ...extractBlockedPaths(stderr, pattern.header) }
  }
  if (/did not match any file\(s\) known to git|invalid reference|not a valid branch/.test(stderr)) {
    return { code: 'target-branch-not-found', message: first }
  }
  if (/already used by worktree|is already checked out at/.test(stderr)) {
    return { code: 'branch-in-other-worktree', message: first }
  }
  return { code: 'internal', message: first || 'git switch failed' }
}
