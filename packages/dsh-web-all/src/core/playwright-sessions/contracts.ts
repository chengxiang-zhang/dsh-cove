/** Pure contracts and defaults for the per-session Playwright capability. */

export type PlaywrightConnectionMode = 'launch' | 'extension'
export type PlaywrightApprovalPolicy = 'never' | 'unsafe' | 'mutations'

export interface PlaywrightSessionsConfig {
  /** Start an isolated browser, or attach to selected tabs in the user's Chrome through the official extension. */
  mode?: PlaywrightConnectionMode
  headless?: boolean
  /** Chrome/Edge channel used by extension mode. */
  browserChannel?: 'chrome' | 'msedge'
  /** Optional browser executable override used by extension mode. */
  executablePath?: string
  allowedHosts?: string[]
  /** Browser request allowlist passed to Playwright MCP (defense in depth, not an authorization boundary). */
  allowedOrigins?: string[]
  /** Browser request blocklist, evaluated before allowedOrigins. */
  blockedOrigins?: string[]
  /** Ask through the DSH approval seam before risky browser tools. */
  approvalPolicy?: PlaywrightApprovalPolicy
  /** Expose browser_run_code_unsafe. Defaults off in extension mode and on in launch mode. */
  unsafeTools?: boolean
  sessionsRoot?: string
  toolCallTimeoutMs?: number
  idleTimeoutMs?: number
  maxConcurrentBrowsers?: number
  pruneProfileOnDispose?: boolean
  profileTtlMs?: number
  profileSweepIntervalMs?: number
  /**
   * Enable the agent-browser live view for launch mode: the host starts the
   * persistent Chromium (dual-owner; the MCP child connects over
   * --cdp-endpoint) and serves the screencast. Extension mode uses the visible
   * Chrome window itself and therefore does not expose a duplicate screencast.
   */
  liveView?: boolean
}

export interface ResolvedPlaywrightSessionsConfig {
  mode: PlaywrightConnectionMode
  headless: boolean
  browserChannel: 'chrome' | 'msedge'
  executablePath: string
  allowedHosts: string[]
  allowedOrigins: string[]
  blockedOrigins: string[]
  approvalPolicy: PlaywrightApprovalPolicy
  unsafeTools: boolean
  sessionsRoot?: string
  toolCallTimeoutMs: number
  idleTimeoutMs: number
  maxConcurrentBrowsers: number
  pruneProfileOnDispose: boolean
  profileTtlMs: number
  profileSweepIntervalMs: number
  liveView: boolean
}

export interface PlaywrightToolContract {
  name: string
  title: string
  description: string
  inputSchema: unknown
  type?: string
}
export const PLAYWRIGHT_CLOSE_TOOL = 'browser_close'
export const UNSCOPED_PLAYWRIGHT_SESSION = 'unscoped'

export const PLAYWRIGHT_SESSIONS_DEFAULTS = Object.freeze({
  mode: 'launch' as PlaywrightConnectionMode,
  headless: true,
  browserChannel: 'chrome' as const,
  executablePath: '',
  allowedHosts: ['*'] as string[],
  allowedOrigins: [] as string[],
  blockedOrigins: [] as string[],
  approvalPolicy: 'unsafe' as PlaywrightApprovalPolicy,
  toolCallTimeoutMs: 120_000,
  idleTimeoutMs: 900_000,
  maxConcurrentBrowsers: 2,
  pruneProfileOnDispose: true,
  profileTtlMs: 86_400_000,
  profileSweepIntervalMs: 3_600_000,
  liveView: false,
})

/** Apply compatibility defaults while keeping caller arrays isolated. */
export function resolvePlaywrightSessionsConfig(
  config: PlaywrightSessionsConfig = {},
): ResolvedPlaywrightSessionsConfig {
  const mode = config.mode ?? PLAYWRIGHT_SESSIONS_DEFAULTS.mode
  const liveView = mode === 'launch' && (config.liveView ?? PLAYWRIGHT_SESSIONS_DEFAULTS.liveView)
  return {
    mode,
    headless: config.headless ?? PLAYWRIGHT_SESSIONS_DEFAULTS.headless,
    browserChannel: config.browserChannel ?? PLAYWRIGHT_SESSIONS_DEFAULTS.browserChannel,
    executablePath: config.executablePath ?? PLAYWRIGHT_SESSIONS_DEFAULTS.executablePath,
    allowedHosts: [...(config.allowedHosts ?? PLAYWRIGHT_SESSIONS_DEFAULTS.allowedHosts)],
    allowedOrigins: [...(config.allowedOrigins ?? PLAYWRIGHT_SESSIONS_DEFAULTS.allowedOrigins)],
    blockedOrigins: [...(config.blockedOrigins ?? PLAYWRIGHT_SESSIONS_DEFAULTS.blockedOrigins)],
    approvalPolicy: config.approvalPolicy ?? (mode === 'extension' ? 'mutations' : PLAYWRIGHT_SESSIONS_DEFAULTS.approvalPolicy),
    unsafeTools: config.unsafeTools ?? mode === 'launch',
    sessionsRoot: config.sessionsRoot,
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? PLAYWRIGHT_SESSIONS_DEFAULTS.toolCallTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs ?? PLAYWRIGHT_SESSIONS_DEFAULTS.idleTimeoutMs,
    maxConcurrentBrowsers: mode === 'extension' ? 1 : config.maxConcurrentBrowsers ?? PLAYWRIGHT_SESSIONS_DEFAULTS.maxConcurrentBrowsers,
    pruneProfileOnDispose: config.pruneProfileOnDispose ?? PLAYWRIGHT_SESSIONS_DEFAULTS.pruneProfileOnDispose,
    profileTtlMs: config.profileTtlMs ?? PLAYWRIGHT_SESSIONS_DEFAULTS.profileTtlMs,
    profileSweepIntervalMs: config.profileSweepIntervalMs ?? PLAYWRIGHT_SESSIONS_DEFAULTS.profileSweepIntervalMs,
    liveView,
  }
}

const READ_ONLY_PLAYWRIGHT_TOOLS = new Set([
  'browser_console_messages', 'browser_find', 'browser_network_request',
  'browser_network_requests', 'browser_snapshot', 'browser_take_screenshot',
])
const UNSAFE_PLAYWRIGHT_TOOLS = new Set(['browser_evaluate', 'browser_run_code_unsafe'])

export function playwrightToolRisk(rawName: string): 'read' | 'mutation' | 'unsafe' {
  if (UNSAFE_PLAYWRIGHT_TOOLS.has(rawName)) return 'unsafe'
  if (READ_ONLY_PLAYWRIGHT_TOOLS.has(rawName)) return 'read'
  return 'mutation'
}

export function playwrightToolNeedsApproval(rawName: string, policy: PlaywrightApprovalPolicy): boolean {
  if (policy === 'never') return false
  const risk = playwrightToolRisk(rawName)
  return risk === 'unsafe' || (policy === 'mutations' && risk === 'mutation')
}

/** Extract the durable DSH session identity without depending on host SDK types. */
export function playwrightSessionId(exec: { agent?: { session?: { id?: unknown } } }): string {
  const id = exec.agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : UNSCOPED_PLAYWRIGHT_SESSION
}
