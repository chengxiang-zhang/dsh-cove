import { describe, expect, it, vi } from 'vitest'
import {
  searchConfigFrom,
  SEARCH_SETTINGS_ENTRY_ID,
  WEB_SEARCH_ANTHROPIC_PROVIDER_ID,
  type SettingsEntry,
} from '../src/host/services/web-search-anthropic/contracts.ts'
import { register } from '../src/host/services/web-search-anthropic/index.ts'
import { AnthropicMessagesSearchProvider, mapSearchResponse, type AnthropicMessagesSearchProviderOptions, type AnthropicResponse } from '../src/host/services/web-search-anthropic/provider.ts'

/**
 * 标准 Anthropic 形状：结果块 + 引用摘录（官方 provider 唯一接受的形状）。
 * 有些上游只回 citation，但这条分支必须仍然可用。
 */
const STANDARD_RESPONSE: AnthropicResponse = {
  content: [
    { type: 'server_tool_use', name: 'web_search' },
    {
      type: 'web_search_tool_result',
      content: [
        { type: 'web_search_result', url: 'https://a.test/one', title: 'A one', page_age: '2 days ago' },
        { type: 'web_search_result', url: 'https://b.test/two', title: 'B two' },
        { type: 'web_search_result', url: 'https://a.test/one', title: 'A duplicate' },
      ],
    },
    { type: 'text', text: '', citations: [{ type: 'web_search_result_location', url: 'https://a.test/one', cited_text: 'snippet A' }] },
  ],
  usage: { server_tool_use: { web_search_requests: 1 } },
}

/** 只有 citation 的形状（Kaon/Bedrock 上游的真实响应裁剪版）：没有结果块。 */
const CITATION_ONLY_RESPONSE: AnthropicResponse = {
  content: [
    { type: 'server_tool_use', name: 'web_search' },
    {
      type: 'text',
      text: '',
      citations: [
        { type: 'web_search_result_location', url: 'https://github.com/example/repo', title: 'example/repo', cited_text: '# example' },
        { type: 'web_search_result_location', url: 'https://docs.example.com/start', title: 'Getting started', cited_text: 'Install with pnpm.' },
      ],
    },
    {
      type: 'text',
      text: 'The project is published on GitHub and documented at docs.example.com.',
      citations: [{ type: 'web_search_result_location', url: 'https://market.example.com', title: 'Market', cited_text: 'Plugin market' }],
    },
  ],
  usage: { server_tool_use: { web_search_requests: 1 } },
}

/** 非 Anthropic 模型：把 web_search 当普通客户端工具回一个 tool_use，端点并未搜索。 */
const CLIENT_TOOL_RESPONSE: AnthropicResponse = {
  content: [
    { type: 'text', text: 'I will search the web.' },
    { type: 'tool_use', name: 'web_search' },
  ],
  stop_reason: 'tool_use',
}

/** 官方设置条目的一条活值（字段与 `web-search-deepseek` 的 Config 对齐）。 */
function entry(overrides: Record<string, unknown> = {}): SettingsEntry {
  return {
    ns: SEARCH_SETTINGS_ENTRY_ID,
    value: {
      baseURL: 'https://search.test/v1',
      model: 'some-model',
      apiKeyEnv: 'SOME_KEY',
      apiVersion: '2023-06-01',
      maxTokens: 4_096,
      maxUses: 3,
      ...overrides,
    },
  }
}

function options(overrides: Partial<AnthropicMessagesSearchProviderOptions> = {}): AnthropicMessagesSearchProviderOptions {
  return {
    baseURL: 'https://search.test/v1',
    model: 'some-model',
    apiKeyEnv: 'SOME_KEY',
    apiVersion: '2023-06-01',
    maxTokens: 4_096,
    maxUses: 3,
    ...overrides,
  }
}

