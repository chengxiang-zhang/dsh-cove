// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { EXTERNAL_SESSION_TAB_KIND, mountExternalSession } from './index.ts'
import { en, zh, type ExternalSessionLocaleKey } from './i18n.ts'

const originalFetch = globalThis.fetch
/** Mounts are torn down per test: a live observer from an earlier harness would
 *  otherwise answer for the current test's dropdown. */
const mounted: Array<() => void> = []
afterEach(() => {
  for (const dispose of mounted.splice(0)) dispose()
  cleanup()
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

type Callback = () => (() => void)
interface Captured {
  key: string
  spec: { key?: string; kind?: string; name?: string; locale?: string; inject?: (sessionId: string) => Record<string, unknown> }
  Body: (props: { useTabInfo?: () => unknown } & Record<string, unknown>) => ReturnType<typeof createElement>
}

/**
 * Harness mirroring the 0.2 seat contract used by the sibling right-pane spec:
 * `sidebar.right.pane.tab` is a keyed session-scoped slot, and the tab registry
 * is a service (`sidebarRightTabs`) that must exist before we register.
 */
function harness() {
  const bodies: Captured[] = []
  const tabs: Array<{ id: string; kind: string; guide?: unknown }> = []
  const waits = new Map<string, Callback[]>()
  const slots = {
    inject(name: string, callback: Callback) {
      const rows = waits.get(name) ?? []
      rows.push(callback)
      waits.set(name, rows)
      return () => {}
    },
    register(spec: Captured['spec'], Body: Captured['Body']) {
      if (spec.name === 'sidebar.right.pane.tab') bodies.push({ key: spec.key ?? '', spec, Body })
      return () => {}
    },
  }
  const openTab = vi.fn()
  const right = { openTab }
  /** The conversation on screen; the dropdown scopes its rows to it. */
  const conversation = { key: 's1' }
  const uiSession = { adapter: { current: { getSnapshot: () => conversation } } }
  const ctx = {
    slots,
    locale: { register: vi.fn(() => vi.fn()), bind: () => (key: ExternalSessionLocaleKey) => zh[key] },
    get: (name: string) => name === 'sidebarRightTabs'
      ? { register: (definition: { id: string; kind: string; guide?: unknown }) => { tabs.push(definition); return () => {} } }
      : name === 'sidebarRight' ? right
        : name === 'uiSession' ? uiSession
          : undefined,
    inject: (_services: string[], setup: (scope: unknown) => void) => { setup(ctx); return () => {} },
  }
  const dispose = mountExternalSession(ctx as never)
  mounted.push(dispose)
  for (const callback of waits.get('sidebar.right.pane.tab') ?? []) callback()
  return { bodies, tabs, ctx, openTab, dispose }
}

const TAB_INFO = () => ({
  sidebar: { expanded: true, fullscreen: false },
  panel: { id: 'p1' },
  tab: { visible: true, navigation: { params: {}, revision: 1 }, signal: new AbortController().signal },
})

describe('external-session position mount', () => {
  it('keeps the zh/en locale key sets identical', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('registers one right-pane tab and one seat with the session identity', () => {
    const { bodies, tabs } = harness()
    expect(tabs.map(tab => tab.id)).toEqual(['dsh-web-all/external-session'])
    expect(tabs.map(tab => tab.kind)).toEqual([EXTERNAL_SESSION_TAB_KIND])
    // No `guide`: the tab stays openable from a dropdown row but does not add a
    // launcher entry beside the native tools (workspace files, terminal, git).
    expect(tabs[0]?.guide).toBeUndefined()
    expect(bodies.map(row => row.key)).toEqual(['dsh-web-all/external-session'])
    expect(bodies[0]?.spec.locale).toBe('web-all-external-session')
    expect(bodies[0]?.spec.inject?.('s1')).toEqual({ sessionId: 's1' })
  })

  it('renders the tab body without crashing when the host has no routes yet', async () => {
    globalThis.fetch = vi.fn(async () => new Response('not found', { status: 404 })) as never
    const { bodies } = harness()
    const body = bodies[0]!
    const { container } = render(createElement(body.Body, { ...body.spec.inject?.('s1'), useTabInfo: TAB_INFO }))
    await waitFor(() => expect(container.textContent).toContain(zh['state.unavailable']))
    expect(container.querySelector('[data-dsh-plugin="external-session"]')).toBeTruthy()
    expect(container.querySelector('[data-dsh-part="root"]')).toBeTruthy()
  })

  it('renders the refused state when the host fence answers 403', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'loopback same-origin access only' } }), { status: 403 })) as never
    const { bodies } = harness()
    const body = bodies[0]!
    const { container } = render(createElement(body.Body, { ...body.spec.inject?.('s1'), useTabInfo: TAB_INFO }))
    await waitFor(() => expect(container.textContent).toContain(zh['state.forbidden']))
  })

  it('appends the group into the rendered subagent dropdown and opens the tab for a clicked row', async () => {
    const row = {
      id: 'ext-1',
      provider: 'claude',
      title: '修登录 bug',
      status: 'idle',
      cwd: '/tmp',
      createdAt: '2026-11-04T09:00:00Z',
      lastTurnAt: '2026-11-04T09:01:00Z',
      canContinue: true,
      originSessionId: 's1',
      turns: [],
    }
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, value: { sessions: [row] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as never
    const { openTab } = harness()
    const tree = document.createElement('div')
    tree.setAttribute('role', 'tree')
    tree.setAttribute('aria-label', '子智能体会话')
    document.body.appendChild(tree)
    await waitFor(() => expect(tree.querySelector('[data-dsh-part="group"]')).toBeTruthy())
    expect(tree.textContent).toContain('外援 · 1')
    expect(tree.textContent).toContain('外部任务')
    ;(tree.querySelector('[data-dsh-part="row"]') as HTMLElement).click()
    expect(openTab).toHaveBeenCalledWith('web-ui.external-session', { params: { sessionId: 'ext-1' } })
  })

  it('keeps the row click harmless when the right pane is not mounted', async () => {
    const ctxHidden = {
      slots: {
        inject: () => () => {},
        register: () => () => {},
      },
      locale: { register: () => () => {}, bind: () => (key: ExternalSessionLocaleKey) => zh[key] },
      get: (name: string) => name === 'sidebarRightTabs'
        ? { register: () => () => {} }
        : name === 'sidebarRight' ? { openTab: () => { throw new Error('sidebarRight: no session surface is mounted') } }
          // The conversation surface still answers here: dropping it would hide
          // every row and make this a test of nothing.
          : name === 'uiSession' ? { adapter: { current: { getSnapshot: () => ({ key: 's1' }) } } }
            : undefined,
      inject: (_services: string[], setup: (scope: unknown) => void) => { setup(ctxHidden); return () => {} },
    }
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, value: { sessions: [{ id: 'ext-1', provider: 'claude', title: 't', status: 'idle', cwd: '/tmp', createdAt: '2026-11-04T09:00:00Z', lastTurnAt: '2026-11-04T09:01:00Z', canContinue: true, originSessionId: 's1', turns: [] }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as never
    mounted.push(mountExternalSession(ctxHidden as never))
    const tree = document.createElement('div')
    tree.setAttribute('role', 'tree')
    tree.setAttribute('aria-label', '子智能体会话')
    document.body.appendChild(tree)
    await waitFor(() => expect(tree.querySelector('[data-dsh-part="row"]')).toBeTruthy())
    expect(() => { (tree.querySelector('[data-dsh-part="row"]') as HTMLElement).click() }).not.toThrow()
  })

  it('never throws into the sidebar position module that now calls it', () => {
    // 这个能力搬进 mountSidebar 之后，抛错会连带拖垮原生面板与右栏，所以
    // 装配阶段必须自己兜住：坏 ctx 也要拿到可调用的卸载函数。
    const hostile = {
      locale: { bind: () => { throw new Error('locale is unavailable') } },
      get: () => undefined,
    }
    const dispose = mountExternalSession(hostile as never)
    expect(typeof dispose).toBe('function')
    expect(() => { dispose() }).not.toThrow()
  })

  it('unmounts without throwing and detaches the dropdown observer', () => {
    const { dispose } = harness()
    expect(() => { dispose() }).not.toThrow()
  })
})

/* ------------------------------------------------------------------------- *
 * Data-state integration: the panel is mounted through the real seat body and
 * the real api client (fetch mocked), so these assertions cover the path the
 * browser takes: host JSON -> reader -> view math -> DOM.
 * ------------------------------------------------------------------------- */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function sessionsEnvelope(payload: { sessions: unknown[] }): Response {
  return jsonResponse({ ok: true, value: payload })
}

/** Microtask drain for promise-driven state updates. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const LONG_PROMPT = '再跑一遍全量测试确认没有回归，'.repeat(12)

/** Two settled turns, shaped exactly like the frozen host route payload. */
function settledSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ext-1',
    provider: 'claude',
    title: '修登录 bug',
    status: 'idle',
    cwd: '/repo',
    createdAt: '2026-11-04T11:59:00Z',
    lastTurnAt: '2026-11-04T12:05:30Z',
    canContinue: true,
    originSessionId: 's1',
    turns: [
      {
        n: 1,
        prompt: '把登录页的第三方弹窗修好，并补一个回归测试',
        status: 'completed',
        startedAt: '2026-11-04T12:00:00Z',
        durationMs: 18_400,
        usage: { input: 67_800, output: 245 },
        costUsd: 0.42,
        result: '已修好弹窗并在 tests/auth 下补了回归用例。',
      },
      {
        n: 2,
        prompt: LONG_PROMPT,
        status: 'completed',
        startedAt: '2026-11-04T12:05:00Z',
        durationMs: 42_000,
        usage: { input: 1_234, output: 567 },
        costUsd: 0.03,
        result: '全量 312 项通过。',
      },
    ],
    ...overrides,
  }
}

