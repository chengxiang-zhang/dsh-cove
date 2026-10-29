/**
 * Gateway HTTP surface: the login page, the pre-auth session/config/login
 * endpoints, and the admin surface (accounts + sessions) — the endpoints
 * the public listener and the loopback webServer both serve under
 * `/api/gateway`. Login is rate-limited per (IP + username) with a generic
 * failure message that never reveals whether a username exists.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBoundedJson, writeJson } from './http.ts'
import { makeReadableCookie, makeSetCookie, readCookie } from './cookie.ts'
import { GATEWAY_MARKER_COOKIE, GATEWAY_MARKER_MAX_AGE_SECONDS, GATEWAY_MARKER_VALUE, gatewaySameOrigin } from './gateway.ts'
import { AccountConflictError, type AccountRole, type AccountStore } from './accounts.ts'
import type { SessionStore } from './sessions.ts'
import { GATEWAY_API_PREFIX } from './roles.ts'

export { GATEWAY_API_PREFIX }

/** Pre-auth gateway paths any webServer front (nginx, trusted-host) must serve. */
export function isPreAuthGatewayPath(method: string, pathname: string): boolean {
  if (method === 'GET' && pathname === '/login') return true
  if (!pathname.startsWith(`${GATEWAY_API_PREFIX}/`) && pathname !== GATEWAY_API_PREFIX) return false
  const rest = pathname.slice(GATEWAY_API_PREFIX.length + 1)
  if (method === 'GET' && (rest === 'status' || rest === 'session' || rest === 'config')) return true
  if (method === 'POST' && (rest === 'login' || rest === 'logout')) return true
  return false
}

/** Request body cap for the tiny JSON endpoints (login: 2 fields). */
const MAX_BODY_BYTES = 8 * 1024

/** Trust context of one /api/gateway invocation. */
export type GatewayTrust = 'loopback' | 'session'

/** The gateway's public pre-auth status. */
export interface GatewayStatus {
  loginRequired: boolean
  cookieName: string
  tls: boolean
  /** Whether the account store is empty (first-run bootstrap needed). */
  noAccounts: boolean
  /** Listen host/port the admin surface shows as the access entry. */
  host?: string
  port?: number
  /** Whether the listener serves HTTPS. */
  secure?: boolean
  /** The live session of the requesting browser, when signed in. */
  session?: { username: string; role: AccountRole; lastSeenAt: number }
}

