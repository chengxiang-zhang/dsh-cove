// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Translate } from '../src/client/lark-inbox/i18n.ts'
import { LarkInboxWizard, LARK_WIZARD_ROUTE_BASE, WIZARD_POLL_INTERVAL_MS } from '../src/client/lark-inbox/wizard.tsx'
import { larkWizardVisible } from '../src/client/settings/lark-inbox.tsx'
import { en } from '../src/client/lark-inbox/i18n.ts'

const t: Translate = (key, params) => {
  let text = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

function response(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => payload } as Response
}

function body(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('LarkInboxWizard', () => {
  it('shows idle actions, the create-new verification URL and QR, then polls to connected', async () => {
    let statusCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `${LARK_WIZARD_ROUTE_BASE}/start-new`) return response({ verificationUrl: 'https://open.feishu.cn/verify/abc', qr: '/tmp/qr.png' })
      if (url === `${LARK_WIZARD_ROUTE_BASE}/status`) {
        statusCalls += 1
        if (statusCalls < 3) return response({ phase: statusCalls === 1 ? 'idle' : 'awaiting-browser' })
        return response({ phase: 'done', appId: 'cli_new', needsSecretPaste: false })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<LarkInboxWizard t={t}/>)
    expect(screen.getByRole('button', { name: 'Create new bot' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Bind existing bot' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Create new bot' }))
    expect(await screen.findByRole('link', { name: 'https://open.feishu.cn/verify/abc' })).toBeTruthy()
    const qr = screen.getByRole('img', { name: 'Feishu authorization QR code' })
    expect(qr.getAttribute('src')).toBe('/lark-inbox/wizard/qr.png')
    expect(container.querySelector('[data-dsh-part="authorization"]')).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(WIZARD_POLL_INTERVAL_MS) })
    expect(await screen.findByText('Connected cli_new')).toBeTruthy()
    expect(fetchMock.mock.calls.some(call => String(call[0]) === '/lark-inbox/wizard/status')).toBe(true)
  })

  it('binds an existing bot while sending the secret only in finish-bind', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/status')) return response({ phase: 'idle' })
      if (url.endsWith('/start-bind')) return response({ consoleUrl: 'https://open.feishu.cn/app/cli_bound' })
      if (url.endsWith('/finish-bind')) return response({ ok: true })
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<LarkInboxWizard t={t}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Bind existing bot' }))
    const appId = screen.getByLabelText('App ID')
    const appSecret = screen.getByLabelText('App Secret')
    expect(appSecret.getAttribute('type')).toBe('password')
    fireEvent.change(appId, { target: { value: ' cli_bound ' } })
    fireEvent.change(appSecret, { target: { value: 'secret-value' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bind' }))
    expect(await screen.findByRole('link', { name: 'https://open.feishu.cn/app/cli_bound' })).toBeTruthy()
    const startCall = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/start-bind'))
    expect(body(startCall?.[1] as RequestInit | undefined)).toEqual({ appId: 'cli_bound' })
    expect(JSON.stringify(startCall?.[1] ?? {})).not.toContain('secret-value')
    expect(container.querySelector('[data-dsh-part="bind-finish"]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Finish bind' }))
    expect(await screen.findByText('Connected cli_bound')).toBeTruthy()
    const finishCall = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/finish-bind'))
    expect(body(finishCall?.[1] as RequestInit | undefined)).toEqual({ appSecret: 'secret-value' })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Create new bot' })).toBeTruthy()
  })

  it('cancels an active flow and returns to idle', async () => {
    let statusCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/status')) {
        statusCalls += 1
        return response({ phase: statusCalls === 1 ? 'idle' : 'awaiting-browser' })
      }
      if (url.endsWith('/start-new')) return response({ verificationUrl: 'https://open.feishu.cn/verify/cancel', qr: null })
      if (url.endsWith('/cancel')) return response({ ok: true })
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<LarkInboxWizard t={t}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Create new bot' }))
    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(cancel.hasAttribute('disabled')).toBe(false))
    fireEvent.click(cancel)
    await waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/cancel'))).toBe(true))
    expect(screen.getByRole('button', { name: 'Create new bot' })).toBeTruthy()
  })

  it('surfaces failure copy and lets the user go back', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/status')) return response({ phase: 'idle' })
      if (url.endsWith('/start-new')) return response({ error: 'lark-cli missing' }, false, 500)
      throw new Error(`unexpected ${url}`)
    }))
    render(<LarkInboxWizard t={t}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Create new bot' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Connection failed')
    expect(screen.getByText('lark-cli missing')).toBeTruthy()
    expect(screen.getByText(/install and log in/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Bind existing bot' })).toBeTruthy()
  })
})

/**
 * The settings card hides the connection wizard while the feature is off: the
 * host refuses those writes (lark-inbox-disabled), so showing the wizard would
 * only offer an action that cannot succeed.
 */
describe('LarkSettingsPage wizard visibility', () => {
  const state = (text: string) => ({ enabled: { text } }) as Parameters<typeof larkWizardVisible>[0]
  it('hides the wizard only when the feature is explicitly disabled', () => {
    expect(larkWizardVisible(state(''))).toBe(true)
    expect(larkWizardVisible(state('true'))).toBe(true)
    expect(larkWizardVisible(state('false'))).toBe(false)
  })
})
