/**
 * dsh-api-proxy process management for the codex-bridge service domain.
 *
 * Spawns (or adopts) the standalone dsh-api-proxy node service, keeps its
 * generated config.yaml in the proxy directory, and exposes health / models /
 * accounts / verification probes. The client api key is minted once and
 * persisted next to the config (0600), so it stays stable across restarts.
 * All HTTP calls target 127.0.0.1 only.
 *
 * Ported verbatim from the pre-merge @dsh-cove/dsh-codex-bridge package
 * (src/bridge.ts) into the dsh-web-all host services.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  exchangeDeviceCode,
  idTokenIdentity,
  pollDeviceCode,
  requestDeviceCode,
  writeCodexAuthFile,
  type CodexAuthStatus,
  type DeviceCodeGrant,
} from './codex-auth.ts'

/** Phase of an in-flight device-code login. */
export type DeviceLoginPhase = 'idle' | 'waiting' | 'success' | 'failed' | 'timeout' | 'cancelled'

export interface DeviceLoginState {
  phase: DeviceLoginPhase
  grant?: DeviceCodeGrant
  email?: string
  error?: string
}

export interface BridgeOptions {
  proxyDir: string
  host?: string
  port?: number
  authFile?: string
  apiKey?: string
}

export interface BridgeStatus {
  proxy: 'stopped' | 'starting' | 'running' | 'failed'
  port: number
  baseURL: string
  apiKeyConfigured: boolean
  auth: CodexAuthStatus
  models: string[]
  accountEmail?: string
  accountPlan?: string
  lastError?: string
  adopted: boolean
}

/** Where the proxy stores its runtime state; under $DSH_HOME by default. */
function runtimeAuthDir(): string {
  return join(process.env.DSH_HOME ?? join(process.env.HOME ?? '/root', '.dsh'), 'dsh-api-proxy')
}

export class ApiProxyBridge {
  readonly port: number
  readonly host: string
  readonly authFile: string
  readonly baseURL: string
  private readonly proxyDir: string
  private readonly configuredKey: string | undefined
  private child: ChildProcess | undefined
  private adopted = false
  private lastError: string | undefined
  private loginState: DeviceLoginState = { phase: 'idle' }
  private loginAbort: AbortController | undefined

  constructor(options: BridgeOptions) {
    this.proxyDir = options.proxyDir
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 8317
    this.authFile = options.authFile ?? '~/.codex/auth.json'
    this.configuredKey = options.apiKey
    this.baseURL = `http://${this.host}:${this.port}`
  }

  private keyFilePath(): string {
    return join(this.proxyDir, '.api-key')
  }

  /**
   * Stable client api key, resolved in order: configured value, the key an
   * existing (adopted) service's config.yaml carries, the persisted key file,
   * or a fresh mint.
   */
  apiKey(): string {
    if (this.configuredKey) return this.configuredKey
    const fromConfig = this.readKeyFromProxyConfig()
    if (fromConfig) return fromConfig
    const keyFile = this.keyFilePath()
    if (existsSync(keyFile)) {
      try {
        const existing = readFileSync(keyFile, 'utf8').trim()
        if (existing) return existing
      } catch {
        /* fall through to mint */
      }
    }
    const key = `sk-${randomBytes(24).toString('hex')}`
    mkdirSync(this.proxyDir, { recursive: true })
    writeFileSync(keyFile, `${key}\n`, { mode: 0o600 })
    return key
  }

