/** Pure wire contract and parsers for the workspace Git surface. */
export interface RepoStatus {
  root: string
  branch: string
  head: string
  dirtyFiles: number
  untrackedFiles: number
  conflicts: number
  operationInProgress: boolean
}

export interface BranchRow { name: string; current: boolean }

export interface BranchesView {
  root: string
  branch: string
  branches: BranchRow[]
  dirtyFiles: number
  untrackedFiles: number
  conflicts: number
  operationInProgress: boolean
}

export type GitErrorCode =
  | 'conflicts-present'
  | 'operation-in-progress'
  | 'branch-in-other-worktree'
  | 'tracked-changes-would-be-overwritten'
  | 'untracked-changes-would-be-overwritten'
  | 'target-branch-not-found'
  | 'invalid-branch-name'
  | 'branch-already-exists'
  | 'workspace-unknown'
  | 'invalid-object-id'
  | 'commit-not-found'
  | 'invalid-file-path'
  | 'file-not-tracked'
  | 'dirty-worktree'
  | 'nothing-to-apply'
  | 'apply-conflict'
  | 'internal'

export interface GitError {
  code: GitErrorCode
  message: string
  paths?: string[]
  moreFiles?: number
}

export type SwitchResult =
  | {
    ok: true
    branch: string
    /**
     * Whether the conversation now runs in the branch's new worktree. A lane is
     * a DSH workspace, and the move is the platform's own workspace navigation
     * (`uiWorkspace.openWorkspace`, the call behind the shell's picker): a build
     * that cannot reach that service reports the worktree as ready and says
     * where to pick it up rather than claiming the user is already in it.
     */
    opened: boolean
  }
  | { ok: false; error: GitError }

export interface GraphCommit {
  oid: string
  parents: string[]
  subject: string
  author: string
  authorTime: number
  refs: string[]
}

export interface GraphView {
  root: string
  branch: string
  commits: GraphCommit[]
  hasMore: boolean
  nextCursor?: string
}

export interface CommitDiffView {
  root: string
  oid: string
  diff: string
}

export type GitMutationKind = 'discard' | 'revert' | 'cherry-pick'
export interface GitMutationResult { changed: true; kind: GitMutationKind; head: string }
export type GitMutationResponse = { ok: true; value: GitMutationResult } | { ok: false; error: GitError }

export type GitEnvelope<T> = { ok: true; value: T } | { ok: false; error: GitError }

export function parseBranches(stdout: string): BranchRow[] {
  return stdout.split('\n').flatMap((line) => {
    if (line === '') return []
    const [name, marker, oid] = line.split('\0')
    return name === undefined || marker === undefined || oid === undefined
      ? []
      : [{ name, current: marker === '*' }]
  }).sort((left, right) => left.name.localeCompare(right.name))
}

export function parsePorcelain(stdout: string): Pick<RepoStatus, 'dirtyFiles' | 'untrackedFiles' | 'conflicts'> {
  const result = { dirtyFiles: 0, untrackedFiles: 0, conflicts: 0 }
  const conflicts = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const code = line.slice(0, 2)
    if (conflicts.has(code)) result.conflicts += 1
    else if (code === '??') result.untrackedFiles += 1
    else result.dirtyFiles += 1
  }
  return result
}

export function parseWorktreeBranches(stdout: string): string[] {
  const found = new Set<string>()
  for (const line of stdout.split('\n')) {
    const prefix = 'branch refs/heads/'
    if (line.startsWith(prefix)) {
      const name = line.slice(prefix.length).trim()
      if (name !== '') found.add(name)
    }
  }
  return [...found]
}

export function parseDecoration(value: string): string[] {
  return value === '' ? [] : value.split(', ').map((ref) => ref === 'HEAD' ? '' : ref.replace(/^HEAD -> /, '').replace(/^tag: /, '').trim()).filter(Boolean)
}

export function parseGraph(stdout: string): GraphCommit[] {
  const commits: GraphCommit[] = []
  for (const raw of stdout.split('\u001e')) {
    const [oid, parents = '', author = '', authorTime = '0', refs = '', subject = ''] = raw.replace(/^\n/, '').split('\0')
    if (!oid) continue
    commits.push({
      oid,
      parents: parents === '' ? [] : parents.split(' '),
      author,
      authorTime: Number(authorTime),
      refs: parseDecoration(refs),
      subject,
    })
  }
  return commits
}

export type LaneGlyph = 'node' | 'pass' | 'merge' | 'gap'
export interface GraphRowLanes { columns: LaneGlyph[]; nodeColumn: number; merge: boolean }

