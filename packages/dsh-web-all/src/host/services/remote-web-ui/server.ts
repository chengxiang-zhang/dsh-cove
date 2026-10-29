/**
 * dsh-remote-web-ui — server-mode plugin entry (host half).
 *
 * Server mode replaces the QR pairing model: this plugin turns `dsh web`
 * into a deployable server on the LAN (and, with TLS configured, addressable
 * from anywhere) without ever trusting the SDK's /api transport fence to be
 * an authentication layer. The plugin owns ONE public listener — the
 * gateway (default 0.0.0.0:3082, optional built-in TLS) — in front of the
 * loopback webServer. Every request passes the account/session wall and the
 * role check, then the gateway re-issues it to 127.0.0.1 as a loopback-shaped
 * call (Host rewritten to loopback, same-origin marker, client cookies and
 * Origin stripped), so the full host surface — including the SDK's
 * loopback-pinned privileged methods — is reachable exactly as far as the
 * role policy allows.
 *
 * Loopback-only surfaces stay on the webServer (never reachable directly
 * from the LAN without the gateway): the /api/gateway admin surface
 * (accounts + sessions, first-admin bootstrap). The gateway proxies every
 * other path after the wall.
 */

import { join } from 'node:path'
import { setInterval as nodeSetInterval, setTimeout as nodeSetTimeout } from 'node:timers'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import { familyNamespace, onFamilyConfigChange, registerFamilyNamespace } from '../family-config.ts'
import { registerResources, type OwnResource } from '../resources.ts'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

import { AccountStore, randomSalt } from './server-mode/accounts.ts'
import {
  DEFAULT_IDLE_EXPIRE_MS,
  DEFAULT_MAX_AGE_MS,
  randomSessionId,
  SessionStore,
} from './server-mode/sessions.ts'
import {
  GATEWAY_API_PREFIX,
  isPreAuthGatewayPath,
  LoginLimiter,
  makeGatewayRequestHandler,
  type GatewayStatus,
} from './server-mode/gateway-routes.ts'
import { Gateway } from './server-mode/gateway.ts'
import { dshHome } from './server-mode/dsh-home.ts'
import { isLoopbackAdmin } from './server-mode/fence.ts'
import { claimPostureKey, postureTargets, probePosture, releasePostureKey } from './server-mode/posture.ts'
import { lanIPv4Addresses } from './server-mode/lan.ts'
import { SERVER_BOOT_SCRIPT } from './server-mode/server-boot.ts'
import { writeJson } from './server-mode/http.ts'
import {
  installIntegratedBrowserAuth,
  type BrowserConnectionLike,
} from './server-mode/integrated-auth.ts'
import { makeSetCookie, readCookie } from './server-mode/cookie.ts'
import {
  ExternalAuthService,
  externalAccountName,
  type FeishuProviderConfig,
  type OidcProviderConfig,
} from './server-mode/external-auth.ts'
import { safeLoginTarget } from './server-mode/integrated-auth.ts'

/** Stable cordis plugin name. */
/** Services required before the server-mode surfaces can mount. */
/**
 * Settings namespace of the remote-control capability — the section the web
 * settings surface edits. Spelled here rather than imported: the browser
 * half spells the same value and must not depend on a Host package.
 */