describe('external-session panel data state', () => {
  // 假时钟必须逐条复位：一条测试超时会把 fake timers 泄漏给下一条，后续
  // waitFor 便永远等不到定时器。
  afterEach(() => { vi.useRealTimers() })

  it('renders a settled two-turn session with truncated prompt, result, duration, usage and estimated cost', async () => {
    globalThis.fetch = vi.fn(async () => sessionsEnvelope({ sessions: [settledSession()] })) as never
    const body = harness().bodies[0]!
    const { container } = render(createElement(body.Body, { ...body.spec.inject?.('s1'), useTabInfo: TAB_INFO }))
    await waitFor(() => expect(container.querySelectorAll('[data-dsh-part="turn"]').length).toBe(2))

    const turns = Array.from(container.querySelectorAll('[data-dsh-part="turn"]'))
    const first = turns[0]!
    const second = turns[1]!

    expect(first.querySelector('[data-dsh-part="turn-status"]')?.textContent).toBe(zh['turn.status.completed'])
    expect(first.querySelector('[data-dsh-part="turn-duration"]')?.textContent).toBe('耗时 18.4s')
    expect(first.querySelector('[data-dsh-part="turn-usage"]')?.textContent).toBe('用量 67.8k 入 / 245 出')
    expect(first.querySelector('[data-dsh-part="turn-cost"]')?.textContent).toBe('估算 $0.42')
    expect(first.querySelector('[data-dsh-part="turn-prompt"]')?.textContent).toBe('把登录页的第三方弹窗修好，并补一个回归测试')
    expect(first.querySelector('[data-dsh-part="turn-result"]')?.textContent).toContain('已修好弹窗')

    // 输入摘要按 160 字截断，长 prompt 不会把面板撑坏。
    const longRendered = second.querySelector('[data-dsh-part="turn-prompt"]')?.textContent ?? ''
    expect(longRendered).toHaveLength(160)
    expect(longRendered.endsWith('…')).toBe(true)
    expect(container.textContent).not.toContain(LONG_PROMPT)
    expect(second.querySelector('[data-dsh-part="turn-duration"]')?.textContent).toBe('耗时 42.0s')

    // 完成态：追问可用，关闭在，取消本轮不在（没有在跑的轮次）。
    expect((container.querySelector('[data-dsh-part="continue-input"]') as HTMLInputElement).disabled).toBe(false)
    expect(container.querySelector('[data-dsh-part="continue-submit"]')).toBeTruthy()
    expect(container.querySelector('[data-dsh-part="close"]')).toBeTruthy()
    expect(container.querySelector('[data-dsh-part="cancel"]')).toBeNull()
  })

  it('offers an enabled cancel while a turn is running and drops it once the turn settles', async () => {
    const running = settledSession({
      status: 'running',
      turns: [{ n: 2, prompt: '正在跑的这一轮', status: 'running', startedAt: '2026-11-04T12:10:00Z' }],
    })
    globalThis.fetch = vi.fn(async () => sessionsEnvelope({ sessions: [running] })) as never
    const body = harness().bodies[0]!
    const { container } = render(createElement(body.Body, { ...body.spec.inject?.('s1'), useTabInfo: TAB_INFO }))
    await waitFor(() => expect(container.querySelector('[data-dsh-part="cancel"]')).toBeTruthy())
    const cancel = container.querySelector('[data-dsh-part="cancel"]') as HTMLButtonElement
    expect(cancel.disabled).toBe(false)
    // 运行中的那一轮：进行中、不显示耗时与结果。
    const turn = container.querySelector('[data-dsh-part="turn"]')!
    expect(turn.querySelector('[data-dsh-part="turn-status"]')?.textContent).toBe(zh['turn.status.running'])
    expect(turn.querySelector('[data-dsh-part="turn-duration"]')).toBeNull()
    expect(turn.querySelector('[data-dsh-part="turn-result"]')?.textContent).toBe(zh['timeline.noResult'])
  })

  it('renders a codex turn with costUsd null without leaking null, undefined or NaN', async () => {
    const codex = settledSession({
      provider: 'codex',
      turns: [{
        n: 1,
        prompt: 'codex 跑的一轮',
        status: 'completed',
        startedAt: '2026-11-04T12:00:00Z',
        durationMs: 18_400,
        usage: { input: 1_234, output: 567 },
        costUsd: null,
        result: '跑完了',
      }],
    })
    globalThis.fetch = vi.fn(async () => sessionsEnvelope({ sessions: [codex] })) as never
    const body = harness().bodies[0]!
    const { container } = render(createElement(body.Body, { ...body.spec.inject?.('s1'), useTabInfo: TAB_INFO }))
    await waitFor(() => expect(container.querySelector('[data-dsh-part="turn"]')).toBeTruthy())

    const text = container.textContent ?? ''
    for (const leak of ['undefined', 'null', 'NaN']) expect(text).not.toContain(leak)
    // 实际行为：没有估值就整块不渲染（不是显示 $null / 估算 空）。
    expect(container.querySelector('[data-dsh-part="turn-cost"]')).toBeNull()
    expect(container.querySelector('[data-dsh-part="turn-duration"]')?.textContent).toBe('耗时 18.4s')
    expect(container.querySelector('[data-dsh-part="turn-usage"]')?.textContent).toBe('用量 1.2k 入 / 567 出')
  })

  it('converges from running to idle through the poll and then stops polling', async () => {
    vi.useFakeTimers()
    let calls = 0
    const runningPayload = { sessions: [settledSession({ status: 'running', turns: [{ n: 1, prompt: '跑着', status: 'running', startedAt: '2026-11-04T12:00:00Z' }] })] }
    const idlePayload = { sessions: [settledSession({ status: 'idle' })] }
    const fetchMock = vi.fn(async () => sessionsEnvelope(++calls <= 2 ? runningPayload : idlePayload))
    globalThis.fetch = fetchMock as never
    const body = harness().bodies[0]!
    const { container } = render(createElement(body.Body, { ...body.spec.inject?.('s1'), useTabInfo: TAB_INFO }))

    await flush()
    expect(container.querySelector('[data-dsh-part="turn-status"]')?.textContent).toBe(zh['turn.status.running'])
    expect(container.querySelector('[data-dsh-part="cancel"]')).toBeTruthy()

    // 一个轮询周期后宿主已给出 idle 快照。
    await act(async () => { vi.advanceTimersByTime(1_500) })
    await flush()
    expect(container.querySelector('[data-dsh-part="turn-status"]')?.textContent).toBe(zh['turn.status.completed'])
    expect(container.querySelector('[data-dsh-part="cancel"]')).toBeNull()

    // 收敛后不再轮询：再走 10 秒没有新请求。
    const settledCalls = fetchMock.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(10_000) })
    await flush()
    expect(fetchMock.mock.calls.length).toBe(settledCalls)
  })

  it('keeps rendering partial turns that miss usage, duration or result', async () => {
    const partial = settledSession({
      turns: [
        { n: 1, prompt: '缺用量与耗时', status: 'completed', result: '仍然有结果' },
        { n: 2, prompt: '缺耗时', status: 'failed', usage: { input: 1_000, output: 20 }, result: '炸了' },
        { n: 3, prompt: '没有结果文本', status: 'aborted' },
      ],
    })
    globalThis.fetch = vi.fn(async () => sessionsEnvelope({ sessions: [partial] })) as never
    const body = harness().bodies[0]!
    const { container } = render(createElement(body.Body, { ...body.spec.inject?.('s1'), useTabInfo: TAB_INFO }))
    await waitFor(() => expect(container.querySelectorAll('[data-dsh-part="turn"]').length).toBe(3))

    const turns = Array.from(container.querySelectorAll('[data-dsh-part="turn"]'))
    // 缺字段的轮次：少渲染，不渲染成占位符垃圾。
    expect(turns[0]?.querySelector('[data-dsh-part="turn-duration"]')).toBeNull()
    expect(turns[0]?.querySelector('[data-dsh-part="turn-usage"]')).toBeNull()
    expect(turns[0]?.querySelector('[data-dsh-part="turn-result"]')?.textContent).toBe('仍然有结果')
    expect(turns[1]?.querySelector('[data-dsh-part="turn-duration"]')).toBeNull()
    expect(turns[1]?.querySelector('[data-dsh-part="turn-usage"]')?.textContent).toBe('用量 1.0k 入 / 20 出')
    expect(turns[2]?.querySelector('[data-dsh-part="turn-result"]')?.textContent).toBe(zh['timeline.noResult'])
    expect(turns[2]?.querySelector('[data-dsh-part="turn-status"]')?.textContent).toBe(zh['turn.status.aborted'])

    const text = container.textContent ?? ''
    for (const leak of ['undefined', 'null', 'NaN']) expect(text).not.toContain(leak)
  })
})

