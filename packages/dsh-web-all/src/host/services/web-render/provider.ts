/**
 * 用真实 Chromium 渲染页面的 fetch provider。
 *
 * 一个 Chromium 实例懒启动、跨次复用，每次抓取开新页面；插件卸载时关闭。
 * 配置按**每次抓取**从注入的读取器取，因此 `web-render` 命名空间的 volatile
 * 热更新（无头/超时/视口等）立即生效，无需重挂插件。
 *
 * `available()` 只做本地文件检查，不发网络请求（seam 的硬要求）。
 *
 * @module web-all/host/services/web-render
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext } from 'playwright-core'
import {
  WebRenderError,
  WEB_RENDER_PROVIDER_ID,
  type ResolvedWebRenderConfig,
  type WebFetchProvider,
  type WebFetchRequest,
  type WebFetchResult,
} from './contracts.ts'

/** 各平台已知的浏览器安装路径，仅用于廉价的可用性判断。 */
const CHANNEL_PATHS: Record<string, Record<string, string[]>> = {
  darwin: {
    chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    msedge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    chromium: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
  },
  linux: {
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
    msedge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  },
  win32: {
    chrome: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    msedge: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    chromium: [],
  },
}

/** 该通道是否像样地可启动：只查已知路径与 playwright 自带的下载缓存。 */
function channelLaunchable(channel: string): boolean {
  const known = CHANNEL_PATHS[platform()]?.[channel] ?? []
  if (known.some(candidate => existsSync(candidate))) return true
  if (channel !== 'chromium') return false
  const caches = [
    join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
    join(process.env['LOCALAPPDATA'] ?? '', 'ms-playwright'),
  ]
  if (caches.some(dir => dir !== '' && existsSync(dir))) return true
  try { return existsSync(chromium.executablePath()) } catch { return false }
}

/**
 * Chrome 的 profile 单例锁冲突。同一个 userDataDir 同时只能有一个浏览器实例
 * （ProcessSingleton），因此同机并发运行第二个使用本 profile 的 dsh 进程会撞上它。
 */
function isProfileInUse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ProcessSingleton|already in use|is already running/i.test(message)
}

/** launchPersistentContext 的选项面。 */
type PersistentLaunchOptions = Parameters<typeof chromium.launchPersistentContext>[1]

/** 用真实 Chromium 渲染页面的抓取后端。 */
export class RenderFetchProvider implements WebFetchProvider {
  readonly id = WEB_RENDER_PROVIDER_ID

  /** 持久化 profile 目录；非空时用 launchPersistentContext 保住登录态。 */
  readonly userDataDir: string

  #readConfig: () => ResolvedWebRenderConfig
  #browser: Browser | undefined
  #context: BrowserContext | undefined
  #launching: Promise<BrowserContext> | undefined
  #disposed = false
  #warn: (message: string) => void
  /** profile 被占用时降级用的临时目录；dispose 时删除。 */
  #ephemeralDir: string | undefined
  #warnedProfileInUse = false

  /**
   * @param readConfig - 每次取值时重新解析配置（命名空间 volatile 热更新可见）。
   * @param userDataDir - 持久化 Chrome profile 目录；空串表示用临时上下文。
   * @param warn - 告警出口（profile 被占用降级等）。
   */
  constructor(readConfig: () => ResolvedWebRenderConfig, userDataDir: string, warn?: (message: string) => void) {
    this.#readConfig = readConfig
    this.userDataDir = userDataDir
    this.#warn = warn ?? ((message: string): void => console.warn(message))
  }

