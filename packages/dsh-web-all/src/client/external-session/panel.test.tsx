// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ExternalSessionPanel } from './panel.tsx'
import { createExternalSessionStore } from './store.ts'
import { ExternalSessionApiError, type ExternalSessionApi } from './api.ts'
import { interpolate, zh } from './i18n.ts'
import type { ExternalSessionLocaleKey } from './i18n.ts'
import type { ExternalSessionView } from './types.ts'

const t = (key: ExternalSessionLocaleKey, params?: Record<string, string | number>): string =>
  interpolate(zh[key], params)

function api(overrides: Partial<ExternalSessionApi> = {}): ExternalSessionApi {
  return {
    list: async () => [],
    continueTurn: async () => [],
    cancelTurn: async () => [],
    closeSession: async () => [],
    ...overrides,
  }
}

function idle(overrides: Partial<ExternalSessionView> = {}): ExternalSessionView {
  return {
    id: 'ext-1',
    provider: 'claude',
    title: '修登录 bug',
    status: 'idle',
    cwd: '/tmp',
    createdAt: '2026-11-04T09:00:00Z',
    canContinue: true,
    lastTurnAt: new Date().toISOString(),
    turns: [{ n: 1, prompt: '把登录页修好', status: 'completed', durationMs: 42_000, usage: { input: 1234, output: 567 }, costUsd: 0.03, result: '已修复并跑了测试' }],
    ...overrides,
  }
}

afterEach(() => { cleanup() })

describe('ExternalSessionPanel states', () => {
  it('renders the empty state without an API that has data', async () => {
    const face = api({ list: async () => [] })
    const store = createExternalSessionStore(face)
    const { getByText, container } = render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await waitFor(() => expect(getByText(zh['list.empty'])).toBeTruthy())
    expect(container.querySelector('[data-dsh-part="list"]')).toBeNull()
    expect(container.querySelector('[data-dsh-part="detail"]')).toBeNull()
  })

  it('explains a refused request instead of pretending it is empty', async () => {
    const face = api({ list: async () => { throw new ExternalSessionApiError('loopback same-origin access only', 'forbidden', 403) } })
    const store = createExternalSessionStore(face)
    const { getByText, container } = render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await waitFor(() => expect(getByText(zh['state.forbidden'])).toBeTruthy())
    expect(container.textContent).not.toContain(zh['list.empty'])
  })

  it('explains a host without the route family', async () => {
    const face = api({ list: async () => { throw new ExternalSessionApiError('response is not JSON', 'unavailable', 200) } })
    const store = createExternalSessionStore(face)
    const { getByText } = render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await waitFor(() => expect(getByText(zh['state.unavailable'])).toBeTruthy())
  })

  it('shows an empty timeline for a session that has not run a turn yet', async () => {
    const face = api({ list: async () => [idle({ turns: [] })] })
    const store = createExternalSessionStore(face)
    const { getByText } = render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await waitFor(() => expect(getByText(zh['timeline.empty'])).toBeTruthy())
  })
})

describe('ExternalSessionPanel content', () => {
  it('lists sessions and renders the turn timeline with duration, usage and estimated cost', async () => {
    const face = api({ list: async () => [idle()] })
    const store = createExternalSessionStore(face)
    const { getAllByText, getByText, container } = render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await waitFor(() => expect(container.querySelector('[data-dsh-part="detail"]')).toBeTruthy())
    expect(container.querySelector('[data-dsh-part="detail-title"]')?.textContent).toBe('修登录 bug')
    expect(container.querySelector('[data-dsh-part="session-provider"]')?.textContent).toBe('claude')
    expect(getAllByText('空闲').length).toBeGreaterThan(0)
    expect(getByText('第 1 轮')).toBeTruthy()
    expect(container.querySelector('[data-dsh-part="turn-status"]')?.textContent).toBe(zh['turn.status.completed'])
    expect(container.querySelector('[data-dsh-part="turn-duration"]')?.textContent).toBe('耗时 42.0s')
    expect(container.querySelector('[data-dsh-part="turn-usage"]')?.textContent).toBe('用量 1.2k 入 / 567 出')
    // 成本必须标注为估值，不能当成账单数字。
    expect(container.querySelector('[data-dsh-part="turn-cost"]')?.textContent).toBe('估算 $0.03')
    expect(container.querySelector('[data-dsh-part="turn-prompt"]')?.textContent).toBe('把登录页修好')
    expect(container.querySelector('[data-dsh-part="turn-result"]')?.textContent).toContain('已修复并跑了测试')
  })

  it('selects the session named by the navigation parameter', async () => {
    const first = idle({ id: 'ext-a', title: 'A', lastTurnAt: '2026-11-04T10:00:00Z' })
    const second = idle({ id: 'ext-b', title: 'B', lastTurnAt: '2026-11-04T12:00:00Z' })
    const face = api({ list: async () => [first, second] })
    const store = createExternalSessionStore(face)
    const { container } = render(<ExternalSessionPanel api={face} store={store} t={t} initialSessionId="ext-a" />)
    await waitFor(() => expect(container.querySelector('[data-dsh-part="detail"]')?.getAttribute('data-session-id')).toBe('ext-a'))
  })
})

