/**
 * Unit tests for the worktree lifecycle stage derivation: the pure mapping
 * from disk truth + status probe to the panel stage that drives the row's
 * primary action.
 */

import { describe, expect, it } from 'vitest'
import { stageOfWorktree } from '../src/client/conversation/worktree/lifecycle.ts'

const WT = { exists: true, branch: 'feature/x' } as const

describe('stageOfWorktree', () => {
  it('classifies a missing directory as missing', () => {
    expect(stageOfWorktree({ exists: false, branch: null }, undefined)).toBe('missing')
    expect(stageOfWorktree({ exists: false, branch: 'feature/x' }, undefined)).toBe('missing')
  })

  it('classifies a merged worktree as merged regardless of PR url', () => {
    expect(stageOfWorktree(WT, { merged: true, prUrl: 'https://github.com/o/r/pull/1', pushed: true, remoteBranchGone: false } as never))
      .toBe('merged')
    expect(stageOfWorktree(WT, { merged: true, prUrl: null, pushed: false, remoteBranchGone: false } as never))
      .toBe('merged')
  })

  it('classifies a pushed branch with a PR url as in-review', () => {
    expect(stageOfWorktree(WT, { merged: false, prUrl: 'https://github.com/o/r/pull/1', pushed: true, remoteBranchGone: false } as never))
      .toBe('in-review')
  })

  it('classifies everything else as developing', () => {
    // no status probe yet
    expect(stageOfWorktree(WT, undefined)).toBe('developing')
    // pushed but no PR recorded — the next step is still submit-PR
    expect(stageOfWorktree(WT, { merged: false, prUrl: null, pushed: true, remoteBranchGone: false } as never))
      .toBe('developing')
    // never pushed
    expect(stageOfWorktree(WT, { merged: false, prUrl: null, pushed: false, remoteBranchGone: false } as never))
      .toBe('developing')
  })
})