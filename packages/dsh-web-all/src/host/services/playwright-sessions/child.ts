/**
 * One per-session Playwright MCP child process.
 *
 * Each conversation owns a dedicated `@playwright/mcp` server spawned over
 * stdio with a per-session `--user-data-dir` (browser profile) and `cwd`
 * (screenshot / file output). Because every child serves exactly one MCP
 * client, no `--shared-browser-context` or `--isolated` flag is needed: the
 * default per-client browser model already gives this session a private
 * browser, and the explicit user-data-dir keeps its login state durable
 * without ever touching another session's profile.
 *
 * In `liveView` mode the host starts the persistent Chromium itself with
 * `launchPersistentContext` (CDP endpoint on an ephemeral port) and passes
 * `--cdp-endpoint` to the MCP child, which connects to that SAME browser as
 * its default context. The host keeps the `BrowserContext` handle so the
 * live-view WebSocket (see live-view.ts) can stream CDP screencast frames of
 * the pages the MCP tools drive. This is the dual-owner launch path the
 * older implementation documented; without `liveView` the child launches its
 * own browser exactly as before.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium as playwrightChromium, type BrowserContext } from 'playwright-core'
import { sanitizePlaywrightSessionKey } from '../../../core/playwright-sessions/names.ts'
import type { PlaywrightConnectionMode } from '../../../core/playwright-sessions/contracts.ts'

export interface SessionBrowserOptions {
  /** Absolute path to the @playwright/mcp cli.js entry. */
  cliPath: string
  /** Durable session identity used for the profile directory name. */
  sessionId: string
  /** Root directory holding every session's profile + output folders. */
  sessionsRoot: string
  /** Environment for the child; PLAYWRIGHT_BROWSERS_PATH is expected here. */
  env: Record<string, string>
  mode: PlaywrightConnectionMode
  /** Required when mode is `cdp`: endpoint of the user-started browser. */
  cdpEndpoint: string
  headless: boolean
  browserChannel: 'chrome' | 'msedge'
  executablePath: string
  allowedHosts: string[]
  allowedOrigins: string[]
  blockedOrigins: string[]
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /**
   * Dual-owner mode: the host starts the persistent Chromium and the MCP
   * child connects over `--cdp-endpoint`; the returned browser exposes the
   * `context` handle for the live view. False (default) keeps the plain
   * child-launched browser with no live view.
   */
  liveView?: boolean
}

export interface SessionBrowser {
  readonly sessionId: string
  /** Durable per-session profile directory (user-data-dir). */
  readonly profileDir: string
  /** Per-session output directory (screenshots, saved files). */
  readonly outputDir: string
  /** Forward one raw MCP tool call to this session's browser. */
  call(rawName: string, args: unknown, signal?: AbortSignal): Promise<SessionBrowserResult>
  /** Close the browser (equivalent to the browser_close tool). */
  close(): Promise<void>
  /** Close the browser and terminate the child process. */
  dispose(): Promise<void>
  /** The host-owned persistent context (liveView mode only). */
  readonly context?: BrowserContext | null
}

export interface SessionBrowserResult {
  content: unknown[]
  isError: boolean
}

const STDERR_CAPTURE_LIMIT = 8192
/** Wait for the DevToolsActivePort file after launching Chromium. */
const CDP_PORT_FILE_TIMEOUT_MS = 15_000

/** The file Chromium writes with its --remote-debugging-port=0 choice. */
function cdpPortFile(profileDir: string): string {
  return join(profileDir, 'DevToolsActivePort')
}

/** Read the ephemeral CDP endpoint Chromium chose (DevToolsActivePort:
 *  first line = port, second line = browser websocket path). */
export function readCdpEndpoint(profileDir: string): string {
  const lines = readFileSync(cdpPortFile(profileDir), 'utf8').trim().split('\n')
  const port = Number.parseInt(lines[0] ?? '', 10)
  if (!Number.isFinite(port) || port <= 0) throw new Error(`unreadable DevToolsActivePort: ${lines.join(' | ').slice(0, 80)}`)
  const wsPath = (lines[1] ?? '').trim()
  return `ws://127.0.0.1:${port}${wsPath === '' ? '' : wsPath}`
}

/** Poll for the CDP port file with a bounded wait. */
export async function waitForCdpEndpoint(profileDir: string, timeoutMs = CDP_PORT_FILE_TIMEOUT_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return readCdpEndpoint(profileDir)
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  throw new Error(`CDP port file did not appear within ${timeoutMs}ms` + (lastError !== undefined ? ` (${String(lastError)})` : ''))
}

/**
 * Build the `@playwright/mcp` arguments for one session browser.
 *
 * Pure so the three connection modes stay directly testable:
 * - `extension` attaches through the official extension (per-connection consent).
 * - `cdp` attaches to a browser the user started with remote debugging; no
 *   extension and no consent step, and the user's persistent profile keeps its
 *   logins (requires a non-default `--user-data-dir` since Chrome 136).
 * - `launch` starts its own browser: host-owned when `hostedEndpoint` is given
 *   (live view dual-owner), otherwise a per-session headless/headed Chrome.
 */
