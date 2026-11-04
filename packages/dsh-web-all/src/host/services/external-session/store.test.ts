import { describe, expect, it } from 'vitest'
import { EXTERNAL_SESSION_STORE_FILE, resolveExternalSessionConfig, EXTERNAL_SESSION_DEFAULTS } from './config.ts'
import { MemoryStoreFileSystem } from './test-doubles.ts'
import { ExternalSessionStore, StoreUnavailableError, isDirectory } from './store.ts'
import { serializeExternalStore } from '../../../core/external-session/schema.ts'
import type { ExternalSessionRecord } from '../../../core/external-session/types.ts'

const PATH = '/tmp/dsh-external-session.json'
const AT = '2026-11-04T12:00:00Z'

function record(overrides: Partial<ExternalSessionRecord> = {}): ExternalSessionRecord {
  return {
    id: 'ext-1',
    provider: 'claude',
    providerSessionId: 'cli-abc',
    cwd: '/tmp',
    title: 'work',
    status: 'idle',
    createdAt: AT,
    lastTurnAt: AT,
    turns: [],
    ...overrides,
  }
}

function makeStore(fs: MemoryStoreFileSystem, maxSessions = 100) {
  const warnings: string[] = []
  const store = new ExternalSessionStore({
    storePath: PATH,
    maxSessions,
    fs,
    onWarning: message => warnings.push(message),
    now: () => 1_700_000_000_000,
  })
  return { store, warnings }
}

describe('external-session config', () => {
  it('defaults to the design numbers', () => {
    const resolved = resolveExternalSessionConfig({}, '/tmp/home')
    expect(resolved.maxConcurrentTurns).toBe(2)
    expect(resolved.maxSessions).toBe(100)
    expect(resolved.cancelGraceMs).toBe(3_000)
    expect(resolved.claudeBin).toBe('claude')
    expect(resolved.codexBin).toBe('codex')
    expect(resolved.storePath).toBe(`/tmp/home/${EXTERNAL_SESSION_STORE_FILE}`)
  })

  it('takes deployment overrides and rejects nonsense values', () => {
    const overridden = resolveExternalSessionConfig({
      maxConcurrentTurns: 4, maxSessions: 10, cancelGraceMs: 500, claudeBin: '/opt/claude', codexBin: ' codex ',
    }, '/tmp/home')
    expect(overridden.maxConcurrentTurns).toBe(4)
    expect(overridden.maxSessions).toBe(10)
    expect(overridden.cancelGraceMs).toBe(500)
    expect(overridden.claudeBin).toBe('/opt/claude')
    expect(overridden.codexBin).toBe('codex')

    const nonsensical = resolveExternalSessionConfig({ maxConcurrentTurns: 0, maxSessions: -1, claudeBin: '' }, '/tmp')
    expect(nonsensical.maxConcurrentTurns).toBe(EXTERNAL_SESSION_DEFAULTS.maxConcurrentTurns)
    expect(nonsensical.maxSessions).toBe(EXTERNAL_SESSION_DEFAULTS.maxSessions)
    expect(nonsensical.claudeBin).toBe(EXTERNAL_SESSION_DEFAULTS.claudeBin)
  })

  it('resolves an absolute store path', () => {
    expect(resolveExternalSessionConfig({ storePath: 'relative/store.json' }, '/tmp').storePath)
      .toBe(resolveExternalSessionConfig({ storePath: 'relative/store.json' }, '/tmp').storePath)
    expect(resolveExternalSessionConfig({ storePath: '/var/tmp/x.json' }, '/tmp').storePath).toBe('/var/tmp/x.json')
  })
})

