import {Platform} from 'react-native';

import {
  ConnectionDiagnostics,
  NetBirdPortal,
  ServerChange,
  ServerConfig,
  ServiceRecord,
  ProbeResult,
} from './NetBirdPortal';

/**
 * Shared NetBird portal state helpers used by the three screens.
 * Built by the anchor slice — consumers must not reimplement these.
 */

export type ServiceInfo = {
  /** Canonical display name, e.g. "dsh.laptop-b.netbird" */
  name: string;
  /** Scheme + name, e.g. "http://dsh.laptop-b.netbird" — the WebView source uri */
  url: string;
  /** HTTP status code from the last probe (200/302/401/403 => alive) */
  statusCode: number;
  /** true when the last probe got any HTTP response */
  reachable: boolean;
  /** true when the service answered 401/403 (alive but needs login) */
  needsLogin: boolean;
};

const DEVICE_NAME = 'netbird-portal-android';

/** The smallest gap between catalogue re-reads caused by returning to the foreground. */
export const FOREGROUND_REFRESH_MIN_MS = 30_000;

/**
 * Whether coming back to the foreground should re-read the catalogue.
 *
 * Nothing in this app pushes the machine list: the native registry answers when asked,
 * and a reachability probe answers when asked. Reading it only at mount - or only after
 * a failure - means a machine that joined the fleet, one that went away, and every
 * reachability that flipped are all invisible until someone pulls to refresh. A failing
 * list already has its own retry chain, so it is refreshed immediately; a healthy one is
 * refreshed on the first return after the gap, and a quick app switch costs nothing.
 *
 * @param {{ lastLoadAt: number, now: number, failures: number, minGapMs?: number }} input
 * @returns {boolean} true when the caller should re-read the catalogue
 */
export function shouldRefreshOnForeground({
  lastLoadAt,
  now,
  failures,
  minGapMs = FOREGROUND_REFRESH_MIN_MS,
}: {
  lastLoadAt: number;
  now: number;
  failures: number;
  minGapMs?: number;
}): boolean {
  if (failures > 0) {
    return true;
  }
  if (!Number.isFinite(lastLoadAt) || lastLoadAt <= 0) {
    return false;
  }
  return now - lastLoadAt >= minGapMs;
}

/**
 * Whether this platform has the bundled browser container.
 *
 * Android ships GeckoView so a DSH page renders in a modern kernel whatever the
 * device's system WebView is; the page then goes through the loopback proxy the
 * container was configured with. iOS has no such container - pages open in the app's
 * own WKWebView - so JavaScript must not call an entry that can only reject, and the
 * native side rejects it as a second line of defence.
 */
export function hasBundledBrowserContainer(platform: string = Platform.OS): boolean {
  return platform !== 'ios';
}

/**
 * Connect-time liveness target, fetched through the embedded tunnel until it
 * answers.
 *
 * It comes from the fleet configuration (src/fleetConfig.ts) and is an
 * overlay-only name on purpose: a public address answers without the tunnel, so
 * it could no longer prove that the overlay's DNS and HTTP work. `tx.vpn` is
 * the network edge peer — always on — which is why neither this check nor the
 * app depends on a particular laptop being awake.
 *
 * This used to be a compiled `http://apk.dl-dev/version.json`; when that DNS
 * zone was retired the probe could never answer again and the login screen sat
 * on "connecting" until the native 45s + 90s budget ran out. A dead probe is a
 * dead app, so the value is configurable now.
 */

/**
 * Resolves to the promise's value, or rejects once `ms` has passed.
 *
 * Native bridge calls can stay pending forever (a proxy override whose
 * completion callback never fires, a bridge thread dying on `java.lang.Error`,
 * a Go engine lock held across an unbounded `nb.New`). A `try/catch` cannot
 * catch a promise that never settles, so every await on the connect path goes
 * through here: the UI must always be able to reach an error and an exit.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Starts the embedded NetBird engine (or reuses the running one) and wires
 * the WebView loopback proxy. Returns true when the network is usable.
 *
 * - A successful SSO login registers the persisted device identity once.
 * - Later runs reuse that identity, so the user is not prompted again.
 */
