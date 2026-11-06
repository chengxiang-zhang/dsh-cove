/**
 * memory-view 宿主路由族：`/api/dsh-memory/*`（只读，统一 `{ok,value}` 信封）。
 *
 *   GET  /status   连接状态 + 由请求目录推导出的工作区 peer
 *   GET  /list     列目录（`scope`，`path?`，`cwd?`）
 *   GET  /read     读文档原文（`uri`，`cwd?`）
 *   GET  /search   语义检索（body `{query, scope?, limit?}`，`cwd?`）—— POST
 *
 * 四类请求都先过共享宿主访问围栏 `accessTrustOf(ctx).isTrusted(request)`：
 * 只读接口同样是特权面，不因为是 GET 而放宽。归属判定全部在宿主做——客户端
 * 给的 `cwd` 只当目录输入，peer 由宿主重新推导，再用推导结果校验 URI；
 * 契约里的纯函数（`isMemoryScope` / `joinMemoryPath` / `isUriUnder` /
 * `memoryRoots` / `isSafeVikingUri`）是唯一的校验实现。
 *
 * OpenViking 的地址与 key 只在宿主：失败体是契约里的固定码加固定文案，不含
 * key、不含带凭据的地址。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  MEMORY_VIEW_API_PREFIX,
  compareMemoryNodes,
  isMemoryScope,
  isSafeVikingUri,
  isUriUnder,
  joinMemoryPath,
  memoryRoot,
  memoryRoots,
  peerMemoriesUri,
  uriName,
  type MemoryConnectionState,
  type MemoryDocument,
  type MemoryEnvelope,
  type MemoryError,
  type MemoryErrorCode,
  type MemoryHit,
  type MemoryListing,
  type MemoryNode,
  type MemoryScope,
  type MemorySearchResult,
  type MemoryStatus,
  type MemoryWorkspaceState,
} from '../../../core/memory-view/protocol.ts'
import { accessTrustOf } from '../access-trust/index.ts'
import { registerResources } from '../resources.ts'
import type { MemoryUpstreamHit } from './client.ts'
import {
  isMemoryViewConfigured,
  resolveMemoryViewConfig,
  type MemoryViewConfig,
} from './config.ts'
import type { PeerResolution } from './peer.ts'
import { parseCwd } from './peer.ts'
import type { MemoryViewClientLike } from './client.ts'

/** 路由依赖：客户端与 peer 推导都可注入（测试不连真实服务、不跑 git）。 */
export interface MemoryViewRouteOptions {
  /** 为一份连接设置造客户端。 */
  createClient(config: MemoryViewConfig): MemoryViewClientLike
  /** 由已校验的目录推导 peer。 */
  resolvePeer(cwd: string): Promise<PeerResolution>
  /** 解析连接设置；默认每次请求读环境变量与 `ovcli.conf`。 */
  resolveConfig?(): MemoryViewConfig
  /** 诊断日志；不记录 key 与地址。 */
  logger?(message: string): void
}

/** 路由依赖 + 围栏判定。 */
export interface MemoryViewRoutesDeps extends MemoryViewRouteOptions {
  /** 共享宿主访问围栏。 */
  isTrusted(request: IncomingMessage): boolean
}

/** 检索默认条数。 */
export const MEMORY_SEARCH_DEFAULT_LIMIT = 10

/** 检索条数上限。 */
export const MEMORY_SEARCH_MAX_LIMIT = 50

/** 请求体上限（检索请求只有三个短字段）。 */
export const MEMORY_SEARCH_BODY_MAX_BYTES = 64 * 1024

/** 查询串长度上限。 */
export const MEMORY_SEARCH_MAX_QUERY_LENGTH = 512

/**
 * 向上游多要几倍的条数：作用域过滤发生在宿主侧，只要 limit 条会在过滤后
 * 剩得更少；上限仍有 `MEMORY_SEARCH_MAX_LIMIT` 兜着。
 */
const UPSTREAM_SEARCH_OVERFETCH = 3

const STATUS_PATH = `${MEMORY_VIEW_API_PREFIX}/status`
const LIST_PATH = `${MEMORY_VIEW_API_PREFIX}/list`
const READ_PATH = `${MEMORY_VIEW_API_PREFIX}/read`
const SEARCH_PATH = `${MEMORY_VIEW_API_PREFIX}/search`

