// @vitest-environment jsdom
/**
 * 记忆面板：客户端半区的取数与排版契约。
 *
 * 覆盖四层：cwd 解析（无注入会话身份时的回落链）、Markdown 分块器、线上信封
 * 解析（含 malformed / not-configured / 不可达），以及面板挂载后的真实行为
 * （两个标签页、目录下钻、文件预览、检索、工作区无 peer 的提示与出口）。
 * 全部用替身取数，不碰网络，也不依赖宿主端点是否已经上线。
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { MemoryListing, MemoryStatus } from '../src/core/memory-view/protocol.ts'
import {
  MemoryViewApi,
  parseMemoryEnvelope,
  type MemoryApi,
  type MemoryListQuery,
  type MemorySearchQuery,
} from '../src/client/sidebar/panels/memory/api.ts'
import {
  createMemoryCwdTracker,
  resolveMemoryCwd,
  type MemoryCwdTracker,
  type ObservableStore,
  type MemoryWorkspaceSources,
} from '../src/client/sidebar/panels/memory/cwd.ts'
import { splitMarkdownBlocks } from '../src/client/sidebar/panels/memory/markdown.ts'
import { MemoryPanel } from '../src/client/sidebar/panels/memory/panel.tsx'
import { en, zh, type MemoryKey } from '../src/client/sidebar/panels/memory/locales.ts'

afterEach(() => {
  cleanup()
  document.documentElement.lang = ''
  vi.restoreAllMocks()
})

/** 固定值 + 空订阅的可观察面。 */
function fixedStore<T>(value: T): ObservableStore<T> {
  return { getSnapshot: () => value, subscribe: () => () => {} }
}

/** 可推送变化的可观察面。 */
function liveStore<T>(read: () => T): ObservableStore<T> & { notify(): void } {
  const listeners = new Set<() => void>()
  return {
    getSnapshot: read,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify: () => { for (const listener of [...listeners]) listener() },
  }
}

// --- cwd 解析 ---------------------------------------------------------------

describe('workspace cwd resolution', () => {
  it('prefers the durable selection cell over the older session sources', () => {
    const sources: MemoryWorkspaceSources = {
      uiWorkspace: { selection: fixedStore({ sessionId: 'selected' }) },
      sessions: { list: fixedStore({ current: 'list-current', byId: { selected: { cwd: '/repo/selected' }, 'list-current': { cwd: '/repo/current' } } }) },
      uiSession: { adapter: { current: fixedStore({ key: 'adapter' }) } },
    }
    expect(resolveMemoryCwd(sources)).toBe('/repo/selected')
  })

  it('falls back to sessions.list.current, then the main-view binding', () => {
    const byId = { 'list-current': { cwd: '/repo/current' }, adapter: { cwd: '/repo/adapter' }, twin: { cwd: '/repo/twin' } }
    expect(resolveMemoryCwd({ sessions: { list: fixedStore({ current: 'list-current', byId }) } })).toBe('/repo/current')
    expect(resolveMemoryCwd({
      sessions: { list: fixedStore({ byId }) },
      uiSession: { adapter: { current: fixedStore({ key: 'adapter' }) } },
    })).toBe('/repo/adapter')
    expect(resolveMemoryCwd({
      sessions: { list: fixedStore({ byId }) },
      uiSession: { current: fixedStore({ key: 'twin' }) },
    })).toBe('/repo/twin')
  })

  it('returns an empty path when no source resolves, and never throws on broken services', () => {
    expect(resolveMemoryCwd({})).toBe('')
    expect(resolveMemoryCwd({
      uiWorkspace: { selection: fixedStore({ sessionId: 'blank' }) },
      sessions: { list: fixedStore({ byId: { blank: { cwd: '   ' } } }) },
    })).toBe('')
    const hostile: MemoryWorkspaceSources = {
      uiWorkspace: { selection: { getSnapshot() { throw new Error('boom') }, subscribe: () => () => {} } },
      sessions: { list: { getSnapshot() { throw new Error('boom') }, subscribe: () => () => {} } },
      uiSession: { adapter: { current: { getSnapshot() { throw new Error('boom') }, subscribe: () => () => {} } } },
    }
    expect(() => resolveMemoryCwd(hostile)).not.toThrow()
    expect(resolveMemoryCwd(hostile)).toBe('')
  })

  it('re-publishes the cwd when the selection changes', () => {
    let selected = 'a'
    const selection = liveStore(() => ({ sessionId: selected }))
    const sources: MemoryWorkspaceSources = {
      uiWorkspace: { selection },
      sessions: { list: fixedStore({ byId: { a: { cwd: '/repo/a' }, b: { cwd: '/repo/b' } } }) },
    }
    const tracker = createMemoryCwdTracker(() => sources)
    const seen: string[] = []
    const dispose = tracker.subscribe(() => { seen.push(tracker.getSnapshot()) })
    expect(tracker.getSnapshot()).toBe('/repo/a')
    selected = 'b'
    selection.notify()
    expect(tracker.getSnapshot()).toBe('/repo/b')
    expect(seen).toEqual(['/repo/b'])
    dispose()
    selected = 'a'
    selection.notify()
    expect(seen).toEqual(['/repo/b'])
  })
})

