/**
 * memory-view 宿主半区：路由信封、归属校验、围栏、peer 推导与上游客户端。
 *
 * 这里不连真实 OpenViking，也不跑真实 git：客户端用 `fetchImpl` 注入，git 用
 * `GitCommandRunner` 注入。断言值按契约写出，不从实现推导。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterAll, describe, expect, it } from 'vitest'
import { workspacePeerFromRoot } from '../src/core/memory-view/protocol.ts'
import {
  MemoryViewClient,
  type MemoryUpstreamEntry,
  type MemoryUpstreamHit,
  type MemoryUpstreamResult,
  type MemoryViewClientLike,
} from '../src/host/services/memory-view/client.ts'
import {
  DEFAULT_MEMORY_VIEW_USER,
  isMemoryViewConfigured,
  resolveMemoryViewConfig,
  type MemoryViewConfig,
} from '../src/host/services/memory-view/config.ts'
import { register as registerMemoryView } from '../src/host/services/memory-view/index.ts'
import {
  GIT_REMOTE_URL_ARGV,
  GIT_TOP_LEVEL_ARGV,
  parseCwd,
  resolveWorkspacePeer,
  type GitCommandResult,
  type GitCommandRunner,
  type PeerResolution,
} from '../src/host/services/memory-view/peer.ts'
import {
  makeMemoryViewRoutes,
  registerMemoryViewRoutes,
  type MemoryViewRouteOptions,
  type MemoryViewRoutesDeps,
} from '../src/host/services/memory-view/routes.ts'

const USER_ROOT = 'viking://user/admin/memories'
const PEER = 'github.com-chengxiang-zhang-dsh-cove'
const PEER_ROOT = `viking://user/admin/peers/${PEER}/memories`
const PREFIX = '/api/dsh-memory'
const CONFIG: MemoryViewConfig = {
  url: 'http://openviking.test',
  apiKey: 'secret-key-do-not-echo',
  account: null,
  user: 'admin',
}

/** 临时目录（配置文件与 cwd 用例），文件级统一清理。 */
const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-view-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

interface RequestOptions {
  method?: string
  url: string
  body?: unknown
  remoteAddress?: string
  host?: string
  headers?: Record<string, string>
}

function fakeRequest(options: RequestOptions): IncomingMessage {
  const request = new EventEmitter() as unknown as IncomingMessage
  Object.assign(request, {
    method: options.method ?? 'GET',
    url: options.url,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    headers: {
      host: options.host ?? '127.0.0.1:3080',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    [Symbol.asyncIterator]: async function* () {
      if (options.body === undefined) return
      yield Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
    },
  })
  return request
}

interface FakeResponse {
  status: number
  headers: Record<string, string>
  text: string
  writableEnded: boolean
  writeHead(status: number, headers?: Record<string, string>): FakeResponse
  end(chunk?: string | Buffer): FakeResponse
}

function fakeResponse(): FakeResponse {
  const response: FakeResponse = {
    status: 0,
    headers: {},
    text: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.writableEnded = false
      for (const [key, value] of Object.entries(headers ?? {})) this.headers[key.toLowerCase()] = value
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.text += chunk.toString()
      this.writableEnded = true
      return this
    },
  }
  return response
}

interface CallResult {
  status: number
  headers: Record<string, string>
  body: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
}

async function callRoute(route: WebRoute, options: RequestOptions): Promise<CallResult> {
  const response = fakeResponse()
  await route.handler(fakeRequest(options), response as unknown as ServerResponse)
  return {
    status: response.status,
    headers: response.headers,
    body: response.text === '' ? { ok: false } : JSON.parse(response.text) as CallResult['body'],
  }
}

async function call(deps: MemoryViewRoutesDeps, options: RequestOptions): Promise<CallResult> {
  return callRoute(makeMemoryViewRoutes(deps)[0], options)
}

/** 假客户端：记录调用并回放固定结果。 */
class FakeClient implements MemoryViewClientLike {
  readonly listingCalls: string[] = []
  readonly readCalls: string[] = []
  readonly searchCalls: Array<{ query: string; limit: number }> = []
  private readonly listing: (uri: string) => MemoryUpstreamResult<MemoryUpstreamEntry[]>
  private readonly read: (uri: string) => MemoryUpstreamResult<string>
  private readonly searchReply: (query: string, limit: number) => MemoryUpstreamResult<MemoryUpstreamHit[]>

  constructor(replies: {
    listing?: (uri: string) => MemoryUpstreamResult<MemoryUpstreamEntry[]>
    read?: (uri: string) => MemoryUpstreamResult<string>
    search?: (query: string, limit: number) => MemoryUpstreamResult<MemoryUpstreamHit[]>
  } = {}) {
    this.listing = replies.listing ?? (() => ({ ok: true, value: [] }))
    this.read = replies.read ?? (() => ({ ok: true, value: '' }))
    this.searchReply = replies.search ?? (() => ({ ok: true, value: [] }))
  }

  async listDirectory(uri: string): Promise<MemoryUpstreamResult<MemoryUpstreamEntry[]>> {
    this.listingCalls.push(uri)
    return this.listing(uri)
  }

  async readContent(uri: string): Promise<MemoryUpstreamResult<string>> {
    this.readCalls.push(uri)
    return this.read(uri)
  }