describe('ExternalSessionPanel actions', () => {
  it('dispatches the next turn with the session id and the typed prompt', async () => {
    const next = idle({ turns: [{ n: 2, prompt: '再看一处', status: 'completed' }] })
    const continueTurn = vi.fn(async () => [next])
    const face = api({ list: async () => [idle()], continueTurn })
    const store = createExternalSessionStore(face)
    const { container } = render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await waitFor(() => expect(container.querySelector('[data-dsh-part="detail"]')).toBeTruthy())
    const input = container.querySelector('[data-dsh-part="continue-input"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '再看一处' } })
    fireEvent.click(container.querySelector('[data-dsh-part="continue-submit"]') as HTMLButtonElement)
    await waitFor(() => expect(continueTurn).toHaveBeenCalledWith('ext-1', '再看一处', undefined))
    await waitFor(() => expect(container.querySelector('[data-dsh-part="turn-prompt"]')?.textContent).toBe('再看一处'))
    expect(input.value).toBe('')
  })

  it('offers cancel only while running and close only while not closed', async () => {
    const running = idle({ status: 'running', turns: [{ n: 1, prompt: '跑着', status: 'running' }] })
    const face = api({ list: async () => [running] })
    const store = createExternalSessionStore(face)
    const { container } = render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await waitFor(() => expect(container.querySelector('[data-dsh-part="cancel"]')).toBeTruthy())
    expect(container.querySelector('[data-dsh-part="close"]')).toBeTruthy()

    cleanup()
    const closed = idle({ status: 'closed' })
    const closedFace = api({ list: async () => [closed] })
    const closedStore = createExternalSessionStore(closedFace)
    const second = render(<ExternalSessionPanel api={closedFace} store={closedStore} t={t} />)
    await waitFor(() => expect(second.container.querySelector('[data-dsh-part="blocked"]')).toBeTruthy())
    expect(second.container.querySelector('[data-dsh-part="cancel"]')).toBeNull()
    expect(second.container.querySelector('[data-dsh-part="close"]')).toBeNull()
    expect((second.container.querySelector('[data-dsh-part="continue-submit"]') as HTMLButtonElement).disabled).toBe(true)
    expect(second.container.querySelector('[data-dsh-part="blocked"]')?.textContent).toBe(zh['blocked.closed'])
  })

  it('shows the host failure inline when an action is rejected', async () => {
    const face = api({
      list: async () => [idle()],
      closeSession: async () => { throw new ExternalSessionApiError('busy', 'failed', 429) },
    })
    const store = createExternalSessionStore(face)
    const { container } = render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await waitFor(() => expect(container.querySelector('[data-dsh-part="detail"]')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-dsh-part="close"]') as HTMLButtonElement)
    await waitFor(() => expect(container.querySelector('[data-dsh-part="action-error"]')?.textContent).toBe('读取外援会话失败：busy'))
    // 失败不改写已有列表：会话还在。
    expect(container.querySelector('[data-dsh-part="detail"]')).toBeTruthy()
  })
})

describe('ExternalSessionPanel running state', () => {
  afterEach(() => { vi.useRealTimers() })

  it('renders the live turn without a duration or result', async () => {
    const live = idle({ status: 'running', turns: [{ n: 2, prompt: '第二轮的输入', status: 'running', startedAt: new Date().toISOString() }] })
    const face = api({ list: async () => [live] })
    const store = createExternalSessionStore(face)
    const { container } = render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await waitFor(() => expect(container.querySelector('[data-dsh-part="turn-status"]')?.textContent).toBe(zh['turn.status.running']))
    expect(container.querySelector('[data-dsh-part="turn-duration"]')).toBeNull()
    expect(container.querySelector('[data-dsh-part="turn-usage"]')).toBeNull()
    expect(container.querySelector('[data-dsh-part="turn-result"]')?.textContent).toBe(zh['timeline.noResult'])
  })

  it('polls while a turn runs and stops once nothing is running', async () => {
    vi.useFakeTimers()
    let running = true
    const list = vi.fn(async () => [idle({ status: running ? 'running' : 'idle' })])
    const face = api({ list })
    const store = createExternalSessionStore(face)

    render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await act(async () => { await Promise.resolve() })
    // 首次渲染至少读一次；running 出现会让 effect 重跑一次，这不是轮询。
    const baseline = list.mock.calls.length
    expect(baseline).toBeGreaterThanOrEqual(1)

    await act(async () => { vi.advanceTimersByTime(1_500) })
    expect(list.mock.calls.length).toBe(baseline + 1)

    running = false
    await act(async () => { vi.advanceTimersByTime(1_500) })
    const settled = list.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(list.mock.calls.length).toBe(settled)
  })

  it('keeps the follow-up action enabled for a failed session that the host can resume', async () => {
    const failed = idle({ status: 'failed', canContinue: true, turns: [{ n: 1, prompt: '跑挂了', status: 'failed' }] })
    const face = api({ list: async () => [failed] })
    const store = createExternalSessionStore(face)
    const { container } = render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await waitFor(() => expect(container.querySelector('[data-dsh-part="detail"]')).toBeTruthy())
    expect((container.querySelector('[data-dsh-part="continue-input"]') as HTMLInputElement).disabled).toBe(false)
    expect(container.querySelector('[data-dsh-part="blocked"]')).toBeNull()
  })
})

describe('ExternalSessionPanel host error codes', () => {
  it('says what the code means instead of blaming a missing route', async () => {
    const face = api({ list: async () => { throw new ExternalSessionApiError('gone', 'failed', 404, 'session-unknown') } })
    const store = createExternalSessionStore(face)
    const { container } = render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await waitFor(() => expect(container.textContent).toContain(zh['fail.session-unknown']))
    // 404 带已知 code 时不能显示「宿主没提供这族路由」。
    expect(container.textContent).not.toContain(zh['state.unavailable'])
  })

  it('shows the concurrency answer for a busy host', async () => {
    const face = api({
      list: async () => [idle()],
      closeSession: async () => { throw new ExternalSessionApiError('busy', 'failed', 429, 'busy') },
    })
    const store = createExternalSessionStore(face)
    const { container } = render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await waitFor(() => expect(container.querySelector('[data-dsh-part="detail"]')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-dsh-part="close"]') as HTMLButtonElement)
    await waitFor(() => expect(container.querySelector('[data-dsh-part="action-error"]')?.textContent).toBe(zh['fail.busy']))
  })

  it('treats an accepted continue as accepted even when that turn goes on to fail', async () => {
    // 契约：continue 立刻回 200，轮级失败体现在该轮 status/result 上，不看 HTTP。
    const failed = idle({ turns: [{ n: 2, prompt: '再跑一次', status: 'failed', result: 'auth-required：先登录 CLI' }] })
    const continueTurn = vi.fn(async () => [failed])
    const face = api({ list: async () => [idle()], continueTurn })
    const store = createExternalSessionStore(face)
    const { container } = render(<ExternalSessionPanel api={face} store={store} t={t} />)
    await waitFor(() => expect(container.querySelector('[data-dsh-part="detail"]')).toBeTruthy())
    const input = container.querySelector('[data-dsh-part="continue-input"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '再跑一次' } })
    fireEvent.click(container.querySelector('[data-dsh-part="continue-submit"]') as HTMLButtonElement)
    await waitFor(() => expect(continueTurn).toHaveBeenCalled())
    // 被接纳 ⇒ 输入清空；失败由轮次本身表达。
    await waitFor(() => expect(input.value).toBe(''))
    expect(container.querySelector('[data-dsh-part="turn-status"]')?.textContent).toBe(zh['turn.status.failed'])
    expect(container.querySelector('[data-dsh-part="turn-result"]')?.textContent).toContain('auth-required')
    expect(container.querySelector('[data-dsh-part="action-error"]')).toBeNull()
  })
})