/**
 * memory-view 跨半区 wire 契约（host 与 client 双 program 编译）。
 *
 * 记忆查看面板是 OpenViking 记忆的**只读**产品面：它不落任何本地存储，
 * 也不写回记忆，所有数据都来自运行中的 OpenViking 服务
 * （`~/.openviking/ovcli.conf` 指向那一份）。宿主服务负责把
 * `viking://user/<user>/memories`（全局）与
 * `viking://user/<user>/peers/<peer>/memories`（当前工作区）代理成只读 JSON；
 * 浏览器半区只做展示。
 *
 * 这个文件只放常量、纯类型和纯函数：不 import `node:*`，不 import
 * `@deepseek-ai/*`，两边都能加载。
 */

/** 路由前缀。所有只读端点都挂在这个前缀下。 */
export const MEMORY_VIEW_API_PREFIX = '/api/dsh-memory'

/**
 * 记忆作用域。
 *
 * - `global`：`viking://user/<user>/memories/` —— 跨仓库共享的用户级记忆。
 * - `workspace`：`viking://user/<user>/peers/<peer>/memories/` —— 按仓库
 *   （git remote 归一化后的 peer）分空间的记忆；没有 git 仓库的工作区退回
 *   全局空间，此时 `workspace.peer` 为 `null`。
 */
export type MemoryScope = 'global' | 'workspace'

/** 允许的作用域字面量；同时用于运行时校验。 */
export const MEMORY_SCOPES: readonly MemoryScope[] = ['global', 'workspace']

/** 一个目录项。字段与 OpenViking `GET /api/v1/fs/ls` 的 result 元素同名。 */
export interface MemoryNode {
  /** 完整 viking URI。 */
  uri: string
  /** 展示名（uri 的末段）。 */
  name: string
  /** 是否目录。 */
  isDir: boolean
  /** 字节数；目录为 0。 */
  size: number
  /** OpenViking 侧修改时间（ISO 8601）。 */
  modTime: string
  /** 已在 OpenViking 生成摘要时的一行摘要。 */
  abstract?: string
}

/** 一次目录列举的结果。 */
export interface MemoryListing {
  /** 列举的是哪个作用域。 */
  scope: MemoryScope
  /** 该作用域的根 URI。 */
  root: string
  /** 本次列举的目录 URI（根或根下子目录）。 */
  uri: string
  /** 直接子项，目录在前、文件在后，同类按名称升序。 */
  nodes: MemoryNode[]
}

/** 一份记忆文档。 */
export interface MemoryDocument {
  /** 文档 URI。 */
  uri: string
  /** 展示名。 */
  name: string
  /** 原文（Markdown / 纯文本）。 */
  text: string
}

/** 一条检索命中。 */
export interface MemoryHit {
  /** 命中项 URI。 */
  uri: string
  /** 展示名。 */
  name: string
  /** 相似度分数，0..1。 */
  score: number
  /** 摘要或正文片段。 */
  abstract: string
  /** OpenViking 标签（如 `memory_type=preferences`）。 */
  tags?: string[]
}

/** 一次检索的结果。 */
export interface MemorySearchResult {
  /** 原始查询串。 */
  query: string
  /** 检索限定的作用域；`all` 表示全局空间加当前工作区。 */
  scope: MemoryScope | 'all'
  /** 按分数降序的命中。 */
  hits: MemoryHit[]
}

/** OpenViking 连接状态。 */
export interface MemoryConnectionState {
  /** 服务可达且授权通过。 */
  connected: boolean
  /** 服务地址（来自 ovcli.conf 或环境变量）。 */
  server: string
  /** 账号（未配置时省略）。 */
  account?: string
  /** 用户（默认 `admin`）。 */
  user: string
  /** 连接失败时的原因；成功时省略。 */
  error?: string
}

/** 当前工作区的记忆身份。 */
export interface MemoryWorkspaceState {
  /** 请求携带的工作目录；没有时 `null`。 */
  cwd: string | null
  /** 由 git remote 归一化出的 peer；解析不出时 `null`。 */
  peer: string | null
  /** 工作区记忆根 URI；`peer` 为 `null` 时省略。 */
  memoryUri?: string
  /**
   * peer 的来源：
   * - `git-remote`：`remote.origin.url` 归一化；
   * - `git-root`：仓库没有 remote，用仓库根路径；
   * - `none`：不在 git 仓库里，记忆退回全局空间；
   * - `unknown`：未能判断（cwd 缺失或 git 不可用）。
   */
  source: 'git-remote' | 'git-root' | 'none' | 'unknown'
}