  async search(query: string, limit: number): Promise<MemoryUpstreamResult<MemoryUpstreamHit[]>> {
    this.searchCalls.push({ query, limit })
    return this.searchReply(query, limit)
  }
}

function makeDeps(client: MemoryViewClientLike, overrides: Partial<MemoryViewRoutesDeps> = {}): MemoryViewRoutesDeps {
  return {
    isTrusted: () => true,
    resolveConfig: () => CONFIG,
    createClient: () => client,
    resolvePeer: async (cwd): Promise<PeerResolution> => ({ cwd, peer: PEER, source: 'git-remote' }),
    ...overrides,
  }
}

function entry(uri: string, isDir: boolean, extra: Partial<MemoryUpstreamEntry> = {}): MemoryUpstreamEntry {
  return { uri, isDir, size: isDir ? 0 : 42, modTime: '2026-11-06T08:42:52.000Z', ...extra }
}

function hit(uri: string, score: number, extra: Partial<MemoryUpstreamHit> = {}): MemoryUpstreamHit {
  return { uri, score, abstract: `about ${uri}`, ...extra }
}

/** 假 git：按 argv 回放固定结果。 */
class FakeRunner implements GitCommandRunner {
  readonly calls: Array<{ argv: readonly string[]; cwd: string }> = []

  constructor(private readonly reply: (argv: readonly string[]) => GitCommandResult | Promise<GitCommandResult>) {}

  async run(argv: readonly string[], cwd: string): Promise<GitCommandResult> {
    this.calls.push({ argv: [...argv], cwd })
    return this.reply(argv)
  }
}

function gitResult(exitCode: number, stdout = ''): GitCommandResult {
  return { exitCode, stdout, stderr: '' }
}

describe('memory-view host access fence', () => {
  it('refuses a request the shared fence rejects before touching OpenViking', async () => {
    const client = new FakeClient()
    const response = await call(makeDeps(client, { isTrusted: () => false }), {
      url: `${PREFIX}/list?scope=global`,
    })
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ ok: false, error: { code: 'forbidden', message: expect.any(String) } })
    expect(client.listingCalls).toEqual([])
  })

  it('mounts through accessTrustOf: a remote socket is refused, a loopback page is served', async () => {
    const registered: WebRoute[] = []
    const disposals: number[] = []
    const ctx = {
      webServer: {
        register(route: WebRoute) {
          registered.push(route)
          return () => { disposals.push(1) }
        },
      },
    } as unknown as Context
    const client = new FakeClient()
    const options: MemoryViewRouteOptions = {
      resolveConfig: () => CONFIG,
      createClient: () => client,
      resolvePeer: async (cwd): Promise<PeerResolution> => ({ cwd, peer: null, source: 'none' }),
    }
    const dispose = registerMemoryViewRoutes(ctx, options)
    expect(registered.map(route => route.path)).toEqual([PREFIX])
    expect(registered[0].kind).toBe('prefix')

    const remote = await callRoute(registered[0], {
      url: `${PREFIX}/list?scope=global`,
      remoteAddress: '10.1.2.3',
    })
    expect(remote.status).toBe(403)
    expect(client.listingCalls).toEqual([])

    const local = await callRoute(registered[0], { url: `${PREFIX}/list?scope=global` })
    expect(local.status).toBe(200)
    expect(client.listingCalls).toEqual([USER_ROOT])

    dispose()
    expect(disposals).toEqual([1])
  })
})

describe('memory-view status', () => {
  it('reports an unconfigured host without treating it as an error', async () => {
    const client = new FakeClient()
    const response = await call(makeDeps(client, {
      resolveConfig: () => ({ url: '', apiKey: null, account: null, user: 'admin' }),
    }), { url: `${PREFIX}/status` })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      value: {
        connection: { connected: false, server: '', user: 'admin', error: 'not-configured' },
        workspace: { cwd: null, peer: null, source: 'unknown' },
      },
    })
    expect(client.listingCalls).toEqual([])
  })

  it('reports the connected server and the workspace peer derived from cwd', async () => {
    const client = new FakeClient()
    const workspace = tempDir()
    const webs = await call(makeDeps(client), { url: `${PREFIX}/status?cwd=${encodeURIComponent(workspace)}` })
    expect(webs.status).toBe(200)
    expect(webs.body).toEqual({
      ok: true,
      value: {
        connection: { connected: true, server: 'http://openviking.test', user: 'admin' },
        workspace: {
          cwd: workspace,
          peer: PEER,
          source: 'git-remote',
          memoryUri: PEER_ROOT,
        },
      },
    })
    expect(client.listingCalls).toEqual([USER_ROOT])
    expect(JSON.stringify(webs.body)).not.toContain(CONFIG.apiKey)
  })

  it('reports the upstream failure code when the probe is rejected', async () => {
    const client = new FakeClient({ listing: () => ({ ok: false, error: { code: 'unauthorized', message: 'no' } }) })
    const response = await call(makeDeps(client), { url: `${PREFIX}/status` })
    expect(response.status).toBe(200)
    expect(response.body.value).toMatchObject({ connection: { connected: false, error: 'unauthorized' } })
  })

  it('treats a missing or non-directory cwd as no workspace instead of failing', async () => {
    const client = new FakeClient()
    const relative = await call(makeDeps(client), { url: `${PREFIX}/status?cwd=relative/dir` })
    expect(relative.status).toBe(400)
    expect(relative.body).toEqual({ ok: false, error: { code: 'malformed', message: expect.any(String) } })
    const missing = await call(makeDeps(client), {
      url: `${PREFIX}/status?cwd=${encodeURIComponent(join(tempDir(), 'gone'))}`,
    })
    expect(missing.status).toBe(200)
    expect(missing.body.value).toMatchObject({ workspace: { cwd: null, peer: null, source: 'unknown' } })
  })
})