// --- Markdown 分块 ----------------------------------------------------------

describe('markdown block splitter', () => {
  it('splits headings, paragraphs, lists, fences and quotes', () => {
    const blocks = splitMarkdownBlocks([
      '# Preferences',
      '',
      'Keep answers short.',
      'Prefer TypeScript.',
      '',
      '## Tools',
      '',
      '- ripgrep',
      '- pnpm',
      '',
      '1. first',
      '2. second',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '> quoted line',
      '> second line',
    ].join('\n'))
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Preferences' },
      { kind: 'paragraph', text: 'Keep answers short.\nPrefer TypeScript.' },
      { kind: 'heading', level: 2, text: 'Tools' },
      { kind: 'list', ordered: false, items: ['ripgrep', 'pnpm'] },
      { kind: 'list', ordered: true, items: ['first', 'second'] },
      { kind: 'code', language: 'ts', text: 'const a = 1' },
      { kind: 'quote', text: 'quoted line\nsecond line' },
    ])
  })

  it('keeps an unterminated fence as code and treats a rule as a paragraph break', () => {
    expect(splitMarkdownBlocks('```sh\nls -la\n')).toEqual([{ kind: 'code', language: 'sh', text: 'ls -la' }])
    expect(splitMarkdownBlocks('one\n\n---\n\ntwo')).toEqual([
      { kind: 'paragraph', text: 'one' },
      { kind: 'paragraph', text: 'two' },
    ])
  })

  it('strips a closing heading sequence and folds indented list continuations', () => {
    expect(splitMarkdownBlocks('## Title ##')).toEqual([{ kind: 'heading', level: 2, text: 'Title' }])
    expect(splitMarkdownBlocks('- item\n  continued\n- next')).toEqual([
      { kind: 'list', ordered: false, items: ['item\ncontinued', 'next'] },
    ])
  })

  it('returns no blocks for empty or blank input', () => {
    expect(splitMarkdownBlocks('')).toEqual([])
    expect(splitMarkdownBlocks('   \n\n')).toEqual([])
  })
})

// --- 线上信封 ---------------------------------------------------------------

const LISTING: MemoryListing = {
  scope: 'global',
  root: 'viking://user/admin/memories',
  uri: 'viking://user/admin/memories',
  nodes: [
    { uri: 'viking://user/admin/memories/preferences', name: 'preferences', isDir: true, size: 0, modTime: '2026-11-01T00:00:00.000Z' },
    { uri: 'viking://user/admin/memories/profile.md', name: 'profile.md', isDir: false, size: 2048, modTime: '2026-11-02T00:00:00.000Z', abstract: 'operator profile' },
  ],
}