export const REMOTE_WEB_UI_SETTINGS_NAMESPACE = 'remote-web-ui'

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the authenticated remote Web surface. */
  enabled?: boolean
  /** Accept account sessions on DSH's own Web origin. */
  integratedAuthEnabled?: boolean
  /** Compatibility listener on serverHost:serverPort. Disabled by default. */
  legacyGatewayEnabled?: boolean
  /** Gateway listen host (default 0.0.0.0 — the only public listener). */
  serverHost?: string
  /** Gateway listen port (default 3082; 0 requests an OS-assigned port). */
  serverPort?: number
  /**
   * Optional built-in TLS: absolute path to the PEM certificate chain. Both
   * cert and key must be set for the gateway to serve https (Secure cookies
   * follow automatically). Paths are read at each listener (re)start.
   */
  serverTlsCert?: string
  /** Optional built-in TLS: absolute path to the PEM private key. */
  serverTlsKey?: string
  /** Session cookie name (default dsh_gw_session). */
  cookieName?: string
  /** Session idle expiry (default 7 days of inactivity). */
  idleExpireMs?: number
  /** Session absolute lifetime cap (default 30 days). */
  maxAgeMs?: number
  /** Account store file (default $DSH_HOME/remote-web-ui-accounts.json, 0600). */
  accountsFile?: string
  /** Session store file (default $DSH_HOME/remote-web-ui-sessions.json, 0600). */
  sessionsFile?: string
  /**
   * First-run bootstrap: when the account store is empty and both values are
   * set, an admin account is created at startup (used for unattended
   * deployments; the loopback admin surface can also create it manually).
   */
  bootstrapAdminUsername?: string
  /** Bootstrap admin password (min 8 characters). */
  bootstrapAdminPassword?: string
  /** Public HTTPS origin used to build OAuth/OIDC callbacks. */
  publicBaseUrl?: string
  /** Generic OIDC providers. */
  oidcProviders?: OidcProviderConfig[]
  /** Feishu/Lark web-login provider. */
  feishuAuth?: FeishuProviderConfig
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  integratedAuthEnabled: z.boolean().default(true),
  legacyGatewayEnabled: z.boolean().default(false),
  serverHost: z.string().min(1).default('0.0.0.0'),
  serverPort: z.number().step(1).min(0).max(65_535).default(3082),
  serverTlsCert: z.string(),
  // This is a filesystem path, not private-key content. Keep it readable so
  // settings round-trips do not erase a configured path behind secret redaction.
  serverTlsKey: z.string(),
  cookieName: z.string().min(1).default('dsh_gw_session'),
  idleExpireMs: z.number().step(1).min(60_000).default(DEFAULT_IDLE_EXPIRE_MS),
  maxAgeMs: z.number().step(1).min(60_000).default(DEFAULT_MAX_AGE_MS),
  accountsFile: z.string(),
  sessionsFile: z.string(),
  bootstrapAdminUsername: z.string(),
  bootstrapAdminPassword: z.string().role('secret'),
  publicBaseUrl: z.string(),
  oidcProviders: z.array(z.object({
    id: z.string(),
    label: z.string(),
    issuer: z.string(),
    clientId: z.string(),
    clientSecret: z.string().role('secret'),
    scopes: z.array(z.string()).default(['openid', 'profile', 'email']),
    allowedSubjects: z.array(z.string()).default([]),
    allowedEmailDomains: z.array(z.string()).default([]),
    defaultRole: z.union(['admin', 'user']).default('user'),
  })).default([]),
  feishuAuth: z.object({
    id: z.string().default('feishu'),
    label: z.string().default('飞书'),
    appId: z.string(),
    appSecret: z.string().role('secret'),
    authorizationUrl: z.string().default('https://accounts.feishu.cn/open-apis/authen/v1/authorize'),
    baseUrl: z.string().default('https://open.feishu.cn'),
    allowedOpenIds: z.array(z.string()).default([]),
    defaultRole: z.union(['admin', 'user']).default('user'),
  }),
}) as unknown as z<Config>

registerFamilyNamespace(REMOTE_WEB_UI_SETTINGS_NAMESPACE, Config)

/** Fully resolved configuration (every field concrete). */
interface ResolvedConfig {
  enabled: boolean
  integratedAuthEnabled: boolean
  legacyGatewayEnabled: boolean
  serverHost: string
  serverPort: number
  serverTlsCert?: string
  serverTlsKey?: string
  cookieName: string
  idleExpireMs: number
  maxAgeMs: number
  accountsFile: string
  sessionsFile: string
  bootstrapAdminUsername?: string
  bootstrapAdminPassword?: string
  publicBaseUrl?: string
  oidcProviders: OidcProviderConfig[]
  feishuAuth?: FeishuProviderConfig
}

/** The whole host-half behavior, factored for tests. */
export function registerServerMode(ctx: Context, config: Config = {}, env: { dshHome: string } = { dshHome: dshHome() }): () => void {
  return registerResources(own => registerOwnedServerMode(ctx, config, env, own))
}

