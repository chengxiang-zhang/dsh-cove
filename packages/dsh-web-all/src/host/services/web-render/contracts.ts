/**
 * 渲染式抓取的契约、设置 schema 与默认值 —— host 半区。
 *
 * 原生 `dsh-web-fetch-http` 走的是纯 HTTP GET，交给 `dsh-tool-web` 转 markdown；
 * 对客户端渲染页面（SPA、懒加载列表、内容靠 XHR 回填）拿到的只是一个空壳。
 * 本域向 `ctx.web` 注册第二个 fetch provider（id `browser`），用真实 Chromium
 * 执行页面脚本后返回**渲染后的 DOM**，`body.kind` 仍是 `html`，因此
 * HTML→markdown、GFM 表格、截断与结果包装仍由 `dsh-tool-web` 负责，
 * 模型侧的工具名、schema 与提示词完全不变。
 *
 * 与 `playwright-sessions` 不共享启动器：那个域按规划会随 `@playwright/mcp`
 * 一起退役，渲染能力不能跟着断，所以这里自包含一个共享 Chromium 实例。
 *
 * @module web-all/host/services/web-render
 */

import { join } from 'node:path'
import z from 'schemastery'
import { registerFamilyNamespace } from '../family-config.ts'

/** 设置命名空间：`web-render`。 */
export const WEB_RENDER_SETTINGS_NAMESPACE = 'web-render'

/** 注册到 `ctx.web` 的 provider id；bundle patch 用它 pin `fetchProvider`。 */
export const WEB_RENDER_PROVIDER_ID = 'browser'

/** 用户可配置面（也是设置文档里该命名空间的字段）。 */
export interface WebRenderConfig {
  /** 关闭后本域不注册 provider，`web_fetch` 回到原生 HTTP 行为。 */
  enabled?: boolean
  /** 无头运行。 */
  headless?: boolean
  /** 依次尝试的 Chromium 通道（chrome / msedge / chromium）。 */
  browserChannels?: string[]
  /** 显式 Chromium 可执行文件路径；设置后不再按通道尝试。 */
  executablePath?: string
  /** 持久化 Chrome profile 目录；留空则用 <DSH_HOME>/cache/web-render/chrome-profile。 */
  userDataDir?: string
  /** 单次抓取硬上限（导航 + 等待渲染）。 */
  timeoutMs?: number
  /** 导航等待条件；SPA 通常 domcontentloaded 后由 networkIdleMs 兜底。 */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
  /** 加载后尽力等网络空闲的上限；0 表示不等。 */
  networkIdleMs?: number
  /** 网络空闲后的额外稳定期，等末帧绘制/字体。 */
  settleMs?: number
  /** `html` 返回渲染后的 DOM（保留表格结构）；`text` 只返回可见文本。 */
  extract?: 'html' | 'text'
  /** 返回字符上限，与 `dsh-tool-web` 自身的上限对齐。 */
  maxBodyChars?: number
  viewportWidth?: number
  viewportHeight?: number
  /** 追加的 Chrome 启动参数，例如 ['--proxy-server=http://127.0.0.1:7890']。 */
  args?: string[]
}

/** 运行时的权威 schema；导出后该命名空间才会出现在设置文档里。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  headless: z.boolean().default(true),
  browserChannels: z.array(z.string()).default(['chrome', 'msedge', 'chromium']),
  executablePath: z.string().default(''),
  userDataDir: z.string().default(''),
  timeoutMs: z.number().step(1).min(1).default(20_000),
  waitUntil: z.union(['load', 'domcontentloaded', 'networkidle', 'commit'] as const).default('domcontentloaded'),
  networkIdleMs: z.number().step(1).min(0).default(2_500),
  settleMs: z.number().step(1).min(0).default(400),
  extract: z.union(['html', 'text'] as const).default('html'),
  maxBodyChars: z.number().step(1).min(1).default(200_000),
  viewportWidth: z.number().step(1).min(1).default(1_280),
  viewportHeight: z.number().step(1).min(1).default(900),
  args: z.array(z.string()).default([]),
}) as unknown as z<WebRenderConfig>

registerFamilyNamespace(WEB_RENDER_SETTINGS_NAMESPACE, Config)

/** 解析后的配置：字段全部落地，无 undefined。 */
export type ResolvedWebRenderConfig = Required<WebRenderConfig>

/** 提取一份可用配置：未配置的字段取 schema 默认值。 */
export function effectiveConfig(config: WebRenderConfig | undefined): ResolvedWebRenderConfig {
  return Config(config ?? {}) as ResolvedWebRenderConfig
}

/** 未显式指定 profile 时的默认目录（登录态可长期保存在这里）。 */
export function defaultUserDataDir(dshHome: string): string {
  return join(dshHome, 'cache', 'web-render', 'chrome-profile')
}

// ——— `ctx.web` 的结构面 ———
// 家族惯例是不 import 原生包类型（版本各自漂移），只按行为断言所需的缝面。
// 与 `@deepseek-ai/dsh-web` 的 `WebFetchRequest/Result/Provider` 形状一致。

/** 一次抓取请求；seam 只传 url。 */
export interface WebFetchRequest {
  readonly url: string
}

/** 解码后的正文；本域只产出 html 或 text。 */
export interface WebFetchBody {
  readonly kind: 'html' | 'text'
  readonly content: string
}

/** 一次抓取结果；非 2xx 仍是结果而非异常。 */
export interface WebFetchResult {
  readonly url: string
  readonly statusCode: number
  readonly body: WebFetchBody
  readonly truncated: boolean
}

/** 一个 fetch 后端。 */
export interface WebFetchProvider {
  readonly id: string
  /** 廉价的本地可用性检查；不得发起网络请求。 */
  available(): boolean
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
}

/** `ctx.web` 上本域用到的部分。 */
export interface WebSeam {
  registerFetchProvider(provider: WebFetchProvider): () => void
}

/**
 * 抓取失败。形状对齐 `WebError`（带机器可路由的 `code`），
 * 由 `dsh-tool-web` 包装成模型可读的 `Error: <message>`。
 */
export class WebRenderError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'WebError'
    this.code = code
  }
}