/**
 * In-memory login limiter: a sliding failure window per (IP + username)
 * plus a hard lockout after repeated failures.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; firstAt: number }>()
  private readonly lockouts = new Map<string, number>()

  /** Both maps are keyed by attacker-chosen strings (IP + username), so neither may grow forever. */
  private readonly maxKeys: number
  private lastPrune = 0

  private readonly windowMs: number
  private readonly maxFailsPerWindow: number
  private readonly maxFailsBeforeLockout: number
  private readonly lockoutMs: number

  constructor(options: {
    windowMs?: number
    maxFailsPerWindow?: number
    maxFailsBeforeLockout?: number
    lockoutMs?: number
    maxKeys?: number
  } = {}) {
    this.windowMs = options.windowMs ?? 60_000
    this.maxFailsPerWindow = options.maxFailsPerWindow ?? 5
    this.maxFailsBeforeLockout = options.maxFailsBeforeLockout ?? 20
    this.lockoutMs = options.lockoutMs ?? 300_000
    this.maxKeys = options.maxKeys ?? 4_096
  }

  private now(): number {
    return Date.now()
  }

  /** Whether a login attempt from this key may proceed. */
  check(key: string): { allowed: boolean; retryAfterMs?: number } {
    const now = this.now()
    this.prune(now)
    const lockedUntil = this.lockouts.get(key)
    if (lockedUntil !== undefined) {
      if (now < lockedUntil) return { allowed: false, retryAfterMs: lockedUntil - now }
      this.lockouts.delete(key)
    }
    const bucket = this.failures.get(key)
    if (bucket !== undefined && now - bucket.firstAt < this.windowMs && bucket.count >= this.maxFailsPerWindow) {
      return { allowed: false, retryAfterMs: this.windowMs - (now - bucket.firstAt) }
    }
    return { allowed: true }
  }

  /** Record one failed attempt. */
  recordFailure(key: string): void {
    const now = this.now()
    const bucket = this.failures.get(key)
    if (bucket === undefined || now - bucket.firstAt >= this.windowMs) {
      this.failures.set(key, { count: 1, firstAt: now })
    } else {
      bucket.count += 1
    }
    if (bucket !== undefined && bucket.count >= this.maxFailsBeforeLockout) {
      this.lockouts.set(key, now + this.lockoutMs)
      this.failures.delete(key)
    }
    this.prune(now)
  }

  /** Record a successful login (reset the window for this key). */
  recordSuccess(key: string): void {
    this.failures.delete(key)
  }

  /**
   * Drops buckets that can no longer block anything, and keeps the failure map bounded.
   *
   * Every key is a string an unauthenticated caller chooses (IP + username), so a limiter
   * that only ever adds is a memory sink: one failed login per invented username is enough
   * to grow it without limit. Expired buckets are removed once per window (a login storm
   * must not pay a full scan per attempt), and past the key bound the oldest buckets go
   * first - Map iteration is insertion order, and the oldest bucket is the least likely to
   * still be inside its window. Lockouts are left to expire on their own: reaching one
   * costs twenty failures, so they cannot be grown cheaply.
   */
  private prune(now: number): void {
    if (now - this.lastPrune < this.windowMs && this.failures.size <= this.maxKeys) return
    this.lastPrune = now
    for (const [key, bucket] of this.failures) {
      if (now - bucket.firstAt >= this.windowMs) this.failures.delete(key)
    }
    for (const [key, until] of this.lockouts) {
      if (now >= until) this.lockouts.delete(key)
    }
    while (this.failures.size > this.maxKeys) {
      const oldest = this.failures.keys().next()
      if (oldest.done === true) break
      this.failures.delete(oldest.value)
    }
  }

  /** Tracked key counts (diagnostics and tests). */
  counts(): { failures: number; lockouts: number } {
    return { failures: this.failures.size, lockouts: this.lockouts.size }
  }
}

/** All handler dependencies. */
export interface GatewayRoutesDeps {
  accounts: AccountStore
  sessions: SessionStore
  cookieName: string
  secure: boolean
  limiter: LoginLimiter
  /** Status payload the /api/gateway/session + config endpoints report. */
  status: GatewayStatus
  /**
   * Called after any successful account mutation (create / password / role /
   * enabled / delete). The caller re-evaluates the fail-closed gateway state
   * from it — creating the first admin must open the door.
   */
  onAccountsChanged?: () => void
}

/** Extract a username/password pair from a login body, or undefined. */
function loginBodyOf(body: unknown): { username: string; password: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const username = (body as Record<string, unknown>).username
  const password = (body as Record<string, unknown>).password
  if (typeof username !== 'string' || typeof password !== 'string') return undefined
  return { username: username.trim(), password }
}