export function sessionBrowserArgs(
  options: SessionBrowserOptions,
  profileDir: string,
  outputDir: string,
  hostedEndpoint?: string,
): string[] {
  const args = [
    options.cliPath,
    '--allowed-hosts',
    options.allowedHosts.join(','),
    '--output-dir',
    outputDir,
  ]
  if (options.allowedOrigins.length > 0) args.push('--allowed-origins', options.allowedOrigins.join(';'))
  if (options.blockedOrigins.length > 0) args.push('--blocked-origins', options.blockedOrigins.join(';'))
  if (options.mode === 'extension') {
    // The official extension opens its own connection/approval page in the
    // selected Chrome profile and exposes only the tabs assigned to this MCP
    // client. The external browser remains owned by the user.
    args.push('--extension', '--browser', options.browserChannel)
    if (options.executablePath !== '') args.push('--executable-path', options.executablePath)
    return args
  }
  if (options.mode === 'cdp') {
    if (options.cdpEndpoint === '') throw new Error('playwright-sessions: mode "cdp" requires a cdpEndpoint (for example http://127.0.0.1:9222)')
    args.push('--cdp-endpoint', options.cdpEndpoint)
    return args
  }
  if (hostedEndpoint !== undefined) {
    args.push('--cdp-endpoint', hostedEndpoint)
    return args
  }
  if (options.headless) args.push('--headless')
  args.push('--user-data-dir', profileDir)
  return args
}

export async function createSessionBrowser(options: SessionBrowserOptions): Promise<SessionBrowser> {
  const profileDir = join(options.sessionsRoot, sanitizePlaywrightSessionKey(options.sessionId))
  const outputDir = join(profileDir, 'output')
  mkdirSync(outputDir, { recursive: true })

  // Dual-owner mode: the host owns the persistent Chromium, the MCP child
  // connects to it over the CDP endpoint. The context handle is kept for the
  // live-view screencast.
  let hostedContext: BrowserContext | null = null
  let hostedEndpoint: string | undefined
  if (options.mode === 'launch' && options.liveView === true) {
    hostedContext = await playwrightChromium.launchPersistentContext(profileDir, {
      headless: options.headless,
      args: ['--remote-debugging-port=0'],
      env: options.env,
    })
    hostedEndpoint = await waitForCdpEndpoint(profileDir)
  }
  const args = sessionBrowserArgs(options, profileDir, outputDir, hostedEndpoint)

  const childEnv = options.env

  let stderrCapture = ''
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: outputDir,
    env: childEnv,
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (stderrCapture.length < STDERR_CAPTURE_LIMIT) {
      stderrCapture = (stderrCapture + text).slice(-STDERR_CAPTURE_LIMIT)
    }
  })

  const client = new Client({ name: 'dsh-playwright-sessions', version: '1.0.0' })
  let closed = false
  let closePromise: Promise<void> | undefined

  const markClosed = () => {
    closed = true
  }
  client.onclose = markClosed

  try {
    await client.connect(transport)
  } catch (error) {
    if (hostedContext !== null) {
      try { await hostedContext.close() } catch { /* ignore */ }
      hostedContext = null
    }
    void transport.close().catch(() => {})
    throw new Error(
      `playwright-sessions: failed to start browser for session ${options.sessionId}: ${String(error)}` +
        (stderrCapture ? ` (child stderr: ${stderrCapture.slice(-2000)})` : ''),
    )
  }

  const ensureOpen = (): void => {
    if (closed) {
      throw new Error(
        `playwright-sessions: browser for session ${options.sessionId} is closed` +
          (stderrCapture ? ` (last child stderr: ${stderrCapture.slice(-1000)})` : ''),
      )
    }
  }

  const shutdown = async (): Promise<void> => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      try {
        await client.close()
      } catch {
        // Transport may already be gone; nothing left to do.
      }
      if (hostedContext !== null) {
        try { await hostedContext.close() } catch { /* ignore */ }
        hostedContext = null
      }
      closed = true
    })()
    return closePromise
  }

  return {
    sessionId: options.sessionId,
    profileDir,
    outputDir,
    context: hostedContext,
    async call(rawName, args, signal) {
      ensureOpen()
      const result = await client.callTool(
        { name: rawName, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { signal, timeout: options.toolCallTimeoutMs },
      )
      if (result.isError === true) {
        throw new Error(extractText(result.content as unknown[] | undefined, rawName))
      }
      return { content: (result.content ?? []) as unknown[], isError: false }
    },
    close: shutdown,
    dispose: shutdown,
  }
}

/** Best-effort text rendering of an MCP content array for error paths. */
export function extractText(content: unknown[] | undefined, rawName: string): string {
  const blocks = Array.isArray(content) ? content : []
  const texts: string[] = []
  for (const block of blocks) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') texts.push(text)
    }
  }
  if (texts.length > 0) return texts.join('\n')
  return blocks.length > 0 ? JSON.stringify(blocks) : `${rawName} returned no text content`
}