const STATUS: MemoryStatus = {
  connection: { connected: true, server: 'http://127.0.0.1:1933', user: 'admin' },
  workspace: { cwd: '/repo', peer: 'github.com-org-repo', memoryUri: 'viking://user/admin/peers/github.com-org-repo/memories', source: 'git-remote' },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('envelope parsing', () => {
  it('accepts a well-formed success envelope', () => {
    expect(parseMemoryEnvelope<{ a: number }>({ ok: true, value: { a: 1 } })).toEqual({ ok: true, value: { a: 1 } })
    expect(parseMemoryEnvelope<MemoryStatus>({ ok: true, value: STATUS })).toEqual({ ok: true, value: STATUS })
  })

  it('keeps typed failures such as not-configured', () => {
    expect(parseMemoryEnvelope<unknown>({ ok: false, error: { code: 'not-configured', message: 'ovcli.conf missing' } })).toEqual({
      ok: false,
      error: { code: 'not-configured', message: 'ovcli.conf missing' },
    })
  })

  it('turns a malformed or non-envelope body into a typed malformed failure', () => {
    for (const body of [{ ok: true }, { ok: false }, { ok: false, error: { code: 'nope' } }, '<html>proxy</html>', null]) {
      const envelope = parseMemoryEnvelope<unknown>(body)
      expect(envelope.ok).toBe(false)
      if (!envelope.ok) expect(envelope.error.code).toBe('malformed')
    }
  })

  it('maps HTTP status codes when the body carries no envelope', () => {
    const code = (status: number): string => {
      const envelope = parseMemoryEnvelope<unknown>(undefined, status)
      return envelope.ok ? 'ok' : envelope.error.code
    }
    expect(code(403)).toBe('forbidden')
    expect(code(401)).toBe('unauthorized')
    // 裸 404 是「路由没挂上」，不是「这条记忆不存在」（后者由宿主的信封给出）。
    expect(code(404)).toBe('unreachable')
    expect(code(503)).toBe('unreachable')
    expect(code(500)).toBe('internal')
  })
})

describe('memory view api', () => {
  it('calls the contract routes and shapes the query strings', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const api = new MemoryViewApi({
      fetch: async (url, init) => {
        requests.push({ url, init })
        if (url.includes('/status')) return json({ ok: true, value: STATUS })
        if (url.includes('/list')) return json({ ok: true, value: LISTING })
        if (url.includes('/search')) return json({ ok: true, value: { query: 'peer id', scope: 'global', hits: [] } })
        return json({ ok: true, value: { uri: 'viking://user/admin/memories/profile.md', name: 'profile.md', text: '# Profile' } })
      },
    })

    expect(await api.status('/repo')).toEqual({ ok: true, value: STATUS })
    expect(requests[0]?.url).toBe('/api/dsh-memory/status?cwd=%2Frepo')
    expect(requests[0]?.init?.method).toBe('GET')

    expect((await api.list({ scope: 'workspace', path: 'projects', cwd: '/repo' })).ok).toBe(true)
    expect(requests[1]?.url).toBe('/api/dsh-memory/list?scope=workspace&path=projects&cwd=%2Frepo')

    expect((await api.search({ query: 'peer id', scope: 'global', cwd: '/repo' })).ok).toBe(true)
    expect(requests[2]?.url).toBe('/api/dsh-memory/search?cwd=%2Frepo')
    expect(requests[2]?.init?.method).toBe('POST')
    expect(requests[2]?.init?.body).toBe(JSON.stringify({ query: 'peer id', scope: 'global' }))

    expect((await api.read('viking://user/admin/memories/profile.md', '/repo')).ok).toBe(true)
    expect(requests[3]?.url).toContain('/api/dsh-memory/read?uri=')
    expect(requests[3]?.url).toContain('cwd=%2Frepo')
  })

  it('reports an unreachable service instead of throwing', async () => {
    const api = new MemoryViewApi({ fetch: async () => { throw new Error('ECONNREFUSED') } })
    expect(await api.status()).toEqual({ ok: false, error: { code: 'unreachable', message: 'ECONNREFUSED' } })
  })

  it('reports a proxied non-JSON answer as malformed', async () => {
    const api = new MemoryViewApi({ fetch: async () => new Response('<html>gateway</html>', { status: 200 }) })
    const envelope = await api.list({ scope: 'global' })
    expect(envelope.ok).toBe(false)
    if (!envelope.ok) expect(envelope.error.code).toBe('malformed')
  })

  it('refuses to send a non-viking uri or an unknown scope', async () => {
    const fetch = vi.fn()
    const api = new MemoryViewApi({ fetch: fetch as never })
    expect((await api.read('javascript:alert(1)')).ok).toBe(false)
    expect((await api.list({ scope: 'elsewhere' as never })).ok).toBe(false)
    expect((await api.search({ query: '   ' })).ok).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})

// --- 文案 -------------------------------------------------------------------

describe('memory locale dictionaries', () => {
  it('mirrors every zh key in en and never leaves an empty string', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const key of Object.keys(zh) as MemoryKey[]) {
      expect(zh[key].trim()).not.toBe('')
      expect(en[key].trim()).not.toBe('')
    }
  })

  it('carries no emoji', () => {
    for (const text of [...Object.values(zh), ...Object.values(en)]) {
      expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false)
    }
  })
})