  /** 廉价的本地检查：必须有一个能启动的浏览器。 */
  available(): boolean {
    if (this.#disposed) return false
    const config = this.#readConfig()
    if (config.executablePath !== '') return existsSync(config.executablePath)
    return config.browserChannels.some(channelLaunchable)
  }

  /**
   * 渲染并取回一个 URL。
   * 非 2xx 作为结果返回（状态码是资源状态的一部分），不抛异常。
   * @param request - seam 的抓取请求。
   * @param signal - 工具调用超时策略下发的取消信号。
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const { url } = request
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new WebRenderError(`invalid URL: ${url}`, 'WEB_INVALID_URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new WebRenderError(`unsupported URL scheme "${parsed.protocol}" (only http and https are fetched)`, 'WEB_INVALID_URL')
    }
    // 用函数重读状态：写成内联比较会让 TS 把 signal.aborted 收窄成 false，
    // catch 分支里的同款判断就变成"无重叠类型"。
    const isAborted = (): boolean => signal?.aborted === true
    if (isAborted()) throw new WebRenderError('web fetch aborted', 'WEB_ABORTED')

    const config = this.#readConfig()
    const context = await this.#ensureContext()
    const page = await context.newPage()
    let timedOut = false
    const abort = (): void => { void page.close().catch(() => undefined) }
    const timer = setTimeout(() => { timedOut = true; abort() }, config.timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })

    try {
      await page.setViewportSize({ width: config.viewportWidth, height: config.viewportHeight })
      const response = await page.goto(url, { waitUntil: config.waitUntil, timeout: config.timeoutMs })

      // 给客户端渲染留出完成时间。两次等待都是尽力而为：带轮询或 websocket 的
      // 页面永远不会进入网络空闲，这不能算抓取失败。
      if (config.networkIdleMs > 0) {
        await page.waitForLoadState('networkidle', { timeout: config.networkIdleMs }).catch(() => undefined)
      }
      if (config.settleMs > 0) await page.waitForTimeout(config.settleMs)

      // `page.innerText` 而不是 page.evaluate 里的 document：host 侧 tsconfig 的
      // lib 只有 ES2024（无 DOM），在 evaluate 回调里引用 DOM 全局无法通过类型检查。
      const raw = config.extract === 'text'
        ? await page.innerText('body').catch(() => '')
        : await page.content()

      let content = raw
      let truncated = false
      if (content.length > config.maxBodyChars) {
        content = content.slice(0, config.maxBodyChars)
        truncated = true
      }

      return {
        url: page.url(),
        statusCode: response?.status() ?? 0,
        body: { kind: config.extract, content },
        truncated,
      }
    } catch (error) {
      if (isAborted()) throw new WebRenderError('web fetch aborted', 'WEB_ABORTED')
      if (timedOut) throw new WebRenderError(`web render timed out after ${config.timeoutMs}ms: ${url}`, 'WEB_FETCH_TIMEOUT')
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
      throw new WebRenderError(`browser fetch failed for ${url}: ${detail}`, 'WEB_PROVIDER_ERROR')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      await page.close().catch(() => undefined)
    }
  }

  /** 懒启动共享浏览器；启动失败不入缓存，下次调用重试。 */
  #ensureContext(): Promise<BrowserContext> {
    this.#launching ??= this.#launch().catch((error: unknown) => {
      this.#launching = undefined
      throw error
    })
    return this.#launching
  }

  /** 按配置的通道逐个尝试启动。 */
  async #launch(): Promise<BrowserContext> {
    const config = this.#readConfig()
    const attempts = config.executablePath !== '' ? [''] : config.browserChannels
    const failures: string[] = []

    for (const channel of attempts) {
      // playwright 的 `chromium` 通道表示自带下载，传 channel 反而会失败。
      const channelOption = channel !== '' && channel !== 'chromium' ? { channel } : {}
      const launchOptions = {
        headless: config.headless,
        args: config.args,
        viewport: { width: config.viewportWidth, height: config.viewportHeight },
        ...(config.executablePath !== '' ? { executablePath: config.executablePath } : {}),
        ...channelOption,
      }
      try {
        if (this.userDataDir !== '') {
          const context = await this.#launchPersistent(launchOptions)
          if (this.#disposed) {
            await context.close().catch(() => undefined)
            throw new Error('web-render disposed during launch')
          }
          this.#context = context
          return context
        }
        const browser = await chromium.launch(launchOptions)
        if (this.#disposed) {
          await browser.close().catch(() => undefined)
          throw new Error('web-render disposed during launch')
        }
        this.#browser = browser
        const context = await browser.newContext({ viewport: launchOptions.viewport })
        this.#context = context
        return context
      } catch (error) {
        if (this.#disposed) throw error
        const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
        failures.push(`${channel === '' ? 'executablePath' : channel}: ${detail}`)
      }
    }
    throw new WebRenderError(
      `no launchable browser found (tried ${failures.join('; ')}). Install Google Chrome, or set the web-render executablePath setting.`,
      'WEB_PROVIDER_UNAVAILABLE',
    )
  }

  /**
   * 启动持久化上下文；profile 被同机另一实例占用时降级到临时 profile。
   *
   * 降级是刻意的：一个 profile 锁不该让整个 `web_fetch` 变成不可用。代价只是
   * 这一次实例没有登录态，并在日志里留一条明确告警。
   */
  async #launchPersistent(launchOptions: PersistentLaunchOptions): Promise<BrowserContext> {
    try {
      return await chromium.launchPersistentContext(this.userDataDir, launchOptions)
    } catch (error) {
      if (!isProfileInUse(error)) throw error
      this.#ephemeralDir ??= mkdtempSync(join(tmpdir(), 'web-render-profile-'))
      if (!this.#warnedProfileInUse) {
        this.#warnedProfileInUse = true
        this.#warn(`[web-all:web-render] Chrome profile "${this.userDataDir}" 已被另一个实例占用：`
          + `本次降级到临时 profile（${this.#ephemeralDir}），抓取可用但没有登录态。`
          + '要保住登录态，请避免同机并发运行第二个使用该 profile 的进程。')
      }
      return await chromium.launchPersistentContext(this.#ephemeralDir, launchOptions)
    }
  }

  /** 关闭共享浏览器并停止接受抓取。 */
  async dispose(): Promise<void> {
    this.#disposed = true
    const pending = this.#launching
    this.#launching = undefined
    if (pending !== undefined) await pending.catch(() => undefined)
    const context = this.#context
    this.#context = undefined
    const browser = this.#browser
    this.#browser = undefined
    if (context !== undefined && (this.userDataDir !== '' || this.#ephemeralDir !== undefined)) {
      await context.close().catch(() => undefined)
    }
    if (browser !== undefined) await browser.close().catch(() => undefined)
    if (this.#ephemeralDir !== undefined) {
      try { rmSync(this.#ephemeralDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响卸载 */ }
      this.#ephemeralDir = undefined
    }
  }
}