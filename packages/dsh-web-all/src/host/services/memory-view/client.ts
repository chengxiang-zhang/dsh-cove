/**
 * OpenViking 只读 REST 客户端。
 *
 * 只有三个读接口：`GET /api/v1/fs/ls`、`GET /api/v1/content/read`、
 * `POST /api/v1/search/search`。这个模块不抛异常、不重试、不做业务判定
 * （URI 归属、作用域、排序都在路由层），只把「上游怎么回答」翻译成契约里的
 * 失败码，这样路由层可以逐条决定 HTTP 状态。
 *
 * API key 只出现在 `Authorization` 头里：失败消息是固定文案加状态码，不含
 * key、不含带凭据的地址。
 */
import { VIKING_SCHEME, type MemoryError } from '../../../core/memory-view/protocol.ts'

/** 上游失败。 */
export interface MemoryUpstreamFailure {
  ok: false
  error: MemoryError
}

/** 上游结果：要么值，要么契约失败体。 */
export type MemoryUpstreamResult<T> = { ok: true; value: T } | MemoryUpstreamFailure

/** `fs/ls` 的一个元素。 */
export interface MemoryUpstreamEntry {
  uri: string
  isDir: boolean
  size: number
  modTime: string
  abstract?: string
}

/** `search/search` 的一条记忆命中。 */
export interface MemoryUpstreamHit {
  uri: string
  score: number
  abstract: string
  tags?: string[]
}

/** 路由层依赖的最小客户端面（测试注入假件不必实现整个类）。 */
export interface MemoryViewClientLike {
  listDirectory(uri: string): Promise<MemoryUpstreamResult<MemoryUpstreamEntry[]>>
  readContent(uri: string): Promise<MemoryUpstreamResult<string>>
  search(query: string, limit: number): Promise<MemoryUpstreamResult<MemoryUpstreamHit[]>>
}

/** 构造参数。 */
export interface MemoryViewClientOptions {
  /** 服务地址，不带末尾斜杠。 */
  url: string
  /** Bearer token。 */
  apiKey: string
  /** 账号头；缺省不发。 */
  account?: string | null
  /** 用户头；缺省不发。 */
  user?: string | null
  /** 单次请求的超时；默认 5 秒。 */
  timeoutMs?: number
  /** fetch 缝隙（测试注入）。 */
  fetchImpl?: typeof fetch
}

/** 单次上游请求的默认超时。 */
export const MEMORY_UPSTREAM_TIMEOUT_MS = 5000

/** 目录列举端点。 */
export const UPSTREAM_LIST_PATH = '/api/v1/fs/ls'

/** 文档读取端点。 */
export const UPSTREAM_READ_PATH = '/api/v1/content/read'

/** 语义检索端点。 */
export const UPSTREAM_SEARCH_PATH = '/api/v1/search/search'

/** 造一个失败结果。 */
function failure(code: MemoryError['code'], message: string): MemoryUpstreamFailure {
  return { ok: false, error: { code, message } }
}

/** 是否是普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有限非负数，其余按 0。 */
function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 只保留 `viking://` 开头的 URI：其余形状进了浏览器只会变成死链。 */
function isViking(value: string): boolean {
  return value.startsWith(VIKING_SCHEME)
}