function registerOwnedServerMode(ctx: Context, config: Config, env: { dshHome: string }, own: OwnResource<() => void>): void {
  let disposed = false
  own(() => { disposed = true })
  const home = env.dshHome
  const DEFAULTS: Omit<ResolvedConfig, 'serverTlsCert' | 'serverTlsKey' | 'bootstrapAdminUsername' | 'bootstrapAdminPassword' | 'publicBaseUrl' | 'feishuAuth'> = {
    enabled: true,
    integratedAuthEnabled: true,
    legacyGatewayEnabled: false,
    serverHost: '0.0.0.0',
    serverPort: 3082,
    cookieName: 'dsh_gw_session',
    idleExpireMs: DEFAULT_IDLE_EXPIRE_MS,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
    accountsFile: join(home, 'remote-web-ui-accounts.json'),
    sessionsFile: join(home, 'remote-web-ui-sessions.json'),
    oidcProviders: [],
  }

  // The live source the surfaces read: the settings section once the web
  // settings surface is served, the composition entry otherwise.
  let current: () => Config = () => config ?? {}
  const resolve = (): ResolvedConfig => {
    const value = current()
    return {
      enabled: value.enabled ?? DEFAULTS.enabled,
      integratedAuthEnabled: value.integratedAuthEnabled ?? DEFAULTS.integratedAuthEnabled,
      legacyGatewayEnabled: value.legacyGatewayEnabled ?? DEFAULTS.legacyGatewayEnabled,
      serverHost: value.serverHost ?? DEFAULTS.serverHost,
      serverPort: value.serverPort ?? DEFAULTS.serverPort,
      serverTlsCert: value.serverTlsCert,
      serverTlsKey: value.serverTlsKey,
      cookieName: value.cookieName ?? DEFAULTS.cookieName,
      idleExpireMs: value.idleExpireMs ?? DEFAULTS.idleExpireMs,
      maxAgeMs: value.maxAgeMs ?? DEFAULTS.maxAgeMs,
      accountsFile: value.accountsFile ?? DEFAULTS.accountsFile,
      sessionsFile: value.sessionsFile ?? DEFAULTS.sessionsFile,
      bootstrapAdminUsername: value.bootstrapAdminUsername,
      bootstrapAdminPassword: value.bootstrapAdminPassword,
      publicBaseUrl: value.publicBaseUrl,
      oidcProviders: value.oidcProviders ?? DEFAULTS.oidcProviders,
      feishuAuth: value.feishuAuth?.appId && value.feishuAuth.appSecret ? value.feishuAuth : undefined,
    }
  }

  // ── stores (rebuilt when a configured file path changes) ────────────────
  let accountsFile = ''
  let sessionsFile = ''
  let accounts = new AccountStore(DEFAULTS.accountsFile, { now: () => Date.now(), randomSalt })
  let sessions = new SessionStore(DEFAULTS.sessionsFile, { now: () => Date.now(), randomId: randomSessionId }, { idleExpireMs: DEFAULTS.idleExpireMs, maxAgeMs: DEFAULTS.maxAgeMs })
  let externalAuthKey = ''
  let externalAuth = new ExternalAuthService({})
  const limiter = new LoginLimiter()

  const ensureStores = (): void => {
    const value = resolve()
    if (value.accountsFile === accountsFile && value.sessionsFile === sessionsFile) return
    accountsFile = value.accountsFile
    sessionsFile = value.sessionsFile
    const now = () => Date.now()
    accounts = new AccountStore(accountsFile, { now, randomSalt })
    sessions = new SessionStore(sessionsFile, { now, randomId: randomSessionId }, { idleExpireMs: value.idleExpireMs, maxAgeMs: value.maxAgeMs })
    sessions.bindAccounts(accounts)
  }

  sessions.bindAccounts(accounts)

  const ensureExternalAuth = (): ExternalAuthService => {
    const value = resolve()
    const key = JSON.stringify({ oidc: value.oidcProviders, feishu: value.feishuAuth })
    if (key !== externalAuthKey) {
      externalAuthKey = key
      externalAuth = new ExternalAuthService({ oidc: value.oidcProviders, feishu: value.feishuAuth })
    }
    return externalAuth
  }

  // Compose the account session into DSH's own BrowserAuth. Connection keeps
  // owning Host/Origin trust and the launch-token break-glass flow; its native
  // index, HTTP RPC and /api/remote.mux paths all consult these methods.
  const connection = (ctx as Context & { connection?: BrowserConnectionLike }).connection
    ?? (ctx as Context & { get?: (id: string, strict?: boolean) => unknown }).get?.call(ctx, 'connection', false) as BrowserConnectionLike | undefined
  if (connection === undefined) throw new Error('remote-web-ui: connection service unavailable for integrated WebAuth')
  own(installIntegratedBrowserAuth(connection, {
    enabled: () => resolve().enabled && resolve().integratedAuthEnabled,
    hasSession: (request) => {
      ensureStores()
      const sessionId = readCookie(request.headers.cookie, resolve().cookieName)
      try { return sessionId !== undefined && sessions.touch(sessionId) !== undefined } catch { return false }
    },
  }))

  // ── first-run bootstrap ─────────────────────────────────────────────────
  const applyBootstrap = (): void => {
    const value = resolve()
    if (
      accounts.canBootstrap()
      && value.bootstrapAdminUsername !== undefined
      && value.bootstrapAdminPassword !== undefined
      && value.bootstrapAdminPassword.length >= 8
    ) {
      accounts.create(value.bootstrapAdminUsername, value.bootstrapAdminPassword, 'admin')
      console.log(`remote-web-ui: bootstrapped the first admin account "${value.bootstrapAdminUsername}"`)
    }
  }

  // ── gateway lifecycle ───────────────────────────────────────────────────
  const webServerPort = ctx.webServer.port
  const tlsConfiguredOf = (value: ResolvedConfig): boolean =>
    value.serverTlsCert !== undefined && value.serverTlsCert !== ''
    && value.serverTlsKey !== undefined && value.serverTlsKey !== ''

  const buildStatus = (): GatewayStatus => {
    const value = resolve()
    return {
      loginRequired: true,
      cookieName: value.cookieName,
      tls: false,
      noAccounts: accounts.isEmpty(),
      port: value.serverPort,
      host: value.serverHost,
      secure: tlsConfiguredOf(value),
    }
  }
  let status: GatewayStatus = buildStatus()
  let gateway: Gateway | undefined
  let gatewayKey = ''
  let gatewayTail: Promise<void> = Promise.resolve()
  own(() => {
    disposed = true
    // Drain already queued starts too: an in-flight start may not yet have
    // published its Gateway into `gateway` when synchronous rollback runs.
    gatewayTail = gatewayTail.catch(() => {}).then(async () => {
      const old = gateway
      gateway = undefined
      if (old !== undefined) await old.close()
    })
    void gatewayTail.catch(error => { console.error('remote-web-ui: gateway cleanup failed:', error) })
  })
  let noAccountsLogged = false

  const sessionRoutes = (): ReturnType<typeof makeGatewayRequestHandler> => {
    const value = resolve()
    ensureStores()
    return makeGatewayRequestHandler('session', {
      accounts,
      sessions,
      cookieName: value.cookieName,
      secure: tlsConfiguredOf(value),
      limiter,
      status,
      onAccountsChanged: applyGateway,
    })
  }
  const loopbackRoutes = (): ReturnType<typeof makeGatewayRequestHandler> => {
    ensureStores()
    return makeGatewayRequestHandler('loopback', {
      accounts,
      sessions,
      cookieName: resolve().cookieName,
      secure: false,
      limiter,
      status,
      onAccountsChanged: applyGateway,
    })
  }

  /** (Re)apply the listener after config/store changes. Serialized. */
  const applyGateway = (): void => {
    if (disposed) return
    const value = resolve()
    const tlsOn = tlsConfiguredOf(value)
    const key = `${value.serverHost}|${value.serverPort}|${tlsOn}|${value.cookieName}|${value.accountsFile}|${value.sessionsFile}`
    gatewayTail = gatewayTail.then(async () => {
      if (disposed) return
      const shouldRun = resolve().enabled && resolve().legacyGatewayEnabled && !accounts.isEmpty()
      if (gateway !== undefined && (!shouldRun || key !== gatewayKey)) {
        const old = gateway
        gateway = undefined
        gatewayKey = ''
        await old.close()
      }
      if (disposed) return
      if (shouldRun && gateway === undefined) {
        const next = new Gateway({
          host: value.serverHost,
          port: value.serverPort,
          tlsCert: tlsOn ? value.serverTlsCert : undefined,
          tlsKey: tlsOn ? value.serverTlsKey : undefined,
          upstreamPort: webServerPort,
          cookieName: value.cookieName,
          routes: sessionRoutes(),
          // Integrated WebAuth owns login/session on the DSH origin. The legacy
          // listener stays a pure transport for those paths so the login page,
          // provider list and cookies always describe the real browser origin.
          proxyAuthRoutes: value.integratedAuthEnabled,
        }, sessions)
        try {
          await next.start()
          if (disposed) {
            await next.close()
            return
          }
          gateway = next
          gatewayKey = key
          console.log(`remote-web-ui: gateway listening on ${tlsOn ? 'https' : 'http'}://${value.serverHost}:${String(next.port)}${tlsOn ? ' (TLS)' : ' — WARNING: no TLS, plaintext LAN session'}`)
          const scheme = next.secure ? 'https' : 'http'
          const urls = lanIPv4Addresses().map(ip => `${scheme}://${ip}:${String(next.port)}/`).join(' , ')
          console.log(`remote-web-ui: server reachable on the LAN at ${urls}`)
          status.noAccounts = false
        } catch (error) {
          // start() may already have allocated its server before rejecting.
          await next.close().catch(cleanupError => { console.error('remote-web-ui: failed gateway cleanup:', cleanupError) })
          console.error(`remote-web-ui: gateway failed to start on ${value.serverHost}:${String(value.serverPort)}:`, error)
        }
      }
      // Refresh the status probe the admin surface and boot redirect read.
      status = buildStatus()
      if (gateway !== undefined) status.secure = gateway.secure
      const empty = accounts.isEmpty()
      status.noAccounts = empty
      if (empty && resolve().enabled && (resolve().integratedAuthEnabled || resolve().legacyGatewayEnabled) && !noAccountsLogged) {
        noAccountsLogged = true
        console.error('remote-web-ui: FAIL-CLOSED — no accounts exist, the gateway is held. Create the first admin account at http://127.0.0.1:3080/api/gateway/accounts (loopback only) or set bootstrapAdminUsername/bootstrapAdminPassword in the plugin config.')
      }
    })
  }

  const requestOrigin = (request: IncomingMessage): string => {
    const configured = resolve().publicBaseUrl
    if (configured !== undefined && configured !== '') return new URL(configured).origin
    const host = request.headers.host
    if (typeof host !== 'string' || host === '') throw new Error('missing request Host')
    const forwarded = request.headers['x-forwarded-proto']
    const protocol = typeof forwarded === 'string' && forwarded.split(',')[0].trim() === 'https' ? 'https' : 'http'
    return `${protocol}://${host}`
  }

  const externalAuthHandler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? '/', 'http://dsh.invalid')
      const match = /^\/auth\/([a-z][a-z0-9-]{1,31})\/(start|callback)$/.exec(url.pathname)
      if (request.method !== 'GET' || match === null) {
        response.writeHead(404); response.end(); return
      }
      const providerId = match[1]
      const action = match[2]
      const callback = `${requestOrigin(request)}/auth/${providerId}/callback`
      if (action === 'start') {
        const next = safeLoginTarget(url.searchParams.get('next') ?? '/')
        const target = await ensureExternalAuth().begin(providerId, callback, next)
        response.writeHead(302, { location: target.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        response.end()
        return
      }
      if (url.searchParams.get('error') !== null) throw new Error('external authorization was declined')
      const code = url.searchParams.get('code')
      const stateValue = url.searchParams.get('state')
      if (code === null || stateValue === null) throw new Error('authorization callback is missing code or state')
      const result = await ensureExternalAuth().callback(providerId, callback, code, stateValue)
      ensureStores()
      const username = externalAccountName(result.principal)
      const account = accounts.ensureExternal(username, result.principal.role)
      if (!account.enabled) throw new Error('external account is disabled')
      const session = sessions.issue(username, account.role, { userAgent: request.headers['user-agent'], ip: request.socket.remoteAddress })
      response.writeHead(303, {
        location: safeLoginTarget(result.next),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'set-cookie': makeSetCookie(resolve().cookieName, session.id, { secure: requestOrigin(request).startsWith('https:'), maxAgeSeconds: Math.floor(resolve().maxAgeMs / 1000) }),
      })
      response.end()
    } catch (error) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录失败</title><main><h1>登录失败</h1><p>${String(error instanceof Error ? error.message : error).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character))}</p><p><a href="/login">返回登录</a></p></main>`)
    }
  }

  const providerListHandler = (_request: IncomingMessage, response: ServerResponse): void => {
    writeJson(response, 200, { ok: true, providers: ensureExternalAuth().list() })
  }

  const originStatus = (request: IncomingMessage): GatewayStatus => {
    const origin = requestOrigin(request)
    const address = new URL(origin)
    return {
      ...status,
      host: address.hostname,
      port: address.port === '' ? (address.protocol === 'https:' ? 443 : 80) : Number(address.port),
      tls: address.protocol === 'https:',
      secure: address.protocol === 'https:',
    }
  }

  const integratedSessionHandler = (request: IncomingMessage): ReturnType<typeof makeGatewayRequestHandler> =>
    makeGatewayRequestHandler('session', {
      accounts,
      sessions,
      cookieName: resolve().cookieName,
      secure: requestOrigin(request).startsWith('https:'),
      limiter,
      status: originStatus(request),
      onAccountsChanged: sync,
    })

  const integratedLoginHandler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    await integratedSessionHandler(request)(request, response)
  }

  const integratedGatewayHandler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://webserver.local')
    const method = request.method ?? 'GET'
    if (isPreAuthGatewayPath(method, url.pathname) || !isLoopbackAdmin(request)) {
      await integratedSessionHandler(request)(request, response)
      return
    }
    await loopbackRoutes()(request, response)
  }

  /** Every webServer route, rebuilt when settings change. */
  const routes = (): WebRoute[] => [
    { kind: 'exact', path: '/login', handler: integratedLoginHandler },
    { kind: 'exact', path: '/api/gateway/auth/providers', handler: providerListHandler },
    { kind: 'prefix', path: '/auth', handler: externalAuthHandler },
    { kind: 'prefix', path: GATEWAY_API_PREFIX, handler: integratedGatewayHandler },
  ]

  // ── posture probe ───────────────────────────────────────────────────────
  // Guardrail for the seam this plugin cannot close itself: the SDK's /api
  // Host fence. Forged-Host probes against every LAN literal make a
  // re-opened /api (a re-added --trusted-host, or the SDK's LAN auto-trust
  // under 0.0.0.0) visible on the log instead of silently trusted.
  let postureKey: string | undefined
  let postureWasExposed = false
  const runPostureProbe = (): void => {
    if (disposed || !resolve().enabled) return
    const targets = postureTargets(undefined, lanIPv4Addresses(), webServerPort)
    if (targets.length === 0) {
      postureKey = undefined
      return
    }
    const key = targets.join('|')
    const claim = claimPostureKey(postureKey, key)
    if (!claim.run) return
    postureKey = claim.next
    void probePosture({ port: webServerPort, targets }).then((snapshot) => {
      const exposedHosts = snapshot.hosts.filter(host => host.exposed).map(host => host.host)
      const exposed = exposedHosts.length > 0
      if (exposed && !postureWasExposed) {
        console.error(`remote-web-ui: CRITICAL — the /api fence is OPEN for [${exposedHosts.join(', ')}]: requests that bypass the gateway reach the full host API. Remove --trusted-host for these hosts or bind loopback (the gateway is the only public door).`)
      } else if (!exposed && postureWasExposed) {
        console.log('remote-web-ui: the /api posture probe is clean again (every LAN literal refused with 403).')
      }
      postureWasExposed = exposed
    }).catch(() => {
      postureKey = releasePostureKey(postureKey, key)
    })
  }
  // The first round waits for the connection plugin's /api route: a probe
  // before it mounts would read the SPA fallback and false-positive.
  const initialPostureTimer = nodeSetTimeout(() => { runPostureProbe() }, 5_000)
  own(() => { clearTimeout(initialPostureTimer) })
  initialPostureTimer.unref()

  // ── sync: register routes + (re)apply the gateway on every change ──────
  let disposeRoutes: (() => void) | undefined
  own(() => { disposeRoutes?.(); disposeRoutes = undefined })
  const sync = (): void => {
    if (disposed) return
    ensureStores()
    applyBootstrap()
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (resolve().enabled) {
      disposeRoutes = registerResources(ownRoute => {
        for (const route of routes()) ownRoute(ctx.webServer.register(route))
      })
    }
    applyGateway()
  }

  // Session sweep cadence: drop expired sessions promptly so the store file
  // and the admin list never show dead rows.
  const sessionSweepTimer = nodeSetInterval(() => { sessions.sweep() }, 60_000)
  own(() => { clearInterval(sessionSweepTimer) })
  sessionSweepTimer.unref()

  // Inject the server-mode boot script that declares gateway host ownership
  // (with a login redirect for unsigned sessions). The shared remote-access
  // domain owns the remote-entry boot row plus the plain-HTTP shims, so this
  // domain adds only its gateway-specific row.
  own(ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script', placement: 'head', text: SERVER_BOOT_SCRIPT })
  }))

  // 0.2：命名空间值取自聚合条目 Config 的 volatile 引用；设置变更由 loader 原地
  // 热更新，userspace 只需在文档变更事件上重新 apply。
  current = () => familyNamespace<Config>(REMOTE_WEB_UI_SETTINGS_NAMESPACE) ?? config ?? {}
  own(onFamilyConfigChange(() => { sync() }))
  sync()
}