/** 用固定配置 + 固定响应构造 provider（不发真实网络请求）；`null` 表示解析不到 key。 */
function providerReturning(
  payload: AnthropicResponse,
  overrides: Partial<AnthropicMessagesSearchProviderOptions> = {},
  key: string | null = 'sk-test',
) {
  return new AnthropicMessagesSearchProvider(
    () => options(overrides),
    async () => key ?? undefined,
    async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
  )
}

describe('web-search-anthropic contracts', () => {
  it('registers a protocol-named provider id and mirrors the official settings entry', () => {
    expect(WEB_SEARCH_ANTHROPIC_PROVIDER_ID).toBe('anthropic-messages')
    expect(SEARCH_SETTINGS_ENTRY_ID).toBe('web-search-deepseek')
  })

  it('reads runtime config from the official entry, with no defaults of its own', () => {
    expect(searchConfigFrom([entry()])).toEqual({
      baseURL: 'https://search.test/v1',
      model: 'some-model',
      apiKeyEnv: 'SOME_KEY',
      apiVersion: '2023-06-01',
      maxTokens: 4_096,
      maxUses: 3,
    })
  })

  it('stays unconfigured instead of inventing an endpoint or model', () => {
    expect(searchConfigFrom(undefined)).toBeUndefined()
    expect(searchConfigFrom([])).toBeUndefined()
    expect(searchConfigFrom([{ ns: 'other', value: entry().value }])).toBeUndefined()
    expect(searchConfigFrom([entry({ baseURL: '' })])).toBeUndefined()
    expect(searchConfigFrom([entry({ model: '  ' })])).toBeUndefined()
  })

  it('prefers the configured Anthropic version and tolerates a missing one', () => {
    expect(searchConfigFrom([entry({ apiVersion: '2024-01-01' })])?.apiVersion).toBe('2024-01-01')
    expect(searchConfigFrom([entry({ apiVersion: undefined })])?.apiVersion).toBe('2023-06-01')
  })
})

describe('web-search-anthropic response mapping', () => {
  it('reads the standard Anthropic shape from result blocks joined to citation snippets', () => {
    const mapped = mapSearchResponse(STANDARD_RESPONSE)
    expect(mapped.sources).toEqual([
      { url: 'https://a.test/one', title: 'A one', snippet: 'snippet A', publishedAt: '2 days ago' },
      { url: 'https://b.test/two', title: 'B two' },
    ])
    expect(mapped.searches).toBe(1)
    expect(mapped.clientToolUse).toBe(false)
  })

  it('reads the citation-only shape the official provider rejects', () => {
    const mapped = mapSearchResponse(CITATION_ONLY_RESPONSE)
    expect(mapped.sources).toEqual([
      { url: 'https://github.com/example/repo', title: 'example/repo', snippet: '# example' },
      { url: 'https://docs.example.com/start', title: 'Getting started', snippet: 'Install with pnpm.' },
      { url: 'https://market.example.com', title: 'Market', snippet: 'Plugin market' },
    ])
    expect(mapped.searches).toBe(1)
    expect(mapped.clientToolUse).toBe(false)
  })

  it('detects a client-side tool_use instead of pretending search ran', () => {
    const mapped = mapSearchResponse(CLIENT_TOOL_RESPONSE)
    expect(mapped.sources).toEqual([])
    expect(mapped.clientToolUse).toBe(true)
    expect(mapped.searches).toBe(0)
  })

  it('surfaces an error payload carried inside a result block', () => {
    const mapped = mapSearchResponse({
      content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }],
    })
    expect(mapped.resultError).toBe('web_search_tool_result_error: max_uses_exceeded')
  })

  it('counts server_tool_use blocks when the endpoint reports no usage', () => {
    expect(mapSearchResponse({ content: [{ type: 'server_tool_use', name: 'web_search' }] }).searches).toBe(1)
    expect(mapSearchResponse({ content: [] }).searches).toBe(0)
  })
})

