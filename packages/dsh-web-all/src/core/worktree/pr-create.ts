/**
 * Pull-request creation wire contract and pure argv/input helpers.
 *
 * Host execution lives in the worktree service. This module stays runtime-neutral
 * so both host and client programs compile the same request/result contract.
 */

export interface PrCreateInput {
  /** Any path inside the project. `repoPath` remains accepted by the host as a legacy alias. */
  cwd?: string
  /** Local branch to publish. `name` remains accepted by the host as a legacy alias. */
  branch?: string
  /** Pull-request title. Defaults to the branch for legacy callers. */
  title?: string
  /** Pull-request body. Defaults to an empty body for legacy callers. */
  body?: string
  /** Target branch. `baseRef` remains accepted by the host as a legacy alias. */
  base?: string
  /** GitHub head selector, usually a branch or `owner:branch`. Defaults to `branch`. */
  head?: string
  /** Create the pull request as a draft. */
  draft?: boolean
  /** Legacy project-root field. */
  repoPath?: string
  /** Legacy worktree-name field. */
  name?: string
  /** Legacy base-branch field. */
  baseRef?: string
}

export interface PrCreateResult {
  url: string
  number: number
  /** Legacy result field retained for the previous browser client. */
  prUrl: string
  /** Legacy discriminator: gh creates the pull request through GitHub's API. */
  method: 'api'
}

export type PrCreateErrorCode =
  | 'invalid-input'
  | 'gh-not-installed'
  | 'gh-not-authenticated'
  | 'pr-already-exists'
  | 'timeout'
  | 'gh-failed'
  | 'invalid-gh-response'

export interface NormalizedPrCreateInput {
  cwd: string
  branch: string
  title: string
  body: string
  base?: string
  head: string
  draft: boolean
}

export type PrCreateInputValidation =
  | { ok: true; value: NormalizedPrCreateInput }
  | { ok: false; message: string }

const MAX_TITLE_LENGTH = 256
const MAX_BODY_LENGTH = 64 * 1024

/** Git's branch-name restrictions, without invoking a subprocess. */
export function isSafeBranchName(value: string): boolean {
  if (value === '' || value.length > 255 || value === '@' || value.startsWith('-')) return false
  if (/\s|[~^:?*\\\[\x00-\x1f\x7f]/u.test(value)) return false
  if (value.includes('..') || value.includes('@{') || value.includes('//')) return false
  if (value.startsWith('/') || value.endsWith('/') || value.startsWith('.') || value.endsWith('.')) return false
  if (value.endsWith('.lock')) return false
  return value.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.'))
}

/** GitHub accepts either a branch or `owner:branch` for --head. */
export function isSafeHead(value: string): boolean {
  const colon = value.indexOf(':')
  if (colon === -1) return isSafeBranchName(value)
  if (colon === 0 || colon !== value.lastIndexOf(':')) return false
  const owner = value.slice(0, colon)
  const branch = value.slice(colon + 1)
  return /^[A-Za-z0-9_.-]+$/u.test(owner) && isSafeBranchName(branch)
}

/** Normalize current and legacy request fields, rejecting malformed or unsafe values. */
export function normalizePrCreateInput(input: PrCreateInput): PrCreateInputValidation {
  const cwdValue = input.cwd ?? input.repoPath
  const branchValue = input.branch ?? input.name
  const baseValue = input.base ?? input.baseRef

  if (input.cwd !== undefined && typeof input.cwd !== 'string') return { ok: false, message: 'cwd must be a string' }
  if (input.repoPath !== undefined && typeof input.repoPath !== 'string') return { ok: false, message: 'repoPath must be a string' }
  if (typeof cwdValue !== 'string' || cwdValue.trim() === '') return { ok: false, message: 'cwd is required' }
  if (typeof branchValue !== 'string' || !isSafeBranchName(branchValue.trim())) {
    return { ok: false, message: 'branch is invalid' }
  }
  if (input.branch !== undefined && typeof input.branch !== 'string') return { ok: false, message: 'branch must be a string' }
  if (input.name !== undefined && typeof input.name !== 'string') return { ok: false, message: 'name must be a string' }
  if (input.title !== undefined && typeof input.title !== 'string') return { ok: false, message: 'title must be a string' }
  if (input.body !== undefined && typeof input.body !== 'string') return { ok: false, message: 'body must be a string' }
  if (input.base !== undefined && typeof input.base !== 'string') return { ok: false, message: 'base must be a string' }
  if (input.baseRef !== undefined && typeof input.baseRef !== 'string') return { ok: false, message: 'baseRef must be a string' }
  if (input.head !== undefined && typeof input.head !== 'string') return { ok: false, message: 'head must be a string' }
  if (input.draft !== undefined && typeof input.draft !== 'boolean') return { ok: false, message: 'draft must be a boolean' }

  const branch = branchValue.trim()
  const title = input.title?.trim() || branch
  const body = input.body ?? ''
  const base = baseValue?.trim()
  const head = input.head?.trim() || branch

  if (title.length > MAX_TITLE_LENGTH || /[\r\n\x00]/u.test(title)) {
    return { ok: false, message: `title must be one line and at most ${MAX_TITLE_LENGTH} characters` }
  }
  if (body.length > MAX_BODY_LENGTH || body.includes('\0')) {
    return { ok: false, message: `body must not contain NUL and must be at most ${MAX_BODY_LENGTH} characters` }
  }
  if (base !== undefined && (base === '' || !isSafeBranchName(base))) return { ok: false, message: 'base is invalid' }
  if (!isSafeHead(head)) return { ok: false, message: 'head is invalid' }

  return {
    ok: true,
    value: {
      cwd: cwdValue.trim(),
      branch,
      title,
      body,
      ...(base === undefined ? {} : { base }),
      head,
      draft: input.draft === true,
    },
  }
}

/** Build an argv-only GitHub CLI invocation. Values never pass through a shell. */
export function ghPrCreateArgv(input: Omit<NormalizedPrCreateInput, 'cwd'>): string[] {
  const argv = ['pr', 'create', '--title', input.title, '--body', input.body, '--head', input.head]
  if (input.base !== undefined) argv.push('--base', input.base)
  if (input.draft) argv.push('--draft')
  return argv
}

/** Extract the PR URL and numeric id from `gh pr create` output. */
export function parseGhPrCreateOutput(stdout: string): { url: string; number: number } | undefined {
  const match = stdout.match(/https?:\/\/[^\s]+\/pull\/(\d+)(?:\b|\/)?/u)
  if (match === null) return undefined
  const number = Number(match[1])
  if (!Number.isSafeInteger(number) || number <= 0) return undefined
  try {
    const url = new URL(match[0].replace(/[),.;]+$/u, ''))
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return { url: url.href.replace(/\/$/u, ''), number }
  } catch {
    return undefined
  }
}