/** `GET <prefix>/status` 的返回。 */
export interface MemoryStatus {
  connection: MemoryConnectionState
  workspace: MemoryWorkspaceState
}

/** 失败码。客户端按码决定文案，不解析 message。 */
export type MemoryErrorCode =
  | 'not-configured'
  | 'unreachable'
  | 'unauthorized'
  | 'malformed'
  | 'forbidden'
  | 'not-found'
  | 'internal'

/** 失败体。 */
export interface MemoryError {
  code: MemoryErrorCode
  message: string
}

/** 所有端点的统一信封。 */
export type MemoryEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: MemoryError }

/**
 * 端点契约（全部只读，全部经宿主访问围栏）：
 *
 * | 方法 | 路径 | 参数 | 返回 |
 * | --- | --- | --- | --- |
 * | GET | `<prefix>/status` | `cwd?` | `MemoryEnvelope<MemoryStatus>` |
 * | GET | `<prefix>/list` | `scope`，`path?`（根下相对路径），`cwd?` | `MemoryEnvelope<MemoryListing>` |
 * | GET | `<prefix>/read` | `uri`，`cwd?` | `MemoryEnvelope<MemoryDocument>` |
 * | POST | `<prefix>/search` | body `{ query, scope?, limit? }`，`cwd?` | `MemoryEnvelope<MemorySearchResult>` |
 *
 * `cwd` 由浏览器给出，宿主**必须**自己重新推导 peer 并据此校验 URI 归属；
 * 客户端给不出可信的 peer，永远不要相信回传的 `cwd` 之外的任何身份。
 */

/** URI 方案前缀。 */
export const VIKING_SCHEME = 'viking://'

/** 单个路径段的最大长度（服务端 identifier part 上限是 100，留余量）。 */
const MAX_SEGMENT_LENGTH = 100

/** 一次 URI 的最大长度。 */
export const MAX_URI_LENGTH = 1024

/** 一次相对路径的最大长度。 */
export const MAX_RELATIVE_PATH_LENGTH = 512

/** 是否是合法作用域字面量。 */
export function isMemoryScope(value: unknown): value is MemoryScope {
  return value === 'global' || value === 'workspace'
}

/** 是否是 `viking://` URI。 */
export function isVikingUri(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(VIKING_SCHEME)
}

/**
 * 全局记忆根。
 *
 * `user` 会被规整流：OpenViking 的用户段不接受 `:` `/` 等字符，直接拼进去
 * 只会拿到 404，规整后至少给出确定的失败。
 */
export function userMemoriesUri(user: string): string {
  return `${VIKING_SCHEME}user/${sanitizeSegment(user)}/memories`
}

/** 工作区（peer）记忆根。 */
export function peerMemoriesUri(user: string, peer: string): string {
  return `${VIKING_SCHEME}user/${sanitizeSegment(user)}/peers/${sanitizeSegment(peer)}/memories`
}

/**
 * 一个作用域的根 URI。`workspace` 且没有 peer 时退回全局根 ——
 * 与 OpenViking 插件「非 git 目录不发送 peer，记忆落到用户空间」的行为一致。
 */
export function memoryRoot(scope: MemoryScope, user: string, peer: string | null): string {
  if (scope === 'workspace' && peer !== null && peer !== '') return peerMemoriesUri(user, peer)
  return userMemoriesUri(user)
}

/** 该作用域允许访问的全部根（`workspace` 无 peer 时与全局根相同）。 */
export function memoryRoots(scope: MemoryScope, user: string, peer: string | null): string[] {
  const roots = [userMemoriesUri(user)]
  if (scope === 'workspace' && peer !== null && peer !== '') roots.push(peerMemoriesUri(user, peer))
  return roots
}