/** The self-contained login page (no SPA, no build step). */
function loginPageHtml(next: string, status: GatewayStatus): string {
  const lang = 'zh' // zh default; the inline script toggles via the page button.
  const scheme = status.secure ? 'https' : 'http'
  const defaultPort = status.secure === true ? 443 : 80
  const showPort = status.port !== undefined && status.port !== defaultPort
  const entry = status.port === undefined
    ? ''
    : `${scheme}://${status.host ?? '127.0.0.1'}${showPort ? `:${String(status.port)}` : ''}`
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness - Sign in</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    background:
      radial-gradient(1200px 600px at 20% -10%, var(--glow-a), transparent 60%),
      radial-gradient(1000px 500px at 110% 110%, var(--glow-b), transparent 55%),
      var(--bg);
    color: var(--text-primary);
  }
  :root {
    --bg: #f4f6fb;
    --glow-a: rgba(77, 107, 254, 0.14);
    --glow-b: rgba(38, 200, 160, 0.10);
    --card: #ffffff;
    --card-border: rgba(15, 23, 42, 0.08);
    --card-shadow: 0 24px 64px rgba(15, 23, 42, 0.10), 0 2px 8px rgba(15, 23, 42, 0.05);
    --text-primary: #111827;
    --text-secondary: #4b5563;
    --text-tertiary: #9ca3af;
    --input-bg: #f9fafb;
    --input-border: #d1d5db;
    --brand: #4d6bfe;
    --brand-soft: rgba(77, 107, 254, 0.10);
    --danger: #dc2626;
    --danger-soft: #fef2f2;
    --success: #059669;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --glow-a: rgba(77, 107, 254, 0.20);
      --glow-b: rgba(38, 200, 160, 0.12);
      --card: #151b24;
      --card-border: rgba(255, 255, 255, 0.08);
      --card-shadow: 0 24px 64px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.3);
      --text-primary: #f3f4f6;
      --text-secondary: #9ca3af;
      --text-tertiary: #6b7280;
      --input-bg: #0f151d;
      --input-border: #2b3542;
      --brand: #6d8bff;
      --brand-soft: rgba(109, 139, 255, 0.16);
      --danger: #f87171;
      --danger-soft: rgba(248, 113, 113, 0.10);
      --success: #34d399;
    }
  }
  .card {
    position: relative;
    width: 100%;
    max-width: 380px;
    margin: 16px;
    padding: 36px 32px 28px;
    border-radius: 20px;
    background: var(--card);
    border: 1px solid var(--card-border);
    box-shadow: var(--card-shadow);
    animation: rise 0.45s cubic-bezier(0.22, 1, 0.36, 1);
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(14px); }
    to { opacity: 1; transform: none; }
  }
  .lang {
    position: absolute;
    top: 14px;
    right: 14px;
    min-width: 44px;
    min-height: 44px;
    font-size: 13px;
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 4px 10px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background-color 0.15s;
  }
  .lang:hover { color: var(--text-secondary); border-color: var(--input-border); }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
  .logo {
    width: 44px;
    height: 44px;
    flex: none;
    border-radius: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #4d6bfe 0%, #6a5cff 55%, #38bdf8 130%);
    box-shadow: 0 8px 20px rgba(77, 107, 254, 0.35);
  }
  .logo svg { width: 26px; height: 26px; }
  .brandText { min-width: 0; }
  .brandName {
    margin: 0;
    font-size: 16px;
    font-weight: 650;
    letter-spacing: -0.01em;
    line-height: 1.3;
    color: var(--text-primary);
  }
  .brandTag {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--text-tertiary);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  h1 {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.3;
  }
  p.sub {
    margin: 0 0 24px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-secondary);
  }
  label {
    display: block;
    margin: 14px 0 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .input {
    width: 100%;
    padding: 11px 14px;
    border-radius: 12px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text-primary);
    min-height: 44px;
    font-size: 16px;
    font-family: inherit;
    transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
  }
  .input:focus-visible {
    outline: none;
    border-color: var(--brand);
    background: var(--card);
    box-shadow: 0 0 0 4px var(--brand-soft);
  }
  .input::placeholder { color: var(--text-tertiary); }
  .error {
    display: none;
    margin-top: 14px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 12px;
    line-height: 1.5;
  }
  .error.show { display: block; animation: shake 0.32s; }
  @keyframes shake {
    20% { transform: translateX(-4px); }
    40% { transform: translateX(4px); }
    60% { transform: translateX(-3px); }
    80% { transform: translateX(2px); }
  }
  .submit {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    margin-top: 22px;
    padding: 12px 16px;
    border: 0;
    border-radius: 12px;
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    color: #ffffff;
    background: linear-gradient(135deg, #4d6bfe 0%, #6a5cff 100%);
    cursor: pointer;
    transition: filter 0.15s, transform 0.1s, box-shadow 0.15s;
    box-shadow: 0 8px 20px rgba(77, 107, 254, 0.30);
  }
  .submit:hover:not(:disabled) { filter: brightness(1.06); box-shadow: 0 10px 24px rgba(77, 107, 254, 0.38); }
  .submit:active:not(:disabled) { transform: translateY(1px); }
  .submit:focus-visible { outline: none; box-shadow: 0 0 0 4px var(--brand-soft), 0 8px 20px rgba(77, 107, 254, 0.30); }
  .submit:disabled { opacity: 0.65; cursor: default; }
  .spinner {
    display: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: #ffffff;
    animation: spin 0.7s linear infinite;
  }
  .submit.loading .spinner { display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .security {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 6px 14px;
    margin-top: 24px;
    padding-top: 18px;
    border-top: 1px solid var(--card-border);
  }
  .sec {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-tertiary);
    white-space: nowrap;
  }
  .secDot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--success);
  }
  .secDot.plain { background: var(--text-tertiary); }
  .sec code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10.5px;
    color: var(--text-secondary);
  }
  .foot {
    margin: 16px 0 0;
    text-align: center;
    font-size: 11px;
    color: var(--text-tertiary);
  }
  @media (prefers-reduced-motion: reduce) {
    .card, .error.show { animation: none; }
    .spinner { animation-duration: 1.4s; }
  }