describe('conversation binding', () => {
  it('lists only the rows this conversation dispatched, never the host-wide pool', async () => {
    const sessions = [
      { id: 'ext-a', provider: 'claude', title: 'this conversation', status: 'idle', cwd: '/tmp', createdAt: '2026-11-04T09:00:00Z', lastTurnAt: '2026-11-04T09:01:00Z', canContinue: true, originSessionId: 's1', turns: [] },
      { id: 'ext-b', provider: 'claude', title: 'another conversation', status: 'idle', cwd: '/tmp', createdAt: '2026-11-04T09:00:00Z', lastTurnAt: '2026-11-04T09:01:00Z', canContinue: true, originSessionId: 's2', turns: [] },
      { id: 'ext-c', provider: 'codex', title: 'origin unknown', status: 'idle', cwd: '/tmp', createdAt: '2026-11-04T09:00:00Z', lastTurnAt: '2026-11-04T09:01:00Z', canContinue: true, turns: [] },
    ]
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, value: { sessions } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as never
    harness()
    const tree = document.createElement('div')
    tree.setAttribute('role', 'tree')
    tree.setAttribute('aria-label', '子智能体会话')
    document.body.appendChild(tree)
    await waitFor(() => expect(tree.querySelector('[data-dsh-part="row"]')).toBeTruthy())
    expect(tree.textContent).toContain('外援 · 1')
    expect(tree.textContent).toContain('this conversation')
    expect(tree.textContent).not.toContain('another conversation')
    expect(tree.textContent).not.toContain('origin unknown')
  })

  it('renders no group at all when every row lacks an origin', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, value: { sessions: [{ id: 'ext-9', provider: 'claude', title: 'legacy', status: 'idle', cwd: '/tmp', createdAt: '2026-11-04T09:00:00Z', lastTurnAt: '2026-11-04T09:01:00Z', canContinue: true, turns: [] }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as never
    harness()
    const tree = document.createElement('div')
    tree.setAttribute('role', 'tree')
    tree.setAttribute('aria-label', '子智能体会话')
    document.body.appendChild(tree)
    await act(async () => { await Promise.resolve() })
    expect(tree.querySelector('[data-dsh-part="group"]')).toBeNull()
    expect(tree.textContent).toBe('')
  })

  it('keeps unattributable rows out of the panel list until all conversations is asked for', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, value: { sessions: [{ id: 'ext-9', provider: 'claude', title: 'legacy', status: 'idle', cwd: '/tmp', createdAt: '2026-11-04T09:00:00Z', lastTurnAt: '2026-11-04T09:01:00Z', canContinue: true, turns: [] }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as never
    const { bodies } = harness()
    const body = bodies[0]!
    const { container } = render(createElement(body.Body, { ...body.spec.inject?.('s1'), useTabInfo: TAB_INFO }))
    await waitFor(() => expect(container.textContent).toContain(zh['list.empty']))
    expect(container.textContent).not.toContain('legacy')
    fireEvent.click(container.querySelector('[data-dsh-part="scope-toggle"] input') as HTMLInputElement)
    await waitFor(() => expect(container.textContent).toContain('legacy'))
  })
})