/** 写一个 JSON 响应：头与 git-graph 家族一致（不允许侦察来源、不允许缓存）。 */
function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

/** 成功信封。 */
function ok<T>(response: ServerResponse, value: T): void {
  const body: MemoryEnvelope<T> = { ok: true, value }
  writeJson(response, 200, body)
}

/** 失败信封。 */
function fail(
  response: ServerResponse,
  status: number,
  code: MemoryErrorCode,
  message: string,
  headers: Record<string, string> = {},
): void {
  const error: MemoryError = { code, message }
  const body: MemoryEnvelope<never> = { ok: false, error }
  writeJson(response, status, body, headers)
}

/** 方法不对：405 + `Allow`，信封里用 `malformed`（契约没有 method 码）。 */
function methodNotAllowed(response: ServerResponse, allow: string): void {
  fail(response, 405, 'malformed', 'method not allowed', { allow })
}

/**
 * 上游失败映射成 HTTP 状态：上游不可达或拒绝凭据都是网关侧故障（502），
 * 条目不存在是 404，其余上游问题也是 502；具体原因由失败码表达。
 */
function failUpstream(response: ServerResponse, error: MemoryError): void {
  const status = error.code === 'not-found' ? 404 : 502
  fail(response, status, error.code, error.message)
}

/** 有界读取 JSON 请求体；超限、空体、非法 JSON 都返回 `null`。 */
async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) return null
    chunks.push(bytes)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** 目录项映射成契约节点。 */
function toNode(entry: { uri: string; isDir: boolean; size: number; modTime: string; abstract?: string }): MemoryNode {
  const node: MemoryNode = {
    uri: entry.uri,
    name: uriName(entry.uri),
    isDir: entry.isDir,
    size: entry.size,
    modTime: entry.modTime,
  }
  if (entry.abstract !== undefined && entry.abstract !== '') node.abstract = entry.abstract
  return node
}

/** 命中映射成契约命中。 */
function toHit(hit: MemoryUpstreamHit): MemoryHit {
  const mapped: MemoryHit = { uri: hit.uri, name: uriName(hit.uri), score: hit.score, abstract: hit.abstract }
  if (hit.tags !== undefined && hit.tags.length > 0) mapped.tags = [...hit.tags]
  return mapped
}

/** 本次请求允许访问的记忆根：全局根，加上（能推导出 peer 时的）工作区根。 */
function allowedRoots(user: string, peer: string | null): string[] {
  return memoryRoots('workspace', user, peer)
}

/**
 * 组装路由（可直接单测，无需 webServer 服务）。
 * @param deps - 围栏判定、客户端工厂、peer 推导。
 * @returns 一条挂在 `MEMORY_VIEW_API_PREFIX` 下的前缀路由。
 */
