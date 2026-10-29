/**
 * memoir host 服务域 —— 路由层（全新实现；行为契约参考旧包）。
 *
 * /api/dsh-memoir/* 前缀路由族（JSON envelope：{ok,value} / {ok,error}，
 * 老 dsh-memoir 契约）：project / global / entries / search / hot-memory /
 * diagnostics / settings。信任围栏为共享的宿主访问围栏（loopback，或部署声明的
 * trusted authority + 已登录浏览器会话）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MemoirStore, queryProjects, FORMAT_VERSION, type MemoirEntry, type MemoirProject, type MemoirStatus, type SectionKey } from './store.ts'
import { DEFAULT_MEMOIR_SETTINGS, validateMemoirSettingsPatch } from './settings.ts'
import type { MemoirSettings } from './settings.ts'
import { accessTrustOf } from '../access-trust/index.ts'
import { isLoopbackRequest } from '../access-trust/trust.ts'
import { registerResources } from '../resources.ts'

export const MEMOIR_API_PREFIX = '/api/dsh-memoir'

interface MemoirRoutesDeps {
  store: MemoirStore
  settings(): MemoirSettings
  saveSettings(settings: MemoirSettings): void
  logger: { warn(error: unknown): void }
  /** Host access fence; defaults to the strict loopback rule. */
  isTrusted?(req: IncomingMessage): boolean
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function ok(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

function fail(res: ServerResponse, status: number, message: string): void {
  writeJson(res, status, { ok: false, error: { code: 'memoir-error', message } })
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) return null
    chunks.push(buf)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

const SECTION_KEYS: SectionKey[] = ['work', 'lessons', 'actions', 'note']
const STATUSES: MemoirStatus[] = ['active', 'superseded', 'archived']

function isSectionKey(value: unknown): value is SectionKey {
  return typeof value === 'string' && (SECTION_KEYS as string[]).includes(value)
}

function isStatus(value: unknown): value is MemoirStatus {
  return typeof value === 'string' && (STATUSES as string[]).includes(value)
}

/** 项目标题（路径末段）。 */
function projectTitle(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** 条目 wire shape：把存储字段映射为面板契约（time/source/sessionId 别名）。 */
function wireEntry(entry: MemoirEntry): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: entry.id,
    section: entry.section,
    title: entry.title,
    content: entry.content,
    time: entry.createdAt ?? entry.updatedAt,
    importance: entry.importance,
    pinned: entry.pinned,
    status: entry.status,
  }
  if (entry.tags !== undefined) wire.tags = entry.tags
  if (entry.supersedes !== undefined) wire.supersedes = entry.supersedes
  return wire
}

/** 项目 wire shape（面板契约：key/path/title/updatedAt/entries）。 */
function wireProject(path: string, project: MemoirProject, filter: (entry: MemoirEntry) => boolean): Record<string, unknown> {
  return {
    key: path,
    path: project.path,
    title: projectTitle(project.path),
    updatedAt: project.entries.reduce((n, e) => Math.max(n, e.updatedAt ?? e.createdAt ?? 0), 0),
    entries: project.entries.filter(filter).map(wireEntry),
  }
}

/** 条目过滤器（section + status + query）。 */
function entryFilter(section: string | undefined, status: string, query: string): (entry: MemoirEntry) => boolean {
  const q = query.toLowerCase()
  return (entry) =>
    (section === undefined || entry.section === section)
    && (status === 'all' || (entry.status ?? 'active') === status)
    && (q === '' || `${entry.title ?? ''} ${entry.content}`.toLowerCase().includes(q))
}

