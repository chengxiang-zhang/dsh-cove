/**
 * The shared family-settings scope adapter and the notification dictionary.
 *
 * The adapter is now used by two settings tabs, and a path-prefix bug in it
 * would silently write one capability's fields into another capability's
 * namespace — the kind of mistake that looks like "my setting did not save"
 * and costs an afternoon. The dictionary parity check is the same gate the
 * other localized surfaces use: `zh` is the key set of record.
 */

import { describe, expect, it, vi } from 'vitest'
import { FAMILY_SETTINGS_NAMESPACE, familyNamespaceScope } from '../src/client/settings/family-scope.ts'
import { en as notifyEn, zh as notifyZh, makeT as makeNotifyT } from '../src/client/notify/i18n.ts'
import type { SettingsFormScope, SettingsFormScopeSnapshot } from '../src/client/settings/primitives-0.2.ts'

/** A scope whose only job is to record what a page asked to read and write. */
function fakeScope(value: Record<string, unknown>, options: { writable?: boolean; revision?: number } = {}) {
  const mutate = vi.fn().mockResolvedValue(true)
  const listeners = new Set<() => void>()
  const snapshot: SettingsFormScopeSnapshot<Record<string, unknown>> = {
    status: 'ready',
    value,
    base: { notify: { enabled: true } },
    user: { notify: { feedLimit: 5 } },
    writable: options.writable ?? true,
    revision: options.revision ?? 7,
  }
  const scope: SettingsFormScope<Record<string, unknown>> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate,
  }
  return { scope, mutate, snapshot }
}

describe('family namespace scope', () => {
  it('names the aggregated runtime entry', () => {
    expect(FAMILY_SETTINGS_NAMESPACE).toBe('web-all')
  })

  it('drills into the capability namespace and keeps the transport fields intact', () => {
    const { scope } = fakeScope({ notify: { enabled: true, feedLimit: 3 }, 'lark-inbox': { enabled: false } })
    const narrowed = familyNamespaceScope<{ enabled?: boolean; feedLimit?: number }>(scope, 'notify')
    const snapshot = narrowed.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.writable).toBe(true)
    expect(snapshot.revision).toBe(7)
    expect(snapshot.value).toEqual({ enabled: true, feedLimit: 3 })
    // The base/user projections are narrowed the same way, so a page can tell
    // an overridden field from a defaulted one.
    expect(snapshot.base).toEqual({ enabled: true })
    expect(snapshot.user).toEqual({ feedLimit: 5 })
  })

  it('reports nothing for a namespace the host does not serve yet', () => {
    const { scope } = fakeScope({})
    expect(familyNamespaceScope<{ enabled?: boolean }>(scope, 'notify').getSnapshot().value).toBeUndefined()
  })

  it('prefixes every write path with the namespace, and passes the revision gate through', async () => {
    const { scope, mutate } = fakeScope({})
    const narrowed = familyNamespaceScope<{ enabled?: boolean }>(scope, 'notify')
    await narrowed.mutate([
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: ['feishuMode'], value: 'idle' },
      { op: 'unset', path: ['feedLimit'] },
    ], 7)
    expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['notify', 'enabled'], value: true },
      { op: 'set', path: ['notify', 'feishuMode'], value: 'idle' },
      { op: 'unset', path: ['notify', 'feedLimit'] },
    ], 7)
  })

  it('keeps two capabilities on separate paths', async () => {
    const { scope, mutate } = fakeScope({})
    await familyNamespaceScope(scope, 'notify').mutate([{ op: 'set', path: ['enabled'], value: true }])
    await familyNamespaceScope(scope, 'lark-inbox').mutate([{ op: 'set', path: ['enabled'], value: false }])
    expect(mutate.mock.calls[0]?.[0]).toEqual([{ op: 'set', path: ['notify', 'enabled'], value: true }])
    expect(mutate.mock.calls[1]?.[0]).toEqual([{ op: 'set', path: ['lark-inbox', 'enabled'], value: false }])
  })

  it('forwards subscriptions so a saved value reaches the page', () => {
    const { scope } = fakeScope({})
    const listener = vi.fn()
    const off = familyNamespaceScope(scope, 'notify').subscribe(listener)
    expect(typeof off).toBe('function')
    off()
  })
})

describe('notification dictionary', () => {
  it('keeps an English key for every Chinese key', () => {
    expect(Object.keys(notifyEn).sort()).toEqual(Object.keys(notifyZh).sort())
  })

  it('leaves no key without a translation in either language', () => {
    for (const key of Object.keys(notifyZh) as Array<keyof typeof notifyZh>) {
      expect(notifyZh[key].trim()).not.toBe('')
      expect(notifyEn[key].trim()).not.toBe('')
    }
  })

  it('picks the table from the document language', () => {
    const zhT = makeNotifyT({ documentElement: { lang: 'zh-CN' } } as unknown as Document)
    const enT = makeNotifyT({ documentElement: { lang: 'en' } } as unknown as Document)
    expect(zhT('settings.tab')).toBe('通知')
    expect(enT('settings.tab')).toBe('Notifications')
    // No document (a non-browser import) falls back to English rather than throwing.
    expect(makeNotifyT(undefined)('settings.tab')).toBe('Notifications')
  })

  it('substitutes named parameters and leaves an unknown one alone', () => {
    const t = makeNotifyT({ documentElement: { lang: 'en' } } as unknown as Document)
    expect(t('settings.title', { missing: 'x' })).toBe('Run-finished notifications')
  })
})