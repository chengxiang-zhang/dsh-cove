// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
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
  const ctx = {
    slots,
    locale: { register: vi.fn(() => vi.fn()), bind: () => (key: ExternalSessionLocaleKey) => zh[key] },
    get: (name: string) => name === 'sidebarRightTabs'
      ? { register: (definition: { id: string; kind: string; guide?: unknown }) => { tabs.push(definition); return () => {} } }
      : name === 'sidebarRight' ? right : undefined,
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
        : name === 'sidebarRight' ? { openTab: () => { throw new Error('sidebarRight: no session surface is mounted') } } : undefined,
      inject: (_services: string[], setup: (scope: unknown) => void) => { setup(ctxHidden); return () => {} },
    }
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, value: { sessions: [{ id: 'ext-1', provider: 'claude', title: 't', status: 'idle', cwd: '/tmp', createdAt: '2026-11-04T09:00:00Z', lastTurnAt: '2026-11-04T09:01:00Z', canContinue: true, turns: [] }] } }),
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