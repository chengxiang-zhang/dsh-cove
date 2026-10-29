/**
 * Anthropic 兼容 Messages 检索：`ctx.web` 的结构面与错误形状 —— host 半区。
 *
 * ## 为什么存在（唯一原因）
 *
 * 官方 `@deepseek-ai/dsh-web-search-deepseek` 的请求侧是通用的（Anthropic 兼容
 * Messages + 原生 `web_search_20250305`），端点/模型/凭据引用本来都可配置；
 * 但它的**响应侧写死了一个前提**：
 *
 *   const resultBlocks = blocks.filter((b) => b.type === "web_search_tool_result")
 *   if (resultBlocks.length === 0) throw new WebError("...no web_search_tool_result blocks...")
 *
 * 所以只要上游不返回结果块，无论怎么改配置都必然失败。Bedrock 系路由正是这种
 * 形状：只有 `server_tool_use` 与带 `citations[]` 的 `text` 块，命中的 URL /
 * 标题 / 摘录全在 citation 里。本域补的就是这一层解析：两种形状都归一化成 seam
 * 的 `sources[]`。
 *
 * ## 为什么没有自己的配置面（重要）
 *
 * 本域**不注册** settings 命名空间、不定义 schema、不设默认值，只读官方
 * `web-search-deepseek` 条目当前的活值（就是官方「Web search」页那几项：
 * Messages API 地址、模型、凭据引用、`anthropic-version`、生成上限、搜索次数上限）。
 * 于是：
 *
 *   - 用户要换任何 Anthropic 兼容搜索 API，改的还是**原来那个配置面**，无需学习新名字；
 *   - 插件源码里不出现任何厂商端点、模型名或密钥引用（默认值由 DSH 自己的 schema 提供）；
 *   - 把 pin 从本 provider 改回 `deepseek-official` 时，配置完全不用动。
 *
 * @module web-all/host/services/web-search-anthropic
 */

/** 注册到 `ctx.web` 的 search provider id；profile 用它 pin `searchProvider`。 */
export const WEB_SEARCH_ANTHROPIC_PROVIDER_ID = 'anthropic-messages'

/**
 * 本域镜像的官方设置条目 id（`dsh-base` 的 `web-search-deepseek` 行）。
 * 配置只从这里读，本域不新增任何命名空间。
 */
export const SEARCH_SETTINGS_ENTRY_ID = 'web-search-deepseek'

// ——— `ctx.web` 的结构面 ———
// 家族惯例是不 import 原生包类型（版本各自漂移），只按行为断言所需的缝面。
// 与 `@deepseek-ai/dsh-web` 的 `WebSearchRequest/Result/Provider` 形状一致。

/** 一次搜索请求；seam 传 query 与可选上限。 */
export interface WebSearchRequest {
  readonly query: string
  readonly maxResults?: number
}

/** 一条可引用来源。 */
export interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

/** 归一化后的搜索产出。 */
export interface WebSearchResult {
  readonly sources: readonly WebSearchSource[]
  readonly truncated: boolean
}

/** 一个搜索后端。 */
export interface WebSearchProvider {
  readonly id: string
  /** 廉价的本地可用性检查；不得发起网络请求。 */
  available(): boolean
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/** `ctx.web` 上本域用到的部分。 */
export interface WebSeam {
  registerSearchProvider(provider: WebSearchProvider): () => void
}

/** `ctx.settings.describe()` 返回的一条条目（只取本域需要的两个字段）。 */
export interface SettingsEntry {
  readonly ns?: string
  readonly value?: unknown
}

/** `ctx.settings` 上本域用到的部分（只读，绝不写入别人的配置）。 */
export interface SettingsSeam {
  describe(options?: { redactSecrets?: boolean }): readonly SettingsEntry[]
}

/** `ctx.credentials` 上本域用到的部分（可选服务）。 */
export interface CredentialSeam {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** 一次搜索的运行期配置快照；每个字段都来自官方设置条目，本域不给默认值。 */
export interface SearchConfig {
  /** Messages API 基址，不含 `/messages`。 */
  baseURL: string
  /** Anthropic 格式模型名。 */
  model: string
  /** 凭据引用名（凭据服务 / 启动环境），仅用于解析 key 与报错。 */
  apiKeyEnv: string
  /** `anthropic-version` 头。 */
  apiVersion: string
  /** 生成上限。 */
  maxTokens: number
  /** 服务端搜索次数上限。 */
  maxUses: number
}

/** 非空字符串。 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 正整数。 */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * 从官方设置条目里读出一次搜索的配置。
 *
 * 读不到条目、或基址/模型为空时返回 `undefined` —— 本域不会替用户猜端点或模型
 * （插件里不该出现任何厂商默认值），而是让 `available()` 为假，由 seam 给出
 * 「去 Web search 设置里配」的明确失败。
 *
 * @param entries - `ctx.settings.describe()` 的结果。
 * @returns 配置快照；缺关键项时为 undefined。
 */
export function searchConfigFrom(entries: readonly SettingsEntry[] | undefined): SearchConfig | undefined {
  const entry = entries?.find(candidate => candidate.ns === SEARCH_SETTINGS_ENTRY_ID)
  const value = entry?.value
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const baseURL = text(raw['baseURL'])
  const model = text(raw['model'])
  if (baseURL === undefined || model === undefined) return undefined
  const maxTokens = positiveInteger(raw['maxTokens'])
  const maxUses = positiveInteger(raw['maxUses'])
  if (maxTokens === undefined || maxUses === undefined) return undefined
  return {
    baseURL,
    model,
    apiKeyEnv: text(raw['apiKeyEnv']) ?? '',
    apiVersion: text(raw['apiVersion']) ?? '2023-06-01',
    maxTokens,
    maxUses,
  }
}

/**
 * 检索失败。形状对齐 `WebError`（带机器可路由的 `code`），
 * 由 `dsh-tool-web` 包装成模型可读的 `Error: <message>`。
 */
export class WebSearchError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'WebError'
    this.code = code
  }
}