</style>
</head>
<body>
  <form class="card" id="login-form" autocomplete="on">
    <button type="button" class="lang" id="lang-toggle" data-zh="English" data-en="中文">English</button>
    <div class="brand">
      <span class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3a9 9 0 0 0-9 9c0 1.5.4 3 1 4.2L3 21l4.8-1a9 9 0 1 0 4.2-17z"/>
          <path d="M8.5 13.5c.6-1.6 1.7-2.6 3.5-2.6s2.9 1 3.5 2.6"/>
        </svg>
      </span>
      <span class="brandText">
        <p class="brandName">DeepSeek Harness</p>
        <p class="brandTag">Server Access</p>
      </span>
    </div>
    <h1 id="title">DeepSeek Harness 登录</h1>
    <p class="sub" id="subtitle">使用本机账号登录以访问工作区</p>
    <label for="username" id="label-user">用户名</label>
    <input class="input" id="username" name="username" autocomplete="username" placeholder="username" required autofocus>
    <label for="password" id="label-pass">密码</label>
    <input class="input" id="password" name="password" type="password" autocomplete="current-password" placeholder="••••••••" required>
    <div class="error" id="error" role="alert"></div>
    <div id="external-providers"></div>
    <button type="submit" class="submit" id="submit">
      <span class="spinner" aria-hidden="true"></span>
      <span id="submit-label">登录</span>
    </button>
    <div class="security">
      ${entry === ''
        ? ''
        : `<span class="sec"><span class="secDot${status.secure ? '' : ' plain'}"></span><span id="sec-tls"></span></span>
           <span class="sec"><code>${entry}</code></span>`}
    </div>
    <p class="foot" id="foot">DeepSeek Harness</p>
  </form>
<script>
  (function () {
    var next = ${JSON.stringify(next)};
    var tls = ${JSON.stringify(status.secure ? 'tlsOn' : 'tlsOff')};
    var texts = {
      zh: { title: 'DeepSeek Harness 登录', sub: '使用本机账号登录以访问工作区',
            user: '用户名', pass: '密码', submit: '登录', err: '登录失败，请检查用户名和密码',
            errRate: '尝试过于频繁，请稍后再试', tlsOn: 'HTTPS 安全连接', tlsOff: '明文 HTTP 连接' },
      en: { title: 'Sign in to DeepSeek Harness', sub: 'Sign in with a local account to access the workspace',
            user: 'Username', pass: 'Password', submit: 'Sign in', err: 'Sign in failed; check username and password',
            errRate: 'Too many attempts; try again later', tlsOn: 'Secure HTTPS connection', tlsOff: 'Plain HTTP connection' }
    };
    var lang = window.localStorage.getItem('dsh-login-lang') || 'zh';
    var toggle = document.getElementById('lang-toggle');
    function apply(l) {
      lang = l;
      window.localStorage.setItem('dsh-login-lang', l);
      var t = texts[l];
      document.getElementById('title').textContent = t.title;
      document.getElementById('subtitle').textContent = t.sub;
      document.getElementById('label-user').textContent = t.user;
      document.getElementById('label-pass').textContent = t.pass;
      document.getElementById('submit-label').textContent = t.submit;
      document.getElementById('sec-tls').textContent = tls === 'tlsOn' ? t.tlsOn : t.tlsOff;
      toggle.textContent = l === 'zh' ? 'English' : '中文';
      document.documentElement.lang = l;
    }
    toggle.addEventListener('click', function () { apply(lang === 'zh' ? 'en' : 'zh'); });
    apply(lang);
    fetch('/api/gateway/auth/providers', { headers: { accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : { providers: [] }; })
      .then(function (body) {
        var root = document.getElementById('external-providers');
        (body.providers || []).forEach(function (provider) {
          var link = document.createElement('a');
          link.className = 'submit';
          link.style.cssText = 'display:flex;text-decoration:none;margin:0 0 10px;';
          link.href = '/auth/' + encodeURIComponent(provider.id) + '/start?next=' + encodeURIComponent(next || '/');
          link.textContent = (lang === 'zh' ? '使用 ' : 'Continue with ') + provider.label + (lang === 'zh' ? ' 登录' : '');
          root.appendChild(link);
        });
      }).catch(function () {});
    var form = document.getElementById('login-form');
    var error = document.getElementById('error');
    var submit = document.getElementById('submit');
    function fail(message) {
      error.textContent = message;
      error.classList.remove('show');
      void error.offsetWidth;
      error.classList.add('show');
      submit.disabled = false;
      submit.classList.remove('loading');
    }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      error.classList.remove('show');
      submit.disabled = true;
      submit.classList.add('loading');
      var username = document.getElementById('username').value;
      var password = document.getElementById('password').value;
      fetch('/api/gateway/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      }).then(function (res) {
        if (res.ok) {
          var target = next && next.indexOf('//') < 0 ? next : '/';
          window.location.href = target;
          return;
        }
        fail(res.status === 429 ? texts[lang].errRate : texts[lang].err);
      }).catch(function () {
        fail(texts[lang].err);
      });
    });
  })();
