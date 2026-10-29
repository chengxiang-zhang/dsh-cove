/**
 * 渲染式抓取服务域 —— 向 `ctx.web` 注册 `browser` fetch provider。
 *
 * ## 为什么注册是"只要 web 在就注册"
 *
 * bundle patch 把 `@deepseek-ai/dsh-web` 的 `fetchProvider` pin 成 `browser`，
 * 否则 `http` 与本 provider 同时可用会让每次抓取都以
 * `WEB_PROVIDER_AMBIGUOUS` 失败。pin 生效后，映射关系是：
 *
 * | 情况 | seam 结果 |
 * |---|---|
 * | provider 已注册且可用 | 正常渲染抓取 |
 * | provider 已注册但 `available()` 为假 | `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
 * | provider 未注册 | `WEB_PROVIDER_CONFIGURED_MISSING` |
 *
 * 后两者都会让 `web_fetch` **整体不可用**。因此这里选择"只要 web 服务在就注册"，
 * 让映射始终成立：没有可用浏览器时在注册期写一条明确告警，运行期由 seam 给出
 * 可操作的错误，而不是留下一个静默失败的 pin。
 *
 * 要彻底关掉本域，必须**同时**把 `fetchProvider` 改回 `http`（见 cordis.patch.yml
 * 的注释），单独设 `enabled: false` 会复现 MISSING。
 *
 * ## 为什么用局部 inject
 *
 * 0.2 严格注入下，插件只能访问自己 inject 声明过的服务。这里用
 * `ctx.inject(['web'], …)` 等待，而不是把 `web` 写进 web-all 的全局 inject：
 * 那会让整个全家桶在缺少 web 服务的 profile 里直接挂掉。
 *
 * ## 配置读取
 *
 * `web-render` 是聚合 Config 里的一个 volatile 命名空间，不是装配参数，
 * 因此按家族惯例用 `familyNamespace()` 读取；provider 拿到的是**读取函数**而非
 * 快照，设置面板改无头/超时/视口可即时生效，无需重挂插件。
 *
 * @module web-all/host/services/web-render
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { familyNamespace } from '../family-config.ts'
import {
  defaultUserDataDir,
  effectiveConfig,
  WEB_RENDER_SETTINGS_NAMESPACE,
  type ResolvedWebRenderConfig,
  type WebRenderConfig,
  type WebSeam,
} from './contracts.ts'
import { RenderFetchProvider } from './provider.ts'

export interface WebRenderRegistrationOptions {
  /** 用户 dsh 配置根，用于推导默认的持久化 profile 目录。 */
  dshHome?: string
  /** 结构化告警出口；缺省写 console。 */
  logger?: { warn: (message: string) => void }
  /** 显式配置（测试用）。缺省时从 `web-render` 命名空间读取。 */
  config?: WebRenderConfig
}

/**
 * 注册渲染式 fetch provider。
 * @param ctx - host plugin context。
 * @param options - dshHome 与告警出口。
 * @returns 卸载回调：注销 provider 并关闭浏览器。
 */
export function register(ctx: Context, options: WebRenderRegistrationOptions = {}): () => void {
  const warn = options.logger?.warn ?? ((message: string): void => console.warn(message))
  const readConfig = (): ResolvedWebRenderConfig => {
    const raw = options.config ?? familyNamespace<WebRenderConfig>(WEB_RENDER_SETTINGS_NAMESPACE)
    return effectiveConfig(raw)
  }

  const initial = readConfig()
  if (!initial.enabled) return () => undefined

  const home = options.dshHome ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  // profile 目录只解析一次：改它需要换浏览器实例，属于重挂语义。
  const userDataDir = initial.userDataDir.trim() !== '' ? initial.userDataDir.trim() : defaultUserDataDir(home)
  const provider = new RenderFetchProvider(readConfig, userDataDir, warn)

  if (!provider.available()) {
    warn(`[web-all:web-render] 未找到可用浏览器（channels=${initial.browserChannels.join('/')}，executablePath=${initial.executablePath === '' ? '未设' : initial.executablePath}）：`
      + 'web_fetch 仍被 pin 到 browser provider，调用会以 WEB_PROVIDER_UNAVAILABLE 失败；'
      + '请安装 Google Chrome 或设置 web-render 的 executablePath，或把 web 行的 fetchProvider 改回 http')
  }

  let disposed = false
  let unregister: (() => void) | undefined

  try {
    ctx.inject(['web'], (cctx) => {
      if (disposed) return
      const seam = (cctx as Context & { web?: WebSeam }).web
      if (seam?.registerFetchProvider === undefined) return
      unregister = seam.registerFetchProvider(provider)
    })
  } catch (error) {
    // 组合里没有 web 服务：本域静默缺席，绝不影响全家桶其余能力。
    warn(`[web-all:web-render] 等待 web 服务失败，本域缺席：${error instanceof Error ? error.message : String(error)}`)
    return () => undefined
  }

  return () => {
    disposed = true
    unregister?.()
    void provider.dispose()
  }
}

export { WEB_RENDER_PROVIDER_ID, WEB_RENDER_SETTINGS_NAMESPACE, effectiveConfig, type WebRenderConfig } from './contracts.ts'
export { RenderFetchProvider } from './provider.ts'