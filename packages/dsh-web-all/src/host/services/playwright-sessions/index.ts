/** Per-session isolated Playwright MCP service domain. */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { convertPlaywrightInputSchema } from '../../../core/playwright-sessions/schema.ts'
import { publicPlaywrightToolName } from '../../../core/playwright-sessions/names.ts'
import { PLAYWRIGHT_CLOSE_TOOL, playwrightSessionId, playwrightToolNeedsApproval, resolvePlaywrightSessionsConfig, UNSCOPED_PLAYWRIGHT_SESSION, type PlaywrightSessionsConfig, type PlaywrightToolContract } from '../../../core/playwright-sessions/contracts.ts'
import { createSessionBrowser, extractText } from './child.ts'
import { SessionBrowserManager } from './manager.ts'
import { PlaywrightSessionsController } from './controller.ts'
import { registerPlaywrightControlRoutes } from './routes.ts'
import { registerLiveViewUpgrade } from './live-view.ts'
import { abortable } from '../lifecycle.ts'
import { registerAsyncResources } from '../resources.ts'
import { pruneStaleProfiles, removeProfileDir } from './profile-gc.ts'

function cliPath(require: NodeRequire): string {
  const manifestPath = require.resolve('@playwright/mcp/package.json')
  const manifest = require(manifestPath) as { bin?: string | Record<string, string> }
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['playwright-mcp'] ?? 'cli.js'
  return join(dirname(manifestPath), relative)
}
function sessionsRoot(configured?: string): string { return resolve(configured ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'playwright-sessions')) }
function browsersPath(): string { return join(homedir(), '.cache', 'ms-playwright') }
async function enumerate(require: NodeRequire): Promise<PlaywrightToolContract[]> {
  const bundle = require(require.resolve('playwright-core/lib/coreBundle')) as { tools?: { resolveCLIConfigForMCP?: (options: unknown) => unknown | Promise<unknown>; filteredTools?: (config: unknown) => Array<{ schema?: { name?: unknown; title?: unknown; description?: unknown; inputSchema?: unknown; type?: unknown } }> } }
  if (!bundle.tools?.resolveCLIConfigForMCP || !bundle.tools.filteredTools) throw new Error('playwright-core tools API is unavailable')
  const config = await bundle.tools.resolveCLIConfigForMCP({ headless: true, allowedHosts: ['*'] })
  return bundle.tools.filteredTools(config).flatMap(item => typeof item.schema?.name === 'string' ? [{ name: item.schema.name, title: typeof item.schema.title === 'string' ? item.schema.title : item.schema.name, description: typeof item.schema.description === 'string' ? item.schema.description : '', inputSchema: item.schema.inputSchema, type: typeof item.schema.type === 'string' ? item.schema.type : undefined }] : [])
}
function output(rawName: string): ToolDefinition['output'] {
  return { schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false }, render(_args, value) { return [{ type: 'text', text: extractText((value as { content?: unknown[] })?.content, rawName) }] } }
}

