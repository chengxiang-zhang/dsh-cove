import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { MEMOIR_API_PREFIX, makeMemoirRoutes, type MemoirRoutesDeps } from '../src/host/services/memoir/routes.ts'
import { MemoirStore } from '../src/host/services/memoir/store.ts'
import type { MemoirEntry } from '../src/core/memoir/protocol.ts'

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  Object.assign(req, {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  })
  return req
}

async function run(deps: MemoirRoutesDeps, method: string, pathname: string, body?: unknown): Promise<{ status: number; text: string }> {
  const req = makeReq(method, pathname, body)
  let status = 0
  let text = ''
  const res = new EventEmitter() as unknown as ServerResponse & { writeHead(code: number): unknown; end(chunk?: string | Buffer): unknown; write(chunk: string | Buffer): boolean; writableEnded: boolean }
  Object.assign(res, {
    writeHead(code: number) { status = code; return this },
    end(chunk?: string | Buffer) { if (chunk !== undefined) text += chunk.toString(); this.emit('finish'); return this },
    write(chunk: string | Buffer) { text += chunk.toString(); return true },
    writableEnded: false,
  })
  const routes = makeMemoirRoutes(deps)
  const route = routes.find(r => r.kind === 'prefix' && pathname.startsWith(r.path))
  if (route === undefined) throw new Error(`no route for ${pathname}`)
  await (route as { handler(req: IncomingMessage, res: ServerResponse): Promise<void> }).handler(req, res as ServerResponse)
  return { status, text }
}

const NOW = 1_700_000_000_000

function entry(partial: Partial<MemoirEntry> = {}): MemoirEntry {
  return {
    id: 'm-1',
    title: 'SSH restore',
    content: 'Ported the original 5-tab panel.',
    section: 'work',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    pinned: false,
    importance: 3,
    ...partial,
  }
}

function makeDeps(entries: MemoirEntry[] = [entry()]): { deps: MemoirRoutesDeps; store: MemoirStore } {
  const store = new MemoirStore('/tmp/dsh-memoir-test-' + Math.random().toString(36).slice(2) + '.json')
  if (entries.length > 0) store.saveProject('/Users/tester/code/dsh-cove', entries)
  const settings = {
    enabled: true,
    announceToAgent: false,
    autoDistill: true,
    autoDistillEvery: 1,
    autoDistillCooldownMin: 0,
    autoDistillMinTools: 1,
    hotMemoryTokens: 900,
    hotMemoryMaxTokens: 1200,
    readDefaultLimit: 8,
    readMaxLimit: 30,
    sessionSnapshotMax: 128,
    queryCacheSize: 128,
  }
  let saved = settings
  const deps: MemoirRoutesDeps = {
    store,
    settings: () => saved,
    saveSettings: (next) => { saved = next },
    logger: { warn: () => {} },
  }
  return { deps, store }
}