/** 构建 /api/dsh-memoir 前缀路由。 */
export function makeMemoirRoutes(deps: MemoirRoutesDeps): WebRoute[] {
  const { store, logger } = deps
  const isTrusted = deps.isTrusted ?? isLoopbackRequest

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isTrusted(req)) { fail(res, 403, 'forbidden: loopback-only'); return }
    const url = new URL(req.url ?? '/', 'http://x')
    const pathname = url.pathname
    try {
      if (req.method === 'GET' && pathname === MEMOIR_API_PREFIX + '/project') {
        const path = url.searchParams.get('path')
        if (path === null || path === '') { fail(res, 400, 'path query is required'); return }
        const section = url.searchParams.get('section') ?? undefined
        const status = url.searchParams.get('status') ?? 'active'
        const filter = entryFilter(section, status, '')
        const key = path
        const project = store.project(path)
        ok(res, { project: project === undefined
          ? { key, path, title: projectTitle(path), updatedAt: 0, entries: [] }
          : wireProject(key, project, filter) })
        return
      }
      if (req.method === 'GET' && pathname === MEMOIR_API_PREFIX + '/global') {
        const section = url.searchParams.get('section') ?? undefined
        const status = url.searchParams.get('status') ?? 'active'
        const filter = entryFilter(section, status, '')
        const all = queryProjects(store.load())
        const projects = all
          .map((p) => wireProject(p.path, p, filter))
          .filter((p) => (p.entries as unknown[]).length > 0)
        ok(res, { projects })
        return
      }
      if (req.method === 'GET' && pathname === MEMOIR_API_PREFIX + '/search') {
        const scope = url.searchParams.get('scope')
        const path = url.searchParams.get('path')
        const section = url.searchParams.get('section') ?? undefined
        const status = url.searchParams.get('status') ?? 'all'
        const limitText = url.searchParams.get('limit')
        const limit = limitText === null ? 100 : Math.min(Number(limitText) || 100, 500)
        const q = url.searchParams.get('query') ?? url.searchParams.get('q') ?? ''
        const needle = q.toLowerCase()
        const projects = scope === 'project' && path !== null && path !== ''
          ? [store.project(path)]
          : queryProjects(store.load())
        const results: Array<{ projectPath: string; entry: Record<string, unknown>; score: number }> = []
        for (const project of projects) {
          for (const entry of project.entries) {
            if (needle === '') continue
            if (section !== undefined && entry.section !== section) continue
            if (status !== 'all' && (entry.status ?? 'active') !== status) continue
            const title = entry.title.toLowerCase()
            const content = entry.content.toLowerCase()
            if (!title.includes(needle) && !content.includes(needle)) continue
            const score = (title.includes(needle) ? 2 : 1) + (content.startsWith(needle) ? 0.5 : 0)
            results.push({ projectPath: project.path, entry: wireEntry(entry), score })
          }
        }
        results.sort((a, b) => b.score - a.score)
        ok(res, { results: results.slice(0, limit) })
        return
      }
      if (req.method === 'GET' && pathname === MEMOIR_API_PREFIX + '/hot-memory') {
        const path = url.searchParams.get('path')
        const project = path !== null && path !== '' ? store.project(path) : undefined
        if (project === undefined) { fail(res, 400, 'path query is required'); return }
        const selected = project.entries
          .filter(e => e.status === 'active' && e.pinned)
          .sort((a, b) => (b.importance ?? 3) - (a.importance ?? 3))
          .slice(0, 8)
        const text = selected.map(e => `### ${e.title}\n${e.content}`).join('\n\n')
        ok(res, {
          hotMemory: selected.length === 0 ? null : {
            text,
            selected: selected.map(wireEntry),
            total: selected.length,
            estimatedTokens: Math.ceil(text.length / 4),
          },
        })
        return
      }
      if (req.method === 'GET' && pathname === MEMOIR_API_PREFIX + '/diagnostics') {
        const all = queryProjects(store.load())
        const entries = all.reduce((n, p) => n + p.entries.length, 0)
        const config = deps.settings()
        ok(res, {
          storeRevision: FORMAT_VERSION,
          snapshotEpoch: 0,
          cache: { revision: 0, epoch: 0, loads: 0, hits: 0, misses: 0, hitRate: 0, fileReads: 0, statProbes: 0, corruptBackups: 0, renders: 0, renderComputes: 0, renderHitRate: 0 },
          snapshotCount: 0,
          snapshotMax: config.sessionSnapshotMax,
          hotMemory: null,
          retrieval: {
            index: null,
            cache: { hits: 0, misses: 0, evictions: 0, hitRate: 0, size: 0, capacity: config.queryCacheSize },
            lastQuery: null,
          },
          snapshot: null,
          config: {
            announceToAgent: config.announceToAgent,
            autoDistill: config.autoDistill,
            autoDistillEvery: config.autoDistillEvery,
            autoDistillCooldownMin: config.autoDistillCooldownMin,
            autoDistillMinTools: config.autoDistillMinTools,
            hotMemoryTokens: config.hotMemoryTokens,
            hotMemoryMaxTokens: config.hotMemoryMaxTokens,
            readDefaultLimit: config.readDefaultLimit,
            readMaxLimit: config.readMaxLimit,
            sessionSnapshotMax: config.sessionSnapshotMax,
            queryCacheSize: config.queryCacheSize,
          },
          projects: all.length,
          entries,
        })
        return
      }
      if ((req.method === 'GET' || req.method === 'POST') && pathname === MEMOIR_API_PREFIX + '/settings') {
        const settings = deps.settings()
        if (req.method === 'POST') {
          const body = await readJsonBody(req, 64 * 1024)
          if (body === null) { fail(res, 400, 'invalid JSON body'); return }
          // 宿主是边界：补丁先过校验，非法值不会落到磁盘。
          const invalid = validateMemoirSettingsPatch(body, settings)
          if (invalid !== undefined) { fail(res, 400, invalid); return }
          const next = { ...settings, ...body } as MemoirSettings
          deps.saveSettings(next)
          ok(res, { settings: next, source: 'web' })
          return
        }
        ok(res, { settings, source: 'profile' })
        return
      }
      if (req.method === 'PUT' && pathname === MEMOIR_API_PREFIX + '/settings') {
        const body = await readJsonBody(req, 64 * 1024)
        if (body === null) { fail(res, 400, 'invalid JSON body'); return }
        const invalid = validateMemoirSettingsPatch(body, deps.settings())
        if (invalid !== undefined) { fail(res, 400, invalid); return }
        const next = { ...deps.settings(), ...body } as MemoirSettings
        deps.saveSettings(next)
        ok(res, { settings: next, source: 'web' })
        return
      }
      if (req.method === 'DELETE' && pathname === MEMOIR_API_PREFIX + '/settings') {
        const body = await readJsonBody(req, 64 * 1024)
        const reset = { ...DEFAULT_MEMOIR_SETTINGS }
        if (body !== null && typeof body === 'object' && (body as Record<string, unknown>).merge !== true) {
          deps.saveSettings(reset)
        }
        ok(res, { settings: deps.settings(), source: 'profile' })
        return
      }
      if ((req.method === 'POST' || req.method === 'PATCH') && pathname === MEMOIR_API_PREFIX + '/entries') {
        const body = await readJsonBody(req, 128 * 1024)
        if (body === null) { fail(res, 400, 'invalid JSON body'); return }
        const path = body.path
        if (typeof path !== 'string' || path === '') { fail(res, 400, 'expected { path }'); return }
        const project = store.project(path)
        if (req.method === 'POST') {
          const { title, content, section } = body
          if (typeof title !== 'string' || title.trim() === '' || typeof content !== 'string' || content.trim() === '' || !isSectionKey(section)) {
            fail(res, 400, 'expected { path, title, content, section }')
            return
          }
          const now = Date.now()
          const entry: MemoirEntry = {
            id: `m-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            title: title.trim(),
            content: content.trim(),
            section,
            status: 'active',
            createdAt: now,
            updatedAt: now,
            pinned: typeof body.pinned === 'boolean' ? body.pinned : false,
            importance: typeof body.importance === 'number' ? body.importance : 3,
            ...(Array.isArray(body.tags) ? { tags: body.tags.filter((t): t is string => typeof t === 'string') } : {}),
            ...(Array.isArray(body.supersedes) ? { supersedes: body.supersedes.filter((t): t is string => typeof t === 'string') } : {}),
          }
          project.entries.push(entry)
          store.saveProject(path, project.entries)
          ok(res, { action: 'recorded' as const, recorded: true, entry: wireEntry(entry), candidates: [] })
          return
        }
        // PATCH /entries — update entry content or lifecycle metadata.
        const { id } = body
        if (typeof id !== 'string' || id === '') { fail(res, 400, 'expected { path, id }'); return }
        const entry = project.entries.find((e) => e.id === id)
        if (entry === undefined) { fail(res, 404, `entry not found: ${id}`); return }
        if (typeof body.title === 'string' && body.title.trim() !== '') entry.title = body.title.trim()
        if (typeof body.content === 'string' && body.content.trim() !== '') entry.content = body.content.trim()
        if (isSectionKey(body.section)) entry.section = body.section
        if (isStatus(body.status)) entry.status = body.status
        if (typeof body.pinned === 'boolean') entry.pinned = body.pinned
        if (typeof body.importance === 'number') entry.importance = body.importance
        if (Array.isArray(body.tags)) entry.tags = body.tags.filter((t): t is string => typeof t === 'string')
        if (Array.isArray(body.supersedes)) entry.supersedes = body.supersedes.filter((t): t is string => typeof t === 'string')
        entry.updatedAt = Date.now()
        store.saveProject(path, project.entries)
        ok(res, { entry: wireEntry(entry), updated: true })
        return
      }
      if (req.method === 'DELETE' && pathname === MEMOIR_API_PREFIX + '/entries') {
        const body = await readJsonBody(req, 64 * 1024)
        if (body === null) { fail(res, 400, 'invalid JSON body'); return }
        const { path, id } = body
        if (typeof path !== 'string' || typeof id !== 'string' || id === '') { fail(res, 400, 'expected { path, id }'); return }
        const project = store.project(path)
        const before = project.entries.length
        project.entries = project.entries.filter((e) => e.id !== id)
        store.saveProject(path, project.entries)
        ok(res, { removed: project.entries.length < before })
        return
      }
      fail(res, 404, `unknown route: ${req.method} ${pathname}`)
    } catch (error) {
      logger.warn(error)
      fail(res, 500, error instanceof Error ? error.message : String(error))
    }
  }

  return [{ kind: 'prefix', path: MEMOIR_API_PREFIX, handler }]
}

/** 服务域注册入口（路由）。 */
export function registerRoutes(ctx: Context, deps: MemoirRoutesDeps): () => void {
  const routes = makeMemoirRoutes({ ...deps, isTrusted: accessTrustOf(ctx).isTrusted })
  return registerResources(own => {
    for (const route of routes) own(ctx.webServer.register(route))
  })
}

// 供 index.ts 使用（保持路径工具同源）。