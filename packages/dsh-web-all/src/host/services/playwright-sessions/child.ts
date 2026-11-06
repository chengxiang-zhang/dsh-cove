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
 * In `cdp` mode the child is pointed at a browser the operator already
 * started with remote debugging (`--cdp-endpoint`): it attaches to that
 * browser and drives its tabs, so the windows and logins being operated are
 * the operator's own. No browser is launched in that mode.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
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
}

export interface SessionBrowserResult {
  content: unknown[]
  isError: boolean
}

const STDERR_CAPTURE_LIMIT = 8192

/**
 * Build the `@playwright/mcp` arguments for one session browser.
 *
 * Pure so the three connection modes stay directly testable:
 * - `extension` attaches through the official extension (per-connection consent).
 * - `cdp` attaches to a browser the user started with remote debugging; no
 *   extension and no consent step, and the user's persistent profile keeps its
 *   logins (requires a non-default `--user-data-dir` since Chrome 136).
 * - `launch` starts its own per-session headless/headed Chrome.
 */
export function sessionBrowserArgs(
  options: SessionBrowserOptions,
  profileDir: string,
  outputDir: string,
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
  if (options.headless) args.push('--headless')
  args.push('--user-data-dir', profileDir)
  return args
}

export async function createSessionBrowser(options: SessionBrowserOptions): Promise<SessionBrowser> {
  const profileDir = join(options.sessionsRoot, sanitizePlaywrightSessionKey(options.sessionId))
  const outputDir = join(profileDir, 'output')
  mkdirSync(outputDir, { recursive: true })

  const args = sessionBrowserArgs(options, profileDir, outputDir)

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
      closed = true
    })()
    return closePromise
  }

  return {
    sessionId: options.sessionId,
    profileDir,
    outputDir,
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