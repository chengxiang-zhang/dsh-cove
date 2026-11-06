/**
 * 记忆只读接口的浏览器端客户端。
 *
 * 四个端点、一套线上信封（`MemoryEnvelope`）。面板只做展示，所以这里的每个
 * 方法都**返回信封而不是抛异常**：服务未配置、服务不可达、响应被代理改写都
 * 变成带 `MemoryErrorCode` 的失败信封，渲染层按码选文案，永远不会因为一次
 * 取数失败炸掉 React 树。只有编程错误（类型层已经排除）才会静默退化成
 * `malformed`。
 *
 * 契约（`src/core/memory-view/protocol.ts`）：
 * - GET  `<prefix>/status?cwd=<abs>`
 * - GET  `<prefix>/list?scope=global|workspace&path=<rel>&cwd=<abs>`
 * - GET  `<prefix>/read?uri=<viking uri>&cwd=<abs>`
 * - POST `<prefix>/search?cwd=<abs>`，body `{ query, scope?, limit? }`
 */
import {
  isMemoryScope,
  isSafeVikingUri,
  MEMORY_VIEW_API_PREFIX,
  type MemoryDocument,
  type MemoryEnvelope,
  type MemoryError,
  type MemoryErrorCode,
  type MemoryListing,
  type MemoryScope,
  type MemorySearchResult,
  type MemoryStatus,
} from '../../../../core/memory-view/protocol.ts'

/** 契约里的全部失败码；用于运行时校验服务端回包。 */
const ERROR_CODES: readonly MemoryErrorCode[] = [
  'not-configured',
  'unreachable',
  'unauthorized',
  'malformed',
  'forbidden',
  'not-found',
  'internal',
]

/** 是否是契约内的失败码。 */
export function isMemoryErrorCode(value: unknown): value is MemoryErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}

/** 目录列举的参数。 */
export interface MemoryListQuery {
  scope: MemoryScope
  /** 作用域根下的相对路径；空串/省略表示根。 */
  path?: string
  /** 当前工作目录（绝对路径）；解析不出时不传。 */
  cwd?: string
}

/** 检索的参数。 */
export interface MemorySearchQuery {
  query: string
  /** 检索范围；`all` 表示全局空间加当前工作区。 */
  scope?: MemoryScope | 'all'
  /** 命中上限；省略时由宿主取默认值。 */
  limit?: number
  cwd?: string
}

/**
 * 面板依赖的取数面。`MemoryViewApi` 是它的线上实现；测试与预览可以传替身，
 * 因此面板不需要知道 fetch 的存在。
 */
export interface MemoryApi {
  status(cwd?: string): Promise<MemoryEnvelope<MemoryStatus>>
  list(query: MemoryListQuery): Promise<MemoryEnvelope<MemoryListing>>
  read(uri: string, cwd?: string): Promise<MemoryEnvelope<MemoryDocument>>
  search(query: MemorySearchQuery): Promise<MemoryEnvelope<MemorySearchResult>>
}

/** fetch 的窄接口（只用到这一个签名）。 */
export type MemoryFetch = (input: string, init?: RequestInit) => Promise<Response>

/** 构造参数。 */
export interface MemoryViewApiOptions {
  /** 自定义 fetch（测试替身用）；缺省 `globalThis.fetch`。 */
  fetch?: MemoryFetch
  /** 前缀前的源（同源部署留空）。 */
  origin?: string
}

/** 造一个失败信封。 */
function failure<T>(code: MemoryErrorCode, message: string): MemoryEnvelope<T> {
  return { ok: false, error: { code, message } }
}

/** 从任意抛出值里取一句可读描述（只用于诊断，不作为界面文案）。 */
function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  try {
    return String(cause)
  } catch {
    return 'unknown error'
  }
}

/**
 * HTTP 状态码到失败码的映射（回包没有信封时的退路）。
 *
 * 404 映射成 `unreachable` 而不是 `not-found`：契约要求宿主永远用信封回答，
 * 裸 404 只可能是「这条路由没挂上」（宿主半区未部署或前缀被代理改写），把它说成
 * 「这条记忆已不存在」会误导人。真正的「记忆不存在」由宿主的信封给出。
 */
function codeForStatus(status: number): MemoryErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'unreachable'
  if (status === 400 || status === 409 || status === 422) return 'malformed'
  if (status === 502 || status === 503 || status === 504) return 'unreachable'
  if (status >= 500) return 'internal'
  return 'malformed'
}

