/**
 * Browser-half smoke tests for the branch-directory surface: locale parity for
 * the header popover, its dialogs, the header chip and the composer's branch
 * picker — plus the one copy rule that outranks style, because the names were
 * unreadable: the user reads "分支目录 / branch directory" and never the
 * implementation words.
 */

import { describe, expect, it } from 'vitest'
import { en, zh, type WorktreeKey } from '../src/client/conversation/worktree/locales.ts'
import { en as pickerEn, zh as pickerZh } from '../src/client/conversation/git-graph/locales.ts'
import { en as chipEn, zh as chipZh } from '../src/client/conversation/session-lane-locales.ts'

describe('worktree locales', () => {
  it('zh is the key source of truth and exposes the expected set', () => {
    const expected: WorktreeKey[] = [
      // the header popover: facts, the PR action, the single delete action, notices
      'menu.aria',
      'menu.path',
      'menu.pr',
      'menu.delete',
      'menu.refresh',
      'menu.running',
      'menu.selfTeardown',
      // the dialogs those actions open
      'worktree.prTitle',
      'worktree.deleteTitle',
      'worktree.deleteBranch',
      'worktree.deleteForce',
      'dialog.cancel',
      'error.permissionDenied',
      'error.worktreeBusy',
      'error.notMerged',
    ]
    for (const key of expected) {
      expect(zh[key], `zh["${key}"] must exist`).toBeTypeOf('string')
      expect(zh[key].length, `zh["${key}"] must be non-empty`).toBeGreaterThan(0)
    }
  })

  it('drops the copy of the removed sidebar page', () => {
    // The panel is gone; its keys must not linger as dead strings.
    const dead = Object.keys(zh).filter((key) => key.startsWith('panel.') || key.startsWith('entry.'))
    expect(dead).toEqual([])
  })

  it('en is a complete translation of the zh key set', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
    for (const key of zhKeys) {
      expect(en[key as WorktreeKey], `en["${key}"] must be a non-empty string`).toBeTypeOf('string')
      expect((en[key as WorktreeKey] as string).length).toBeGreaterThan(0)
    }
  })

  it('never shows the implementation words to the user', () => {
    // "worktree" / "lane" are how the code is organized, not what a user is
    // looking at: every user-visible string in this surface says 分支目录 /
    // "branch directory" instead. Without this the next refactor quietly puts
    // the jargon back into the UI.
    const jargon = /worktree|work tree|lane/i
    const dictionaries: Array<[string, Record<string, string>]> = [
      ['worktree', zh],
      ['worktree/en', en],
      ['git-graph', pickerZh],
      ['git-graph/en', pickerEn],
      ['session-lane', chipZh],
      ['session-lane/en', chipEn],
    ]
    for (const [name, dictionary] of dictionaries) {
      for (const [key, value] of Object.entries(dictionary)) {
        // Placeholders interpolate numbers and are never read as words.
        const visible = value.replace(/\{[a-zA-Z]+\}/g, '')
        expect(visible, `${name}["${key}"] leaks implementation wording`).not.toMatch(jargon)
      }
    }
  })
})