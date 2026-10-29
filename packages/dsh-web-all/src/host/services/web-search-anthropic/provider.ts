/**
 * Anthropic 兼容 Messages 搜索 provider（只补响应解析）。
 *
 * 一次搜索 = 一次 Messages 请求 + 原生 `web_search_20250305` 服务端工具：代价是
 * 一个模型回合，回报是结构化结果。相对官方 provider 的唯一差别是**响应归一化**：
 * 本 provider 同时接受标准 Anthropic 形状（`web_search_tool_result` 条目 + citation
 * 摘录）与只有 citation 的形状（`server_tool_use` + `text.citations[]`，Bedrock 系
 * 上游的表现），并在「模型只是申请调用客户端工具」时给出可操作的报错，而不是假装
 * 搜到了东西。
 *
 * 配置不在本域：每次搜索都从官方设置条目现读（见 contracts 的
 * `searchConfigFrom`），所以用户改的还是原来那个 Web search 配置面，
 * 热更新立即生效，无需重挂插件。
 *
 * @module web-all/host/services/web-search-anthropic
 */

import {
  WebSearchError,
  WEB_SEARCH_ANTHROPIC_PROVIDER_ID,
  type SearchConfig,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchSource,
} from './contracts.ts'

/** 归因头；与 provider 行为一起演进。 */
const USER_AGENT = 'dsh-web-all/web-search-anthropic'

/** 一次引用位置；只有 citation 的形状把命中信息全放在这里。 */
export interface CitationLocation {
  type?: string
  url?: string | null
  title?: string | null
  cited_text?: string | null
}

/** 一个内容块；只消费下方注释里列出的几种。 */
export interface ContentBlock {
  type?: string
  text?: string | null
  name?: string | null
  citations?: readonly CitationLocation[] | null
  /** `web_search_tool_result` 的载荷：条目数组，或一个错误对象。 */
  content?: unknown
}

/** `web_search_tool_result` 里的一个可引用条目。 */
export interface SearchResultItem {
  type?: string
  url?: string | null
  title?: string | null
  page_age?: string | null
}

/** Anthropic Messages 响应信封（best-effort；字段随上游而变）。 */
export interface AnthropicResponse {
  content?: readonly ContentBlock[] | null
  stop_reason?: string | null
  usage?: { server_tool_use?: { web_search_requests?: number | null } | null } | null
}

/** 归一化结果：来源 + 用于诊断的检索事实。 */
export interface MappedSearchResponse {
  sources: readonly WebSearchSource[]
  /** 端点侧实际执行的服务端搜索次数（0 表示没搜）。 */
  searches: number
  /** 响应里有 `tool_use(web_search)`：模型申请调用客户端工具，端点没执行搜索。 */
  clientToolUse: boolean
  /** `web_search_tool_result` 自带的错误码（有则整体失败）。 */
  resultError?: string
}

/** 一次搜索的运行期选项快照：配置 + 凭据解析面（测试可注入 fetch）。 */
export interface AnthropicMessagesSearchProviderOptions extends SearchConfig {
  /** 字面 key；存在时优先于 {@link resolveApiKey}。 */
  apiKey?: string
  /** 每次搜索解析一次当前 key（凭据服务 / 启动环境）。 */
  resolveApiKey?: () => Promise<string | undefined>
  /** 注入的 fetch，测试用。 */
  fetchImpl?: typeof fetch
}

/** 收集每个 URL 的 citation 摘录（首次出现优先）；标准形状下它才是 snippet 来源。 */
export function citationSnippets(blocks: readonly ContentBlock[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const cite of block.citations ?? []) {
      const url = cite.url ?? ''
      const text = cite.cited_text ?? ''
      if (url !== '' && text !== '' && !map.has(url)) map.set(url, text)
    }
  }
  return map
}

/** 读出 `web_search_tool_result` 自带的错误（载荷是对象而非数组时）。 */
function resultErrorOf(block: ContentBlock): string | undefined {
  const payload = block.content
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const record = payload as { type?: unknown; error_code?: unknown }
  if (record.error_code === undefined || record.error_code === null) return undefined
  return `${String(record.type ?? 'web_search_tool_result_error')}: ${String(record.error_code)}`
}