describe('web-search-anthropic provider', () => {
  it('returns sources from the citation-only shape', async () => {
    const result = await providerReturning(CITATION_ONLY_RESPONSE).search({ query: 'example project', maxResults: 5 })
    expect(result.sources).toHaveLength(3)
    expect(result.sources[0]?.url).toBe('https://github.com/example/repo')
    expect(result.truncated).toBe(false)
  })

  it('fails with model guidance when the endpoint returns a client tool call', async () => {
    const error = await providerReturning(CLIENT_TOOL_RESPONSE).search({ query: 'x' }).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ name: 'WebError', code: 'WEB_PROVIDER_ERROR' })
    expect(String((error as Error).message)).toContain('client-side tool_use(web_search)')
    expect(String((error as Error).message)).toContain('Claude model')
  })

  it('fails instead of returning an empty source list', async () => {
    const error = await providerReturning({ content: [{ type: 'server_tool_use', name: 'web_search' }] }).search({ query: 'x' }).catch((reason: unknown) => reason)
    expect((error as { code?: string }).code).toBe('WEB_PROVIDER_ERROR')
    expect(String((error as Error).message)).toContain('no citeable sources')
  })

  it('reports the endpoint and status on an HTTP failure', async () => {
    const provider = new AnthropicMessagesSearchProvider(
      () => options(),
      async () => 'sk-test',
      async () => new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 }),
    )
    const error = await provider.search({ query: 'x' }).catch((reason: unknown) => reason)
    const message = String((error as Error).message)
    expect(message).toContain('HTTP 402')
    expect(message).toContain('Insufficient Balance')
    expect(message).toContain('https://search.test/v1/messages')
    expect(message).toContain('Web search')
  })

  it('names the missing credential reference', async () => {
    const provider = providerReturning(CITATION_ONLY_RESPONSE, {}, null)
    const error = await provider.search({ query: 'x' }).catch((reason: unknown) => reason)
    expect((error as { code?: string }).code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
    expect(String((error as Error).message)).toContain('SOME_KEY')
  })

  it('fails with configuration guidance when the entry has no endpoint or model', async () => {
    const provider = new AnthropicMessagesSearchProvider(() => undefined, async () => 'sk-test')
    expect(provider.available()).toBe(false)
    const error = await provider.search({ query: 'x' }).catch((reason: unknown) => reason)
    expect(String((error as Error).message)).toContain('no Messages API base URL and model are configured')
  })

  it('maps caller cancellation to WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await providerReturning(CITATION_ONLY_RESPONSE).search({ query: 'x' }, controller.signal).catch((reason: unknown) => reason)
    expect((error as { code?: string }).code).toBe('WEB_ABORTED')
  })

  it('sends the native server tool and re-reads the configuration each time', async () => {
    const seen: Array<{ url: string; body: unknown; key: string | null; version: string | null }> = []
    let current = options()
    const provider = new AnthropicMessagesSearchProvider(
      () => current,
      async () => 'sk-live',
      async (url, init) => {
        const headers = new Headers(init?.headers)
        seen.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          key: headers.get('x-api-key'),
          version: headers.get('anthropic-version'),
        })
        return new Response(JSON.stringify(CITATION_ONLY_RESPONSE), { status: 200 })
      },
    )
    await provider.search({ query: 'example' })
    current = options({ baseURL: 'https://other.test/v1', model: 'other-model', apiVersion: '2025-01-01' })
    await provider.search({ query: 'second' })
    expect(seen.map(item => item.url)).toEqual(['https://search.test/v1/messages', 'https://other.test/v1/messages'])
    expect(seen[1]?.version).toBe('2025-01-01')
    expect(seen[0]?.key).toBe('sk-live')
    expect(seen[0]?.body).toMatchObject({
      model: 'some-model',
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: example' }] }],
    })
  })

  it('reports availability locally without a network call', () => {
    expect(providerReturning(CITATION_ONLY_RESPONSE).available()).toBe(true)
    expect(new AnthropicMessagesSearchProvider(() => options({ baseURL: 'not-a-url' }), async () => 'k').available()).toBe(false)
    expect(new AnthropicMessagesSearchProvider(() => undefined, async () => 'k').available()).toBe(false)
  })
})

