/**
 * 网关页面的宿主信任补丁（客户端半边）。
 *
 * 0.2 客户端用**页面来源**判断设置面归谁管：
 *
 *   const persistence = ctx.remote.$host.isLoopback ? "host" : "memory"
 *   (dsh-client-ui-settings)
 *
 * 经家族网关打开的页面（http://dsh.mac/ 、http://<lan-ip>:3082）主机名不是回环地址，
 * 于是客户端把整个设置面降级成进程内的内存态：设置 → 模型 显示
 * “settings are unavailable in this browser”，账号页、配置文件入口同样失效。
 * 而宿主半边其实早就把网关请求当回环处理（server-mode 代理重写为回环形状 + noBrowserAuth），
 * 只有客户端还认为自己低人一等。
 *
 * 两份声明，互为兜底：
 * 1. 宿主注入的 boot 脚本（server-mode SERVER_BOOT_SCRIPT）在非回环分支同步声明
 *    `__DSH_TRANSPORT__.ownsHost = true`（官方 transport 钩子：“本页拥有 Host”）；
 * 2. 本模块在客户端启动时兜底：只要**能证明**这页是家族网关发出来的
 *    （浏览器可读的 dsh_gw 标记 cookie，拿不到时退化为一次 /api/gateway/session 探测），
 *    就把 `ctx.connection.isLoopback` 置为 true 并让 `remote.$host` 的快照失效重建。
 *    这样即使 shell HTML 被浏览器缓存、boot 脚本是旧的，设置面依然留在宿主上。
 *
 * 回环页面与非网关页面完全不受影响：前者本来 isLoopback 就是 true，后者拿不到标记也不会被改写。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  HOST_ACCESS_MARKER_COOKIE,
  HOST_ACCESS_MARKER_VALUE,
  HOST_ACCESS_SESSION_PATH,
} from '../core/remote-access/paths.ts'

/** 宿主网关写的“来源标记”cookie 名（非密值，仅供客户端识别来源）。 */
export const GATEWAY_MARKER_COOKIE = 'dsh_gw'

/** 标记 cookie 的期望值。 */
export const GATEWAY_MARKER_VALUE = '1'

/**
 * 远程访问域写的第二份来源标记（同样非密值）。反向代理直连拓扑
 * （browser -> nginx -> 127.0.0.1:3080，没有家族网关）拿不到网关 cookie 与
 * 网关 boot 脚本，由宿主在 `GET /api/dsh-access/session` 和 per-request boot
 * 脚本响应上写入该标记。
 */
export { HOST_ACCESS_MARKER_COOKIE, HOST_ACCESS_MARKER_VALUE } from '../core/remote-access/paths.ts'

/** 网关会话探测路径（server-mode 网关才有）。 */
export const GATEWAY_SESSION_PATH = '/api/gateway/session'

/** 远程访问域的准入探测路径；`owners === true` 表示本页可以拥有 Host。 */
export const ACCESS_SESSION_PATH = HOST_ACCESS_SESSION_PATH

/** 浏览器位置的最小面（便于单测注入）。 */
export interface LocationLike {
  hostname: string
}

/** 连接句柄的最小面（只读成员在运行时是普通可写属性）。 */
export interface ConnectionTrustTarget {
  isLoopback?: boolean
}

/** remote 服务的最小面：`$host` 是带缓存的 getter，缓存字段是 hostFacts。 */
export interface RemoteTrustTarget {
  hostFacts?: unknown
  [key: string]: unknown
}

/** 宿主名是否属于回环（与 dsh-client-connection 的判定一致：localhost / ::1 / 127/8）。 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 从 document.cookie 里读某个标记（同步、无网络）。 */
function hasMarker(cookie: string | undefined, name: string, value: string): boolean {
  if (cookie === undefined || cookie === '') return false
  return cookie.split(';').some(part => {
    const eq = part.indexOf('=')
    if (eq < 0) return false
    return part.slice(0, eq).trim() === name && part.slice(eq + 1).trim() === value
  })
}

/** 家族网关写的来源标记。 */
export function hasGatewayMarker(cookie: string | undefined): boolean {
  return hasMarker(cookie, GATEWAY_MARKER_COOKIE, GATEWAY_MARKER_VALUE)
}

