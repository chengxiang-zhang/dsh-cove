/**
 * The Feishu settings tab: field inventory, namespace routing, and dictionary.
 *
 * Two things this tab got wrong once and would get wrong silently again:
 *
 * - a host schema field that no row edits (the inbound admission switch
 *   `dropAppMessages` was added on the host and never reached the page), and
 * - a credential written into the wrong namespace (`lark-inbox` is the read-only
 *   compatibility copy; the shared application lives in `feishu`).
 *
 * The page cannot be rendered here: the pinned SDK cohort in this repository does
 * not ship the 0.2 settings primitives (that is why `primitives-0.2.ts` exists),
 * so `SettingsForm` / `SettingsFormModel` are undefined in a unit test. The
 * inventory is therefore checked on the declared field lists, the schema those
 * lists must track, the scope adapter, and the page source that wires the rows.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  FEISHU_CREDENTIAL_FIELDS,
  FEISHU_NAMESPACE,
  LARK_INBOX_FIELDS,
  LARK_INBOX_NAMESPACE,
  feishuCredentialsScope,
  larkInboxScope,
} from '../src/client/settings/lark-inbox.tsx'
import { en, makeT, zh, type LarkKey } from '../src/client/lark-inbox/i18n.ts'
import type { SettingsFormScope, SettingsFormScopeSnapshot } from '../src/client/settings/primitives-0.2.ts'

const packageRoot = process.cwd()

/** Read one source file of this package. */
async function source(path: string): Promise<string> {
  return await readFile(resolve(packageRoot, path), 'utf8')
}

/**
 * Field names of one `z.object({...})` schema block.
 *
 * The host schema is the fact source for what the page must be able to edit, so
 * the test reads it instead of restating it; a field added there without a row
 * here turns this spec red rather than shipping as an invisible setting.
 */
function schemaFields(text: string, marker: string): string[] {
  const start = text.indexOf(marker)
  if (start < 0) throw new Error(`schema block not found: ${marker}`)
  const rest = text.slice(start + marker.length)
  // The block closes with `}) as unknown as z<Interface>`.
  const end = rest.search(/\}\s*\)\s*as unknown as/u)
  if (end < 0) throw new Error(`schema block end not found after: ${marker}`)
  return [...rest.slice(0, end).matchAll(/^\s{2}([A-Za-z][\w]*):/gmu)].map(match => match[1] as string)
}

/**
 * A scope whose only job is to record what a page asked to read and write.
 *
 * Mirrors the shape `tests/notify-settings.spec.ts` uses: the aggregated
 * `web-all` entry, with each capability as one namespace inside it.
 */
function fakeEntry(value: Record<string, unknown>, options: { writable?: boolean; revision?: number } = {}) {
  const mutate = vi.fn().mockResolvedValue(true)
  const listeners = new Set<() => void>()
  const snapshot: SettingsFormScopeSnapshot<Record<string, unknown>> = {
    status: 'ready',
    value,
    base: { 'lark-inbox': { enabled: true }, feishu: { domain: 'feishu' } },
    user: { 'lark-inbox': { enabled: true }, feishu: { appId: 'cli_configured' } },
    writable: options.writable ?? true,
    revision: options.revision ?? 11,
  }
  const scope: SettingsFormScope<Record<string, unknown>> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate,
  }
  return { scope, mutate, snapshot }
}

describe('Feishu settings field inventory', () => {
  it('covers every lark-inbox schema field except the read-only legacy credentials', async () => {
    const declared = schemaFields(await source('src/host/services/lark-inbox/config.ts'), 'export const Config = z.object({')
    // `appId` / `appSecret` stay in the old namespace only so an installation
    // configured before the shared namespace keeps working; the page never
    // writes them (the wizard owns the automatic path, the credential form owns
    // the manual one, and both target `feishu`).
    const legacyCredentialFields = ['appId', 'appSecret']
    expect(declared.filter(field => !legacyCredentialFields.includes(field)).sort()).toEqual([...LARK_INBOX_FIELDS].sort())
    expect(LARK_INBOX_FIELDS).toContain('dropAppMessages')
  })

  it('edits exactly the shared feishu credential fields', async () => {
    const declared = schemaFields(await source('src/host/services/feishu/config.ts'), 'export const Config = z.object({')
    expect(declared.sort()).toEqual([...FEISHU_CREDENTIAL_FIELDS].sort())
    expect(FEISHU_CREDENTIAL_FIELDS).toEqual(['appId', 'appSecret', 'domain'])
  })

  it('declares a staged spec for every behavior field, and the secret one write-only', async () => {
    const page = await source('src/client/settings/lark-inbox.tsx')
    // The behavior form names each spec explicitly (the projection then walks
    // LARK_INBOX_FIELDS), so a field dropped from the constructor loses its
    // editor even though the list still claims it.
    for (const call of ["booleanField('enabled')", "booleanField('announceToAgent')", "settingsTextField('domain')", "booleanField('requireMentionInGroup')", "booleanField('dropAppMessages')", 'openIdsField()', "settingsTextField('queueDir')", "settingsNumberField('maxAttempts')", "settingsNumberField('staleTimeoutMs')"]) {
      expect(page).toContain(call)
    }
    // The secret is a write-only channel, never a path-write spec: a path write
    // would let an empty draft clear the stored secret.
    expect(page).toContain("settingsSecretField('appSecret'")
    expect(page).not.toContain("settingsTextField('appSecret')")
  })

  it('renders one row per credential field plus the admission switch', async () => {
    const page = await source('src/client/settings/lark-inbox.tsx')
    for (const id of ['feishu-app-id', 'feishu-app-secret', 'feishu-domain']) expect(page).toContain(`id="${id}"`)
    expect(page).toContain('field="dropAppMessages"')
    // The secret control is rendered from the write-only projection and edits
    // through the credential form, so its draft never comes from the snapshot.
    expect(page).toContain('...credentials.domain')
    expect(page).toContain('text={credentials.appSecret.text}')
    expect(page).toContain("credentialEdit('appSecret'")
    // Nothing in the page may read a stored secret value.
    expect(page).not.toContain('credentials.appSecret.value')
  })
})

