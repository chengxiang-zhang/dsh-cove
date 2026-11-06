/**
 * memory-view 工作区 peer 推导：浏览器给的 `cwd` 只是目录输入，身份由宿主自己
 * 用 git 推出来。
 *
 * 顺序与 OpenViking 插件模板一致：`remote.origin.url` 归一化优先，仓库没有
 * remote 时退回仓库根路径，两者都不成立（不在 git 仓库里）则退回全局空间。
 * 客户端回传的任何身份字段都不参与判定，所以伪造 `cwd` 只能读到那个目录自己
 * 的 peer 空间。
 */
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  workspacePeerFromRemote, workspacePeerFromRoot, type MemoryWorkspaceState,
} from '../../../core/memory-view/protocol.ts'

/** peer 来源，与契约 `MemoryWorkspaceState['source']` 同一套字面量。 */
export type PeerSource = MemoryWorkspaceState['source']

/** 一次 git 调用的结果，形状与 `shared/host/git-runner.ts` 的 `GitRunResult` 兼容。 */
export interface GitCommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** 宿主侧 git 执行缝隙；生产实现由 `ctx.subprocess` 提供。 */
export interface GitCommandRunner {
  run(argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitCommandResult>
}

/** 单次 git 调用的硬超时：推导 peer 是页面首屏路径，不能拖住面板。 */
export const PEER_GIT_TIMEOUT_MS = 3000

/** `cwd` 长度上限（普通路径，几百字节足够）。 */
export const MAX_CWD_LENGTH = 4096

/** 读 git remote 的固定 argv。 */
export const GIT_REMOTE_URL_ARGV: readonly string[] = ['config', '--get', 'remote.origin.url']

/** 读仓库根的固定 argv。 */
export const GIT_TOP_LEVEL_ARGV: readonly string[] = ['rev-parse', '--show-toplevel']

/** `cwd` 参数判定：要么没有，要么是存在的绝对目录。 */
export type CwdVerdict = { ok: true; cwd: string | null } | { ok: false }

/** 一次 peer 推导的结果。 */
export interface PeerResolution {
  /** 参与推导的目录；没有目录时为 `null`。 */
  cwd: string | null
  /** 推导出的 peer；推导不出时为 `null`。 */
  peer: string | null
  /** peer 的来源。 */
  source: PeerSource
}

/** 一次 git 尝试。`ok` 为假表示 git 本身跑不起来（与「跑了但失败」不同）。 */
interface GitAttempt {
  ok: boolean
  timedOut: boolean
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * 判定浏览器给的 `cwd`：缺省或空串表示「没有目录」，非法则整条请求按格式
 * 错误拒绝，而不是静默退回全局空间（那会把别人的空间当成自己的读）。
 * @param value - 原始查询参数值。
 * @returns 判定结果；`ok` 为假表示参数存在但不合法。
 */
export function parseCwd(value: string | null | undefined): CwdVerdict {
  if (value === null || value === undefined) return { ok: true, cwd: null }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: true, cwd: null }
  if (trimmed.length > MAX_CWD_LENGTH) return { ok: false }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) return { ok: false }
  if (!isAbsolute(trimmed)) return { ok: false }
  try {
    // 目录已经被删掉（worktree 收尾后就常见）不是客户端错误：`cwd` 只是目录
    // 选择器，选不中就是「没有工作区」，面板照常退回全局空间并给出提示。
    if (!statSync(trimmed).isDirectory()) return { ok: true, cwd: null }
  } catch {
    return { ok: true, cwd: null }
  }
  return { ok: true, cwd: trimmed }
}

/**
 * 跑一次 git，带硬超时：即使执行缝隙不理会 abort 信号，超时也会让这次调用
 * 返回，不会让请求挂住。
 */
async function runGit(
  runner: GitCommandRunner,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<GitAttempt> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<GitAttempt>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ ok: false, timedOut: true, exitCode: null, stdout: '', stderr: '' })
    }, timeoutMs)
  })
  const attempt = runner.run(argv, cwd, controller.signal).then(
    (result): GitAttempt => ({ ok: true, timedOut: false, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }),
    (): GitAttempt => ({ ok: false, timedOut: false, exitCode: null, stdout: '', stderr: '' }),
  )
  try {
    return await Promise.race([attempt, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 由目录推导工作区 peer。
 * @param cwd - 已校验的绝对目录，或 `null`。
 * @param runner - git 执行缝隙；缺省时按「未能判断」处理。
 * @param timeoutMs - 单次 git 调用的硬超时。
 * @returns 推导结果；`source` 为 `unknown` 表示没有目录或 git 不可用。
 */
export async function resolveWorkspacePeer(
  cwd: string | null,
  runner: GitCommandRunner | null | undefined,
  timeoutMs: number = PEER_GIT_TIMEOUT_MS,
): Promise<PeerResolution> {
  if (cwd === null || cwd === undefined) return { cwd: null, peer: null, source: 'unknown' }
  if (runner === null || runner === undefined) return { cwd, peer: null, source: 'unknown' }
  const remote = await runGit(runner, GIT_REMOTE_URL_ARGV, cwd, timeoutMs)
  if (!remote.ok) return { cwd, peer: null, source: 'unknown' }
  if (remote.exitCode === 0) {
    const peer = workspacePeerFromRemote(remote.stdout.trim())
    if (peer !== '') return { cwd, peer, source: 'git-remote' }
  }
  const topLevel = await runGit(runner, GIT_TOP_LEVEL_ARGV, cwd, timeoutMs)
  if (!topLevel.ok) return { cwd, peer: null, source: 'unknown' }
  if (topLevel.exitCode !== 0) return { cwd, peer: null, source: 'none' }
  const root = topLevel.stdout.trim()
  if (root === '') return { cwd, peer: null, source: 'none' }
  const peer = workspacePeerFromRoot(root)
  return peer === '' ? { cwd, peer: null, source: 'none' } : { cwd, peer, source: 'git-root' }
}