/**
 * `uri` 是否等于 `root` 或位于其下（按段比较，`..` 一律视为越界）。
 *
 * 纯字符串前缀比较会让 `.../memories-evil` 命中 `.../memories`，所以这里按
 * 段边界判定，并且先拒绝任何带 `..`、反斜杠、控制字符或查询串的 URI。
 */
export function isUriUnder(uri: string, root: string): boolean {
  if (!isSafeVikingUri(uri) || !isSafeVikingUri(root)) return false
  const value = uri.replace(/\/+$/u, '')
  const base = root.replace(/\/+$/u, '')
  return value === base || value.startsWith(`${base}/`)
}

/** URI 是否安全：`viking://`、无控制字符、无反斜杠、无 `?`/`#`、无 `..` 段。 */
export function isSafeVikingUri(value: unknown): value is string {
  if (!isVikingUri(value)) return false
  if (value.length > MAX_URI_LENGTH) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false
  if (value.includes('\\') || value.includes('?') || value.includes('#')) return false
  const body = value.slice(VIKING_SCHEME.length)
  if (body === '' || body.startsWith('/')) return false
  const segments = body.split('/')
  if (segments.some(segment => segment === '' && segment !== segments[segments.length - 1])) return false
  return segments.every(segment => segment !== '..' && segment !== '.')
}

/**
 * 把「根 + 根下相对路径」拼成 URI；不合法返回 `null`。
 *
 * 相对路径是唯一允许由客户端给出的路径成分，因此单独校验：不许绝对路径、
 * 不许 `..`/`.` 段、不许反斜杠、控制字符、`?`/`#`，每段不超过上限。
 */
export function joinMemoryPath(root: string, relative: string): string | null {
  if (!isSafeVikingUri(root)) return null
  const trimmed = relative.trim()
  if (trimmed === '') return root
  if (trimmed.length > MAX_RELATIVE_PATH_LENGTH) return null
  if (trimmed.startsWith('/') || trimmed.includes('\\')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) return null
  if (trimmed.includes('?') || trimmed.includes('#')) return null
  const segments = trimmed.replace(/\/+$/u, '').split('/')
  if (segments.length === 0) return root
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null
    if (segment.length > MAX_SEGMENT_LENGTH) return null
  }
  return `${root.replace(/\/+$/u, '')}/${segments.join('/')}`
}

/** URI 的末段展示名。 */
export function uriName(uri: string): string {
  const body = uri.startsWith(VIKING_SCHEME) ? uri.slice(VIKING_SCHEME.length) : uri
  const segments = body.split('/').filter(segment => segment !== '')
  return segments.length === 0 ? uri : String(segments[segments.length - 1])
}

/** 父 URI；已经在根上时返回 `null`。 */
export function parentUri(uri: string): string | null {
  if (!isVikingUri(uri)) return null
  const trimmed = uri.replace(/\/+$/u, '')
  const index = trimmed.lastIndexOf('/')
  if (index <= VIKING_SCHEME.length) return null
  const parent = trimmed.slice(0, index)
  return parent === `${VIKING_SCHEME}user` ? null : parent
}

/**
 * `uri` 相对 `root` 的路径；不在根下时返回 `null`，正好等于根时返回 `''`。
 */
export function uriRelativeTo(uri: string, root: string): string | null {
  if (!isUriUnder(uri, root)) return null
  const base = root.replace(/\/+$/u, '')
  const value = uri.replace(/\/+$/u, '')
  if (value === base) return ''
  return value.slice(base.length + 1)
}

/**
 * 规整一个 URI 段：OpenViking 的 identifier part 只接受
 * `[a-zA-Z0-9_.@-]`，其余字节折叠成 `-`。
 *
 * 这是**展示层与请求路径**的规整；peer 的推导见 `sanitizePeerId`，那条规则
 * 必须与 OpenViking 插件逐字对齐，不能复用这一个。
 */
export function sanitizeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_.@-]+/gu, '-').replace(/-{2,}/gu, '-')
  return cleaned.replace(/^[-.]+|[-.]+$/gu, '')
}