  /** Extract the first api key from an existing dsh-api-proxy config.yaml. */
  private readKeyFromProxyConfig(): string | undefined {
    const configPath = this.proxyConfigPath()
    if (!existsSync(configPath)) return undefined
    try {
      const text = readFileSync(configPath, 'utf8')
      const match = text.match(/^\s*-\s+"(sk-[^"]+)"\s*$/m)
      return match?.[1]
    } catch {
      return undefined
    }
  }

  private proxyConfigPath(): string {
    return join(this.proxyDir, 'config.yaml')
  }

  /** Ensure the proxy config.yaml exists with our endpoint, the codex auth
   *  file, and the stable api key. */
  ensureConfig(): { key: string; configPath: string } {
    mkdirSync(this.proxyDir, { recursive: true })
    const key = this.apiKey()
    const config = {
      host: this.host,
      port: this.port,
      'auth-dir': runtimeAuthDir(),
      'codex-auth-file': this.authFile,
      'api-keys': [key],
      'body-limit': '200mb',
      timeouts: {
        'messages-ms': 120000,
        'stream-messages-ms': 600000,
        'count-tokens-ms': 30000,
      },
      stats: { enabled: true },
      debug: 'errors' as const,
    }
    writeFileSync(this.proxyConfigPath(), toYaml(config), { mode: 0o600 })
    return { key, configPath: this.proxyConfigPath() }
  }

  /** True when a service already answers on our endpoint (adopt mode). */
  async detectExisting(signal?: AbortSignal): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseURL}/health`, { signal, headers: { Accept: 'application/json' } })
      return resp.ok
    } catch {
      return false
    }
  }

  /** Spawn the proxy service and wait for /health; adopt an existing one. */
  async start(): Promise<void> {
    if (this.child) return
    if (await this.detectExisting()) {
      this.adopted = true
      return
    }
    const { configPath } = this.ensureConfig()
    const entry = join(this.proxyDir, 'dist', 'index.js')
    if (!existsSync(entry)) {
      throw new Error(`dsh-api-proxy build not found at ${entry}; run npm ci && npm run build in ${this.proxyDir}`)
    }
    this.adopted = false
    this.lastError = undefined
    this.child = spawn(process.execPath, [entry, `--config=${configPath}`], {
      cwd: this.proxyDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child.stdout?.on('data', () => { /* keep pipe drained */ })
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.lastError = text
    })
    this.child.on('exit', (code) => {
      if (this.child) {
        this.lastError = `proxy exited with code ${code}`
        this.child = undefined
      }
    })
    await this.waitForHealth(15_000)
  }

  private async waitForHealth(timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    for (;;) {
      if (await this.detectExisting()) return
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(this.lastError ?? 'proxy did not become healthy in time')
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  /** Stop a child we spawned (adopted services are left alone). */
  stop(): void {
    if (!this.child) return
    const child = this.child
    this.child = undefined
    child.kill('SIGTERM')
  }

  async restart(): Promise<void> {
    this.stop()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await this.start()
  }

  /** Current device-login state. */
  deviceLoginState(): DeviceLoginState {
    return this.loginState
  }

  /**
   * Start a device-code login: request the one-time code, surface it, then
   * poll in the background, exchange and persist tokens on success. The
   * returned grant is what the UI shows the user.
   */
  async startDeviceLogin(
    fetchImpl: typeof fetch = fetch,
  ): Promise<DeviceCodeGrant> {
    if (this.loginState.phase === 'waiting') {
      throw new Error('a device login is already in progress')
    }
    const grant = await requestDeviceCode(fetchImpl)
    this.loginAbort = new AbortController()
    this.loginState = { phase: 'waiting', grant }
    void this.runDevicePoll(grant, this.loginAbort.signal, fetchImpl)
    return grant
  }

  private async runDevicePoll(
    grant: DeviceCodeGrant,
    signal: AbortSignal,
    fetchImpl: typeof fetch,
  ): Promise<void> {
    try {
      const success = await pollDeviceCode(
        grant.deviceAuthId,
        grant.userCode,
        grant.intervalSec,
        fetchImpl,
        undefined,
        signal,
      )
      if (!success) {
        this.loginState = { ...this.loginState, phase: 'timeout' }
        return
      }
      const tokens = await exchangeDeviceCode(success.authorizationCode, success.codeVerifier, fetchImpl)
      writeCodexAuthFile(this.authFile, tokens)
      const identity = idTokenIdentity(tokens.idToken)
      this.loginState = {
        phase: 'success',
        grant,
        email: identity.email,
      }
      // Token file changed: force the proxy to reload (or start it).
      await this.restart()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.loginState = {
        ...this.loginState,
        phase: error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed',
        error: message,
      }
    }
  }

  cancelDeviceLogin(): void {
    this.loginAbort?.abort()
    this.loginState = { ...this.loginState, phase: 'cancelled' }
  }

  private async authedFetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseURL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey()}`, ...(init?.headers ?? {}) },
    })
  }

  async listModels(): Promise<string[]> {
    try {
      const resp = await this.authedFetch('/v1/models')
      if (!resp.ok) return []
      const data = (await resp.json()) as { data?: Array<{ id: string }> }
      return (data.data ?? []).map((m) => m.id).filter((id) => id !== 'gpt-reserve')
    } catch {
      return []
    }
  }

  async accounts(): Promise<{ email?: string; planType?: string } | undefined> {
    try {
      const resp = await this.authedFetch('/admin/accounts')
      if (!resp.ok) return undefined
      const data = (await resp.json()) as {
        providers?: { codex?: { accounts?: Array<{ email?: string; planType?: string }> } }
      }
      const account = data.providers?.codex?.accounts?.[0]
      return account ? { email: account.email, planType: account.planType } : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Verify the whole chain end to end: models endpoint plus one minimal
   * chat completion through the codex backend.
   */
  async verify(model?: string): Promise<{ ok: boolean; model?: string; reply?: string; error?: string }> {
    const models = await this.listModels()
    if (models.length === 0) return { ok: false, error: 'no models advertised' }
    const target = model ?? models[0]
    const resp = await this.authedFetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: target,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 16,
      }),
    })
    if (!resp.ok) {
      return { ok: false, model: target, error: `upstream ${resp.status}: ${(await resp.text()).slice(0, 200)}` }
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const reply = data.choices?.[0]?.message?.content
    return { ok: Boolean(reply), model: target, reply }
  }

  async status(auth: CodexAuthStatus): Promise<BridgeStatus> {
    const running = Boolean(this.child) || (await this.detectExisting().catch(() => false))
    const models = running ? await this.listModels() : []
    const account = running ? await this.accounts() : undefined
    return {
      proxy: running ? 'running' : this.lastError ? 'failed' : 'stopped',
      port: this.port,
      baseURL: this.baseURL,
      apiKeyConfigured: Boolean(this.apiKey()),
      auth,
      models,
      accountEmail: account?.email,
      accountPlan: account?.planType,
      lastError: this.lastError,
      adopted: this.adopted,
    }
  }
}

function toYaml(config: {
  host: string
  port: number
  'auth-dir': string
  'codex-auth-file'?: string
  'api-keys': string[]
  'body-limit': string
  timeouts: Record<string, number>
  stats: { enabled: boolean }
  debug: 'off' | 'errors' | 'verbose'
}): string {
  const lines: string[] = []
  lines.push(`host: "${config.host}"`)
  lines.push(`port: ${config.port}`)
  lines.push(`auth-dir: "${config['auth-dir']}"`)
  if (config['codex-auth-file']) lines.push(`codex-auth-file: "${config['codex-auth-file']}"`)
  lines.push('api-keys:')
  for (const key of config['api-keys']) lines.push(`  - "${key}"`)
  lines.push(`body-limit: "${config['body-limit']}"`)
  lines.push('timeouts:')
  for (const [k, v] of Object.entries(config.timeouts)) lines.push(`  ${k}: ${v}`)
  lines.push('stats:')
  lines.push(`  enabled: ${config.stats.enabled}`)
  lines.push(`debug: "${config.debug}"`)
  return `${lines.join('\n')}\n`
}