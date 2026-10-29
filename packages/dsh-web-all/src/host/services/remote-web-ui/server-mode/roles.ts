/**
 * Role policy of the server-mode gateway (decided: admin + user).
 *
 * The gateway is the authentication + loopback-shaping front door: once a
 * session crosses the wall, every request is re-issued to 127.0.0.1 with the
 * client's cookies/Origin stripped and Host rewritten, so the upstream's own
 * loopback fence can no longer tell roles apart. This table is therefore the
 * only place a role is narrowed.
 *
 * Decided surface — both roles use the whole product:
 * - the native DSH API, addressed as `/api/<namespace>/<method>` in 0.2
 *   (`/api/settings/describe`, `/api/pluginManager/setPluginEnabled`,
 *   `/api/llm/listProviders`, `/api/credentials/describe`, ...);
 * - the family's own feature routes (`/worktree/*`, `/git/*`,
 *   `/api/workbench/*`).
 * Remote access exists so the same web UI runs on another device. Walling the
 * settings plane or the plugin manager away from the `user` role produced
 * exactly the "the page renders but the switch will not flip / the models tab
 * stays empty" failures on the owner's own devices — and the 0.1-era dotted
 * method names this table used to carry (`settings.describe`,
 * `/api/plugin-manager`) silently matched nothing in 0.2 anyway.
 *
 * Admin-only is the family's machine-control surface: pairing and token
 * administration under `/api/pair` (that route is also loopback-guarded
 * upstream). `/api/gateway/*` never reaches this table — the gateway answers it
 * before the wall.
 */

/**
 * Family control prefixes that stay out of the user surface. These are real 0.2
 * paths: the family mounts them literally, unlike the SDK's method names, which
 * are `/api/<namespace>/<method>` (camelCase namespace).
 */
export const CONTROL_PREFIXES = ['/api/pair'] as const

/** Gateway self-served prefix (never proxied; handled before the wall logic). */
export const GATEWAY_API_PREFIX = '/api/gateway'

/** Whether an /api pathname falls under a control prefix. */
export function isControlPath(pathname: string): boolean {
  return CONTROL_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * Whether a user-role session may pass this request upstream.
 * @param pathname - the request pathname (without query).
 * @returns true to proxy, false to refuse with 403.
 */
export function userRoleAllows(pathname: string): boolean {
  return !isControlPath(pathname)
}