describe('memory-view list', () => {
  it('lists the global scope with directories first and names from the uri', async () => {
    const client = new FakeClient({
      listing: (uri) => {
        expect(uri).toBe(USER_ROOT)
        return {
          ok: true,
          value: [
            entry(`${USER_ROOT}/preferences.md`, false, { abstract: '偏好' }),
            entry(`${USER_ROOT}/preferences`, true),
            entry(`${USER_ROOT}/entities`, true),
            entry('viking://resources/elsewhere.md', false),
          ],
        }
      },
    })
    const response = await call(makeDeps(client), { url: `${PREFIX}/list?scope=global` })
    expect(response.status).toBe(200)
    expect(response.body.value).toEqual({
      scope: 'global',
      root: USER_ROOT,
      uri: USER_ROOT,
      nodes: [
        { uri: `${USER_ROOT}/entities`, name: 'entities', isDir: true, size: 0, modTime: '2026-11-06T08:42:52.000Z' },
        { uri: `${USER_ROOT}/preferences`, name: 'preferences', isDir: true, size: 0, modTime: '2026-11-06T08:42:52.000Z' },
        {
          uri: `${USER_ROOT}/preferences.md`,
          name: 'preferences.md',
          isDir: false,
          size: 42,
          modTime: '2026-11-06T08:42:52.000Z',
          abstract: '偏好',
        },
      ],
    })
    expect(JSON.stringify(response.body)).not.toContain(CONFIG.apiKey)
  })

  it('lists a subdirectory of the requested scope root', async () => {
    const client = new FakeClient()
    const response = await call(makeDeps(client), {
      url: `${PREFIX}/list?scope=global&path=events%2F2026`,
    })
    expect(response.status).toBe(200)
    expect(client.listingCalls).toEqual([`${USER_ROOT}/events/2026`])
    expect(response.body.value).toMatchObject({ root: USER_ROOT, uri: `${USER_ROOT}/events/2026` })
  })

  it('derives the workspace root from the host-side peer, not from the client', async () => {
    const client = new FakeClient()
    const workspace = tempDir()
    const seen: string[] = []
    const response = await call(makeDeps(client, {
      resolvePeer: async (cwd): Promise<PeerResolution> => {
        seen.push(cwd)
        return { cwd, peer: PEER, source: 'git-remote' }
      },
    }), { url: `${PREFIX}/list?scope=workspace&cwd=${encodeURIComponent(workspace)}&path=events` })
    expect(response.status).toBe(200)
    expect(seen).toEqual([workspace])
    expect(client.listingCalls).toEqual([`${PEER_ROOT}/events`])
    expect(response.body.value).toMatchObject({ scope: 'workspace', root: PEER_ROOT })
  })

  it('falls back to the global root when the directory has no peer', async () => {
    const client = new FakeClient()
    const workspace = tempDir()
    const response = await call(makeDeps(client, {
      resolvePeer: async (cwd): Promise<PeerResolution> => ({ cwd, peer: null, source: 'none' }),
    }), { url: `${PREFIX}/list?scope=workspace&cwd=${encodeURIComponent(workspace)}` })
    expect(response.status).toBe(200)
    expect(client.listingCalls).toEqual([USER_ROOT])
    expect(response.body.value).toMatchObject({ scope: 'workspace', root: USER_ROOT, uri: USER_ROOT })
  })

  it('rejects traversal, absolute paths and backslashes in path', async () => {
    const client = new FakeClient()
    const cases = ['..%2Fx', '%2Fetc', 'a%5Cb', 'a%2F..%2Fb', 'events%3Fx%3D1']
    for (const relative of cases) {
      const response = await call(makeDeps(client), { url: `${PREFIX}/list?scope=global&path=${relative}` })
      expect(response.status, relative).toBe(400)
      expect(response.body.error?.code, relative).toBe('malformed')
    }
    expect(client.listingCalls).toEqual([])
  })

  it('rejects an unknown or missing scope', async () => {
    const client = new FakeClient()
    const missing = await call(makeDeps(client), { url: `${PREFIX}/list` })
    expect(missing.status).toBe(400)
    const unknown = await call(makeDeps(client), { url: `${PREFIX}/list?scope=whatever` })
    expect(unknown.status).toBe(400)
    expect(client.listingCalls).toEqual([])
  })

  it('answers not-configured instead of calling OpenViking', async () => {
    const client = new FakeClient()
    const response = await call(makeDeps(client, {
      resolveConfig: () => ({ url: '', apiKey: null, account: null, user: 'admin' }),
    }), { url: `${PREFIX}/list?scope=global` })
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ ok: false, error: { code: 'not-configured', message: expect.any(String) } })
    expect(client.listingCalls).toEqual([])
  })

  it('maps an upstream failure onto the envelope', async () => {
    const client = new FakeClient({ listing: () => ({ ok: false, error: { code: 'unreachable', message: 'down' } }) })
    const response = await call(makeDeps(client), { url: `${PREFIX}/list?scope=global` })
    expect(response.status).toBe(502)
    expect(response.body.error).toEqual({ code: 'unreachable', message: 'down' })
  })
})