// --- 面板挂载 ---------------------------------------------------------------

function trackerOf(cwd: string): MemoryCwdTracker {
  return createMemoryCwdTracker(() => ({ sessions: { list: fixedStore({ current: 's', byId: { s: { cwd } } }) } }))
}

function fakeApi(overrides: Partial<MemoryApi> = {}): {
  api: MemoryApi
  calls: { status: Array<string | undefined>; list: MemoryListQuery[]; search: MemorySearchQuery[]; read: string[] }
} {
  const calls = { status: [] as Array<string | undefined>, list: [] as MemoryListQuery[], search: [] as MemorySearchQuery[], read: [] as string[] }
  const api: MemoryApi = {
    status: async (cwd) => {
      calls.status.push(cwd)
      return { ok: true, value: STATUS }
    },
    list: async (query) => {
      calls.list.push(query)
      return { ok: true, value: { ...LISTING, scope: query.scope } }
    },
    search: async (query) => {
      calls.search.push(query)
      return {
        ok: true,
        value: {
          query: query.query,
          scope: query.scope ?? 'all',
          hits: [{ uri: 'viking://user/admin/memories/profile.md', name: 'profile.md', score: 0.87, abstract: 'operator profile' }],
        },
      }
    },
    read: async (uri) => {
      calls.read.push(uri)
      return { ok: true, value: { uri, name: 'profile.md', text: '# Profile\n\n- prefers pnpm' } }
    },
    ...overrides,
  }
  return { api, calls }
}