describe('Feishu settings namespace routing', () => {
  it('names the namespaces the host registers', () => {
    expect(LARK_INBOX_NAMESPACE).toBe('lark-inbox')
    expect(FEISHU_NAMESPACE).toBe('feishu')
  })

  it('writes behavior fields under lark-inbox and credentials under feishu', async () => {
    const { scope, mutate } = fakeEntry({})
    await larkInboxScope(scope).mutate([{ op: 'set', path: ['dropAppMessages'], value: false }])
    await feishuCredentialsScope(scope).mutate([{ op: 'set', path: ['appSecret'], value: 'secret-value' }])
    expect(mutate.mock.calls[0]?.[0]).toEqual([{ op: 'set', path: ['lark-inbox', 'dropAppMessages'], value: false }])
    expect(mutate.mock.calls[1]?.[0]).toEqual([{ op: 'set', path: ['feishu', 'appSecret'], value: 'secret-value' }])
  })

  it('keeps the revision gate and the read projections of each namespace apart', () => {
    const { scope } = fakeEntry({ 'lark-inbox': { enabled: false }, feishu: { appId: 'cli_from_document' } })
    const inbox = larkInboxScope(scope).getSnapshot()
    const credentials = feishuCredentialsScope(scope).getSnapshot()
    expect(inbox.value).toEqual({ enabled: false })
    expect(credentials.value).toEqual({ appId: 'cli_from_document' })
    expect(inbox.revision).toBe(11)
    expect(credentials.revision).toBe(11)
    expect(credentials.base).toEqual({ domain: 'feishu' })
  })

  it('never reads a secret the host would have stripped', () => {
    const { scope } = fakeEntry({ feishu: { appId: 'cli_from_document' } })
    const credentials = feishuCredentialsScope(scope).getSnapshot()
    // The host removes `role('secret')` fields from every read, so this is what
    // the page actually receives: an appId and no secret at all.
    expect(credentials.value?.appSecret).toBeUndefined()
  })
})

describe('Feishu dictionary', () => {
  it('keeps an English key for every Chinese key', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const key of Object.keys(zh) as LarkKey[]) expect(en[key], key).toBeDefined()
  })

  it('leaves no key without a translation in either language', () => {
    for (const key of Object.keys(zh) as LarkKey[]) {
      expect(zh[key].trim(), key).not.toBe('')
      expect(en[key].trim(), key).not.toBe('')
    }
  })

  it('translates the credential area and the admission switch on both sides', () => {
    for (const key of ['settings.credentialsTitle', 'settings.credentialsIntro', 'settings.appId', 'settings.appSecret', 'settings.appSecretState', 'settings.credentialDomain', 'settings.dropAppMessages'] as LarkKey[]) {
      expect(zh[key].trim(), key).not.toBe('')
      expect(en[key].trim(), key).not.toBe('')
    }
    // A write-only field says so in both languages rather than pretending to
    // know whether a secret is stored.
    expect(zh['settings.appSecretHint']).toContain('留空表示保持不变')
    expect(en['settings.appSecretHint']).toContain('Blank keeps the stored secret')
  })

  it('does not promise that credentials take effect immediately', () => {
    // Credentials hot-reload, but the long connection is established
    // asynchronously: the copy must say the host will try, not that events flow.
    expect(zh['wizard.connectedHint']).toContain('将尝试建立')
    expect(zh['wizard.connectedHint']).not.toBe('凭据已就绪，飞书事件将进入当前会话。')
    expect(en['wizard.connectedHint']).toContain('will try to open the long connection')
    expect(zh['settings.credentialsIntro']).toContain('异步')
    expect(en['settings.credentialsIntro']).toContain('asynchronously')
  })

  it('picks the table from the document language and substitutes named parameters', () => {
    const zhT = makeT({ documentElement: { lang: 'zh-CN' } } as unknown as Document)
    const enT = makeT({ documentElement: { lang: 'en' } } as unknown as Document)
    expect(zhT('settings.credentialsTitle')).toBe(zh['settings.credentialsTitle'])
    expect(enT('settings.credentialsTitle')).toBe(en['settings.credentialsTitle'])
    expect(zhT('wizard.connected', { appId: 'cli_x' })).toBe('已连接 cli_x')
    expect(enT('wizard.connected', { appId: 'cli_x' })).toBe('Connected cli_x')
    // No document (a non-browser import) falls back to English rather than throwing.
    expect(makeT(undefined)('settings.tab')).toBe('Feishu')
  })
})