describe('memory-view read', () => {
  it('returns the document text and its display name', async () => {
    const client = new FakeClient({ read: () => ({ ok: true, value: '# 偏好\n' }) })
    const uri = `${USER_ROOT}/preferences/preferences.md`
    const response = await call(makeDeps(client), { url: `${PREFIX}/read?uri=${encodeURIComponent(uri)}` })
    expect(response.status).toBe(200)
    expect(response.body.value).toEqual({ uri, name: 'preferences.md', text: '# 偏好\n' })
    expect(client.readCalls).toEqual([uri])
  })

  it('rejects unsafe uris and uris outside the allowed roots', async () => {
    const client = new FakeClient()
    const unsafe = [
      '/etc/passwd',
      'viking://user/admin/memories/../../etc',
      'viking://user/admin/memories/a\\b',
      'viking://user/admin/memories?x',
      'https://example.test/x',
    ]
    for (const uri of unsafe) {
      const response = await call(makeDeps(client), { url: `${PREFIX}/read?uri=${encodeURIComponent(uri)}` })
      expect(response.status, uri).toBe(400)
      expect(response.body.error?.code, uri).toBe('malformed')
    }
    const foreign = await call(makeDeps(client), {
      url: `${PREFIX}/read?uri=${encodeURIComponent('viking://user/other/memories/x.md')}`,
    })
    expect(foreign.status).toBe(403)
    expect(foreign.body.error?.code).toBe('forbidden')
    expect(client.readCalls).toEqual([])
  })

  it('forbids a peer document when the request carries no workspace directory', async () => {
    const client = new FakeClient({ read: () => ({ ok: true, value: 'text' }) })
    const uri = `${PEER_ROOT}/events/x.md`
    const anonymous = await call(makeDeps(client, {
      resolvePeer: async (cwd): Promise<PeerResolution> => ({ cwd, peer: null, source: 'none' }),
    }), { url: `${PREFIX}/read?uri=${encodeURIComponent(uri)}` })
    expect(anonymous.status).toBe(403)
    expect(client.readCalls).toEqual([])

    const workspace = tempDir()
    const scoped = await call(makeDeps(client), {
      url: `${PREFIX}/read?uri=${encodeURIComponent(uri)}&cwd=${encodeURIComponent(workspace)}`,
    })
    expect(scoped.status).toBe(200)
    expect(client.readCalls).toEqual([uri])
  })

  it('answers 404 when OpenViking does not have the entry', async () => {
    const client = new FakeClient({ read: () => ({ ok: false, error: { code: 'not-found', message: 'missing' } }) })
    const response = await call(makeDeps(client), {
      url: `${PREFIX}/read?uri=${encodeURIComponent(`${USER_ROOT}/gone.md`)}`,
    })
    expect(response.status).toBe(404)
    expect(response.body.error).toEqual({ code: 'not-found', message: 'missing' })
  })
})