/**
 * 把两种 Anthropic 兼容响应形状统一成 seam 的 `sources[]`。
 *
 * 顺序：先走标准结果块（带 `page_age` 与条目级字段），拿不到任何条目时再回落到
 * citation —— 只有 citation 的上游永远走第二条分支；两条分支都用同一张 citation
 * 摘录表补 `snippet`，按 URL 去重（`max_uses > 1` 时同一 URL 可能多次出现）。
 *
 * @param response - 解析后的 Messages 响应体。
 * @returns 归一化结果；`searches`/`clientToolUse`/`resultError` 供诊断使用。
 */
export function mapSearchResponse(response: AnthropicResponse): MappedSearchResponse {
  const blocks = response.content ?? []
  const searches = response.usage?.server_tool_use?.web_search_requests
    ?? blocks.filter(block => block.type === 'server_tool_use' && block.name === 'web_search').length
  const clientToolUse = blocks.some(block => block.type === 'tool_use' && block.name === 'web_search')
  const resultError = blocks.filter(block => block.type === 'web_search_tool_result')
    .map(resultErrorOf)
    .find(error => error !== undefined)

  const snippets = citationSnippets(blocks)
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  const add = (url: string | null | undefined, title: string | null | undefined, snippet: string | null | undefined, publishedAt?: string | null): void => {
    const value = url ?? ''
    if (value === '' || seen.has(value)) return
    seen.add(value)
    sources.push({
      url: value,
      ...title !== null && title !== undefined && title !== '' ? { title } : {},
      ...snippet !== null && snippet !== undefined && snippet !== '' ? { snippet } : {},
      ...publishedAt !== null && publishedAt !== undefined && publishedAt !== '' ? { publishedAt } : {},
    })
  }

  for (const block of blocks) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue
    for (const item of block.content as SearchResultItem[]) {
      if (item?.type !== 'web_search_result') continue
      const url = item.url ?? ''
      add(url, item.title, snippets.get(url), item.page_age)
    }
  }

  if (sources.length === 0) {
    for (const block of blocks) {
      if (block.type !== 'text') continue
      for (const cite of block.citations ?? []) add(cite.url, cite.title, cite.cited_text)
    }
  }

  return {
    sources,
    searches,
    clientToolUse,
    ...resultError !== undefined ? { resultError } : {},
  }
}

/** 去掉尾斜杠，避免 `baseURL` 以 `/` 结尾时拼出 `//messages`。 */
function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.replace(/\/+$/u, '') : value
}

/** 端点与配置引导：把「这是配置问题、改哪里」写进错误里（指向官方那套配置面）。 */
function endpointHint(endpoint: string): string {
  return `\n\nThe web search request used endpoint ${JSON.stringify(endpoint)}. Search endpoint configuration is separate from chat: guide the user to Plugins > Built-in plugin settings > Web search, where they can change and save the Messages API base URL, the model, and the credential reference. Only the user should choose or change the endpoint.`
}

/** 端点没执行搜索时的可操作报错：区分「模型申请客户端工具」与「搜了但没结果」。 */
function noResultError(mapped: MappedSearchResponse, config: SearchConfig): WebSearchError {
  if (mapped.clientToolUse) {
    return new WebSearchError(
      `The endpoint returned a client-side tool_use(web_search) instead of executing the search itself, so model ${JSON.stringify(config.model)} has no web search results. `
      + 'Native server-side web_search_20250305 is an Anthropic-model feature: on a multi-vendor gateway pick a Claude model, because DeepSeek/Gemini routes reply with a client tool call. '
      + 'The model comes from the Web search settings, not from this plugin.',
      'WEB_PROVIDER_ERROR',
    )
  }
  if (mapped.searches === 0) {
    return new WebSearchError(
      `The endpoint executed no server-side web search for model ${JSON.stringify(config.model)} and returned no citeable sources; the request may not have triggered native web search.`,
      'WEB_PROVIDER_ERROR',
    )
  }
  return new WebSearchError(
    `The endpoint executed ${mapped.searches} server-side web search(es) but returned no citeable sources.`,
    'WEB_PROVIDER_ERROR',
  )
}

/** 用 Anthropic 兼容 Messages 端点做检索的 provider。 */
export class AnthropicMessagesSearchProvider implements WebSearchProvider {
  readonly id = WEB_SEARCH_ANTHROPIC_PROVIDER_ID
  private readonly resolveConfig: () => SearchConfig | undefined
  private readonly resolveKey: () => Promise<string | undefined>
  private readonly fetchImpl: typeof fetch | undefined

