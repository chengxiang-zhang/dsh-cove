/**
 * 记忆查看服务域（只读 OpenViking 代理）的注册入口。
 *
 * 这个域只做三件事：把浏览器请求代理成 OpenViking 的三个只读调用、用宿主
 * 自己的 git 推导工作区 peer、用共享宿主围栏挡住非授权请求。它不落本地存储，
 * 也不写回记忆——记忆本体始终是 OpenViking 插件写入的那一份。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { MemoryViewClient, type MemoryViewClientLike } from './client.ts'
import { resolveMemoryViewConfig, type MemoryViewConfig, type MemoryViewConfigSeams } from './config.ts'
import { resolveWorkspacePeer, type GitCommandRunner } from './peer.ts'
import { registerMemoryViewRoutes, type MemoryViewRouteOptions } from './routes.ts'

/** 单条 git 命令的收集上限（与其它域一致）。 */
const OUTPUT_CAP_BYTES = 1 << 20

/** git 子进程的宽限时间：硬超时由 peer 推导自己控制。 */
const GIT_GRACE_MS = 5000

/** 记忆查看服务域的可注入缝隙（测试用，生产不传）。 */
export interface MemoryViewServiceOptions {
  /** 存放 `.openviking/ovcli.conf` 的主目录。 */
  homeDir?: string
  /** 环境变量表。 */
  env?: NodeJS.ProcessEnv
  /** git 执行缝隙；`null` 表示不跑 git（工作区身份记为未能判断）。 */
  runner?: GitCommandRunner | null
  /** 客户端工厂。 */
  createClient?: (config: MemoryViewConfig) => MemoryViewClientLike
  /** 连接设置解析；缺省每次请求读环境变量与配置文件。 */
  resolveConfig?: () => MemoryViewConfig
}

/** 生产 git 执行缝隙：一条命令一个受管子进程，信号直达子进程树。 */
function subprocessGitRunner(ctx: Context): GitCommandRunner {
  return {
    async run(argv, cwd, signal) {
      signal?.throwIfAborted()
      const processHandle = ctx.subprocess.spawn({
        argv: [process.platform === 'win32' ? 'git.exe' : 'git', ...argv],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: OUTPUT_CAP_BYTES },
          stderr: { maxBytes: OUTPUT_CAP_BYTES },
        },
        graceMs: GIT_GRACE_MS,
        signal,
      })
      const result = await processHandle.done
      signal?.throwIfAborted()
      return {
        exitCode: result.exitCode,
        stdout: processHandle.collected.stdout?.readFrom(0).text ?? '',
        stderr: processHandle.collected.stderr?.readFrom(0).text ?? '',
      }
    },
  }
}

/**
 * 挂载记忆查看服务域。
 * @param ctx - 宿主插件上下文。
 * @param options - 可注入缝隙（测试用）。
 * @returns 释放已登记路由的 disposer。
 */
export function register(ctx: Context, options: MemoryViewServiceOptions = {}): () => void {
  const runner = options.runner !== undefined ? options.runner : subprocessGitRunner(ctx)
  const seams: MemoryViewConfigSeams = { homeDir: options.homeDir, env: options.env }
  const routeOptions: MemoryViewRouteOptions = {
    resolveConfig: options.resolveConfig ?? (() => resolveMemoryViewConfig(seams)),
    createClient: options.createClient ?? (config => new MemoryViewClient({
      url: config.url,
      apiKey: config.apiKey ?? '',
      account: config.account,
      user: config.user,
    })),
    resolvePeer: cwd => resolveWorkspacePeer(cwd, runner),
    logger: (message) => {
      try {
        ctx.logger('web-all:memory-view').warn(message)
      } catch {
        console.warn(message)
      }
    },
  }
  return registerMemoryViewRoutes(ctx, routeOptions)
}

export { MemoryViewClient } from './client.ts'
export type { MemoryViewClientLike } from './client.ts'
export type { MemoryViewConfig, MemoryViewConfigSeams } from './config.ts'
export type { GitCommandRunner, PeerResolution } from './peer.ts'
export { resolveMemoryViewConfig } from './config.ts'
export { MEMORY_VIEW_API_PREFIX } from '../../../core/memory-view/protocol.ts'