describe('memory-view search', () => {
  it('keeps only hits inside the requested scope and echoes the envelope', async () => {
    const client = new FakeClient({
      search: () => ({
        ok: true,
        value: [
          hit(`${PEER_ROOT}/preferences/a.md`, 0.8),
          hit(`${USER_ROOT}/preferences/b.md`, 0.7, { tags: ['memory_type=preferences'] }),
          hit('viking://resources/c.md', 0.6),
        ],
      }),
    })
    const response = await call(makeDeps(client), {
      url: `${PREFIX}/search`,
      method: 'POST',
      body: { query: ' preferences ', scope: 'global', limit: 5 },
    })
    expect(response.status).toBe(200)
    expect(response.body.value).toEqual({
      query: ' preferences ',
      scope: 'global',
      hits: [{
        uri: `${USER_ROOT}/preferences/b.md`,
        name: 'b.md',
        score: 0.7,
        abstract: `about ${USER_ROOT}/preferences/b.md`,
        tags: ['memory_type=preferences'],
      }],
    })
    expect(client.searchCalls).toEqual([{ query: 'preferences', limit: 15 }])
  })

  it('searches both spaces by default and trims to the requested limit by score', async () => {
    const client = new FakeClient({
      search: (_query, limit) => ({
        ok: true,
        value: Array.from({ length: limit }, (_unused, index) => hit(`${PEER_ROOT}/m${index}.md`, index / 100)),
      }),
    })
    const response = await call(makeDeps(client), {
      url: `${PREFIX}/search?cwd=${encodeURIComponent(tempDir())}`,
      method: 'POST',
      body: { query: 'preference', limit: 2 },
    })
    expect(response.status).toBe(200)
    expect(client.searchCalls).toEqual([{ query: 'preference', limit: 6 }])
    const value = response.body.value as { scope: string; hits: Array<{ score: number }> }
    expect(value.scope).toBe('all')
    expect(value.hits.map(item => item.score)).toEqual([0.05, 0.04])
  })

  it('accepts cwd from the query string for a workspace-scoped search', async () => {
    const client = new FakeClient()
    const workspace = tempDir()
    const seen: string[] = []
    const response = await call(makeDeps(client, {
      resolvePeer: async (cwd): Promise<PeerResolution> => {
        seen.push(cwd)
        return { cwd, peer: PEER, source: 'git-remote' }
      },
    }), {
      url: `${PREFIX}/search?cwd=${encodeURIComponent(workspace)}`,
      method: 'POST',
      body: { query: 'memory', scope: 'workspace' },
    })
    expect(response.status).toBe(200)
    expect(seen).toEqual([workspace])
    expect(client.searchCalls).toEqual([{ query: 'memory', limit: 30 }])
  })

  it('rejects malformed search bodies', async () => {
    const client = new FakeClient()
    const cases: Array<{ body?: unknown; reason: string }> = [
      { reason: 'no body' },
      { body: 'not json', reason: 'invalid json' },
      { body: [], reason: 'array' },
      { body: {}, reason: 'missing query' },
      { body: { query: '   ' }, reason: 'blank query' },
      { body: { query: 'x'.repeat(513) }, reason: 'long query' },
      { body: { query: 'x', scope: 'peers' }, reason: 'bad scope' },
      { body: { query: 'x', limit: 0 }, reason: 'low limit' },
      { body: { query: 'x', limit: 51 }, reason: 'high limit' },
      { body: { query: 'x', limit: 1.5 }, reason: 'fractional limit' },
      { body: { query: 'x', limit: '5' }, reason: 'string limit' },
      { body: { query: 'x'.repeat(70 * 1024) }, reason: 'oversized body' },
    ]
    for (const testCase of cases) {
      const response = await call(makeDeps(client), {
        url: `${PREFIX}/search`,
        method: 'POST',
        body: testCase.body,
      })
      expect(response.status, testCase.reason).toBe(400)
      expect(response.body.error?.code, testCase.reason).toBe('malformed')
    }
    expect(client.searchCalls).toEqual([])
  })

  it('maps an unauthorized upstream onto the envelope', async () => {
    const client = new FakeClient({ search: () => ({ ok: false, error: { code: 'unauthorized', message: 'bad key' } }) })
    const response = await call(makeDeps(client), { url: `${PREFIX}/search`, method: 'POST', body: { query: 'x' } })
    expect(response.status).toBe(502)
    expect(response.body.error?.code).toBe('unauthorized')
  })
})

describe('memory-view upstream failure chain', () => {
  it('carries an upstream 401 through the real client as an unauthorized envelope', async () => {
    const client = new MemoryViewClient({
      url: 'http://openviking.test',
      apiKey: CONFIG.apiKey ?? '',
      fetchImpl: (async () => new Response(null, { status: 401 })) as typeof fetch,
    })
    const response = await call(makeDeps(client), { url: `${PREFIX}/list?scope=global` })
    expect(response.status).toBe(502)
    expect(response.body).toEqual({ ok: false, error: { code: 'unauthorized', message: expect.any(String) } })
    expect(JSON.stringify(response.body)).not.toContain(CONFIG.apiKey)
  })

  it('carries a transport failure through the real client as an unreachable envelope', async () => {
    const client = new MemoryViewClient({
      url: 'http://openviking.test',
      apiKey: CONFIG.apiKey ?? '',
      fetchImpl: (async () => { throw new TypeError('network down') }) as typeof fetch,
    })
    const response = await call(makeDeps(client), { url: `${PREFIX}/list?scope=global` })
    expect(response.status).toBe(502)
    expect(response.body).toEqual({ ok: false, error: { code: 'unreachable', message: expect.any(String) } })
  })
})

describe('memory-view routing errors', () => {
  it('answers 405 with an Allow header for a wrong method', async () => {
    const client = new FakeClient()
    const list = await call(makeDeps(client), { url: `${PREFIX}/list?scope=global`, method: 'POST' })
    expect(list.status).toBe(405)
    expect(list.headers['allow']).toBe('GET')
    expect(list.body.error?.code).toBe('malformed')

    const search = await call(makeDeps(client), { url: `${PREFIX}/search`, method: 'GET' })
    expect(search.status).toBe(405)
    expect(search.headers['allow']).toBe('POST')
    expect(client.listingCalls).toEqual([])
    expect(client.searchCalls).toEqual([])
  })

  it('answers 404 for an unknown endpoint', async () => {
    const response = await call(makeDeps(new FakeClient()), { url: `${PREFIX}/nope` })
    expect(response.status).toBe(404)
    expect(response.body.error?.code).toBe('not-found')
  })

  it('serves the documented envelope headers', async () => {
    const response = await call(makeDeps(new FakeClient()), { url: `${PREFIX}/list?scope=global` })
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
  })

  it('tolerates a trailing slash on a known endpoint', async () => {
    const response = await call(makeDeps(new FakeClient()), { url: `${PREFIX}/list/?scope=global` })
    expect(response.status).toBe(200)
  })
})