export async function ensureConnected(_setupKey = ''): Promise<boolean> {
  // No HTTP probe here, deliberately.
  //
  // This used to call `verify(setupKey, healthUrl)`, which fetched a liveness
  // URL through the embedded netstack and treated the answer as "the network is
  // usable". That gate failed the login twice for the same reason: the
  // netstack's own resolver does not answer the names it was pointed at
  // (`apk.dl-dev` after its zone was retired; then `tx.vpn`, measured as
  // "no such host" on a phone while a desktop client resolved it fine). A login
  // must not depend on a name resolving inside a userspace DNS stack, and the
  // tunnel's real usability is what the service list checks anyway - it probes
  // every discovered service, retries, names the failing stage and offers a way
  // out. So: start the engine, wait for the management stream, wire the proxy,
  // and let the list screen own reachability.
  let proxyUrl: string | null = null;
  try {
    // The native side does exactly what the working path always did - mark the
    // user as connected and wait for the engine to report a connected
    // management stream - and returns the loopback proxy URL. It no longer
    // finishes with an HTTP fetch.
    proxyUrl = await withTimeout(
      NetBirdPortal.ensureServiceReady(),
      CONNECT_READY_TIMEOUT_MS,
      '连接引擎没有在预期时间内就绪',
    );
  } catch (error) {
    // Only a confirmed authentication problem belongs in front of the user as a
    // login failure. Everything else hands off to the service list, which names
    // the failing stage and offers retry (rebuilding the engine) and re-login.
    if (isAuthenticationRequired(error)) {
      throw error;
    }
    console.warn('NETBIRD_SERVICE_PENDING', error);
  }
  if (proxyUrl) {
    try {
      // Only the fallback system-WebView path needs this override, and the
      // native runtime applies it on every connect anyway. Bounding it matters:
      // its completion callback is documented as possibly never firing, and a
      // try/catch cannot see a promise that never settles.
      await withTimeout(
        NetBirdPortal.applyWebViewProxy(proxyUrl),
        WEBVIEW_PROXY_TIMEOUT_MS,
        'WebView 代理设置超时',
      );
    } catch (error) {
      console.warn('NETBIRD_WEBVIEW_PROXY_UNSUPPORTED', error);
    }
  }
  return true;
}

/**
 * Slightly above the native service window (`REQUEST_TIMEOUT_SECONDS` = 45s) so
 * the native path reports its own precise failure instead of a JS timeout.
 */
export const CONNECT_READY_TIMEOUT_MS = 50_000;
export const WEBVIEW_PROXY_TIMEOUT_MS = 3_000;

/** The one error the login flow must surface rather than retry past. */
export function isAuthenticationRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /NETBIRD_AUTH_REQUIRED|authentication required|login required/i.test(message);
}

/**
 * Returns true when a previous SSO identity is present locally and the user
 * did not explicitly sign out or receive a confirmed authentication rejection.
 * Temporary management/network failures must not erase that persisted login.
 */
export async function hasPersistedLogin(): Promise<boolean> {
  try {
    // Cold start must be local-only. A management request can fail while
    // Android is still restoring connectivity; that does not mean the saved
    // identity disappeared or that the user should perform SSO again.
    return await NetBirdPortal.hasPersistedConfig();
  } catch {
    return false;
  }
}

export function resumePersistedConnection(): Promise<void> {
  return NetBirdPortal.resumeConnection();
}

/** A settings row is decoration until it answers; bound the read, then say so. */
export const SERVER_READ_TIMEOUT_MS = 3_000;

