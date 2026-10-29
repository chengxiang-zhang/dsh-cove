/**
 * codex-bridge host 服务域（node 半区，按旧包原交互恢复）。
 *
 * The pre-merge @dsh-cove/dsh-codex-bridge plugin ran a host half inside the dsh
 * web process: it spawns/adopts the standalone dsh-api-proxy service that
 * turns the ChatGPT Codex login into an OpenAI-compatible API, checks the
 * Codex CLI auth file, drives a device-code login when no valid credential
 * exists, and automatically registers the proxy as a `llm-pi-ai` provider
 * route so DSH can use codex models from the model picker. The browser half
 * (src/client/settings/codex-bridge) renders the restored status/login card.
 *
 * Ported into the dsh-web-all host services with the import layout adapted:
 * the `dsh-codex-bridge` settings namespace is owned by the
 * settings-experiences service (schema identical to the old host Config), so
 * the bridge reads its live document value at boot instead of installing a
 * section of its own. The /api/dsh-codex-bridge route family, the bridge
 * process management and the device-code flow keep the original envelopes
 * and semantics; edits in the settings form take effect on the next harness
 * restart, exactly like the old package.
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { familyNamespace } from '../family-config.ts'
import { ApiProxyBridge } from './bridge.ts'
import { makeRoutes } from './routes.ts'
import { checkCodexAuth } from './codex-auth.ts'
import { registerProvider } from './dsh-integration.ts'
import { registerResources } from '../resources.ts'

/** Settings namespace of this capability (owned by settings-experiences). */
export const CODEX_BRIDGE_SETTINGS_NAMESPACE = 'dsh-codex-bridge'

/** Environment variable override for the proxy directory. */
const PROXY_DIR_ENV = 'DSH_CODEX_PROXY_DIR'

/** Default codex auth file location (the Codex CLI's own). */
const DEFAULT_AUTH_FILE = '~/.codex/auth.json'

/** Settings the bridge reads at boot (mirrors the old host Config). */
export interface CodexBridgeServiceConfig {
  /** Master switch. */
  enabled?: boolean
  /**
   * Directory containing the dsh-api-proxy npm project (dist/index.js +
   * build/install scripts). Defaults to `$DSH_CODEX_PROXY_DIR`, then the
   * assembler fallback, then `<cwd>/tools/dsh-api-proxy`.
   */
  proxyDir?: string
  /** Loopback bind address of the proxy service. */
  host?: string
  /** Port of the proxy service. */
  port?: number
  /** Codex CLI auth file the proxy reads and the login flow writes. */
  authFile?: string
  /** Spawn/adopt the proxy and provision the DSH provider automatically. */
  autoStart?: boolean
  /** Register the provider into `llm-pi-ai` once codex auth exists. */
  autoRegister?: boolean
}

/** Assembler-supplied seams. */
export interface CodexBridgeServiceDeps {
  /** Fallback proxy directory (used when no config/env value names one). */
  proxyDir?: string
  logger?: { warn(error: unknown): void }
}

/** Read the live `dsh-codex-bridge` namespace value, when served. */
function liveConfig(ctx: Context): CodexBridgeServiceConfig | undefined {
  void ctx
  return familyNamespace<CodexBridgeServiceConfig>(CODEX_BRIDGE_SETTINGS_NAMESPACE)
}

/** Resolve the proxy directory in the old precedence: config, env, deps, cwd default. */
function resolveProxyDir(config: CodexBridgeServiceConfig, deps: CodexBridgeServiceDeps): string {
  if (config.proxyDir) return config.proxyDir
  const fromEnv = process.env[PROXY_DIR_ENV]
  if (fromEnv) return fromEnv
  if (deps.proxyDir) return deps.proxyDir
  return join(process.cwd(), 'tools', 'dsh-api-proxy')
}

/**
 * Provision the whole chain: ensure the proxy runs, and when codex auth is
 * valid, register the provider into DSH.
 */
async function provision(
  bridge: ApiProxyBridge,
  ctx: Context,
  autoRegister: boolean,
): Promise<{ started: boolean; registered: boolean; models: string[] }> {
  await bridge.start()
  if (!autoRegister) return { started: true, registered: false, models: [] }
  const models = await bridge.listModels()
  if (models.length === 0) {
    return { started: true, registered: false, models: [] }
  }
  await registerProvider(ctx, bridge.baseURL, bridge.apiKey(), models)
  return { started: true, registered: true, models }
}

/**
 * 服务域注册入口：读取 dsh-codex-bridge 设置分区，挂载路由，并在存在有效
 * codex 凭据时启动代理与 provider 注册（与旧包 apply 一致；设置改动重启生效）。
 * @param ctx - host plugin context。
 * @param deps - 装配器提供的回退目录与日志缝隙。
 * @returns 统一 disposer。
 */
export function register(ctx: Context, deps: CodexBridgeServiceDeps = {}): () => void {
  const warn = deps.logger?.warn ?? ((error: unknown): void => console.warn('[web-all:codex-bridge]', error))
  const config: CodexBridgeServiceConfig = liveConfig(ctx) ?? {}
  if (config.enabled === false) return () => {}

  const authFile = config.authFile ?? DEFAULT_AUTH_FILE
  const autoRegister = config.autoRegister ?? true
  const bridge = new ApiProxyBridge({
    proxyDir: resolveProxyDir(config, deps),
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 8317,
    authFile,
  })

  const onLoginComplete = async (): Promise<void> => {
    try {
      await provision(bridge, ctx, autoRegister)
    } catch (error) {
      warn(error)
    }
  }

  return registerResources(own => {
    own(() => { bridge.stop() })
    const routes = makeRoutes({ bridge, ctx, authFile, onLoginComplete })
    for (const route of routes) own(ctx.webServer.register(route))

    // Boot-time provisioning: no codex credential means no point starting the
    // proxy — the settings card offers the device-code login instead.
    if (config.autoStart ?? true) {
      const auth = checkCodexAuth(authFile)
      if (auth.valid) {
        void provision(bridge, ctx, autoRegister).catch((error) => {
          warn(error)
        })
      }
    }

  })
}