describe('memory panel', () => {
  it('renders both tabs, the semantic root, and browses the global space on mount', async () => {
    document.documentElement.lang = 'zh'
    const { api, calls } = fakeApi()
    const { container } = render(<MemoryPanel api={api} cwd={trackerOf('/repo')}/>)

    expect(container.querySelector('[data-dsh-plugin="memory"]')).toBeTruthy()
    const tabs = [...container.querySelectorAll('[data-dsh-part="tab"]')]
    expect(tabs.map((tab) => tab.textContent)).toEqual([zh['tab.global'], zh['tab.workspace']])

    await waitFor(() => expect(container.textContent).toContain('profile.md'))
    expect(calls.status).toEqual(['/repo'])
    expect(calls.list[0]).toEqual({ scope: 'global', path: '', cwd: '/repo' })
    expect(container.querySelector('[data-dsh-part="crumb"]')?.textContent).toBe(zh['tab.global'])
  })

  it('opens a directory and previews a file', async () => {
    document.documentElement.lang = 'zh'
    const { api, calls } = fakeApi()
    const { container } = render(<MemoryPanel api={api} cwd={trackerOf('/repo')}/>)
    await waitFor(() => expect(container.textContent).toContain('preferences'))

    fireEvent.click(container.querySelector('[data-dsh-part="row"][data-kind="dir"]') as HTMLElement)
    await waitFor(() => expect(calls.list.at(-1)).toEqual({ scope: 'global', path: 'preferences', cwd: '/repo' }))

    fireEvent.click(container.querySelector('[data-dsh-part="row"][data-kind="file"]') as HTMLElement)
    await waitFor(() => expect(container.querySelector('[data-dsh-part="preview"]')).toBeTruthy())
    expect(calls.read).toEqual(['viking://user/admin/memories/profile.md'])
    await waitFor(() => expect(container.querySelector('[data-dsh-part="preview"]')?.textContent).toContain('prefers pnpm'))
    // 预览以纯文本渲染标题块，而不是 HTML 标题标签之外的东西。
    expect(container.querySelector('[data-dsh-part="preview"] [role="heading"]')?.textContent).toBe('Profile')
  })

  it('shows the resolved peer on the workspace tab and lists that scope', async () => {
    document.documentElement.lang = 'zh'
    const { api, calls } = fakeApi()
    const { container } = render(<MemoryPanel api={api} cwd={trackerOf('/repo')}/>)
    await waitFor(() => expect(calls.list.length).toBeGreaterThan(0))

    fireEvent.click(container.querySelectorAll('[data-dsh-part="tab"]')[1] as HTMLElement)
    await waitFor(() => expect(calls.list.at(-1)).toEqual({ scope: 'workspace', path: '', cwd: '/repo' }))
    expect(container.textContent).toContain(zh['workspace.peer'].replace('{peer}', 'github.com-org-repo'))
  })

  it('explains a workspace without a git peer and offers the global space', async () => {
    document.documentElement.lang = 'zh'
    const { api, calls } = fakeApi({
      status: async () => ({
        ok: true,
        value: {
          connection: STATUS.connection,
          workspace: { cwd: '/tmp/scratch', peer: null, source: 'none' },
        },
      }),
    })
    const { container } = render(<MemoryPanel api={api} cwd={trackerOf('/tmp/scratch')}/>)
    await waitFor(() => expect(calls.list.length).toBeGreaterThan(0))

    fireEvent.click(container.querySelectorAll('[data-dsh-part="tab"]')[1] as HTMLElement)
    await waitFor(() => expect(container.textContent).toContain(zh['workspace.noPeer']))
    // 退回全局空间不是死路：提示行里就有出口，而且列表照常取数。
    expect(calls.list.at(-1)).toEqual({ scope: 'workspace', path: '', cwd: '/tmp/scratch' })
    const exit = [...container.querySelectorAll('button')].find((button) => button.textContent === zh['workspace.openGlobal'])
    expect(exit).toBeTruthy()
    fireEvent.click(exit as HTMLElement)
    await waitFor(() => expect(container.querySelectorAll('[data-dsh-part="tab"]')[0]?.getAttribute('aria-selected')).toBe('true'))
  })

  it('searches inside the active scope and shows the hits', async () => {
    document.documentElement.lang = 'zh'
    const { api, calls } = fakeApi()
    const { container } = render(<MemoryPanel api={api} cwd={trackerOf('/repo')}/>)
    await waitFor(() => expect(calls.list.length).toBeGreaterThan(0))

    const form = container.querySelector('[data-dsh-part="search"]') as HTMLFormElement
    const input = form.querySelector('input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'profile' } })
    fireEvent.submit(form)

    await waitFor(() => expect(container.querySelector('[data-dsh-part="row"][data-kind="hit"]')).toBeTruthy())
    expect(calls.search[0]).toEqual({ query: 'profile', scope: 'global', cwd: '/repo' })
    expect(container.textContent).toContain(zh['search.results'].replace('{count}', '1'))
    expect(container.querySelector('[data-dsh-part="crumb"]')).toBeNull()
  })

  it('reports a not-configured host as a typed notice instead of crashing', async () => {
    document.documentElement.lang = 'zh'
    const { api } = fakeApi({ status: async () => ({ ok: false, error: { code: 'not-configured', message: 'missing' } }) })
    const { container } = render(<MemoryPanel api={api} cwd={trackerOf('/repo')}/>)
    await waitFor(() => expect(container.textContent).toContain(zh['error.notConfigured']))
    expect(container.querySelector('[data-dsh-part="row"]')).toBeNull()
  })

  it('reports a disconnected host with its address', async () => {
    document.documentElement.lang = 'zh'
    const { api } = fakeApi({
      status: async () => ({
        ok: true,
        value: { connection: { connected: false, server: 'http://127.0.0.1:1933', user: 'admin', error: 'connect ECONNREFUSED' }, workspace: STATUS.workspace },
      }),
    })
    const { container } = render(<MemoryPanel api={api} cwd={trackerOf('/repo')}/>)
    await waitFor(() => expect(container.textContent).toContain('127.0.0.1:1933'))
    expect(container.textContent).toContain('connect ECONNREFUSED')
  })

  it('degrades to an unknown cwd when nothing resolves', async () => {
    document.documentElement.lang = 'zh'
    const { api, calls } = fakeApi()
    render(<MemoryPanel api={api} cwd={trackerOf('')}/>)
    await waitFor(() => expect(calls.list.length).toBeGreaterThan(0))
    expect(calls.status).toEqual([undefined])
    expect(calls.list[0]?.cwd).toBeUndefined()
  })

  it('keeps the semantic hooks and never injects HTML', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/client/sidebar/panels/memory/panel.tsx'), 'utf8')
    for (const hook of ['plugin="memory"', 'data-dsh-part="tab"', 'data-dsh-part="crumb"', 'data-dsh-part="row"', 'data-dsh-part="preview"', 'data-dsh-part="search"']) {
      expect(source).toContain(hook)
    }
    expect(source).not.toContain('dangerouslySetInnerHTML')
    expect(/\.innerHTML/u.test(source)).toBe(false)
  })
})