/**
 * Choosing a server stops the connection service before it can drop the
 * enrollment, and that wait is bounded natively (45s). The bound here only
 * covers a bridge call that never settles at all, which a try/catch cannot see.
 */
export const SERVER_WRITE_TIMEOUT_MS = 60_000;

/**
 * The management server this install enrolls against, or null when the bridge
 * cannot answer. A null makes the row show that the value is unknown rather than
 * printing a default it might not be using.
 */
export async function readServerConfig(): Promise<ServerConfig | null> {
  try {
    return await withTimeout(
      NetBirdPortal.getServerConfig(),
      SERVER_READ_TIMEOUT_MS,
      '读取服务器设置超时',
    );
  } catch (error) {
    console.warn('NETBIRD_SERVER_READ_FAILED', error);
    return null;
  }
}

/** Ports a scheme already implies, so a reader should never be shown them. */
const DEFAULT_PORTS: Record<string, string> = {https: '443', http: '80'};

/**
 * One management address as a person reads it: `https://` already says 443, so a
 * default port is not spelled out.
 *
 * The native canonical form always carries one (`NetBirdServerAddress.kt` keeps
 * the port explicit so that `host` and `host:443` are one enrollment identity
 * instead of two), but that is an internal fact, not something a one-line row has
 * to make the reader decode. A non-default port is still shown: there it is the
 * only thing telling two servers apart.
 *
 * Read off the string rather than through `new URL()`: this has to work on the
 * raw value a screen was handed, including one the parser would reject.
 */
export function serverDisplayUrl(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(url.trim());
  if (!match) {
    return url;
  }
  const scheme = match[1].toLowerCase();
  const authority = match[2].toLowerCase();
  const implied = DEFAULT_PORTS[scheme];
  return `${scheme}://${implied ? authority.replace(new RegExp(`:${implied}$`), '') : authority}`;
}