describe('memory-view upstream client', () => {
  interface Captured {
    url: string
    init: RequestInit
  }

  function capturingFetch(reply: () => Response | Promise<Response>): { fetchImpl: typeof fetch; seen: Captured[] } {
    const seen: Captured[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} })
      return await reply()
    }) as typeof fetch
    return { fetchImpl, seen }
  }

  it('sends the bearer token, identity headers and an encoded uri', async () => {
    const { fetchImpl, seen } = capturingFetch(() => new Response(JSON.stringify({ status: 'ok', result: [] }), { status: 200 }))
    const client = new MemoryViewClient({
      url: 'http://ov.test/',
      apiKey: 'key-123',
      account: 'default',
      user: 'admin',
      fetchImpl,
    })
    await expect(client.listDirectory(USER_ROOT)).resolves.toEqual({ ok: true, value: [] })
    expect(seen[0].url).toBe(`http://ov.test/api/v1/fs/ls?uri=${encodeURIComponent(USER_ROOT)}`)
    expect(seen[0].init.method).toBe('GET')
    const headers = seen[0].init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer key-123')
    expect(headers['x-openviking-account']).toBe('default')
    expect(headers['x-openviking-user']).toBe('admin')
    expect(headers['accept']).toBe('application/json')
  })

  it('posts search bodies as JSON', async () => {
    const { fetchImpl, seen } = capturingFetch(() => new Response(
      JSON.stringify({ status: 'ok', result: { memories: [{ uri: `${PEER_ROOT}/a.md`, score: 0.5, abstract: 'a', tags: ['t'] }] } }),
      { status: 200 },
    ))
    const client = new MemoryViewClient({ url: 'http://ov.test', apiKey: 'key-123', fetchImpl })
    await expect(client.search('preference', 3)).resolves.toEqual({
      ok: true,
      value: [{ uri: `${PEER_ROOT}/a.md`, score: 0.5, abstract: 'a', tags: ['t'] }],
    })
    expect(seen[0].url).toBe('http://ov.test/api/v1/search/search')
    expect(seen[0].init.method).toBe('POST')
    expect(seen[0].init.body).toBe(JSON.stringify({ query: 'preference', limit: 3 }))
    expect((seen[0].init.headers as Record<string, string>)['content-type']).toBe('application/json')
  })

  it('maps an upstream 401 and 403 to unauthorized without echoing the key', async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = capturingFetch(() => new Response(null, { status }))
      const client = new MemoryViewClient({ url: 'http://ov.test', apiKey: 'key-123', fetchImpl })
      const result = await client.listDirectory(USER_ROOT)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.error.code).toBe('unauthorized')
      expect(JSON.stringify(result)).not.toContain('key-123')
    }
  })

  it('maps a transport failure and a stalled request to unreachable', async () => {
    const thrown = new MemoryViewClient({
      url: 'http://ov.test',
      apiKey: 'key-123',
      timeoutMs: 20,
      fetchImpl: (async () => { throw new TypeError('network down') }) as typeof fetch,
    })
    const unreachable = await thrown.listDirectory(USER_ROOT)
    expect(unreachable.ok).toBe(false)
    if (unreachable.ok) throw new Error('expected failure')
    expect(unreachable.error.code).toBe('unreachable')

    // fetch 自己实现的缝隙：只认 abort 信号，模拟一个卡住的上游。
    const stalled = new MemoryViewClient({
      url: 'http://ov.test',
      apiKey: 'key-123',
      timeoutMs: 10,
      fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as typeof fetch,
    })
    const timedOut = await stalled.readContent(`${USER_ROOT}/a.md`)
    expect(timedOut.ok).toBe(false)
    if (timedOut.ok) throw new Error('expected failure')
    expect(timedOut.error.code).toBe('unreachable')
  })

  it('maps upstream 404, other statuses, bad JSON and an error envelope', async () => {
    const cases: Array<{ reply: () => Response; code: string }> = [
      { reply: () => new Response(null, { status: 404 }), code: 'not-found' },
      { reply: () => new Response(null, { status: 500 }), code: 'internal' },
      { reply: () => new Response('<html>', { status: 200 }), code: 'malformed' },
      { reply: () => new Response(JSON.stringify({ status: 'error', result: null }), { status: 200 }), code: 'malformed' },
    ]
    for (const testCase of cases) {
      const { fetchImpl } = capturingFetch(testCase.reply)
      const client = new MemoryViewClient({ url: 'http://ov.test', apiKey: 'key-123', fetchImpl })
      const result = await client.readContent(`${USER_ROOT}/a.md`)
      expect(result.ok, testCase.code).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.error.code, testCase.code).toBe(testCase.code)
    }
  })

  it('rejects an upstream payload with the wrong shape', async () => {
    const cases: Array<{ payload: unknown; surface: 'list' | 'read' | 'search' }> = [
      { payload: { status: 'ok', result: 'not-an-array' }, surface: 'list' },
      { payload: { status: 'ok', result: [{ isDir: true }] }, surface: 'list' },
      { payload: { status: 'ok', result: { text: 'x' } }, surface: 'read' },
      { payload: { status: 'ok', result: 'x' }, surface: 'search' },
      { payload: { status: 'ok', result: {} }, surface: 'search' },
      { payload: { status: 'ok', result: { memories: [{ score: 1 }] } }, surface: 'search' },
    ]
    for (const testCase of cases) {
      const { fetchImpl } = capturingFetch(() => new Response(JSON.stringify(testCase.payload), { status: 200 }))
      const client = new MemoryViewClient({ url: 'http://ov.test', apiKey: 'key-123', fetchImpl })
      const result = testCase.surface === 'list'
        ? await client.listDirectory(USER_ROOT)
        : testCase.surface === 'read'
          ? await client.readContent(`${USER_ROOT}/a.md`)
          : await client.search('x', 1)
      expect(result.ok, testCase.surface).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.error.code, testCase.surface).toBe('malformed')
    }
  })

  it('drops non-viking entries instead of forwarding dead links', async () => {
    const { fetchImpl } = capturingFetch(() => new Response(JSON.stringify({
      status: 'ok',
      result: [
        { uri: `${USER_ROOT}/keep.md`, isDir: false, size: 10, modTime: 'm' },
        { uri: 'https://example.test/drop.md', isDir: false, size: 1, modTime: 'm' },
      ],
    }), { status: 200 }))
    const client = new MemoryViewClient({ url: 'http://ov.test', apiKey: 'key-123', fetchImpl })
    await expect(client.listDirectory(USER_ROOT)).resolves.toEqual({
      ok: true,
      value: [{ uri: `${USER_ROOT}/keep.md`, isDir: false, size: 10, modTime: 'm' }],
    })
  })
})

