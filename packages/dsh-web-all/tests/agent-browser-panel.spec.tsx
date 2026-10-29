// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AgentBrowserPanel } from '../src/client/sidebar/agent-browser.tsx'
import { rightPaneZh, type RightPaneLocaleKey } from '../src/client/sidebar/right-pane-i18n.ts'

const originalFetch = globalThis.fetch
const t = (key: RightPaneLocaleKey) => rightPaneZh[key]
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; vi.restoreAllMocks() })

function envelope(value: unknown) { return new Response(JSON.stringify({ ok: true, value }), { status: 200, headers: { 'content-type': 'application/json' } }) }
function denied(message = 'loopback same-origin access only') { return new Response(JSON.stringify({ ok: false, error: { code: 'forbidden', message } }), { status: 403, headers: { 'content-type': 'application/json' } }) }

describe('AgentBrowserPanel', () => {
  it('shows the isolated-mode explanation when extension mode is unavailable', async () => {
    globalThis.fetch = vi.fn(async () => envelope({ mode: 'launch', state: 'unavailable', ownedByThisSession: false, busy: false, liveView: false })) as never
    const { container } = render(<AgentBrowserPanel sessionId="s1" t={t}/>)
    await waitFor(() => expect(container.textContent).toContain('当前使用独立浏览器模式'))
    expect(container.querySelector('button:last-child')?.hasAttribute('disabled')).toBe(true)
  })

  it('connects the selected session through the attended control route', async () => {
    let connected = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/connect')) connected = true
      return envelope({ mode: 'extension', state: connected ? 'connected' : 'disconnected', ownedByThisSession: connected, busy: false, liveView: false })
    })
    globalThis.fetch = fetchMock as never
    const { getByText, container } = render(<AgentBrowserPanel sessionId="s1" t={t}/>)
    await waitFor(() => expect(getByText('连接本机 Chrome')).toBeTruthy())
    fireEvent.click(getByText('连接本机 Chrome'))
    await waitFor(() => expect(container.textContent).toContain('本机 Chrome 已连接'))
    expect(fetchMock).toHaveBeenCalledWith('/api/playwright-sessions/connect', expect.objectContaining({ method: 'POST', body: JSON.stringify({ sessionId: 's1' }) }))
  })

  it('reports a refused control-plane call as an admission problem, not isolated mode', async () => {
    globalThis.fetch = vi.fn(async () => denied()) as never
    const { container } = render(<AgentBrowserPanel sessionId="s1" t={t}/>)
    await waitFor(() => expect(container.textContent).toContain('无法连接本机 Chrome'))
    // The misleading isolated-mode pill must not describe a refused request.
    expect(container.textContent).not.toContain('当前使用独立浏览器模式')
    expect(container.querySelector('[data-state=\"error\"]')).toBeTruthy()
  })

  it('does not reveal the owning session when Chrome is busy elsewhere', async () => {
    globalThis.fetch = vi.fn(async () => envelope({ mode: 'extension', state: 'disconnected', ownedByThisSession: false, busy: true, liveView: false })) as never
    const { container } = render(<AgentBrowserPanel sessionId="s2" t={t}/>)
    await waitFor(() => expect(container.textContent).toContain('本机 Chrome 正被另一个会话使用'))
    expect(container.textContent).not.toContain('s1')
  })
})
