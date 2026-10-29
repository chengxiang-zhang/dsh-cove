/**
 * dsh-web-all — host half.
 *
 * dsh-cove 的唯一运行时实体。host 半区按服务域组织（src/host/services/*），
 * 每个服务域导出一个 register(ctx) 注册函数，由本文件统一装配；
 * cordis.patch.yml 只有一行 `web-all`。
 *
 * 服务域不按能力对外暴露插件边界：路由前缀（/api/dsh-ssh 等）、agent 工具名
 * （ssh_exec 等）、settings namespace（dsh-ssh 等）保持不变，仅注册入口收敛。
 */
import type { Context } from '@deepseek-ai/cordis'
import { assembleServices } from './host/services/index.ts'
import { bindFamilyConfig, createFamilyConfig, notifyFamilyConfigChange } from './host/services/family-config.ts'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'web-all'

/**
 * Services the host half needs before any service domain can mount.
 * 每个服务域会声明自己的额外依赖；装配器把 ctx 完整交给它们。
 */
export const inject = [
  'webServer',
  'tools',
  'systemPrompt',
  'settings',
  'sessions',
  'sessionController',
  'workspaceController',
  'workspaceRegistry',
  'connection',
  'subprocess',
  'fs',
  'agentPresets',
  'commands',
  'agents',
] as const

/**
 * 插件 config 类型面（运行时的权威 schema 是下面导出的 `Config`）。
 * 命名空间键（doctor / remote-web-ui / dsh-ssh / …）即各能力域的设置命名空间。
 */
export interface Config extends Record<string, unknown> {
  /** 用户 dsh 配置根（默认 $DSH_HOME 或 ~/.dsh）。 */
  dshHome?: string
  /** 用户 agents 配置根（默认 $DSH_AGENTS_HOME 或 ~/.agents）。 */
  agentsHome?: string
  /** Worktree PR credential reference. */
  worktree?: import('./host/services/worktree/index.ts').WorktreeServiceConfig
  /** Playwright sessions service options (profile overridable; `liveView` enables the agent-browser live view). */
  playwright?: import('./core/playwright-sessions/contracts.ts').PlaywrightSessionsConfig
  /** 跳过 BrowserAuth token/cookie 检查；仅可信反向代理或局域网显式启用。 */
  noBrowserAuth?: boolean
}

/**
 * 运行时 Config（0.2 原生设置模型的入口）：聚合条目 = 装配参数 + 每个能力域的
 * 设置命名空间（volatile）。导出后该条目才会出现在原生设置文档里，家族设置
 * 才能被读写而不必重挂插件。构建时机必须在装配器 import 求值之后——见
 * `createFamilyConfig` 的注释。
 */
export const Config = createFamilyConfig()

/**
 * Application entry：装配全部 host 服务域。
 * @param ctx - host plugin context。
 */
export function apply(ctx: Context, config?: Config): void {
  // 绑定 loader 解析后的聚合 config：volatile 节点是引用，设置变更会原地热更新。
  bindFamilyConfig(config)
  // 设置变更扇出：注册时读一次的服务域据此重新 sync（无需重挂插件）。
  ctx.effect(() => {
    const off = (ctx as unknown as { on?: (event: string, listener: () => void) => (() => void) | undefined }).on?.('loader/volatile-update', () => { notifyFamilyConfigChange() })
    const offSettings = (ctx as unknown as { on?: (event: string, listener: () => void) => (() => void) | undefined }).on?.('settings/document-updated', () => { notifyFamilyConfigChange() })
    return () => { off?.(); offSettings?.() }
  }, 'web-all: settings change fan-out')
  ctx.effect(async () => assembleServices(ctx, {
    dshHome: config?.dshHome,
    agentsHome: config?.agentsHome,
    noBrowserAuth: config?.noBrowserAuth,
    worktree: config?.worktree,
    playwright: config?.playwright,
  }), 'web-all: host services')
}