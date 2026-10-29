/**
 * DSH integration for the codex-bridge service domain: registers the codex
 * proxy as a `llm-pi-ai` provider route and stores the client api key in the
 * DSH credential store. Both writes are live — pi-ai settings apply with no
 * restart, and the credentials file reloads through its own watcher.
 *
 * Ported from the pre-merge @dsh-cove/dsh-codex-bridge package
 * (src/dsh-integration.ts) into the dsh-web-all host services. Deviation
 * forced by the dependency layout: the old module value-imported
 * `credentialRef` from `@deepseek-ai/dsh-credentials`, which is not a
 * dependency of the entity package. `credentialRef` only brands an
 * environment-variable name; the runtime value is that plain string, so the
 * reference is passed through a structural `ctx.credentials` seam exactly
 * like the media-gen service domain does.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'

/** Credential reference name the pi-ai profile points at. */
export const PROXY_KEY_REF = 'DSH_API_PROXY_KEY'

/** Provider route registered into llm-pi-ai. */
export const PROVIDER_ROUTE = 'codex-local'

/** Wire protocol of the proxy. */
export const PROXY_API = 'openai-completions'

/**
 * Models the codex backend advertises but that are not usable chat targets.
 * `gpt-reserve` and `codex-auto-review` stay excluded at every CLI version.
 */
const EXCLUDED_MODELS = new Set(['gpt-reserve', 'codex-auto-review'])

// gpt-5*/gpt-6* (the codex model families the ChatGPT backend serves), o\d*
// (o3, o4-mini), codex-* — but NOT legacy gpt-3/gpt-4* and not the excluded
// slugs. The family gate must stay in sync with the proxy's own codex route
// regex (tools/dsh-api-proxy/src/providers/codex.ts MODEL_RE); upstream
// version-gates visibility (gpt-6 requires client_version >= 0.162.0), and
// the bridge only ever sees models the proxy's live list already resolved.
export function serviceableModels(modelIds: string[]): string[] {
  return modelIds
    .filter((id) => !EXCLUDED_MODELS.has(id))
    .filter((id) => /^(gpt-[56]|o\d|codex-)/i.test(id))
}

export interface CodexProviderProfile {
  displayName: string
  apiKeyEnv: string
  api: string
  baseURL: string
  reasoning: 'off' | 'low' | 'medium' | 'high'
  defaultContextWindow: number
  defaultMaxTokens: number
  models: Array<{
    id: string
    name: string
    contextWindow: number
    maxTokens: number
    input: string[]
    reasoningEfforts: Record<string, string | null>
  }>
}

/**
 * Build the pi-ai provider profile for one codex model list. Reasoning
 * efforts mirror the OpenAI codex-model vocabulary (low/medium/high, shared
 * by the gpt-5.x and gpt-6.x families); omitting `max` keeps the upstream
 * from receiving an unsupported value.
 */
export function buildProviderProfile(baseURL: string, modelIds: string[]): CodexProviderProfile {
  const models = serviceableModels(modelIds).map((id) => ({
    id,
    name: id,
    contextWindow: 400_000,
    maxTokens: 32_768,
    input: ['text'],
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } as Record<
      string,
      string | null
    >,
  }))
  return {
    displayName: 'Codex (local proxy)',
    apiKeyEnv: PROXY_KEY_REF,
    api: PROXY_API,
    baseURL,
    reasoning: 'high',
    defaultContextWindow: 400_000,
    defaultMaxTokens: 32_768,
    models,
  }
}

export interface RegisterResult {
  registered: boolean
  keyStored: boolean
  models: string[]
}

/** The credential-reference half of the ctx.credentials seam. */
interface CredentialSeam {
  set?: (ref: string, value: string) => Promise<unknown>
}

/** 可选读取 credentials 缝隙：0.2 严格注入下访问未声明的服务会直接抛错。 */
function optionalCredentials(ctx: Context): CredentialSeam | undefined {
  try {
    return (ctx as Context & { credentials?: CredentialSeam }).credentials
  } catch {
    return undefined
  }
}

/**
 * credentials 服务就绪后再写入代理 key（一次性钩子）。
 * 0.2 里插件只有在自己的 inject 声明中才能访问服务，因此这里用局部 inject 等待，
 * 而不是在 registerProvider 里直接取属性；组合里没有该服务时静默跳过。
 */
function storeKeyWhenAvailable(ctx: Context, apiKey: string): void {
  try {
    ctx.inject(['credentials'], (cctx) => {
      const seam = (cctx as Context & { credentials?: CredentialSeam }).credentials
      if (seam?.set === undefined) return
      void seam.set(PROXY_KEY_REF, apiKey).catch(() => undefined)
    })
  } catch {
    // 该 profile 没有 credentials 服务：provider 仍然注册，key 交由环境变量或手工配置。
  }
}

/** The settings-write half of the ctx.settings seam. */
interface SettingsSeam {
  update?: (ns: string, patch: object) => Promise<unknown>
}

/**
 * Store the proxy api key in the DSH credential store and merge the
 * provider profile into the `llm-pi-ai` settings namespace. Live applies.
 */
export async function registerProvider(
  ctx: Context,
  baseURL: string,
  apiKey: string,
  modelIds: string[],
): Promise<RegisterResult> {
  const serviceable = serviceableModels(modelIds)
  if (serviceable.length === 0) {
    throw new Error('no serviceable codex models to register')
  }
  const credentials = optionalCredentials(ctx)
  let keyStored = false
  if (credentials?.set) {
    await credentials.set(PROXY_KEY_REF, apiKey)
    keyStored = true
  } else {
    // 0.2 严格注入：先不阻塞 provider 注册，等服务就绪后补写 key。
    storeKeyWhenAvailable(ctx, apiKey)
  }
  const settings = (ctx as Context & { settings?: SettingsSeam }).settings
  if (settings?.update) {
    await settings.update('llm-pi-ai', {
      providers: { [PROVIDER_ROUTE]: buildProviderProfile(baseURL, serviceable) },
    })
  } else {
    throw new Error('DSH settings service unavailable; cannot register the codex provider')
  }
  return { registered: true, keyStored, models: serviceable }
}