/** [serverDisplayUrl] without its scheme, for a row that already names the field. */
export function serverHostLabel(url: string): string {
  return serverDisplayUrl(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
}

/**
 * Chooses the management server. Shared by the login screen and settings, so both
 * surfaces submit exactly what the native rule accepts under the same bound.
 */
export function chooseServer(url: string): Promise<ServerChange> {
  return withTimeout(
    NetBirdPortal.setServerUrl(url),
    SERVER_WRITE_TIMEOUT_MS,
    '保存服务器地址超时，请重试',
  );
}

/** A probe is a pre-flight check, not a gate: fail fast and say what happened. */
export const MANAGEMENT_PROBE_TIMEOUT_MS = 8_000;

export type ManagementProbe = {
  /** What was actually dialled, so the reader can see what was tested. */
  url: string;
  reachable: boolean;
  statusCode: number;
  /**
   * `management`: the host answered its own management API. `answering`:
   * something answered, but not that API. `unreachable`: nothing did.
   */
  verdict: 'management' | 'answering' | 'unreachable';
  /** One line for the reader: the status, or why nothing answered. */
  detail: string;
};

/**
 * Probes a management address over the device's own network, before it is saved.
 *
 * Deliberately not through the netstack: before enrollment there is nothing to
 * route yet, and the address being checked is normally a public HTTPS name that
 * the embedded resolver cannot even answer (`native/download.go` records the
 * same asymmetry). This answers the one question sign-in cannot answer for
 * itself - whether the address this install is about to enroll against is a
 * NetBird control plane at all - which is what a build carrying the wrong
 * address shipped without.
 *
 * `/api/peers` is the marker, and the same one `self-hosted.md` uses to prove a
 * deployment's chain: an unauthenticated call answers 401, which is a *positive*
 * result here (the API exists and wants credentials). A 200 is accepted as well,
 * since it can only come from something serving that route.
 *
 * It deliberately does not probe the identity provider's discovery document:
 * measured on this fleet, `/.well-known/openid-configuration` is a 404 because
 * the provider is mounted under `/oauth2/`, so that path would report a correct
 * address as wrong. Whether the provider itself answers is what the sign-in
 * attempt reports, in the words the native side gives it.
 */
export async function probeManagementServer(raw: string): Promise<ManagementProbe> {
  let target: string;
  try {
    target = `${new URL((raw || '').trim()).origin}/api/peers`;
  } catch {
    return {
      url: (raw || '').trim(),
      reachable: false,
      statusCode: 0,
      verdict: 'unreachable',
      detail: '地址无法解析，请写成完整的 https:// 地址',
    };
  }
  try {
    const status = await withTimeout(
      fetch(target).then(response => response.status),
      MANAGEMENT_PROBE_TIMEOUT_MS,
      '测试超时',
    );
    const management = status === 200 || status === 401 || status === 403;
    return {
      url: target,
      reachable: true,
      statusCode: status,
      verdict: management ? 'management' : 'answering',
      detail: `HTTP ${status}`,
    };
  } catch (error) {
    return {
      url: target,
      reachable: false,
      statusCode: 0,
      verdict: 'unreachable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Drops the user's choice and returns to the compiled default. */
export function restoreDefaultServer(): Promise<ServerChange> {
  return withTimeout(
    NetBirdPortal.resetServerUrl(),
    SERVER_WRITE_TIMEOUT_MS,
    '恢复默认服务器超时，请重试',
  );
}

/**
 * How long the catalogue waits for a freshly connected peer's network map to
 * arrive before it accepts an empty answer.
 *
 * The map is pushed asynchronously, so a peer that already reports a connected
 * management stream can still have an empty peer set and no DNS records for a
 * second or two. Reading that as "there are no services" is what left the list
 * screen showing "已连接 · 没有可用的 DSH 服务" on a cold start while a
 * pull-to-refresh immediately listed six machines (measured on the emulator,
 * and the retry chain never armed because an empty catalogue is not an error).
 */
export const CATALOGUE_SETTLE_TIMEOUT_MS = 8000;
const CATALOGUE_SETTLE_POLL_MS = 1000;

/**
 * Reads the records the native registry accepted, waiting out that settle
 * window while the answer is still empty.
 */
async function readRecordsUntilPresent(): Promise<ServiceRecord[]> {
  const deadline = Date.now() + CATALOGUE_SETTLE_TIMEOUT_MS;
  for (;;) {
    const records = await NetBirdPortal.listServices();
    if (records.length > 0 || Date.now() >= deadline) {
      return records;
    }
    await new Promise<void>(resolve => {
      setTimeout(() => resolve(), CATALOGUE_SETTLE_POLL_MS);
    });
  }
}

/**
 * Returns the DSH services that discovery accepted and that currently answer
 * through the NetBird tunnel.
 *
 * The native registry decided which records exist (a `dsh.<machine>` entry in
 * the fleet's zone, pointing at a peer of this network) and every other intranet
 * record was already discarded, so this app can only ever offer those services.
 *
 * Reachability rule (user-approved): any HTTP response counts as reachable
 * (200/302/401/403); timeouts / connection failures are dropped.
 */
export async function listServices(): Promise<ServiceInfo[]> {
  const records = await readRecordsUntilPresent();
  const byName = new Map<string, ServiceRecord>();
  for (const record of records) {
    // Defensive re-normalization only: the name is derived again from the
    // record's own zone so the two sides cannot disagree about a display name.
    // The acceptance decision stays native.
    const name = normalizeIntranetName(record);
    if (!name) {
      continue;
    }
    const existing = byName.get(name);
    if (!existing || (record.zone && !existing.zone)) {
      byName.set(name, record);
    }
  }
  // Ordered by name, not by the order the registry answered in: the list has to
  // read the same way on two reads in a row, which is what lets someone aim at
  // the row they saw a moment ago. The catalogue test pins this order.
  const names = [...byName.keys()].sort((a, b) => a.localeCompare(b));
  const probes: ProbeResult[] = await probeAll(names, 5);
  const probeByUrl = new Map<string, ProbeResult>();
  for (const p of probes) {
    probeByUrl.set(p.url, p);
  }
  const services: ServiceInfo[] = [];
  for (const name of names) {
    const probeUrl = getProbeUrl(name);
    const probe = probeByUrl.get(probeUrl);
    if (!probe || !probe.reachable) {
      continue;
    }
    services.push({
      name,
      url: getServiceUrl(name),
      statusCode: probe.statusCode,
      reachable: true,
      needsLogin: probe.statusCode === 401 || probe.statusCode === 403,
    });
  }
  // Keep the ongoing notification honest about what is actually reachable.
  // Best effort: a notification is never worth failing the catalogue for.
  await NetBirdPortal.reportServiceCount(services.length);
  return services;
}

/**
 * Disconnect the tunnel and wipe all WebView cookies/sessions.
 *
 * Every step is best-effort on purpose: this is the path a user takes to get
 * out of a stuck install, so a wedged service (its stop call can time out
 * behind a 30-second management wait) must not keep them on the service list.
 * The proxy clear still runs, because a leftover loopback proxy breaks the
 * next public-Internet login page.
 */
export async function clearWebViewSessions(): Promise<void> {
  try {
    await NetBirdPortal.clearWebSessions();
  } catch (error) {
    console.warn('NETBIRD_LOGOUT_SESSIONS_FAILED', error);
  }
  // Quiesce the foreground runtime before clearing its process-wide WebView
  // proxy. A reconnect finishing after an earlier clear could reinstall the
  // dead loopback proxy and break the next OAuth page.
  try {
    await NetBirdPortal.stop();
  } catch (error) {
    console.warn('NETBIRD_LOGOUT_STOP_FAILED', error);
  }
  try {
    await NetBirdPortal.clearWebViewProxy();
  } catch (error) {
    console.warn('NETBIRD_LOGOUT_PROXY_FAILED', error);
  }
}

export function getServiceUrl(name: string): string {
  return `${getProbeUrl(name)}/`;
}

function getProbeUrl(name: string): string {
  return `http://${name}`;
}

/**
 * Returns the canonical DSH name of one DNS record: the record is qualified
 * against its own zone (a name that already carries the zone is kept as-is), and
 * the netbird.selfhosted internal zone and zone-root records are denied.
 *
 * This mirrors the native name rule in `DshHostRegistry.canonicalRecordName`,
 * which is the side that also decides acceptance (fleet zone + target is a peer
 * of this network). The fleet serves `dsh.<machine>.netbird` from one shared
 * zone named `netbird`, so a record entered as the fully qualified name and one
 * entered as the zone-relative `dsh.<machine>` derive the same name.
 */
function normalizeIntranetName(record: ServiceRecord): string | null {
  if (record.type !== 1) {
    return null;
  }
  const zone = normalizeDnsName(record.zone);
  const name = normalizeDnsName(record.name);
  if (!zone || zone === 'netbird.selfhosted' || !name || name === zone) {
    return null;
  }
  return name.endsWith(`.${zone}`) ? name : `${name}.${zone}`;
}

function normalizeDnsName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

async function probeAll(names: string[], concurrency: number): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const run = async () => {
    while (cursor < names.length) {
      const index = cursor;
      cursor += 1;
      const name = names[index];
      try {
        results.push(await NetBirdPortal.probe(getProbeUrl(name)));
      } catch {
        results.push({url: getProbeUrl(name), statusCode: 0, reachable: false});
      }
    }
  };
  for (let i = 0; i < Math.min(concurrency, names.length); i += 1) {
    workers.push(run());
  }
  await Promise.all(workers);
  return results;
}

export {DEVICE_NAME};

/**
 * How long the app keeps retrying quietly before it tells the user the saved
 * login may be gone, and offers a way out.
 */
export const RECONNECT_ESCALATE_AFTER_ATTEMPTS = 3;
export const RECONNECT_ESCALATE_AFTER_MS = 90_000;

/** Background retries rebuild the engine every N failures, not on every pass. */
export const HARD_RESET_EVERY = 3;

/**
 * Consecutive failed catalogue loads.
 *
 * `escalated` is what turns a silent background retry into an actionable
 * screen: a message with no way forward is exactly the state this app must
 * never sit in again.
 */
export type ReconnectStreak = {
  failures: number;
  firstFailureAt: number | null;
  escalated: boolean;
};

export function startReconnectStreak(): ReconnectStreak {
  return {failures: 0, firstFailureAt: null, escalated: false};
}

export function shouldEscalateReconnect(
  failures: number,
  firstFailureAt: number | null,
  now: number,
): boolean {
  if (failures >= RECONNECT_ESCALATE_AFTER_ATTEMPTS) {
    return true;
  }
  return firstFailureAt !== null && now - firstFailureAt >= RECONNECT_ESCALATE_AFTER_MS;
}

export function recordReconnectFailure(state: ReconnectStreak, now: number): ReconnectStreak {
  const firstFailureAt = state.firstFailureAt ?? now;
  const failures = state.failures + 1;
  return {
    failures,
    firstFailureAt,
    escalated: state.escalated || shouldEscalateReconnect(failures, firstFailureAt, now),
  };
}

export type ReconnectNotice = {
  message: string;
  detail: string;
  /** True when the app has positive evidence that the saved login is gone. */
  loginRequired: boolean;
  escalate: boolean;
};

/**
 * Wording for the service list. Networking outages and a dead login get
 * different sentences, and the escalated wording always names a next step.
 */
export function reconnectNotice(
  state: ReconnectStreak,
  diagnostics: ConnectionDiagnostics | null,
): ReconnectNotice {
  const loginRequired = diagnostics?.authVerdict === 'login_required';
  const escalate = state.escalated || loginRequired;
  const reason = describeConnectionStage(diagnostics);
  if (!escalate) {
    return {
      message: '内网暂时未连接，无需重新登录，正在自动重试…',
      detail: [reason, `已自动重试 ${state.failures} 次。`].filter(Boolean).join(' '),
      loginRequired: false,
      escalate: false,
    };
  }
  return {
    message: loginRequired ? '登录已失效，请重新登录' : '内网一直没连上，登录可能已失效',
    detail: [
      loginRequired
        ? '管理端可以访问，但本机保存的登录凭据已不再被接受。'
        : '已自动重试较长时间仍未连上。',
      reason,
      '可以点「重试」重建连接，或点「重新登录」重新登录一次。',
    ]
      .filter(Boolean)
      .join(' '),
    loginRequired,
    escalate: true,
  };
}

function describeConnectionStage(diagnostics: ConnectionDiagnostics | null): string {
  if (!diagnostics) {
    return '';
  }
  switch (diagnostics.stage) {
    case 'engine_not_running':
      return '本机连接引擎没有启动。';
    case 'management_disconnected':
      return '管理端没有连上。';
    case 'proxy_unavailable':
      return '本机代理没有就绪。';
    case 'auth_required':
      return '登录已失效。';
    default:
      return '';
  }
}

/**
 * Rebuilds the embedded engine, then lets the foreground service reconnect.
 *
 * `resumeConnection()` alone cannot recover a stalled engine: `Portal.start()`
 * returns immediately while an instance exists.
 */
export async function resetAndReconnect(): Promise<void> {
  try {
    await NetBirdPortal.resetConnection();
  } catch {
    // A build without the reset entry point still gets the resume path.
    await resumePersistedConnection();
  }
}

export async function readConnectionDiagnostics(): Promise<ConnectionDiagnostics | null> {
  try {
    return await NetBirdPortal.diagnostics();
  } catch {
    return null;
  }
}