/**
 * 把 git remote 归一化成 `host/path`（小写、去掉 userinfo 与 `.git`）。
 *
 * 与 OpenViking 插件 `normalizeGitRemote` 同一套结果：同一个仓库的 https 与
 * scp 两种写法必须落到同一个 peer，否则同一台机器上两种 clone 会各写一份记忆。
 * 归一化不出结果时返回 `''`，调用方退回仓库根路径。
 */
export function normalizeGitRemote(url: string): string {
  const raw = url.trim()
  if (raw === '') return ''
  // Windows 盘符路径不是身份，scp 形态会把它读成 host。
  if (/^[A-Za-z]:[\\/]/u.test(raw)) return ''
  let rest = raw
  // 去掉 scheme。
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(rest)
  if (scheme !== null) rest = rest.slice(scheme[0].length)
  // 去掉 userinfo（`git@` / `user:token@`），避免凭据进入 peer。
  const at = rest.lastIndexOf('@')
  if (at !== -1) rest = rest.slice(at + 1)
  if (rest === '') return ''
  // scp 形态 `host:path` 与 URL 形态 `host/path` 收敛。
  rest = rest.replace(/^([^/:]+):(?!\/\/)/u, '$1/')
  rest = rest.replace(/\/{2,}/gu, '/').replace(/^\/+|\/+$/gu, '')
  rest = rest.replace(/\.git$/iu, '').replace(/\/+$/u, '')
  if (rest === '' || rest.includes('://')) return ''
  return rest.toLowerCase()
}

/**
 * peer 标识：与 OpenViking 插件 `sanitizePeerId` 同规则。
 *
 * 顺序是「折叠非法字符 → 去重连字符 → 去首尾 `-.` → 只允许一个 `@` →
 * 避开服务端保留名」。长度超过 100 时截断（服务端上限）；这里不复制插件的
 * 哈希后缀，超长 remote 属于人为构造，截断后失配会表现为「工作区记忆为空」，
 * 不会读错别人的空间。
 */
export function sanitizePeerId(value: string): string {
  const raw = value.trim()
  let cleaned = raw.replace(/[^a-zA-Z0-9_.@-]+/gu, '-').replace(/-{2,}/gu, '-').replace(/^[-.]+|[-.]+$/gu, '')
  if (cleaned === '') return ''
  const at = cleaned.indexOf('@')
  if (at !== -1) cleaned = cleaned.slice(0, at + 1) + cleaned.slice(at + 1).replace(/@/gu, '-')
  if (cleaned.startsWith('ext-')) cleaned = `x-${cleaned}`
  if (cleaned === '__self') cleaned = 'self'
  if (cleaned === '.' || cleaned === '..') return ''
  if (cleaned.length > MAX_SEGMENT_LENGTH) cleaned = cleaned.slice(0, MAX_SEGMENT_LENGTH).replace(/[-.]+$/u, '')
  return cleaned
}

/**
 * 由 git remote 推导工作区 peer；remote 归一化不出来时返回 `''`。
 *
 * 调用方在 `''` 时应退回仓库根路径那一层（插件模板的
 * `["{git_remote}", "{git_root}"]` 顺序）。
 */
export function workspacePeerFromRemote(remote: string): string {
  const normalized = normalizeGitRemote(remote)
  if (normalized === '') return ''
  return sanitizePeerId(normalized)
}

/** 由仓库根路径推导 peer（remote 缺失时的退路）。 */
export function workspacePeerFromRoot(root: string): string {
  return sanitizePeerId(root)
}

/**
 * OpenViking 尚未为目录生成摘要时回一句占位串，形如
 * `# viking://user/admin/memories/cases [Directory abstract is not ready]`。
 *
 * 它不是内容，直接展示会把每个目录行都变成一行噪音，因此目录项在出宿主前
 * 丢掉这种摘要；文件与检索命中的摘要不受影响。
 */
export function isPlaceholderDirectoryAbstract(value: string): boolean {
  return /^# viking:\/\/\S+ \[Directory abstract is not ready\]$/u.test(value.trim())
}

/** 排序：目录在前，同类按名称升序（`localeCompare` 不与运行环境绑定语言）。 */
export function compareMemoryNodes(left: MemoryNode, right: MemoryNode): number {
  if (left.isDir !== right.isDir) return left.isDir ? -1 : 1
  return left.name.localeCompare(right.name, 'en')
}