export async function register(ctx: Context, input: PlaywrightSessionsConfig = {}, ownerSignal?: AbortSignal): Promise<() => Promise<void>> {
  const config = resolvePlaywrightSessionsConfig(input)
  if (config.mode === 'cdp' && config.cdpEndpoint === '') {
    throw new Error('playwright-sessions: mode "cdp" requires a cdpEndpoint (for example http://127.0.0.1:9222)')
  }
  const require = createRequire(import.meta.url)
  const root = sessionsRoot(config.sessionsRoot)
  mkdirSync(root, { recursive: true })
  let controller: PlaywrightSessionsController
  const manager = new SessionBrowserManager(sessionId => createSessionBrowser({
    cliPath: cliPath(require),
    sessionId,
    sessionsRoot: root,
    env: { ...scrubbedParentEnv(), PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? browsersPath() },
    mode: config.mode,
    cdpEndpoint: config.cdpEndpoint,
    headless: config.headless,
    browserChannel: config.browserChannel,
    executablePath: config.executablePath,
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    blockedOrigins: config.blockedOrigins,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    liveView: config.liveView,
  }), {
    idleTimeoutMs: config.idleTimeoutMs,
    maxConcurrentBrowsers: config.maxConcurrentBrowsers,
    onDispose: sessionId => {
      controller?.release(sessionId)
      if (config.mode === 'launch' && config.pruneProfileOnDispose) removeProfileDir(root, sessionId)
    },
  })
  const sessionExists = async (sessionId: string): Promise<boolean> => {
    try {
      const sessions = (ctx as unknown as { sessionController: { inspect(id: string): Promise<unknown> } }).sessionController
      await sessions.inspect(sessionId)
      return true
    } catch { return false }
  }
  return registerAsyncResources(async own => {
    own(() => manager.disposeAll())
    controller = new PlaywrightSessionsController({ config, manager, sessionExists })
    own(() => controller.dispose())
    own(registerPlaywrightControlRoutes(ctx, controller))
    // Agent-browser live view: a per-session WebSocket streaming CDP screencast
    // of the browser the MCP child drives. Only mounted when liveView is on;
    // the resolver reads the manager registry and never creates a browser.
    if (config.liveView) {
      own(registerLiveViewUpgrade(ctx, sessionId => manager.contextOf(sessionId)))
    }
    let tools = await abortable(enumerate(require), ownerSignal)
    if (!config.unsafeTools) tools = tools.filter(tool => tool.name !== 'browser_run_code_unsafe')
    ownerSignal?.throwIfAborted()
    if (tools.length === 0) throw new Error('playwright-sessions: bundled tool list is empty')
    try {
      for (const tool of tools) {
        ownerSignal?.throwIfAborted()
        own(ctx.tools.register({
          name: publicPlaywrightToolName(tool.name),
          description: tool.description || tool.title,
          parameters: convertPlaywrightInputSchema(tool.inputSchema),
          output: output(tool.name),
          execute: async (args, exec) => {
            const id = playwrightSessionId(exec)
            if (config.mode === 'extension') {
              if (id === UNSCOPED_PLAYWRIGHT_SESSION) throw new Error('local Chrome requires a scoped DSH session')
              controller.requireOwner(id)
            }
            const browser = await manager.get(id)
            try {
              const result = await browser.call(tool.name, args ?? {}, exec.signal)
              return { content: result.content }
            } finally {
              if (tool.name === PLAYWRIGHT_CLOSE_TOOL) await manager.dispose(id)
            }
          },
        } satisfies ToolDefinition))
      }
    } catch (error) {
      throw new Error(`playwright-sessions tool registration failed; remove the global mcp-playwright row: ${String(error)}`, { cause: error })
    }
    const toolContracts = new Map(tools.map(tool => [publicPlaywrightToolName(tool.name), tool] as const))
    const disposePolicy = config.mode === 'extension'
      ? ctx.on('tools/pre-execute', async (exec, next) => {
          const tool = toolContracts.get(exec.name)
          if (tool === undefined) return next()
          const id = playwrightSessionId(exec)
          if (id === UNSCOPED_PLAYWRIGHT_SESSION) return { kind: 'deny', reason: 'local Chrome requires a scoped DSH session' }
          try { controller.requireOwner(id) } catch (error) { return { kind: 'deny', reason: error instanceof Error ? error.message : String(error) } }
          if (playwrightToolNeedsApproval(tool.name, config.approvalPolicy)) {
            return { kind: 'ask', reason: `This action (${tool.title || tool.name}) will operate tabs in your logged-in Chrome.` }
          }
          return next()
        })
      : () => {}
    own(disposePolicy)
    own((ctx as unknown as { on(event: string, listener: (...args: unknown[]) => void): () => void }).on('workspace/session-stop', (...args: unknown[]) => {
      const payload = args[0] as { sessionId?: unknown } | undefined
      if (typeof payload?.sessionId === 'string') void manager.dispose(payload.sessionId)
    }))
    const sweep = (): void => { if (config.mode === 'launch' && config.profileTtlMs > 0) pruneStaleProfiles({ sessionsRoot: root, maxAgeMs: config.profileTtlMs, keepSessionIds: manager.ids() }) }
    sweep()
    const timer = config.profileTtlMs > 0 && config.profileSweepIntervalMs > 0 ? setInterval(sweep, config.profileSweepIntervalMs) : undefined
    timer?.unref()
    if (timer) own(() => { clearInterval(timer) })
    ownerSignal?.throwIfAborted()
  })
}

export { SessionBrowserManager } from './manager.ts'
export { createSessionBrowser } from './child.ts'
