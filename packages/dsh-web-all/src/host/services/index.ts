/** Host service-domain assembly for the sole web-all Cordis entity. */
import type { Context } from '@deepseek-ai/cordis'
import * as accessTrust from './access-trust/index.ts'
import * as remoteAccess from './remote-access/index.ts'
import * as memoryView from './memory-view/index.ts'
import * as ssh from './ssh/index.ts'
import * as worktree from './worktree/index.ts'
import * as gitGraph from './git-graph/index.ts'
import * as rightPane from './right-pane/index.ts'
import * as feishu from './feishu/index.ts'
import * as superagent from './superagent/index.ts'
import * as notify from './notify/index.ts'
import * as playwrightSessions from './playwright-sessions/index.ts'
import * as noBrowserAuth from './no-browser-auth/index.ts'
import * as webRender from './web-render/index.ts'
import * as webSearchAnthropic from './web-search-anthropic/index.ts'
import * as scheduleMode from './schedule-mode/index.ts'
import * as externalSession from './external-session/index.ts'
import { createServiceLifecycleOwner, type ServiceRegistrationDiagnostic } from './lifecycle.ts'

export interface ServiceAssemblyDeps {
  dshHome?: string
  agentsHome?: string
  noBrowserAuth?: boolean
  worktree?: import('./worktree/index.ts').WorktreeServiceConfig
  /** Playwright sessions options; `liveView` toggles the agent-browser live view. */
  playwright?: import('../../core/playwright-sessions/contracts.ts').PlaywrightSessionsConfig
  /** External CLI session defaults (concurrency, retention, binary overrides). */
  externalSession?: import('./external-session/config.ts').ExternalSessionConfig
  /** Structured registration/disposal diagnostics, primarily for tests. */
  onDiagnostic?: (diagnostic: ServiceRegistrationDiagnostic) => void
  /**
   * Called with each domain name as it is mounted, in mount order.
   *
   * A successful mount otherwise leaves no trace: the owner keeps the domain
   * name only inside its disposer table, so a test cannot tell which names the
   * assembly actually used. Renaming a domain is a user-visible contract change
   * (the name is the row in the capability inventory), so the name has to be
   * observable without a registration failing first.
   */
  onMount?: (service: string) => void
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
  const mount = (name: string, register: () => () => void | Promise<void>): void => {
    deps.onMount?.(name)
    owner.mount(name, register)
  }

  // The admission decision every privileged host route family consults. Mount
  // it first: the families resolve it lazily, but an earlier mount keeps the
  // service present for the whole lifetime of the assembly.
  mount('access-trust', () => accessTrust.register(ctx))
  // Host ownership + plain-HTTP boot shims for the reverse-proxied entry.
  // Mounted right after the fence it consults, before any route family.
  mount('remote-access', () => remoteAccess.register(ctx))
  // Read-only OpenViking memory proxy for the sidebar panel; it keeps no store of its own.
  mount('memory-view', () => memoryView.register(ctx))
  mount('ssh', () => ssh.register(ctx))
  mount('worktree', () => worktree.register(ctx, deps.worktree))
  mount('git-graph', () => gitGraph.register(ctx))
  mount('right-pane', () => rightPane.register(ctx))
  // Mounted before the two Feishu consumers: it owns the one answer to "which
  // application is this host talking to", which they both resolve through.
  mount('feishu', () => feishu.register(ctx))
  // The superagent domain owns the Feishu channel (the former standalone inbox
  // domain) and will own the secretary modules beside it, so the assembly keeps
  // one row per capability while the inside stays modular.
  mount('superagent', () => superagent.register(ctx))
  // Mounted straight after the inbox because it is the same integration's
  // outbound half and borrows its credentials when it has none of its own.
  // It only subscribes and serves one read route, so it consults the fence
  // rather than depending on any other family.
  mount('notify', () => notify.register(ctx))
  // Network-gate mode patches the private BrowserAuth object so the Host/Origin
  // fence is the only admission rule. Without it, the native launch token and
  // cookie remain the gate; this plugin does not mint sessions of its own.
  if (deps.noBrowserAuth === true) {
    mount('no-browser-auth', () => noBrowserAuth.register(ctx, { enabled: true }))
  }
  mount('web-render', () => webRender.register(ctx, { dshHome: deps.dshHome }))
  // Mounted next to web-render: both register providers into `ctx.web` and are
  // pinned by the using profile's cordis.patch.yml, under the same
  // MISSING/UNAVAILABLE selection rules.
  mount('web-search-anthropic', () => webSearchAnthropic.register(ctx))
  mount('schedule-mode', () => scheduleMode.register(ctx))
  // External CLI sessions: the store, engine, panel data plane and the
  // model-facing delegation tools. This entity row registers the tools itself;
  // no preset-plane entry exists, so the module stays replaceable by the Loader.
  mount('external-session', () => externalSession.register(ctx, {
    config: deps.externalSession,
    dshHome: deps.dshHome,
  }))

  deps.onMount?.('playwright-sessions')
  owner.track('playwright-sessions', playwrightSessions.register(ctx, deps.playwright ?? {}, owner.signal))
  return owner.dispose
}

export { createServiceLifecycleOwner } from './lifecycle.ts'
export type { ServiceLifecycleOwner, ServiceRegistrationDiagnostic } from './lifecycle.ts'
