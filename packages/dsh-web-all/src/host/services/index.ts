/** Host service-domain assembly for the sole web-all Cordis entity. */
import type { Context } from '@deepseek-ai/cordis'
import * as accessTrust from './access-trust/index.ts'
import * as remoteAccess from './remote-access/index.ts'
import * as ssh from './ssh/index.ts'
import * as memoir from './memoir/index.ts'
import * as worktree from './worktree/index.ts'
import * as gitGraph from './git-graph/index.ts'
import * as rightPane from './right-pane/index.ts'
import * as larkInbox from './lark-inbox/index.ts'
import * as notify from './notify/index.ts'
import * as playwrightSessions from './playwright-sessions/index.ts'
import * as remoteWebUi from './remote-web-ui/index.ts'
import * as codexBridge from './codex-bridge/index.ts'
import * as noBrowserAuth from './no-browser-auth/index.ts'
import * as webRender from './web-render/index.ts'
import * as webSearchAnthropic from './web-search-anthropic/index.ts'
import * as scheduleMode from './schedule-mode/index.ts'
import { createServiceLifecycleOwner, type ServiceRegistrationDiagnostic } from './lifecycle.ts'

export interface ServiceAssemblyDeps {
  dshHome?: string
  agentsHome?: string
  codexProxyDir?: string
  noBrowserAuth?: boolean
  worktree?: import('./worktree/index.ts').WorktreeServiceConfig
  /** Playwright sessions options; `liveView` toggles the agent-browser live view. */
  playwright?: import('../../core/playwright-sessions/contracts.ts').PlaywrightSessionsConfig
  /** Structured registration/disposal diagnostics, primarily for tests. */
  onDiagnostic?: (diagnostic: ServiceRegistrationDiagnostic) => void
}

function warn(ctx: Context, diagnostic: ServiceRegistrationDiagnostic): void {
  const text = `[web-all:services] ${diagnostic.service} ${diagnostic.phase} failed: ${diagnostic.message}`
  try { ctx.logger('web-all:services').warn(text) } catch { console.warn(text, diagnostic.error) }
}

/**
 * Mount every service domain beneath one owner. Synchronous failures remain
 * tolerant and observable; asynchronous registration is tracked, aborted and
 * awaited during unload so no disposer can arrive after the owner disappeared.
 */
export function assembleServices(ctx: Context, deps: ServiceAssemblyDeps = {}): () => Promise<void> {
  const owner = createServiceLifecycleOwner({
    onDiagnostic: diagnostic => {
      warn(ctx, diagnostic)
      deps.onDiagnostic?.(diagnostic)
    },
  })
  const mount = (name: string, register: () => () => void | Promise<void>): void => owner.mount(name, register)

  // The admission decision every privileged host route family consults. Mount
  // it first: the families resolve it lazily, but an earlier mount keeps the
  // service present for the whole lifetime of the assembly.
  mount('access-trust', () => accessTrust.register(ctx))
  // Host ownership + plain-HTTP boot shims for the reverse-proxied entry.
  // Mounted right after the fence it consults, before any route family.
  mount('remote-access', () => remoteAccess.register(ctx))
  mount('ssh', () => ssh.register(ctx))
  mount('memoir', () => memoir.register(ctx))
  mount('worktree', () => worktree.register(ctx, deps.worktree))
  mount('git-graph', () => gitGraph.register(ctx))
  mount('right-pane', () => rightPane.register(ctx))
  mount('lark-inbox', () => larkInbox.register(ctx))
  // Mounted straight after the inbox because it is the same integration's
  // outbound half and borrows its credentials when it has none of its own.
  // It only subscribes and serves one read route, so it consults the fence
  // rather than depending on any other family.
  mount('notify', () => notify.register(ctx))
  mount('codex-bridge', () => codexBridge.register(ctx, {
    proxyDir: deps.codexProxyDir ?? process.env.DSH_CODEX_PROXY_DIR,
    logger: { warn: error => console.warn('[web-all:codex-bridge]', error) },
  }))
  // The legacy bypass and integrated WebAuth both patch the private BrowserAuth
  // object. Never stack them: an explicit bypass is the legacy compatibility
  // mode, otherwise remote-web-ui owns the composed account session.
  if (deps.noBrowserAuth === true) {
    mount('no-browser-auth', () => noBrowserAuth.register(ctx, { enabled: true }))
  } else {
    mount('remote-web-ui', () => remoteWebUi.register(ctx))
  }
  mount('web-render', () => webRender.register(ctx, { dshHome: deps.dshHome }))
  // Mounted next to web-render: both register providers into `ctx.web` and are
  // pinned by the using profile's cordis.patch.yml, under the same
  // MISSING/UNAVAILABLE selection rules.
  mount('web-search-anthropic', () => webSearchAnthropic.register(ctx))
  mount('schedule-mode', () => scheduleMode.register(ctx))

  owner.track('playwright-sessions', playwrightSessions.register(ctx, deps.playwright ?? {}, owner.signal))
  return owner.dispose
}

export { createServiceLifecycleOwner } from './lifecycle.ts'
export type { ServiceLifecycleOwner, ServiceRegistrationDiagnostic } from './lifecycle.ts'
