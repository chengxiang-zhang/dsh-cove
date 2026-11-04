/**
 * 外援会话宿主路由的浏览器端客户端 —— 数据面的唯一入口。
 *
 * 面板与会话头部的下拉分组都从这里取数，谁都不自己写 fetch。路由前缀只在这里
 * 出现一次；宿主契约定稿（`src/host/services/external-session/routes.ts`）后，
 * 这里改成引用 `src/core/external-session/` 的路由常量，不动调用方。
 *
 * 三种失败必须分开，因为它们的用户处置完全不同：
 * - `forbidden`（401/403）：访问围栏拒绝，页面没有权限；
 * - `unavailable`（404/405/501，或 2xx 却不是 JSON）：宿主没提供这族路由；
 * - `failed`：其它错误，带 HTTP 状态与宿主给的 message。
 */
import { readSessionList, type ExternalSessionView } from './types.ts'

/** 路由族前缀（契约提议：`/api/external-session`）。 */
export const EXTERNAL_SESSION_API = '/api/external-session'

/** 本能力的四个路由。 */
export const EXTERNAL_SESSION_ROUTES = {
  list: `${EXTERNAL_SESSION_API}/list`,
  continueTurn: `${EXTERNAL_SESSION_API}/continue`,
  cancelTurn: `${EXTERNAL_SESSION_API}/cancel`,
  closeSession: `${EXTERNAL_SESSION_API}/close`,
} as const

/** 失败种类：决定面板显示哪一句话。 */
export type ExternalApiFailure = 'forbidden' | 'unavailable' | 'failed'

/** 宿主在错误信封里给的错误码（设计稿 §7，`code` 永远是权威）。 */
export const EXTERNAL_SESSION_ERROR_CODES = [
  'provider-missing',
  'provider-error',
  'cwd-invalid',
  'session-unknown',
  'session-closed',
  'session-unresumable',
  'busy',
  'limit',
  'auth-required',
] as const

/** 错误码。 */
export type ExternalSessionErrorCode = typeof EXTERNAL_SESSION_ERROR_CODES[number]

/** 是否是本能力认识的错误码。 */
export function isExternalSessionErrorCode(value: unknown): value is ExternalSessionErrorCode {
  return typeof value === 'string' && (EXTERNAL_SESSION_ERROR_CODES as readonly string[]).includes(value)
}

/** 带失败种类与宿主错误码的路由错误。 */
export class ExternalSessionApiError extends Error {
  readonly failure: ExternalApiFailure
  readonly status: number | undefined
  /** 宿主给的错误码；决定面板说哪一句具体原因。 */
  readonly code: ExternalSessionErrorCode | undefined

  constructor(message: string, failure: ExternalApiFailure, status?: number, code?: ExternalSessionErrorCode) {
    super(message)
    this.name = 'ExternalSessionApiError'
    this.failure = failure
    this.status = status
    this.code = code
  }
}

/** 注入点：测试传假 fetch，运行时用全局 fetch。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** 面板与下拉分组依赖的数据面。 */
export interface ExternalSessionApi {
  list(signal?: AbortSignal): Promise<readonly ExternalSessionView[]>
  continueTurn(sessionId: string, prompt: string, signal?: AbortSignal): Promise<readonly ExternalSessionView[]>
  cancelTurn(sessionId: string, signal?: AbortSignal): Promise<readonly ExternalSessionView[]>
  closeSession(sessionId: string, signal?: AbortSignal): Promise<readonly ExternalSessionView[]>
}

interface Envelope {
  readonly ok?: unknown
  readonly value?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown } | null
}

/**
 * 失败分类：**先看宿主给的 `code`，再看 HTTP 状态**。
 *
 * 这一步不能只按状态码判：契约里 404 既可能是「这族路由不存在」，也可能是
 * `session-unknown`（会话被删了）；501 可能是 `provider-missing`（CLI 没装），
 * 也可能是路由未实现。把这两种混成「宿主没有这个能力」会让用户去重启服务，
 * 而真正该做的是换会话或装 CLI。
 *
 * @param status - HTTP 状态码。
 * @param code - 错误信封里的 `code`。
 * @returns `forbidden`（围栏拒绝）/ `unavailable`（宿主没这族路由）/ `failed`（会话级失败）。
 */
