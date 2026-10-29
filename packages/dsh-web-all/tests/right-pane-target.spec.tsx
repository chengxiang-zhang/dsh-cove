// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { mountRightPane, rightPaneEn, rightPaneZh, type RightPaneLocaleKey } from '../src/client/sidebar/right-pane.tsx'
import { fileAddressFor, sessionFileAddress } from '../src/core/right-pane/protocol.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks() })

type Callback = () => (() => void)
interface CapturedBody {
  key: string
  props: { sessionId?: string; useTabInfo?: () => unknown }
  Body: (props: { useTabInfo?: () => unknown } & Record<string, unknown>) => ReturnType<typeof createElement>
}

/**
 * The harness mirrors the 0.2 seat contract: `sidebar.right.pane.tab` is a
 * keyed session-scoped slot whose `inject(sessionId)` carries the session
 * identity (the shell no longer hands it through the session list).
 */
function harness(snapshot: { byId: Record<string, { cwd?: string }> }) {
  const view = { ...snapshot }
  const bodies: CapturedBody[] = []
  const tabs: Array<{ id: string; kind: string; guide?: unknown }> = []
  const waits = new Map<string, Callback[]>()
  const slots = {
    inject(name: string, callback: Callback) { const rows = waits.get(name) ?? []; rows.push(callback); waits.set(name, rows); return () => {} },
    register(spec: { name?: string; key?: string; inject?: (sessionId: string) => Record<string, unknown> }, Body: CapturedBody['Body']) {
      if (spec.name === 'sidebar.right.pane.tab') bodies.push({ key: spec.key!, props: (spec.inject?.('s1') ?? {}) as CapturedBody['props'], Body })
      return () => {}
    },
  }
  const ctx = {
    slots,
    locale: { register: vi.fn(() => vi.fn()), bind: () => (key: RightPaneLocaleKey) => rightPaneZh[key] },
    get: (name: string) => name === 'sessions' ? { list: { getSnapshot: () => view, subscribe: () => () => {} } }
      : name === 'sidebarRightTabs' ? { register: (definition: { id: string }) => { tabs.push(definition); return () => {} } }
        : name === 'sidebarRight' ? { openTab: vi.fn(), openResource: vi.fn() }
          : undefined,
    inject: (services: string[], setup: (scope: unknown) => void) => { setup(ctx); return () => {} },
  }
  mountRightPane(ctx as never)
  // The seat bodies register only once the shell has declared the seat; the
  // harness declares it synchronously, mirroring the regression spec.
  for (const callback of waits.get('sidebar.right.pane.tab') ?? []) callback()
  return { bodies, tabs, view, ctx }
}

const TAB_INFO = () => ({ sidebar: { expanded: true, fullscreen: false }, panel: { id: 'p1' }, tab: { visible: true, navigation: { params: {}, revision: 1 }, signal: new AbortController().signal } })

describe('right-pane page contract', () => {
  it('keeps zh/en locale key sets identical', () => {
    expect(Object.keys(rightPaneEn).sort()).toEqual(Object.keys(rightPaneZh).sort())
  })

  it('registers the git page and the agent-browser tab', () => {
    const { bodies, tabs } = harness({ byId: { s1: { cwd: '/repo' } } })
    expect(bodies.map(row => row.key)).toEqual(['dsh-web-all/git', 'dsh-web-all/agent-browser'])
    expect(tabs.map(row => row.id)).toEqual(['dsh-web-all/git', 'dsh-web-all/agent-browser'])
    expect(tabs.map(row => row.kind)).toEqual(['web-ui.git', 'web-ui.agent-browser'])
    // The seat injects the session identity; nothing reads the removed
    // `sessions.list.current` fallback any more.
    expect(bodies[0].props.sessionId).toBe('s1')
  })

  it('git page gates on a workspace and does not crash without one', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as never
    const { bodies } = harness({ byId: {} })
    const gitBody = bodies.find(row => row.key === 'dsh-web-all/git')!
    const { container } = render(createElement(gitBody.Body, { ...gitBody.props, sessionId: undefined, useTabInfo: TAB_INFO }))
    await waitFor(() => expect(container.textContent).toContain('请选择已注册工作区的会话。'))
    expect(container.querySelector('[data-dsh-part="workbench-git"]')).toBeNull()
  })

  it('git page mounts the workbench when a workspace is present', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as never
    const { bodies } = harness({ byId: { s1: { cwd: '/repo' } } })
    const gitBody = bodies.find(row => row.key === 'dsh-web-all/git')!
    const { container } = render(createElement(gitBody.Body, { ...gitBody.props, useTabInfo: TAB_INFO }))
    await waitFor(() => expect(container.querySelector('[data-dsh-part="workbench-git"]')).not.toBeNull())
  })

  it('native file addresses follow the official dsh-resource vocabulary', () => {
    expect(sessionFileAddress('s1', 'a/b.md')).toBe('dsh-resource://file/session/s1/a/b.md')
    expect(fileAddressFor('s1', '/repo', '/repo/a/b.md')).toBe('dsh-resource://file/session/s1/a/b.md')
    // Absolute paths outside the workspace root keep their leading slash,
    // exactly like the official sidebar-files encoder.
    expect(fileAddressFor('s1', '/repo', '/outside/a.md')).toBe('dsh-resource://file/session/s1//outside/a.md')
    expect(fileAddressFor('s1', undefined, 'a.md')).toBe('dsh-resource://file/session/s1/a.md')
  })
})