export function computeLanes(commits: readonly GraphCommit[]): GraphRowLanes[] {
  const futureParents = new Set(commits.flatMap((commit) => commit.parents))
  const pending: Array<string | null> = []
  return commits.map((commit) => {
    let nodeColumn = pending.indexOf(commit.oid)
    if (nodeColumn < 0) {
      pending.push(commit.oid)
      nodeColumn = pending.length - 1
    }
    const columns = pending.map<LaneGlyph>((oid, column) => {
      if (column === nodeColumn) return commit.parents.length > 1 ? 'merge' : 'node'
      if (oid === null || oid === commit.oid) return 'gap'
      return futureParents.has(oid) ? 'pass' : 'gap'
    })
    const parents = commit.parents.filter((parent) => futureParents.has(parent))
    for (let i = 0; i < pending.length; i += 1) {
      if (i !== nodeColumn && pending[i] === commit.oid) pending[i] = null
    }
    pending[nodeColumn] = parents[0] ?? null
    for (const parent of parents.slice(1)) if (!pending.includes(parent)) pending.push(parent)
    while (pending.at(-1) === null) pending.pop()
    return { columns, nodeColumn, merge: commit.parents.length > 1 }
  })
}

const ERROR_CODES = new Set<GitErrorCode>([
  'conflicts-present', 'operation-in-progress', 'branch-in-other-worktree',
  'tracked-changes-would-be-overwritten', 'untracked-changes-would-be-overwritten',
  'target-branch-not-found', 'invalid-branch-name', 'branch-already-exists',
  'workspace-unknown', 'invalid-object-id', 'commit-not-found', 'invalid-file-path',
  'file-not-tracked', 'dirty-worktree', 'nothing-to-apply', 'apply-conflict', 'internal',
])
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined

export function isRepoStatus(value: unknown): value is RepoStatus {
  const row = record(value)
  return row !== undefined && typeof row.root === 'string' && typeof row.branch === 'string'
    && typeof row.head === 'string' && typeof row.dirtyFiles === 'number'
    && typeof row.untrackedFiles === 'number' && typeof row.conflicts === 'number'
    && typeof row.operationInProgress === 'boolean'
}

export function isBranchesView(value: unknown): value is BranchesView {
  const row = record(value)
  return row !== undefined && typeof row.root === 'string' && typeof row.branch === 'string'
    && Array.isArray(row.branches) && row.branches.every((item) => {
      const branch = record(item)
      return branch !== undefined && typeof branch.name === 'string' && typeof branch.current === 'boolean'
    }) && typeof row.dirtyFiles === 'number' && typeof row.untrackedFiles === 'number'
    && typeof row.conflicts === 'number' && typeof row.operationInProgress === 'boolean'
}

export function isGraphView(value: unknown): value is GraphView {
  const row = record(value)
  return row !== undefined && typeof row.root === 'string' && typeof row.branch === 'string'
    && typeof row.hasMore === 'boolean' && (row.nextCursor === undefined || typeof row.nextCursor === 'string')
    && Array.isArray(row.commits) && row.commits.every((item) => {
      const commit = record(item)
      return commit !== undefined && typeof commit.oid === 'string'
        && Array.isArray(commit.parents) && commit.parents.every((parent) => typeof parent === 'string')
        && typeof commit.subject === 'string' && typeof commit.author === 'string'
        && typeof commit.authorTime === 'number' && Array.isArray(commit.refs)
        && commit.refs.every((ref) => typeof ref === 'string')
    })
}

export function isCommitDiffView(value: unknown): value is CommitDiffView {
  const row = record(value)
  return row !== undefined && typeof row.root === 'string' && typeof row.oid === 'string' && typeof row.diff === 'string'
}

export function isGitMutationResult(value: unknown): value is GitMutationResult {
  const row = record(value)
  return row !== undefined && row.changed === true
    && (row.kind === 'discard' || row.kind === 'revert' || row.kind === 'cherry-pick')
    && typeof row.head === 'string'
}

export function isGitError(value: unknown): value is GitError {
  const error = record(value)
  return error !== undefined && typeof error.code === 'string' && ERROR_CODES.has(error.code as GitErrorCode)
    && typeof error.message === 'string'
    && (error.paths === undefined || (Array.isArray(error.paths) && error.paths.every((path) => typeof path === 'string')))
    && (error.moreFiles === undefined || typeof error.moreFiles === 'number')
}