/** 远程访问域写的来源标记（反向代理直连拓扑）。 */
export function hasHostAccessMarker(cookie: string | undefined): boolean {
  return hasMarker(cookie, HOST_ACCESS_MARKER_COOKIE, HOST_ACCESS_MARKER_VALUE)
}

/**
 * 把“本页拥有 Host”落到运行时对象上：改 connection 的 isLoopback，并让 remote.$host 的
 * 缓存快照失效（该 getter 下一次访问会用新的 connection 值重建）。
 * @param targets - connection 与 remote 服务（任一缺失都安全跳过）。
 * @returns 是否真的改写过 connection。
 */
export function applyGatewayHostOwnership(targets: {
  connection?: ConnectionTrustTarget | undefined
  remote?: RemoteTrustTarget | undefined
  transport?: Record<string, unknown> | undefined
}): boolean {
  let changed = false
  if (targets.transport !== undefined && targets.transport.ownsHost !== true) {
    try {
      targets.transport.ownsHost = true
      changed = true
    } catch { /* 冻结的 transport：跳过 */ }
  }
  const connection = targets.connection
  if (connection !== undefined && connection.isLoopback !== true) {
    try {
      connection.isLoopback = true
      changed = true
    } catch { /* 冻结的句柄：跳过 */ }
  }
  const remote = targets.remote
  if (remote !== undefined) {
    try {
      delete remote.hostFacts
    } catch { /* 无视 */ }
  }
  return changed
}

/** 取一个可选服务（缺失或抛错都返回 undefined）。 */
function optionalService<T>(ctx: ClientContext, name: string): T | undefined {
  try {
    return (ctx.get as unknown as (id: string, strict?: boolean) => unknown)(name, false) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * 挂载信任补丁；返回 disposer。只对“非回环 + 能证明来自家族网关”的页面生效。
 * @param ctx - client root context。
 * @param locationLike - 可注入的位置（默认取 globalThis.location）。
 * @param cookie - 可注入的 cookie 串（默认取 document.cookie）。
 */
export function mountGatewayTrust(
  ctx: ClientContext,
  locationLike: LocationLike | undefined = typeof location === 'undefined' ? undefined : location,
  cookie: string | undefined = typeof document === 'undefined' ? undefined : document.cookie,
  probe: ((path: string) => Promise<boolean>) | undefined = undefined,
): () => void {
  if (locationLike === undefined || isLoopbackHostname(locationLike.hostname)) return () => {}
  const globalTransport = (globalThis as { __DSH_TRANSPORT__?: Record<string, unknown> }).__DSH_TRANSPORT__
  const apply = (): boolean => applyGatewayHostOwnership({
    connection: optionalService<ConnectionTrustTarget>(ctx, 'connection'),
    remote: optionalService<RemoteTrustTarget>(ctx, 'remote'),
    transport: globalTransport,
  })
  if (hasGatewayMarker(cookie) || hasHostAccessMarker(cookie)) {
    apply()
    return () => {}
  }
  if (globalTransport?.ownsHost === true) {
    // boot 脚本已经声明过（壳是新的）：只需要把 remote 的快照失效掉，让 settings 读到 true。
    apply()
    return () => {}
  }
  // 老壳（HTML 被缓存、没有 boot 声明、也没有标记 cookie）：先探家族网关会话，
  // 再退到远程访问域的准入探测（反向代理直连拓扑没有网关），任一确认即补。
  let disposed = false
  const sessionProbe = probe ?? defaultAdmissionProbe
  void sessionProbe(GATEWAY_SESSION_PATH)
    .then(admitted => admitted ? true : sessionProbe(ACCESS_SESSION_PATH))
    .then(admitted => { if (!disposed && admitted) apply() })
    .catch(() => { /* 网关与远程访问域都不可达：保持原状 */ })
  return () => { disposed = true }
}

/**
 * 默认探测：网关会话回答 `authenticated`，远程访问域回答 `owners`。
 * @param path - 要探测的准入路径。
 * @returns 该页是否可以拥有 Host。
 */
async function defaultAdmissionProbe(path: string): Promise<boolean> {
  const response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!response.ok) return false
  const body = await response.json() as { authenticated?: unknown; owners?: unknown }
  return path === GATEWAY_SESSION_PATH ? body.authenticated === true : body.owners === true
}