/** 把响应体解析成信封；形状不对时按状态码给出失败信封。 */
export function parseMemoryEnvelope<T>(body: unknown, status = 200): MemoryEnvelope<T> {
  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined
  if (record !== undefined && record['ok'] === true && 'value' in record) {
    return { ok: true, value: record['value'] as T }
  }
  const error = record === undefined ? undefined : parseMemoryError(record['error'])
  if (record !== undefined && record['ok'] === false && error !== undefined) return { ok: false, error }
  return failure<T>(codeForStatus(status), `HTTP ${status}`)
}

/** 校验失败体形状；形状不对时返回 `undefined`（交给调用方按状态码退化）。 */
function parseMemoryError(value: unknown): MemoryError | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { code?: unknown; message?: unknown }
  if (!isMemoryErrorCode(record.code)) return undefined
  const message = typeof record.message === 'string' && record.message !== '' ? record.message : record.code
  return { code: record.code, message }
}

/** 拼查询串；空值与空串一律省略（`path=''` 表示根，不是错误）。 */
function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(name, String(value))
  }
  const text = search.toString()
  return text === '' ? path : `${path}?${text}`
}

/** 同源只读客户端。 */
export class MemoryViewApi implements MemoryApi {
  private readonly request: MemoryFetch
  private readonly origin: string

  constructor(options: MemoryViewApiOptions = {}) {
    this.request = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.origin = options.origin ?? ''
  }

  /** 连接状态与当前工作区的记忆身份。 */
  status(cwd?: string): Promise<MemoryEnvelope<MemoryStatus>> {
    return this.get<MemoryStatus>('status', { cwd })
  }

  /** 列举一个作用域下的目录。 */
  list(query: MemoryListQuery): Promise<MemoryEnvelope<MemoryListing>> {
    if (!isMemoryScope(query.scope)) return Promise.resolve(failure('malformed', `invalid scope: ${String(query.scope)}`))
    return this.get<MemoryListing>('list', { scope: query.scope, path: query.path, cwd: query.cwd })
  }

  /** 读一份记忆文档。 */
  read(uri: string, cwd?: string): Promise<MemoryEnvelope<MemoryDocument>> {
    if (!isSafeVikingUri(uri)) return Promise.resolve(failure('malformed', 'invalid memory uri'))
    return this.get<MemoryDocument>('read', { uri, cwd })
  }

  /** 检索记忆。 */
  search(query: MemorySearchQuery): Promise<MemoryEnvelope<MemorySearchResult>> {
    const text = query.query.trim()
    if (text === '') return Promise.resolve(failure('malformed', 'empty query'))
    const body: Record<string, unknown> = { query: text }
    if (query.scope !== undefined) body['scope'] = query.scope
    if (query.limit !== undefined) body['limit'] = query.limit
    return this.post<MemorySearchResult>('search', body, { cwd: query.cwd })
  }

  /** GET 一个只读端点。 */
  private get<T>(route: string, params: Record<string, string | number | undefined>): Promise<MemoryEnvelope<T>> {
    const url = `${this.origin}${MEMORY_VIEW_API_PREFIX}/${route}${withQuery('', params)}`
    return this.call<T>(url, { method: 'GET' })
  }

  /** POST 检索端点（`cwd` 走查询串，body 只有检索参数）。 */
  private post<T>(route: string, body: Record<string, unknown>, params: Record<string, string | number | undefined>): Promise<MemoryEnvelope<T>> {
    const url = `${this.origin}${MEMORY_VIEW_API_PREFIX}/${route}${withQuery('', params)}`
    return this.call<T>(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** 发一次请求并把任何传输/解析失败折成失败信封。 */
  private async call<T>(url: string, init: RequestInit): Promise<MemoryEnvelope<T>> {
    let response: Response
    try {
      response = await this.request(url, { cache: 'no-store', credentials: 'same-origin', ...init })
    } catch (cause) {
      return failure<T>('unreachable', describe(cause))
    }
    let text: string
    try {
      text = await response.text()
    } catch (cause) {
      return failure<T>('unreachable', describe(cause))
    }
    let body: unknown
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        // 代理改写的 HTML 错误页、被截断的响应都会到这里。
        return failure<T>(response.ok ? 'malformed' : codeForStatus(response.status), `HTTP ${response.status}: invalid JSON`)
      }
    }
    return parseMemoryEnvelope<T>(body, response.status)
  }
}