describe('memory-view config resolution', () => {
  it('defaults the user and prefers the environment over the file', () => {
    const home = tempDir()
    const file = { url: 'http://file.test', api_key: 'file-key', account: 'file-account', user: 'file-user' }
    writeConf(home, file)
    const resolved = resolveMemoryViewConfig({
      env: { OPENVIKING_URL: 'http://env.test', OPENVIKING_API_KEY: 'env-key' },
      homeDir: home,
    })
    expect(resolved).toEqual({ url: 'http://env.test', apiKey: 'env-key', account: 'file-account', user: 'file-user' })
    expect(isMemoryViewConfigured(resolved)).toBe(true)
    expect(isMemoryViewConfigured(resolveMemoryViewConfig({ env: {}, homeDir: tempDir() }))).toBe(false)
  })

  it('reads the file when the environment says nothing and defaults user to admin', () => {
    const home = tempDir()
    writeConf(home, { url: 'http://file.test', api_key: 'file-key' })
    expect(resolveMemoryViewConfig({ env: {}, homeDir: home })).toEqual({
      url: 'http://file.test',
      apiKey: 'file-key',
      account: null,
      user: DEFAULT_MEMORY_VIEW_USER,
    })
  })

  it('accepts OPENVIKING_BASE_URL as the address fallback', () => {
    const resolved = resolveMemoryViewConfig({
      env: { OPENVIKING_BASE_URL: 'http://base.test', OPENVIKING_API_KEY: 'env-key' },
      homeDir: tempDir(),
    })
    expect(resolved.url).toBe('http://base.test')
  })

  it('strips credentials, queries and trailing slashes from the address', () => {
    const resolved = resolveMemoryViewConfig({
      env: { OPENVIKING_URL: 'http://user:pass@host.test:8080/base///?token=x', OPENVIKING_API_KEY: 'env-key' },
      homeDir: tempDir(),
    })
    expect(resolved.url).toBe('http://host.test:8080/base')
  })

  it('treats a non-http address or unreadable config as not configured', () => {
    expect(resolveMemoryViewConfig({
      env: { OPENVIKING_URL: 'ftp://host.test', OPENVIKING_API_KEY: 'env-key' },
      homeDir: tempDir(),
    }).url).toBe('')
    const broken = tempDir()
    writeConf(broken, 'not json at all')
    expect(isMemoryViewConfigured(resolveMemoryViewConfig({ env: {}, homeDir: broken }))).toBe(false)
    expect(resolveMemoryViewConfig({ env: {}, homeDir: broken }).user).toBe(DEFAULT_MEMORY_VIEW_USER)
  })
})

/** 在临时主目录里写一份 `ovcli.conf`（字符串表示不可解析的内容）。 */
function writeConf(home: string, conf: Record<string, unknown> | string): void {
  const dir = join(home, '.openviking')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ovcli.conf'), typeof conf === 'string' ? conf : JSON.stringify(conf), 'utf8')
}