export function makeMemoryViewRoutes(deps: MemoryViewRoutesDeps): WebRoute[] {
  const resolveConfig = deps.resolveConfig ?? (() => resolveMemoryViewConfig())
  const logger = deps.logger ?? (() => {})

  /** 由目录推导 peer；推导失败按「没有 peer」处理。 */
  const peerOf = async (cwd: string | null): Promise<PeerResolution> => {
    if (cwd === null) return { cwd: null, peer: null, source: 'unknown' }
    return deps.resolvePeer(cwd)
  }

  /** GET /status：连接状态与工作区身份。 */
  const handleStatus = async (response: ServerResponse, url: URL): Promise<void> => {
    const verdict = parseCwd(url.searchParams.get('cwd'))
    if (!verdict.ok) return fail(response, 400, 'malformed', 'cwd 必须是已存在的绝对目录')
    const config = resolveConfig()
    const resolution = await peerOf(verdict.cwd)
    const workspace: MemoryWorkspaceState = resolution.peer === null
      ? { cwd: resolution.cwd, peer: null, source: resolution.source }
      : { cwd: resolution.cwd, peer: resolution.peer, source: resolution.source, memoryUri: peerMemoriesUri(config.user, resolution.peer) }
    if (!isMemoryViewConfigured(config)) {
      // 未配置不是错误：面板要能显示一句「去配置 ovcli.conf」，而不是一个红条。
      const connection: MemoryConnectionState = {
        connected: false,
        server: config.url,
        user: config.user,
        error: 'not-configured',
      }
      if (config.account !== null) connection.account = config.account
      const status: MemoryStatus = { connection, workspace }
      return ok(response, status)
    }
    const client = deps.createClient(config)
    const probe = await client.listDirectory(memoryRoot('global', config.user, null))
    const connection: MemoryConnectionState = {
      connected: probe.ok,
      server: config.url,
      user: config.user,
      ...(probe.ok ? {} : { error: probe.error.code }),
    }
    if (config.account !== null) connection.account = config.account
    const status: MemoryStatus = { connection, workspace }
    ok(response, status)
  }

  /** GET /list：某一作用域下某个目录的直接子项。 */
  const handleList = async (response: ServerResponse, url: URL): Promise<void> => {
    const scopeValue = url.searchParams.get('scope')
    if (!isMemoryScope(scopeValue)) return fail(response, 400, 'malformed', 'scope 必须是 global 或 workspace')
    const verdict = parseCwd(url.searchParams.get('cwd'))
    if (!verdict.ok) return fail(response, 400, 'malformed', 'cwd 必须是已存在的绝对目录')
    const config = resolveConfig()
    if (!isMemoryViewConfigured(config)) return fail(response, 503, 'not-configured', '宿主没有配置 OpenViking')
    const peer = (await peerOf(verdict.cwd)).peer
    const root = memoryRoot(scopeValue, config.user, peer)
    const uri = joinMemoryPath(root, url.searchParams.get('path') ?? '')
    if (uri === null) return fail(response, 400, 'malformed', 'path 必须是根下的相对路径')
    if (!allowedRoots(config.user, peer).some(candidate => isUriUnder(uri, candidate))) {
      return fail(response, 403, 'forbidden', 'path 越出了允许的记忆根')
    }
    const client = deps.createClient(config)
    const listing = await client.listDirectory(uri)
    if (!listing.ok) return failUpstream(response, listing.error)
    // 只回显确实位列本次目录之下的条目：上游若混进别的路径，不进浏览器。
    const nodes = listing.value
      .filter(entry => isSafeVikingUri(entry.uri) && isUriUnder(entry.uri, uri))
      .map(toNode)
      .sort(compareMemoryNodes)
    const value: MemoryListing = { scope: scopeValue, root, uri, nodes }
    ok(response, value)
  }

  /** GET /read：一份记忆文档的原文。 */
  const handleRead = async (response: ServerResponse, url: URL): Promise<void> => {
    const uri = url.searchParams.get('uri')
    if (uri === null || !isSafeVikingUri(uri)) return fail(response, 400, 'malformed', 'uri 必须是 viking:// 记忆 URI')
    const verdict = parseCwd(url.searchParams.get('cwd'))
    if (!verdict.ok) return fail(response, 400, 'malformed', 'cwd 必须是已存在的绝对目录')
    const config = resolveConfig()
    if (!isMemoryViewConfigured(config)) return fail(response, 503, 'not-configured', '宿主没有配置 OpenViking')
    const peer = (await peerOf(verdict.cwd)).peer
    if (!allowedRoots(config.user, peer).some(root => isUriUnder(uri, root))) {
      return fail(response, 403, 'forbidden', 'uri 越出了允许的记忆根')
    }
    const client = deps.createClient(config)
    const document = await client.readContent(uri)
    if (!document.ok) return failUpstream(response, document.error)
    const value: MemoryDocument = { uri, name: uriName(uri), text: document.value }
    ok(response, value)
  }

  /** POST /search：语义检索，按作用域过滤归属。 */
  const handleSearch = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const body = await readJsonBody(request, MEMORY_SEARCH_BODY_MAX_BYTES)
    if (body === null) return fail(response, 400, 'malformed', 'search 需要 JSON 请求体')
    const rawQuery = body['query']
    if (typeof rawQuery !== 'string') return fail(response, 400, 'malformed', 'query 必须是字符串')
    const query = rawQuery.trim()
    if (query === '' || query.length > MEMORY_SEARCH_MAX_QUERY_LENGTH) {
      return fail(response, 400, 'malformed', `query 长度必须在 1..${MEMORY_SEARCH_MAX_QUERY_LENGTH}`)
    }
    let scope: MemoryScope | 'all' = 'all'
    const scopeInput = body['scope']
    if (scopeInput !== undefined && scopeInput !== null) {
      if (scopeInput !== 'all' && !isMemoryScope(scopeInput)) {
        return fail(response, 400, 'malformed', 'scope 必须是 global、workspace 或 all')
      }
      scope = isMemoryScope(scopeInput) ? scopeInput : 'all'
    }
    const limitInput = body['limit']
    const limit = limitInput === undefined || limitInput === null ? MEMORY_SEARCH_DEFAULT_LIMIT : limitInput
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MEMORY_SEARCH_MAX_LIMIT) {
      return fail(response, 400, 'malformed', `limit 必须是 1..${MEMORY_SEARCH_MAX_LIMIT} 的整数`)
    }
    // `cwd` 是信封外的查询参数；同时容忍放在请求体里，避免两半区各读一处。
    const bodyCwd = body['cwd']
    const cwdParam = url.searchParams.get('cwd') ?? (typeof bodyCwd === 'string' ? bodyCwd : null)
    const verdict = parseCwd(cwdParam)
    if (!verdict.ok) return fail(response, 400, 'malformed', 'cwd 必须是已存在的绝对目录')
    const config = resolveConfig()
    if (!isMemoryViewConfigured(config)) return fail(response, 503, 'not-configured', '宿主没有配置 OpenViking')
    const peer = (await peerOf(verdict.cwd)).peer
    const roots = scope === 'global' ? memoryRoots('global', config.user, peer) : memoryRoots('workspace', config.user, peer)
    const client = deps.createClient(config)
    const upstreamLimit = Math.min(limit * UPSTREAM_SEARCH_OVERFETCH, MEMORY_SEARCH_MAX_LIMIT)
    const found = await client.search(query, upstreamLimit)
    if (!found.ok) return failUpstream(response, found.error)
    const hits = found.value
      .filter(hit => roots.some(root => isUriUnder(hit.uri, root)))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(toHit)
    const value: MemorySearchResult = { query: rawQuery, scope, hits }
    ok(response, value)
  }

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!deps.isTrusted(request)) return fail(response, 403, 'forbidden', '宿主访问围栏拒绝了这次请求')
    const url = new URL(request.url ?? '/', 'http://dsh.local')
    const pathname = url.pathname.replace(/\/+$/u, '')
    try {
      switch (pathname) {
        case STATUS_PATH:
          if (request.method !== 'GET') return methodNotAllowed(response, 'GET')
          return await handleStatus(response, url)
        case LIST_PATH:
          if (request.method !== 'GET') return methodNotAllowed(response, 'GET')
          return await handleList(response, url)
        case READ_PATH:
          if (request.method !== 'GET') return methodNotAllowed(response, 'GET')
          return await handleRead(response, url)
        case SEARCH_PATH:
          if (request.method !== 'POST') return methodNotAllowed(response, 'POST')
          return await handleSearch(request, response, url)
        default:
          return fail(response, 404, 'not-found', '未知的记忆端点')
      }
    } catch (error) {
      logger(`memory-view: request failed for ${pathname}: ${error instanceof Error ? error.message : String(error)}`)
      if (!response.writableEnded) fail(response, 500, 'internal', '记忆请求处理失败')
    }
  }

  return [{ kind: 'prefix', path: MEMORY_VIEW_API_PREFIX, handler }]
}

/**
 * 服务域注册入口：围栏取共享 `accessTrustOf(ctx)`，路由登记纳入本域的
 * 资源事务（解析失败会回滚已登记的路由）。
 * @param ctx - 宿主插件上下文。
 * @param options - 客户端工厂、peer 推导与配置解析。
 * @returns 释放已登记路由的 disposer。
 */
export function registerMemoryViewRoutes(ctx: Context, options: MemoryViewRouteOptions): () => void {
  return registerResources((own) => {
    for (const route of makeMemoryViewRoutes({ ...options, isTrusted: accessTrustOf(ctx).isTrusted })) {
      own(ctx.webServer.register(route))
    }
  })
}

export { MEMORY_VIEW_API_PREFIX }