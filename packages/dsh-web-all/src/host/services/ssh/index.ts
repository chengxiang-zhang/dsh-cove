/**
 * ssh host 服务域（全新实现；行为契约参考旧包）。
 *
 * 引擎（连接池/exec/shell/sftp/tunnel/cluster）+ store（主机配置）+
 * /api/dsh-ssh 路由族 + agent 工具（ssh_*）。注册入口 register(ctx, deps)，
 * 由 host 装配器统一调用。
 */
import type { Context } from '@deepseek-ai/cordis'
import { familyNamespace } from '../family-config.ts'
// Type-only: pulls the tools service Context merge (ctx.tools.register).
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { HostStore } from './store.ts'
import { SshEngine } from './engine.ts'
import { registerRoutes } from './routes.ts'
import { makeSshTools } from './tools.ts'
import { registerTerminalUpgrade } from './terminal-ws.ts'
import { registerResources } from '../resources.ts'

export { SSH_API, type SshHostEntry, type SshHostSummary, type ExecResult } from '../../../core/ssh/protocol.ts'
export { HostStore, storePath } from './store.ts'
export { SshEngine } from './engine.ts'

export const SSH_SETTINGS_NAMESPACE = 'dsh-ssh'
const SECTION_ORDER = 150

/** Model-facing announcement retained from the authoritative SSH package. */
export const SSH_GUIDANCE = '本机已安装 dsh-web-all 的 SSH 能力（DSH 远程 SSH 运维）：侧边栏「SSH」入口；实现在 packages/dsh-web-all/src/host/services/ssh 统一维护。能力：主机配置存 $DSH_HOME/dsh-ssh.json（默认 ~/.dsh）（可从 ~/.ssh/config 导入）；持久连接池复用长连接（空闲 30 分钟自动断开）；命令默认 120 秒超时，超时会终止远端命令（可用 timeoutMs 显式覆盖，长任务请调大）；ssh_list 列出主机、ssh_exec 执行远程命令、ssh_upload/ssh_download 传输文件、ssh_tunnel 本地端口转发（访问远程数据库/内网服务）、ssh_cluster 集群并发执行；支持密钥/密码与 passphrase；agent 模式仅探测默认私钥，未连接真实 ssh-agent；ProxyJump 当前拒绝使用。服务器密钥必须匹配宿主 known_hosts 或经用户可信渠道核验的 SHA256 pin，未知或变化密钥拒绝连接，禁止自动接受首次扫描；Web 终端走 WebSocket。限制：主机操作由用户在 GUI 中配置后 agent 方可使用；密码以明文存在用户主目录私有文件（权限 0600）；命令输出原样返回、可能含敏感信息；断线重连可能重放非幂等命令；传输/执行消耗真实远程资源，先确认再操作。路径区分：本机（dsh host）上的文件与命令一律用本地工具（read / write / edit / bash），ssh_* 工具只针对远程主机上的路径。用户提到「SSH / 远程服务器 / 服务器操作 / 跳板机 / 隧道 / 部署 / 上传下载」时即指此能力，请据此协作。'

export interface SshServiceConfig {
  enabled?: boolean
  announceToAgent?: boolean
  /** 默认命令超时毫秒（exec / cluster 未显式传 timeoutMs 时使用；缺省为引擎默认值）。 */
  execTimeoutMs?: number
}

/** 服务域依赖。 */
export interface SshServiceDeps {
  /** 主机配置存储路径（默认 $DSH_HOME/dsh-ssh.json）。 */
  storePath?: string
  /** 引擎空闲回收毫秒（默认 30min）。 */
  idleTimeoutMs?: number
  /** 引擎默认命令超时毫秒（设置命名空间未给时生效；默认见 DEFAULT_EXEC_TIMEOUT_MS）。 */
  execTimeoutMs?: number
  /** Composition fallback until the settings owner scope is available. */
  config?: SshServiceConfig
  /** 日志。 */
  logger?: { warn(error: unknown): void }
}

/** 服务域注册入口；返回统一 disposer。 */
export function register(ctx: Context, deps: SshServiceDeps = {}): () => void {
  const logger = deps.logger ?? { warn: (error: unknown) => { console.warn('[web-all:ssh]', error) } }
  const store = new HostStore(deps.storePath)
  const current = (): SshServiceConfig => familyNamespace<SshServiceConfig>(SSH_SETTINGS_NAMESPACE) ?? deps.config ?? {}
  // 默认命令超时按次求值：设置文档热更新后无需重挂插件即生效。
  const engine = new SshEngine(store, {
    idleTimeoutMs: deps.idleTimeoutMs,
    execTimeoutMs: () => current().execTimeoutMs ?? deps.execTimeoutMs,
  })
  let disposeSurfaces: (() => void) | undefined

  const sync = (): void => {
    disposeSurfaces?.()
    disposeSurfaces = undefined
    const value = current()
    if ((value.enabled ?? true) === false) return

    disposeSurfaces = registerResources(own => {
      own(registerRoutes(ctx, { store, engine, logger }))
      own(registerTerminalUpgrade(ctx, { engine, store }))
      for (const tool of makeSshTools(engine, store)) own(ctx.tools.register(tool))
      if (value.announceToAgent ?? false) {
        own(ctx.systemPrompt.section({ name: 'plugin:dsh-ssh', order: SECTION_ORDER, text: SSH_GUIDANCE }))
      }
    })
  }

  return registerResources(own => {
    own(() => engine.dispose())
    own(() => { disposeSurfaces?.() })
    sync()
  })
}