describe('memory-view peer resolution', () => {
  it('uses the normalized git remote when there is one', async () => {
    const runner = new FakeRunner(argv => argv === GIT_REMOTE_URL_ARGV
      ? gitResult(0, 'git@github.com:chengxiang-zhang/dsh-cove.git\n')
      : gitResult(1))
    const workspace = tempDir()
    await expect(resolveWorkspacePeer(workspace, runner)).resolves.toEqual({
      cwd: workspace,
      peer: PEER,
      source: 'git-remote',
    })
    expect(runner.calls).toEqual([{ argv: [...GIT_REMOTE_URL_ARGV], cwd: workspace }])
  })

  it('falls back to the repository root when there is no remote', async () => {
    const runner = new FakeRunner(argv => argv === GIT_REMOTE_URL_ARGV
      ? gitResult(1)
      : gitResult(0, '/Users/leo/code/dsh-web\n'))
    const workspace = tempDir()
    const resolution = await resolveWorkspacePeer(workspace, runner)
    expect(resolution.source).toBe('git-root')
    expect(resolution.peer).toBe(workspacePeerFromRoot('/Users/leo/code/dsh-web'))
    expect(runner.calls.map(call => call.argv)).toEqual([[...GIT_REMOTE_URL_ARGV], [...GIT_TOP_LEVEL_ARGV]])
  })

  it('reports none when the directory is not a git repository', async () => {
    const runner = new FakeRunner(() => gitResult(128))
    await expect(resolveWorkspacePeer(tempDir(), runner)).resolves.toMatchObject({
      peer: null,
      source: 'none',
    })
  })

  it('reports unknown when git cannot run or the call is too slow', async () => {
    const unavailable = new FakeRunner(() => { throw new Error('spawn git ENOENT') })
    await expect(resolveWorkspacePeer(tempDir(), unavailable)).resolves.toMatchObject({
      peer: null,
      source: 'unknown',
    })
    expect(unavailable.calls).toHaveLength(1)

    const stalled = new FakeRunner(() => new Promise<GitCommandResult>(() => {}))
    await expect(resolveWorkspacePeer(tempDir(), stalled, 10)).resolves.toMatchObject({
      peer: null,
      source: 'unknown',
    })
  })

  it('reports unknown when there is no directory or no runner', async () => {
    await expect(resolveWorkspacePeer(null, new FakeRunner(() => gitResult(0, 'x')))).resolves.toEqual({
      cwd: null,
      peer: null,
      source: 'unknown',
    })
    const workspace = tempDir()
    await expect(resolveWorkspacePeer(workspace, null)).resolves.toEqual({
      cwd: workspace,
      peer: null,
      source: 'unknown',
    })
  })

  it('treats an unreachable cwd as no workspace and a relative one as malformed', () => {
    expect(parseCwd(null)).toEqual({ ok: true, cwd: null })
    expect(parseCwd('   ')).toEqual({ ok: true, cwd: null })
    expect(parseCwd('relative/dir')).toEqual({ ok: false })
    expect(parseCwd(join(tempDir(), 'missing'))).toEqual({ ok: true, cwd: null })
    const workspace = tempDir()
    expect(parseCwd(workspace)).toEqual({ ok: true, cwd: workspace })
    const file = join(workspace, 'a-file')
    writeFileSync(file, 'x', 'utf8')
    expect(parseCwd(file)).toEqual({ ok: true, cwd: null })
  })
})

describe('memory-view service registration', () => {
  interface FakeSpawnSpec {
    argv: readonly string[]
    cwd: string
  }

  function fakeContext(routes: WebRoute[], spawns: FakeSpawnSpec[]): Context {
    return {
      webServer: {
        register(route: WebRoute) {
          routes.push(route)
          return () => {}
        },
      },
      subprocess: {
        spawn(spec: { argv: readonly string[]; cwd: string }) {
          spawns.push({ argv: spec.argv, cwd: spec.cwd })
          return {
            done: Promise.resolve({ exitCode: 0 }),
            collected: {
              stdout: { readFrom: () => ({ text: 'git@github.com:chengxiang-zhang/dsh-cove.git\n' }) },
              stderr: { readFrom: () => ({ text: '' }) },
            },
          }
        },
      },
      logger: () => ({ warn: () => {} }),
    } as unknown as Context
  }

  it('resolves configuration from the injected home and derives the peer through ctx.subprocess', async () => {
    const routes: WebRoute[] = []
    const spawns: FakeSpawnSpec[] = []
    const home = tempDir()
    writeConf(home, { url: 'http://file.test', api_key: 'file-key' })
    const client = new FakeClient()
    const dispose = registerMemoryView(fakeContext(routes, spawns), {
      env: {},
      homeDir: home,
      createClient: () => client,
    })
    expect(routes.map(route => route.path)).toEqual([PREFIX])

    const workspace = tempDir()
    const status = await callRoute(routes[0], { url: `${PREFIX}/status?cwd=${encodeURIComponent(workspace)}` })
    expect(status.status).toBe(200)
    expect(status.body.value).toMatchObject({
      connection: { connected: true, server: 'http://file.test', user: 'admin' },
      workspace: { cwd: workspace, peer: PEER, source: 'git-remote', memoryUri: PEER_ROOT },
    })
    expect(client.listingCalls).toEqual([USER_ROOT])
    expect(spawns).toEqual([{ argv: ['git', ...GIT_REMOTE_URL_ARGV], cwd: workspace }])
    expect(JSON.stringify(status.body)).not.toContain('file-key')
    dispose()
  })

  it('skips git when the domain is mounted without a runner', async () => {
    const routes: WebRoute[] = []
    const spawns: FakeSpawnSpec[] = []
    registerMemoryView(fakeContext(routes, spawns), { env: {}, homeDir: tempDir(), runner: null })
    const workspace = tempDir()
    const status = await callRoute(routes[0], { url: `${PREFIX}/status?cwd=${encodeURIComponent(workspace)}` })
    expect(status.body.value).toMatchObject({
      connection: { connected: false, error: 'not-configured' },
      workspace: { cwd: workspace, peer: null, source: 'unknown' },
    })
    expect(spawns).toEqual([])
  })
})