  /**
   * @param resolveConfig - 下一次操作的配置；thunk 而非快照，官方设置条目的热更新
   * 因此每次搜索都生效，而不必重注册 provider（重注册会让 seam 的选择对用户可见地抖动）。
   * @param resolveKey - 解析字面 key / 凭据服务 / 启动环境，每次搜索调用一次。
   * @param fetchImpl - 注入的 fetch，测试用。
   */
  constructor(
    resolveConfig: () => SearchConfig | undefined,
    resolveKey: () => Promise<string | undefined>,
    fetchImpl?: typeof fetch,
  ) {
    this.resolveConfig = resolveConfig
    this.resolveKey = resolveKey
    this.fetchImpl = fetchImpl
  }

  available(): boolean {
    const config = this.resolveConfig()
    return config !== undefined
      && URL.canParse(config.baseURL)
      && config.model !== ''
      && Number.isInteger(config.maxTokens) && config.maxTokens > 0
      && Number.isInteger(config.maxUses) && config.maxUses > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const config = this.resolveConfig()
    if (config === undefined) throw missingConfigError()
    // 读经函数而非直接比属性：TS 会把 `signal?.aborted === true` 早退后的属性
    // 窄化成 false，后续再判同一属性就成了「无重叠比较」。
    const isAborted = (): boolean => signal?.aborted === true
    const endpoint = `${trimTrailingSlash(config.baseURL)}/messages`
    const apiKey = await this.apiKey(config, signal)
    if (isAborted()) throw abortedError()

    const body = {
      model: config.model,
      max_tokens: config.maxTokens,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `Perform a web search for the query: ${request.query}` }],
      }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: config.maxUses }],
    }

    const doFetch = this.fetchImpl ?? fetch
    let response: Response
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-api-key': apiKey,
          'authorization': `Bearer ${apiKey}`,
          'anthropic-version': config.apiVersion,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      if (isAborted()) throw abortedError()
      throw new WebSearchError(`Web search request failed: ${String(error)}.${endpointHint(endpoint)}`, 'WEB_PROVIDER_ERROR')
    }

    if (!response.ok) {
      let detail = ''
      try {
        const parsed = await response.json() as { error?: { message?: string } | string; message?: string }
        detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message ?? ''
      } catch {
        // 非 JSON 错误体：状态码已经足够定位。
      }
      const message = `Web search endpoint error (HTTP ${response.status})${detail === '' ? '' : `: ${detail}`}`
      throw new WebSearchError(`${message}${endpointHint(endpoint)}`, 'WEB_PROVIDER_ERROR')
    }

    let mapped: MappedSearchResponse
    try {
      mapped = mapSearchResponse(await response.json() as AnthropicResponse)
    } catch (error) {
      throw new WebSearchError(`Web search returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR')
    }

    if (mapped.resultError !== undefined) {
      throw new WebSearchError(`The endpoint's web search failed: ${mapped.resultError}.`, 'WEB_PROVIDER_ERROR')
    }
    if (mapped.sources.length === 0) throw noResultError(mapped, config)

    return { sources: mapped.sources, truncated: false }
  }

  /** 解析一次操作的 key：调用方给的解析器（字面 key → 凭据服务 → 环境变量）。 */
  private async apiKey(config: SearchConfig, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted === true) throw abortedError()
    const resolved = await this.resolveKey()
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = config.apiKeyEnv === '' ? 'the configured credential reference' : config.apiKeyEnv
    throw new WebSearchError(
      `Web search has no API key for "${ref}"; store it through the credentials service, export it in the launching environment, `
      + 'or set the credential reference in the Web search settings.',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** 配置缺失：设置条目读不到、或基址/模型为空。 */
function missingConfigError(): WebSearchError {
  return new WebSearchError(
    'Web search is pinned to the anthropic-messages provider, but no Messages API base URL and model are configured. '
    + 'Guide the user to Plugins > Built-in plugin settings > Web search and set the Messages API base URL, the model, and the credential reference.',
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

/** 调用方取消：与原生 provider 的 `WEB_ABORTED` 对齐。 */
function abortedError(): WebSearchError {
  return new WebSearchError('Web search aborted', 'WEB_ABORTED')
}