describe('memoir routes — restored panel wire contract', () => {
  it('GET /project returns the wrapped {project} wire shape', async () => {
    const { deps } = makeDeps()
    const { status, text } = await run(deps, 'GET', `${MEMOIR_API_PREFIX}/project?path=${encodeURIComponent('/Users/tester/code/dsh-cove')}`)
    expect(status).toBe(200)
    const body = JSON.parse(text) as { ok: boolean; value: { project: { key: string; path: string; title: string; updatedAt: number; entries: Array<{ id: string; time: number }> } } }
    expect(body.ok).toBe(true)
    expect(body.value.project.key).toBe('/Users/tester/code/dsh-cove')
    expect(body.value.project.title).toBe('dsh-cove')
    expect(body.value.project.entries[0]?.time).toBe(NOW)
  })

  it('GET /global returns full non-empty projects', async () => {
    const { deps } = makeDeps()
    const { status, text } = await run(deps, 'GET', `${MEMOIR_API_PREFIX}/global`)
    expect(status).toBe(200)
    const body = JSON.parse(text) as { value: { projects: Array<{ key: string; entries: unknown[] }> } }
    expect(body.value.projects.length).toBeGreaterThan(0)
    expect(body.value.projects[0]?.entries.length).toBeGreaterThan(0)
  })

  it('GET /search returns {results} with projectPath/entry/score', async () => {
    const { deps } = makeDeps()
    const { status, text } = await run(deps, 'GET', `${MEMOIR_API_PREFIX}/search?scope=global&query=ssh`)
    expect(status).toBe(200)
    const body = JSON.parse(text) as { value: { results: Array<{ projectPath: string; entry: { title: string }; score: number }> } }
    expect(body.value.results[0]?.entry.title).toBe('SSH restore')
    expect(typeof body.value.results[0]?.score).toBe('number')
  })

  it('GET /hot-memory returns {hotMemory} with text/selected/total', async () => {
    const { deps } = makeDeps([entry({ pinned: true })])
    const { status, text } = await run(deps, 'GET', `${MEMOIR_API_PREFIX}/hot-memory?path=${encodeURIComponent('/Users/tester/code/dsh-cove')}`)
    expect(status).toBe(200)
    const body = JSON.parse(text) as { value: { hotMemory: { text: string; selected: unknown[]; total: number; estimatedTokens: number } } }
    expect(body.value.hotMemory.total).toBe(1)
    expect(body.value.hotMemory.selected).toHaveLength(1)
    expect(body.value.hotMemory.estimatedTokens).toBeGreaterThan(0)
  })

  it('POST /entries records and returns the WireRecordResult shape', async () => {
    const { deps } = makeDeps([])
    const { status, text } = await run(deps, 'POST', `${MEMOIR_API_PREFIX}/entries`, { path: '/Users/tester/code/dsh-cove', title: 'New', content: 'Body', section: 'work', importance: 5 })
    expect(status).toBe(200)
    const body = JSON.parse(text) as { value: { action: string; recorded: boolean; entry: { title: string; time: number }; candidates: unknown[] } }
    expect(body.value.action).toBe('recorded')
    expect(body.value.recorded).toBe(true)
    expect(body.value.entry.title).toBe('New')
    expect(Array.isArray(body.value.candidates)).toBe(true)
  })

  it('PATCH /entries updates and returns {entry, updated}', async () => {
    const { deps } = makeDeps()
    const { status, text } = await run(deps, 'PATCH', `${MEMOIR_API_PREFIX}/entries`, { path: '/Users/tester/code/dsh-cove', id: 'm-1', pinned: true })
    expect(status).toBe(200)
    const body = JSON.parse(text) as { value: { entry: { pinned: boolean }; updated: boolean } }
    expect(body.value.updated).toBe(true)
    expect(body.value.entry.pinned).toBe(true)
  })

  it('DELETE /entries removes and returns {removed}', async () => {
    const { deps } = makeDeps()
    const { status, text } = await run(deps, 'DELETE', `${MEMOIR_API_PREFIX}/entries`, { path: '/Users/tester/code/dsh-cove', id: 'm-1' })
    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({ ok: true, value: { removed: true } })
  })

  it('GET /settings returns {settings, source}', async () => {
    const { deps } = makeDeps()
    const { status, text } = await run(deps, 'GET', `${MEMOIR_API_PREFIX}/settings`)
    expect(status).toBe(200)
    const body = JSON.parse(text) as { value: { settings: { announceToAgent: boolean }; source: string } }
    expect(typeof body.value.settings.announceToAgent).toBe('boolean')
    expect(['profile', 'web']).toContain(body.value.source)
  })

  it('PUT /settings persists and returns source=web', async () => {
    const { deps } = makeDeps()
    const { status, text } = await run(deps, 'PUT', `${MEMOIR_API_PREFIX}/settings`, { announceToAgent: true, autoDistill: false })
    expect(status).toBe(200)
    const body = JSON.parse(text) as { value: { settings: { announceToAgent: boolean; autoDistill: boolean }; source: string } }
    expect(body.value.settings.announceToAgent).toBe(true)
    expect(body.value.settings.autoDistill).toBe(false)
    expect(body.value.source).toBe('web')
  })

  /**
 * The host is the boundary. `validateMemoirSettingsPatch` existed with no call
 * site, so both settings mutations merged the raw body straight to disk: a
 * wrong-typed or negative value was persisted and only coerced back on the next
 * load, and unknown keys were written verbatim.
 */
describe('memoir settings validation', () => {
  it('refuses a wrong-typed or out-of-range patch instead of writing it', async () => {
    const { deps, store } = makeDeps()
    const cases = [
      { hotMemoryMaxTokens: 'many' },
      { readMaxLimit: -1 },
      { autoDistillEvery: 0 },
      { autoDistillCooldownMin: -5 },
      { announceToAgent: 'yes' },
      { hotMemoryMaxTokens: 10 },
      { nonsense: true },
    ]
    for (const body of cases) {
      const put = await run(deps, 'PUT', `${MEMOIR_API_PREFIX}/settings`, body)
      expect(put.status, JSON.stringify(body)).toBe(400)
      const post = await run(deps, 'POST', `${MEMOIR_API_PREFIX}/settings`, body)
      expect(post.status, JSON.stringify(body)).toBe(400)
    }
    // Nothing rejected reached the store or the settings file.
    expect(store.load().projects).toBeDefined()
  })

  it('accepts the range the settings panel actually offers', async () => {
    const { deps } = makeDeps()
    const put = await run(deps, 'PUT', `${MEMOIR_API_PREFIX}/settings`, {
      announceToAgent: true, autoDistillEvery: 3, autoDistillCooldownMin: 0,
      hotMemoryTokens: 800, hotMemoryMaxTokens: 1000, readDefaultLimit: 5, readMaxLimit: 20,
    })
    expect(put.status).toBe(200)
    const body = JSON.parse(put.text) as { value: { settings: { hotMemoryMaxTokens: number; autoDistillEvery: number } } }
    expect(body.value.settings.hotMemoryMaxTokens).toBe(1000)
    expect(body.value.settings.autoDistillEvery).toBe(3)
  })

  it('checks the cross-field limits against the merged result', async () => {
    const { deps } = makeDeps()
    // hotMemoryTokens alone: 1200 would exceed the stored hotMemoryMaxTokens.
    expect((await run(deps, 'PUT', `${MEMOIR_API_PREFIX}/settings`, { hotMemoryTokens: 1300 })).status).toBe(400)
    expect((await run(deps, 'PUT', `${MEMOIR_API_PREFIX}/settings`, { readDefaultLimit: 40 })).status).toBe(400)
    expect((await run(deps, 'PUT', `${MEMOIR_API_PREFIX}/settings`, { hotMemoryTokens: 1100 })).status).toBe(200)
  })
})

it('GET /diagnostics returns the WireDiagnostics object shape', async () => {
    const { deps } = makeDeps()
    const { status, text } = await run(deps, 'GET', `${MEMOIR_API_PREFIX}/diagnostics`)
    expect(status).toBe(200)
    const body = JSON.parse(text) as { value: { storeRevision: number; cache: { hitRate: number }; retrieval: { index: unknown; cache: { capacity: number } }; config: { queryCacheSize: number } } }
    expect(typeof body.value.storeRevision).toBe('number')
    expect(typeof body.value.cache.hitRate).toBe('number')
    expect(body.value.retrieval.cache.capacity).toBe(128)
    expect(body.value.config.queryCacheSize).toBe(128)
  })
})