</script>
</body>
</html>`
}

/** One error envelope the SPA and admin panels can parse. */
function gatewayError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { ok: false, error: { code, message, details: { issues: [] } } })
}

/** Map account-domain invariant violations onto a stable conflict response. */
function writeAccountConflict(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof AccountConflictError)) return false
  gatewayError(res, 409, error.code, error.message)
  return true
}

/**
 * Handle one request under the gateway surface.
 * @param trust - 'loopback' (webServer side; caller is already loopback) or
 *   'session' (public listener; admin endpoints need an admin session).
 * @param deps - accounts/sessions/cookie/limiter/status.
 * @returns the handler.
 */
export function makeGatewayRequestHandler(trust: GatewayTrust, deps: GatewayRoutesDeps) {
  const { accounts, sessions, cookieName, secure, limiter, status } = deps
  sessions.bindAccounts(accounts)

  /**
   * Resolve the limiter/session-audit client IP. The public session listener
   * must never trust a caller-controlled forwarding header; only the loopback
   * compatibility front may consume its reverse proxy's first XFF hop.
   */
  function clientIpOf(req: IncomingMessage): string {
    if (trust === 'loopback') {
      const xff = req.headers['x-forwarded-for']
      if (typeof xff === 'string' && xff.trim() !== '') return xff.split(',')[0].trim()
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  /** Current session of this request (loopback trust reads accounts anyway). */
  function sessionOf(req: IncomingMessage): { username: string; role: AccountRole; lastSeenAt: number } | undefined {
    if (trust === 'loopback') return undefined
    const cookieValue = readCookie(req.headers.cookie, cookieName)
    let session
    try { session = cookieValue === undefined ? undefined : sessions.touch(cookieValue) } catch { return undefined }
    if (session === undefined) return undefined
    return { username: session.username, role: session.role, lastSeenAt: session.lastSeenAt }
  }

  /** Whether the session may perform admin operations. */
  function isAdminSession(req: IncomingMessage): boolean {
    if (trust === 'loopback') return true
    return sessionOf(req)?.role === 'admin'
  }

  const requireAdmin = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isAdminSession(req)) return true
    gatewayError(res, 403, 'forbidden-role', 'admin role required')
    return false
  }

  return async function handleGatewayRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (trust === 'session' && !gatewaySameOrigin(req, secure)) {
      gatewayError(res, 403, 'forbidden-origin', 'same-origin request required')
      return
    }
    const url = new URL(req.url ?? '/', 'http://gateway.local')
    const pathname = url.pathname
    const method = req.method ?? 'GET'

    // Login page (public listener only).
    if (trust === 'session' && method === 'GET' && pathname === '/login') {
      const next = url.searchParams.get('next') ?? '/'
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' })
      res.end(loginPageHtml(next, status))
      return
    }

    // Everything else lives under /api/gateway.
    if (!pathname.startsWith(`${GATEWAY_API_PREFIX}/`) && pathname !== GATEWAY_API_PREFIX) {
      gatewayError(res, 404, 'not-found', 'unknown gateway route')
      return
    }
    const rest = pathname.slice(GATEWAY_API_PREFIX.length + 1)

    // Pre-auth public endpoints.
    if (method === 'GET' && rest === 'status') {
      const session = sessionOf(req)
      writeJson(res, 200, { ok: true, status: session === undefined
        ? status
        : { ...status, session: { username: session.username, role: session.role, lastSeenAt: session.lastSeenAt } } })
      return
    }
    if (method === 'GET' && rest === 'session') {
      const session = sessionOf(req)
      writeJson(res, 200, session === undefined
        ? { ok: true, authenticated: false, status }
        : { ok: true, authenticated: true, username: session.username, role: session.role, status })
      return
    }
    if (method === 'GET' && rest === 'config') {
      writeJson(res, 200, { ok: true, status })
      return
    }
    if (method === 'POST' && rest === 'login') {
      const ip = clientIpOf(req)
      const body = await readBoundedJson(req, MAX_BODY_BYTES).catch(() => undefined)
      const credentials = loginBodyOf(body)
      const gate = limiter.check(`${ip}|${credentials?.username ?? ''}`)
      if (!gate.allowed && credentials !== undefined) {
        gatewayError(res, 429, 'rate-limited', 'login attempts too frequent')
        return
      }
      if (credentials === undefined) {
        limiter.recordFailure(`${ip}|`)
        gatewayError(res, 400, 'bad-request', 'username and password required')
        return
      }
      const { username, password } = credentials
      if (!accounts.verify(username, password)) {
        limiter.recordFailure(`${ip}|${username}`)
        gatewayError(res, 401, 'invalid-credentials', 'invalid username or password')
        return
      }
      const role = accounts.roleOf(username) ?? 'user'
      const session = sessions.issue(username, role, {
        userAgent: req.headers['user-agent'],
        ip,
      })
      limiter.recordSuccess(`${ip}|${username}`)
      writeJson(res, 200, { ok: true, username, role }, {
        'set-cookie': [
          makeSetCookie(cookieName, session.id, { secure, maxAgeSeconds: GATEWAY_MARKER_MAX_AGE_SECONDS }),
          makeReadableCookie(GATEWAY_MARKER_COOKIE, GATEWAY_MARKER_VALUE, { secure, maxAgeSeconds: GATEWAY_MARKER_MAX_AGE_SECONDS }),
        ],
      })
      return
    }
    if (method === 'POST' && rest === 'logout') {
      const sessionId = readCookie(req.headers.cookie, cookieName)
      if (sessionId !== undefined) sessions.revoke(sessionId)
      writeJson(res, 200, { ok: true }, {
        'set-cookie': [
          makeSetCookie(cookieName, '', { secure, maxAgeSeconds: 0 }),
          makeReadableCookie(GATEWAY_MARKER_COOKIE, '', { secure, maxAgeSeconds: 0 }),
        ],
      })
      return
    }

    // Admin surface (loopback or an admin session).
    if (!isAdminSession(req)) {
      gatewayError(res, 403, 'forbidden-role', 'admin role required')
      return
    }

    if (method === 'GET' && rest === 'accounts') {
      writeJson(res, 200, { ok: true, accounts: accounts.list() })
      return
    }
    if (method === 'POST' && rest === 'accounts') {
      const body = await readBoundedJson(req, MAX_BODY_BYTES).catch(() => undefined)
      if (!requireAdmin(req, res)) return
      const record = body as Record<string, unknown> | undefined
      const username = typeof record?.username === 'string' ? record.username.trim() : ''
      const password = typeof record?.password === 'string' ? record.password : ''
      const role: AccountRole = record?.role === 'user' ? 'user' : 'admin'
      if (username === '' || password.length < 8) {
        gatewayError(res, 400, 'bad-request', 'username required and password must be at least 8 characters')
        return
      }
      if (accounts.isEnabled(username) || accounts.roleOf(username) !== undefined) {
        gatewayError(res, 409, 'conflict', 'username already exists')
        return
      }
      try {
        const created = accounts.create(username, password, role)
        deps.onAccountsChanged?.()
        writeJson(res, 200, { ok: true, account: created })
      } catch (error) {
        if (writeAccountConflict(res, error)) return
        console.error('remote-web-ui: account create failed:', error)
        gatewayError(res, 500, 'internal', 'account create failed')
      }
      return
    }
    if (rest.startsWith('accounts/')) {
      const name = rest.slice('accounts/'.length)
      if (method === 'POST' && name.endsWith('/password')) {
        const username = name.slice(0, -'/password'.length)
        const body = await readBoundedJson(req, MAX_BODY_BYTES).catch(() => undefined)
        if (!requireAdmin(req, res)) return
        const password = typeof (body as Record<string, unknown> | undefined)?.password === 'string'
          ? (body as Record<string, unknown>).password as string
          : ''
        if (password.length < 8) {
          gatewayError(res, 400, 'bad-request', 'password must be at least 8 characters')
          return
        }
        const changed = accounts.setPassword(username, password)
        if (!changed) { gatewayError(res, 404, 'not-found', 'no such account'); return }
        sessions.revokeAllFor(username)
        deps.onAccountsChanged?.()
        writeJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && name.endsWith('/role')) {
        const username = name.slice(0, -'/role'.length)
        const body = await readBoundedJson(req, MAX_BODY_BYTES).catch(() => undefined)
        if (!requireAdmin(req, res)) return
        const role: AccountRole = (body as Record<string, unknown> | undefined)?.role === 'user' ? 'user' : 'admin'
        try {
          if (!accounts.setRole(username, role)) { gatewayError(res, 404, 'not-found', 'no such account'); return }
          // Sessions snapshot roles at login; never retain the old privilege.
          sessions.revokeAllFor(username)
        } catch (error) {
          if (writeAccountConflict(res, error)) return
          throw error
        }
        deps.onAccountsChanged?.()
        writeJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && name.endsWith('/enabled')) {
        const username = name.slice(0, -'/enabled'.length)
        const body = await readBoundedJson(req, MAX_BODY_BYTES).catch(() => undefined)
        if (!requireAdmin(req, res)) return
        const enabled = (body as Record<string, unknown> | undefined)?.enabled === true
        try {
          if (!accounts.setEnabled(username, enabled)) { gatewayError(res, 404, 'not-found', 'no such account'); return }
        } catch (error) {
          if (writeAccountConflict(res, error)) return
          throw error
        }
        if (!enabled) sessions.revokeAllFor(username)
        deps.onAccountsChanged?.()
        writeJson(res, 200, { ok: true })
        return
      }
      if (method === 'DELETE' && name !== '') {
        try {
          if (!accounts.remove(name)) { gatewayError(res, 404, 'not-found', 'no such account'); return }
        } catch (error) {
          if (writeAccountConflict(res, error)) return
          throw error
        }
        sessions.revokeAllFor(name)
        deps.onAccountsChanged?.()
        writeJson(res, 200, { ok: true })
        return
      }
    }
    if (method === 'GET' && rest === 'sessions') {
      writeJson(res, 200, { ok: true, sessions: sessions.list() })
      return
    }
    if (method === 'POST' && (rest === 'sessions/revoke' || rest === 'sessions/revoke-all')) {
      if (rest.endsWith('revoke-all')) {
        const count = sessions.revokeAll()
        writeJson(res, 200, { ok: true, revoked: count })
        return
      }
      const body = await readBoundedJson(req, MAX_BODY_BYTES).catch(() => undefined)
      if (!requireAdmin(req, res)) return
      const sessionId = (body as Record<string, unknown> | undefined)?.sessionId
      const revoked = typeof sessionId === 'string' ? sessions.revoke(sessionId) : false
      writeJson(res, 200, { ok: true, revoked })
      return
    }

    gatewayError(res, 404, 'not-found', 'unknown gateway route')
  }
}