export class MemoryViewClient implements MemoryViewClientLike {
  private readonly url: string
  private readonly apiKey: string
  private readonly account: string | null
  private readonly user: string | null
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: MemoryViewClientOptions) {
    this.url = options.url.replace(/\/+$/u, '')
    this.apiKey = options.apiKey
    this.account = options.account ?? null
    this.user = options.user ?? null
    this.timeoutMs = options.timeoutMs ?? MEMORY_UPSTREAM_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * 一次上游请求。
   * @param path - 已编码的路径与查询串。
   * @param method - GET 或 POST。
   * @param body - POST 的 JSON 体。
   * @returns `result` 字段的值，或契约失败体。
   */
  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<MemoryUpstreamResult<unknown>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    }
    if (this.account !== null && this.account !== '') headers['x-openviking-account'] = this.account
    if (this.user !== null && this.user !== '') headers['x-openviking-user'] = this.user
    if (method === 'POST') headers['content-type'] = 'application/json'
    try {
      let response: Response
      try {
        response = await this.fetchImpl(`${this.url}${path}`, {
          method,
          headers,
          body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
          signal: controller.signal,
        })
      } catch {
        return failure('unreachable', 'OpenViking 服务不可达或请求超时')
      }
      if (response.status === 401 || response.status === 403) return failure('unauthorized', 'OpenViking 拒绝了宿主凭据')
      if (response.status === 404) return failure('not-found', 'OpenViking 上没有这个条目')
      if (!response.ok) return failure('internal', `OpenViking 返回状态 ${response.status}`)
      let text: string
      try {
        text = await response.text()
      } catch {
        return failure('unreachable', 'OpenViking 响应读取失败')
      }
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        return failure('malformed', 'OpenViking 响应不是合法 JSON')
      }
      if (!isRecord(payload) || payload['status'] !== 'ok') return failure('malformed', 'OpenViking 响应状态不是 ok')
      return { ok: true, value: payload['result'] }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 列目录。
   * @param uri - 目录 URI。
   * @returns 该目录的直接子项（形状未排序、未过滤归属）。
   */
  async listDirectory(uri: string): Promise<MemoryUpstreamResult<MemoryUpstreamEntry[]>> {
    const result = await this.request(`${UPSTREAM_LIST_PATH}?uri=${encodeURIComponent(uri)}`, 'GET')
    if (!result.ok) return result
    if (!Array.isArray(result.value)) return failure('malformed', 'OpenViking 目录结果不是数组')
    const entries: MemoryUpstreamEntry[] = []
    for (const item of result.value) {
      if (!isRecord(item) || typeof item['uri'] !== 'string') return failure('malformed', 'OpenViking 目录项缺少 uri')
      const entryUri = item['uri']
      if (!isViking(entryUri)) continue
      const entry: MemoryUpstreamEntry = {
        uri: entryUri,
        isDir: item['isDir'] === true,
        size: safeNumber(item['size']),
        modTime: typeof item['modTime'] === 'string' ? item['modTime'] : '',
      }
      const abstract = item['abstract']
      if (typeof abstract === 'string' && abstract !== '') entry.abstract = abstract
      entries.push(entry)
    }
    return { ok: true, value: entries }
  }

  /**
   * 读文档原文。
   * @param uri - 文档 URI。
   * @returns 原文文本。
   */
  async readContent(uri: string): Promise<MemoryUpstreamResult<string>> {
    const result = await this.request(`${UPSTREAM_READ_PATH}?uri=${encodeURIComponent(uri)}`, 'GET')
    if (!result.ok) return result
    if (typeof result.value !== 'string') return failure('malformed', 'OpenViking 文档结果不是文本')
    return { ok: true, value: result.value }
  }

  /**
   * 语义检索。
   * @param query - 查询串。
   * @param limit - 向上游要的条数（路由层可能多要一些再做归属过滤）。
   * @returns 记忆命中（不含 resources / skills）。
   */
  async search(query: string, limit: number): Promise<MemoryUpstreamResult<MemoryUpstreamHit[]>> {
    const result = await this.request(UPSTREAM_SEARCH_PATH, 'POST', { query, limit })
    if (!result.ok) return result
    const value = result.value
    if (!isRecord(value)) return failure('malformed', 'OpenViking 检索结果不是对象')
    const memories = value['memories']
    if (!Array.isArray(memories)) return failure('malformed', 'OpenViking 检索结果缺少 memories')
    const hits: MemoryUpstreamHit[] = []
    for (const item of memories) {
      if (!isRecord(item) || typeof item['uri'] !== 'string') return failure('malformed', 'OpenViking 检索命中缺少 uri')
      const hitUri = item['uri']
      if (!isViking(hitUri)) continue
      const hit: MemoryUpstreamHit = {
        uri: hitUri,
        score: typeof item['score'] === 'number' && Number.isFinite(item['score']) ? item['score'] : 0,
        abstract: typeof item['abstract'] === 'string' ? item['abstract'] : '',
      }
      const tags = item['tags']
      if (Array.isArray(tags)) hit.tags = tags.filter((tag): tag is string => typeof tag === 'string')
      hits.push(hit)
    }
    return { ok: true, value: hits }
  }
}