export function classifyFailure(status: number, code?: string): ExternalApiFailure {
  if (status === 401 || status === 403) return 'forbidden'
  if (isExternalSessionErrorCode(code)) return 'failed'
  if (status === 404 || status === 405 || status === 501) return 'unavailable'
  return 'failed'
}

/** 从错误信封里取 `{code, message}`；缺哪个给 undefined。 */
function envelopeError(body: unknown): { code?: ExternalSessionErrorCode; message?: string } {
  if (typeof body !== 'object' || body === null) return {}
  const error = (body as Envelope).error
  if (typeof error !== 'object' || error === null) return {}
  const message = typeof error.message === 'string' ? error.message.trim() : ''
  const raw = typeof error.code === 'string' ? error.code.trim() : ''
  const code = isExternalSessionErrorCode(raw) ? raw : undefined
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === '' ? {} : { message }),
  }
}

/** 解包信封：有 `value` 取 value，没有就把整个 body 当载荷。 */
function unwrap(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body
  return 'value' in body ? (body as Envelope).value : body
}

async function request(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
    })
  } catch (cause) {
    // Abort 必须原样抛回，调用方靠它区分「用户离开」与「真失败」。
    if ((cause as { name?: unknown } | null)?.name === 'AbortError') throw cause
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new ExternalSessionApiError(`request failed: ${message}`, 'failed')
  }
  const body = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = envelopeError(body)
    const failure = classifyFailure(response.status, error.code)
    // 认得错误码就把它原样留给面板；人话由面板按码选，不在这里拼。
    const message = error.message ?? error.code ?? `HTTP ${response.status}`
    throw new ExternalSessionApiError(message, failure, response.status, error.code)
  }
  // 200 但解析不出 JSON：多半是宿主没这族路由时把首页返回来了。
  if (body === undefined) {
    throw new ExternalSessionApiError('response is not JSON', 'unavailable', response.status)
  }
  if (typeof body === 'object' && body !== null && (body as Envelope).ok === false) {
    const error = envelopeError(body)
    throw new ExternalSessionApiError(error.message ?? error.code ?? 'request rejected', 'failed', response.status, error.code)
  }
  return unwrap(body)
}

async function post(
  fetchImpl: FetchLike,
  url: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<readonly ExternalSessionView[]> {
  const body = await request(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    ...(signal === undefined ? {} : { signal }),
  })
  return readSessionList(body)
}

/** 造一个数据面客户端；`fetchImpl` 只为测试而存在。 */
export function createExternalSessionApi(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): ExternalSessionApi {
  return {
    async list(signal) {
      const body = await request(fetchImpl, EXTERNAL_SESSION_ROUTES.list, signal === undefined ? {} : { signal })
      return readSessionList(body)
    },
    continueTurn: (sessionId, prompt, signal) =>
      post(fetchImpl, EXTERNAL_SESSION_ROUTES.continueTurn, { sessionId, prompt }, signal),
    cancelTurn: (sessionId, signal) =>
      post(fetchImpl, EXTERNAL_SESSION_ROUTES.cancelTurn, { sessionId }, signal),
    closeSession: (sessionId, signal) =>
      post(fetchImpl, EXTERNAL_SESSION_ROUTES.closeSession, { sessionId }, signal),
  }
}

/** 失败种类 → i18n 键；面板据此选一句人话。 */
export function failureCopyKey(failure: ExternalApiFailure): 'state.forbidden' | 'state.unavailable' | 'state.failed' {
  if (failure === 'forbidden') return 'state.forbidden'
  if (failure === 'unavailable') return 'state.unavailable'
  return 'state.failed'
}