describe('web-search-anthropic registration', () => {
  /** 只实现本域用到的 ctx.inject，捕获被注册的 provider 与注入的服务。 */
  function fakeContext(services: { web?: boolean; settings?: boolean; credentials?: { value?: string } } = { web: true, settings: true }) {
    const providers: Array<{ id: string }> = []
    const warnings: string[] = []
    const ctx = {
      inject: (deps: readonly string[], callback: (c: unknown) => void): void => {
        const answer: Record<string, unknown> = {}
        if (deps.includes('web')) {
          if (services.web === false) throw new Error('service "web" is not available')
          answer['web'] = {
            registerSearchProvider(provider: { id: string }) {
              providers.push(provider)
              return () => { providers.splice(providers.indexOf(provider), 1) }
            },
          }
        }
        if (deps.includes('settings')) {
          if (services.settings === false) throw new Error('service "settings" is not available')
          answer['settings'] = { describe: () => [entry()] }
        }
        if (deps.includes('credentials')) {
          if (services.credentials === undefined) throw new Error('service "credentials" is not available')
          answer['credentials'] = { resolve: async () => services.credentials }
        }
        callback(answer)
      },
    }
    return { ctx, providers, warnings }
  }

  it('registers the pinned provider id and unregisters on dispose', () => {
    const { ctx, providers } = fakeContext()
    const dispose = register(ctx as never, { logger: { warn: () => undefined } })
    expect(providers.map(provider => provider.id)).toEqual([WEB_SEARCH_ANTHROPIC_PROVIDER_ID])
    dispose()
    expect(providers).toEqual([])
  })

  it('resolves the key from the credentials service before the environment', async () => {
    const { ctx, providers } = fakeContext({ web: true, settings: true, credentials: { value: 'sk-from-store' } })
    const seen: Array<string | null> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-api-key'))
      return new Response(JSON.stringify(CITATION_ONLY_RESPONSE), { status: 200 })
    }))
    try {
      register(ctx as never, { env: () => 'sk-from-env', logger: { warn: () => undefined } })
      await (providers[0] as unknown as { search: (request: { query: string }) => Promise<unknown> }).search({ query: 'x' })
      expect(seen).toEqual(['sk-from-store'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls back to the ambient variable when no credential is stored', async () => {
    const { ctx, providers } = fakeContext({ web: true, settings: true })
    const seen: Array<string | null> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-api-key'))
      return new Response(JSON.stringify(CITATION_ONLY_RESPONSE), { status: 200 })
    }))
    try {
      register(ctx as never, { env: name => name === 'SOME_KEY' ? 'sk-from-env' : undefined, logger: { warn: () => undefined } })
      await (providers[0] as unknown as { search: (request: { query: string }) => Promise<unknown> }).search({ query: 'x' })
      expect(seen).toEqual(['sk-from-env'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('stays absent without a web service and never throws', () => {
    const { ctx, warnings } = fakeContext({ web: false, settings: true })
    const dispose = register(ctx as never, { logger: { warn: message => warnings.push(message) } })
    expect(typeof dispose).toBe('function')
    expect(warnings.join('\n')).toContain('等待 web 服务失败')
  })

  it('warns when the official entry still has no endpoint or model', () => {
    const { ctx, warnings } = fakeContext({ web: true, settings: true })
    register(ctx as never, {
      settings: { describe: () => [entry({ baseURL: '' })] },
      logger: { warn: message => warnings.push(message) },
    })
    expect(warnings.join('\n')).toContain('还没有可用的 Messages API 基址与模型')
  })
})