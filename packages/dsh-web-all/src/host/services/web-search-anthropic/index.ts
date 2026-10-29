/**
 * Anthropic 兼容检索服务域 —— 向 `ctx.web` 注册 `anthropic-messages` search provider。
 *
 * ## 它只补什么
 *
 * 官方 `web-search-deepseek` provider 的请求侧通用、配置侧齐全，唯独解析侧写死
 * 「响应必须含 `web_search_tool_result` 块」，否则抛错。本域用同一份配置发出同样的
 * 请求，只把「只有 citation 的响应」也解析成来源（Bedrock 系路由的表现）。
 * 因此本域**不新增配置面**：每次搜索从官方 `web-search-deepseek` 条目现读活值。
 *
 * ## 为什么注册是「只要 web 在就注册」
 *
 * profile patch 把 `@deepseek-ai/dsh-web` 的 `searchProvider` pin 成 `anthropic-messages`。
 * seam 在指定了 id 时只用该 id：provider 缺席报 `WEB_PROVIDER_CONFIGURED_MISSING`，
 * 注册了但 `available()` 为假报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`——两者都会让
 * `web_search` 整体不可用。所以这里「只要 web 服务在就注册」，没配端点/模型时在注册期
 * 写一条明确告警，运行期由 seam 给出可操作的错误，而不是留下一个静默失败的 pin。
 *
 * 要彻底关掉本域，必须**同时**把 profile 里的 `searchProvider` 改回
 * `deepseek-official`，只删这一段会留下一个指向不存在 provider 的 pin。
 *
 * ## 为什么用局部 inject
 *
 * 0.2 严格注入下，插件只能访问自己 inject 声明过的服务。这里用
 * `ctx.inject([...])` 分别等待 `web` / `settings` / `credentials`，而不是把它们写进
 * web-all 的全局 inject：那会让整个全家桶在缺少这些服务的 profile 里挂掉。
 *
 * @module web-all/host/services/web-search-anthropic
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  searchConfigFrom,
  SEARCH_SETTINGS_ENTRY_ID,
  WEB_SEARCH_ANTHROPIC_PROVIDER_ID,
  type CredentialSeam,
  type SettingsSeam,
  type WebSeam,
} from './contracts.ts'
import { AnthropicMessagesSearchProvider } from './provider.ts'

export interface WebSearchAnthropicRegistrationOptions {
  /** 结构化告警出口；缺省写 console。 */
  logger?: { warn: (message: string) => void }
  /** 显式的 settings 缝面（测试用）。缺省时从 `ctx.settings` 拿。 */
  settings?: SettingsSeam
  /** 环境变量读取面（测试用）。缺省读 `process.env`。 */
  env?: (name: string) => string | undefined
  /** 注入的 fetch，测试用。 */
  fetchImpl?: typeof fetch
}

/** 可选读取一个服务缝隙：0.2 严格注入下访问未声明的服务会直接抛错。 */
function optionalService<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as Context & Record<string, unknown>)[name] as T | undefined
  } catch {
    return undefined
  }
}

/**
 * 注册 Anthropic 兼容检索 provider。
 * @param ctx - host plugin context。
 * @param options - 告警出口与测试注入面。
 * @returns 卸载回调：注销 provider。
 */
export function register(ctx: Context, options: WebSearchAnthropicRegistrationOptions = {}): () => void {
  const warn = options.logger?.warn ?? ((message: string): void => console.warn(message))
  const env = options.env ?? ((name: string): string | undefined => process.env[name])
  let settings = options.settings
  let credentials: CredentialSeam | undefined

  // settings 是可选依赖：没有它就读不到配置，provider 仍注册（注册期告警）。
  try {
    ctx.inject(['settings'], (cctx) => {
      settings = settings ?? optionalService<SettingsSeam>(cctx as Context, 'settings')
      if (searchConfigFrom(readEntries()) === undefined) {
        warn(`[web-all:web-search-anthropic] ${SEARCH_SETTINGS_ENTRY_ID} 条目里还没有可用的 Messages API 基址与模型：`
          + `web_search 仍被 pin 到 ${WEB_SEARCH_ANTHROPIC_PROVIDER_ID}，调用会以 WEB_PROVIDER_CREDENTIAL_MISSING 失败；`
          + '请在 Web search 设置（Plugins > Built-in plugin settings > Web search）里填写 Messages API 地址、模型与凭据引用')
      }
    })
  } catch {
    // 组合里没有 settings 服务：本域无法读配置，注册期告警后继续。
    warn('[web-all:web-search-anthropic] 没有 settings 服务，读不到 Web search 配置；本域注册但不可用')
  }

  // credentials 也是可选依赖：没有它时 key 回落到启动环境变量。
  try {
    ctx.inject(['credentials'], (cctx) => { credentials = optionalService<CredentialSeam>(cctx as Context, 'credentials') })
  } catch {
    // 该 profile 没有 credentials 服务：静默缺席，key 交由环境变量。
  }

  /** 当前设置条目的活值（`describe` 失败时视为无配置，不抛给 seam）。 */
  function readEntries(): ReturnType<SettingsSeam['describe']> | undefined {
    try {
      return settings?.describe()
    } catch {
      return undefined
    }
  }

  /** 每次搜索解析一次 key：凭据服务 → 启动环境变量。 */
  async function resolveKey(): Promise<string | undefined> {
    const ref = searchConfigFrom(readEntries())?.apiKeyEnv ?? ''
    if (ref === '') return undefined
    try {
      const stored = await credentials?.resolve(ref)
      if (stored !== undefined && stored.value.length > 0) return stored.value
    } catch {
      // 凭据服务拒绝解析（引用不存在/语法非法）时退回环境变量。
    }
    const ambient = env(ref)
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }

  const provider = new AnthropicMessagesSearchProvider(
    () => searchConfigFrom(readEntries()),
    resolveKey,
    options.fetchImpl,
  )

  let disposed = false
  let unregister: (() => void) | undefined

  try {
    ctx.inject(['web'], (cctx) => {
      if (disposed) return
      const seam = optionalService<WebSeam>(cctx as Context, 'web')
      if (seam?.registerSearchProvider === undefined) return
      unregister = seam.registerSearchProvider(provider)
    })
  } catch (error) {
    // 组合里没有 web 服务：本域静默缺席，绝不影响全家桶其余能力。
    warn(`[web-all:web-search-anthropic] 等待 web 服务失败，本域缺席：${error instanceof Error ? error.message : String(error)}`)
    return () => undefined
  }

  return () => {
    disposed = true
    unregister?.()
  }
}

export {
  searchConfigFrom,
  SEARCH_SETTINGS_ENTRY_ID,
  WEB_SEARCH_ANTHROPIC_PROVIDER_ID,
} from './contracts.ts'
export { AnthropicMessagesSearchProvider, citationSnippets, mapSearchResponse } from './provider.ts'