describe('external-session store', () => {
  it('treats a missing file as an empty store and reads back what it wrote', async () => {
    const fs = new MemoryStoreFileSystem()
    const { store } = makeStore(fs)
    expect(await store.load()).toEqual([])
    expect(store.isLoaded).toBe(true)

    await store.upsert(record())
    expect(fs.writes).toEqual([PATH])

    // Cold start: a fresh instance over the same bytes must see the session.
    const cold = makeStore(fs).store
    expect(await cold.load()).toHaveLength(1)
    expect(cold.get('ext-1')?.providerSessionId).toBe('cli-abc')
  })

  it('writes the whole file atomically through the injected seam', async () => {
    const fs = new MemoryStoreFileSystem()
    const { store } = makeStore(fs)
    await store.load()
    await store.upsert(record())
    const written = JSON.parse(fs.files.get(PATH) ?? '{}') as { version: number; sessions: unknown[] }
    expect(written.version).toBe(1)
    expect(written.sessions).toHaveLength(1)
    expect((fs.files.get(PATH) ?? '').endsWith('\n')).toBe(true)
  })

  it('quarantines an illegal store instead of overwriting it', async () => {
    const illegal = JSON.stringify({ version: 1, sessions: [{ id: '' }] })
    const fs = new MemoryStoreFileSystem({ [PATH]: illegal })
    const { store, warnings } = makeStore(fs)

    expect(await store.load()).toEqual([])
    expect(store.size).toBe(0)
    expect(store.quarantinedPath).toBe(`${PATH}.corrupt-1700000000000`)
    // The bytes are preserved under the quarantine name, not destroyed.
    expect(fs.files.get(`${PATH}.corrupt-1700000000000`)).toBe(illegal)
    expect(warnings.join('\n')).toContain('unreadable external-session store')
  })

  it('quarantines a file that is not JSON at all', async () => {
    const fs = new MemoryStoreFileSystem({ [PATH]: 'not json' })
    const { store, warnings } = makeStore(fs)
    await store.load()
    expect(store.quarantinedPath).not.toBeNull()
    expect(warnings).toHaveLength(1)
  })

  it('refuses a new session at the limit but still replaces an existing one', async () => {
    const fs = new MemoryStoreFileSystem()
    const { store } = makeStore(fs, 1)
    await store.load()
    await store.upsert(record())
    expect(store.canAdd()).toBe(false)
    await expect(store.upsert(record({ id: 'ext-2' }))).rejects.toThrow('full')
    // Replacing the session already held is not growth.
    await store.upsert(record({ title: 'renamed' }))
    expect(store.get('ext-1')?.title).toBe('renamed')
  })

  it('does not adopt state a failed write never committed', async () => {
    const fs = new MemoryStoreFileSystem()
    const { store } = makeStore(fs)
    await store.load()
    fs.failNextWrite = new Error('disk full')
    // The refusal is typed so the engine can answer `store-unavailable`: the
    // raw cause is kept for the host log, never for the model.
    const failure = await store.upsert(record()).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(StoreUnavailableError)
    expect(String((failure as StoreUnavailableError).cause)).toContain('disk full')
    expect(store.get('ext-1')).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('serializes concurrent writes so the last one wins without interleaving', async () => {
    const fs = new MemoryStoreFileSystem()
    const { store } = makeStore(fs)
    await store.load()
    await Promise.all([
      store.upsert(record({ id: 'ext-a' })),
      store.upsert(record({ id: 'ext-b' })),
      store.upsert(record({ id: 'ext-c' })),
    ])
    expect(store.list().map(session => session.id).sort()).toEqual(['ext-a', 'ext-b', 'ext-c'])
    const written = JSON.parse(fs.files.get(PATH) ?? '{}') as { sessions: Array<{ id: string }> }
    expect(written.sessions).toHaveLength(3)
  })

  it('round-trips turns and their usage', async () => {
    const fs = new MemoryStoreFileSystem()
    const { store } = makeStore(fs)
    await store.load()
    await store.upsert(record({ turns: [{
      n: 1, prompt: 'remember 42', status: 'completed', startedAt: AT, durationMs: 10,
      usage: { input: 5, output: 2 }, costUsd: 0.01, result: '42',
    }] }))
    const cold = makeStore(fs).store
    await cold.load()
    expect(cold.get('ext-1')?.turns[0]?.usage).toEqual({ input: 5, output: 2 })
    expect(cold.get('ext-1')?.turns[0]?.result).toBe('42')
  })

  it('reads an empty store it wrote itself', async () => {
    const fs = new MemoryStoreFileSystem({ [PATH]: serializeExternalStore({ version: 1, sessions: [] }) })
    const { store } = makeStore(fs)
    expect(await store.load()).toEqual([])
    expect(store.quarantinedPath).toBeNull()
  })
})

describe('isDirectory', () => {
  it('reports a real directory and refuses a missing one', async () => {
    await expect(isDirectory('/tmp')).resolves.toBe(true)
    await expect(isDirectory('/tmp/definitely-not-a-directory-9f3a')).resolves.toBe(false)
  })
})