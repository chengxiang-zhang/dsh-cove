/**
 * memory-view 宿主侧连接配置：环境变量优先，其次 `~/.openviking/ovcli.conf`。
 *
 * 这份配置只属于宿主半区：地址与 API key 出现在宿主到 OpenViking 的请求里，
 * 不下发浏览器、不进日志、不进响应。面板只需要知道「连上了没有」。
 *
 * 环境变量优先，是为了让测试台或容器里的同一个构建指向另一台服务，而不必
 * 改用户主目录下的配置文件。
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 未配置 `user` 时的默认命名空间。 */
export const DEFAULT_MEMORY_VIEW_USER = 'admin'

/** `ovcli.conf` 相对 home 的路径。 */
export const OPENVIKING_CONF_RELATIVE_PATH = join('.openviking', 'ovcli.conf')

/** 配置文件读取上限：超过这个大小的文件不解析（配置不可能这么大）。 */
const MAX_CONF_BYTES = 1 << 20

/** 解析出的连接设置。 */
export interface MemoryViewConfig {
  /** 服务地址，已去掉末尾斜杠并剥掉 userinfo；未配置时为空串。 */
  url: string
  /** Bearer token；未配置时为 `null`。永不打印、永不返回。 */
  apiKey: string | null
  /** OpenViking 账号；未配置时为 `null`。 */
  account: string | null
  /** OpenViking 用户命名空间，默认 `admin`。 */
  user: string
}

/** 配置解析的可注入缝隙（测试不读真实主目录与环境）。 */
export interface MemoryViewConfigSeams {
  /** 环境变量表；默认 `process.env`。 */
  env?: NodeJS.ProcessEnv
  /** 存放 `.openviking/ovcli.conf` 的主目录；默认 OS 主目录。 */
  homeDir?: string
}

/** 取第一个非空字符串。 */
function firstText(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed !== '') return trimmed
  }
  return null
}

/** 读取 JSON 字段里的字符串；非字符串按缺失处理。 */
function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

/** 规整服务地址：只接受 http(s)，剥掉 userinfo/查询串与末尾斜杠。 */
function normalizeServerUrl(value: string | null): string {
  if (value === null) return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    // 地址里的凭据不是服务身份：留在配置里只会被回显进状态接口。
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
  } catch {
    return ''
  }
}

/**
 * 读取 `ovcli.conf`；文件缺失、不可读、过大或不是 JSON 对象时返回空对象。
 * 解析失败不是错误：调用方按「未配置」处理，面板显示一句配置提示。
 * @param homeDir - 主目录；默认 OS 主目录。
 * @returns 配置文件里的 JSON 对象（永不抛异常）。
 */
export function readOvcliConf(homeDir: string = homedir()): Record<string, unknown> {
  const path = join(homeDir, OPENVIKING_CONF_RELATIVE_PATH)
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size > MAX_CONF_BYTES) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/**
 * 解析连接设置：环境变量优先，其次配置文件，`user` 兜底 `admin`。
 * @param seams - 环境变量表与主目录（测试注入）。
 * @returns 规整后的连接设置；缺少地址或 key 时 `url === ''` 或 `apiKey === null`。
 */
export function resolveMemoryViewConfig(seams: MemoryViewConfigSeams = {}): MemoryViewConfig {
  const env = seams.env ?? process.env
  const file = readOvcliConf(seams.homeDir)
  return {
    url: normalizeServerUrl(firstText([env['OPENVIKING_URL'], env['OPENVIKING_BASE_URL'], textField(file, 'url')])),
    apiKey: firstText([env['OPENVIKING_API_KEY'], textField(file, 'api_key')]),
    account: firstText([env['OPENVIKING_ACCOUNT'], textField(file, 'account')]),
    user: firstText([env['OPENVIKING_USER'], textField(file, 'user')]) ?? DEFAULT_MEMORY_VIEW_USER,
  }
}

/** 地址与 key 都齐了才算配置完成。 */
export function isMemoryViewConfigured(config: MemoryViewConfig): boolean {
  return config.url !== '' && config.apiKey !== null && config.apiKey !== ''
}