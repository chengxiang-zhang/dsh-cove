import { createHash, randomBytes } from "node:crypto";
import * as http2 from "node:http2";
import { v4 as uuidv4 } from "uuid";
import { TokenData } from "../types";
import { decodeJwtPayload } from "../../utils/jwt";
import { CURSOR_CLIENT_ID, DEFAULT_CURSOR_CLIENT_VERSION } from "./storage";

/**
 * Cursor's browser OAuth uses a PKCE-style "deep control" flow (the same one
 * the Cursor CLI uses for `cursor login`). It is not a standard OAuth code
 * exchange — there is no redirect back to a local callback server. Instead:
 *
 *   1. We generate a verifier/challenge pair and a UUID for this attempt.
 *   2. We surface a `https://cursor.com/loginDeepControl?...` URL to the
 *      user. They open it in a browser, sign in to Cursor, and click
 *      "Yes, Log In".
 *   3. We poll `https://api2.cursor.sh/auth/poll?uuid=...&verifier=...`
 *      with a small backoff. Once the user confirms, that endpoint returns
 *      `{ accessToken, refreshToken?, authId }`.
 *
 * This is reverse-engineered behaviour. It can break when Cursor rotates the
 * deep-control URL or version-gates the endpoint; we keep both swappable
 * through `CursorBrowserLoginOptions`.
 */

const DEFAULT_LOGIN_URL = "https://www.cursor.com/loginDeepControl";
const DEFAULT_POLL_URL = "https://api2.cursor.sh/auth/poll";
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_POLL_BACKOFF = 1.2;
const DEFAULT_POLL_MAX_INTERVAL_MS = 5000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;

export interface CursorBrowserLoginOptions {
  /** Override the deep-control URL (default points at cursor.com). */
  loginBaseUrl?: string;
  /** Override the poll URL (default points at api2.cursor.sh/auth/poll). */
  pollUrl?: string;
  /** Initial polling interval in milliseconds (default 1000). */
  pollIntervalMs?: number;
  /** Backoff multiplier applied between attempts (default 1.2). */
  pollBackoff?: number;
  /** Cap on polling interval (default 5000ms). */
  pollMaxIntervalMs?: number;
  /** Hard timeout before we stop polling (default 5 minutes). */
  pollTimeoutMs?: number;
  /** User-Agent header sent with the poll request. */
  userAgent?: string;
  /** Optional callback that receives the URL the user must visit. */
  onLoginUrl?: (url: string) => void | Promise<void>;
  /** Optional abort signal to cancel the poll loop. */
  signal?: AbortSignal;
  /**
   * Optional transport override (for tests). When omitted we use a custom
   * node:http2 client because Cursor's `api2.cursor.sh` is HTTP/2 only and
   * undici (Node's built-in fetch) intermittently fails on long-lived
   * polling against it with `fetch failed`.
   */
  fetchImpl?: typeof fetch;
}

interface PollHttpResponse {
  status: number;
  body: string;
}

/**
 * GET helper that speaks HTTP/2 directly. Works around undici falling back
 * to HTTP/1.1 against api2.cursor.sh and surfacing as `fetch failed` after
 * the first attempt.
 */
function http2Get(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15000,
): Promise<PollHttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = http2.connect(parsed.origin);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      client.close();
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("cursor auth/poll HTTP/2 request timed out")));
    }, timeoutMs);

    client.on("error", (err) => finish(() => reject(err)));

    const req = client.request({
      ":method": "GET",
      ":path": `${parsed.pathname}${parsed.search}`,
      ...Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    });
    let status = 0;
    const chunks: Buffer[] = [];
    req.on("error", (err) => finish(() => reject(err)));
    req.on("response", (h) => {
      status = Number(h[":status"] || 0);
    });
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () =>
      finish(() => resolve({ status, body: Buffer.concat(chunks).toString("utf8") })),
    );
    req.end();
  });
}

export interface CursorPkceParams {
  uuid: string;
  verifier: string;
  challenge: string;
}

export interface CursorPollResponse {
  accessToken: string;
  refreshToken?: string;
  authId?: string;
  /** Some Cursor builds return `apiKey` for API-key style sessions. */
  apiKey?: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCursorPkce(): CursorPkceParams {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { uuid: uuidv4(), verifier, challenge };
}

export function buildCursorLoginUrl(
  pkce: CursorPkceParams,
  baseUrl: string = DEFAULT_LOGIN_URL,
): string {
  const url = new URL(baseUrl);
  url.searchParams.set("challenge", pkce.challenge);
  url.searchParams.set("uuid", pkce.uuid);
  url.searchParams.set("mode", "login");
  // `redirectTarget=cli` tells Cursor to register the token against the
  // /auth/poll endpoint instead of trying to hand it off through a
  // `cursor://` deep link to the desktop app. Without this flag the
  // poll endpoint never sees the token and we time out.
  url.searchParams.set("redirectTarget", "cli");
  return url.toString();
}

function pollHeaders(userAgent?: string): Record<string, string> {
  return {
    Accept: "application/json",
    // Cursor's poll endpoint inspects User-Agent loosely. Sending a Cursor
    // desktop UA looks the most like a real client and avoids occasional
    // rate-limit responses on plain `node-fetch`/curl.
    "User-Agent":
      userAgent ||
      `Cursor/${DEFAULT_CURSOR_CLIENT_VERSION} (dsh-api-proxy browser login)`,
  };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One-shot poll attempt. Returns null when not yet authorized. */
export async function pollCursorAuthOnce(
  uuid: string,
  verifier: string,
  options: Pick<CursorBrowserLoginOptions, "pollUrl" | "userAgent" | "fetchImpl"> = {},
): Promise<CursorPollResponse | null> {
  const url = new URL(options.pollUrl || DEFAULT_POLL_URL);
  url.searchParams.set("uuid", uuid);
  url.searchParams.set("verifier", verifier);

  let status: number;
  let bodyText: string;
  if (options.fetchImpl) {
    // Test paths (and any caller that wants to inject a transport) keep using
    // a fetch-shaped function so they can mock easily.
    const resp = await options.fetchImpl(url.toString(), {
      method: "GET",
      headers: pollHeaders(options.userAgent),
    });
    status = resp.status;
    bodyText = await resp.text().catch(() => "");
  } else {
    const resp = await http2Get(url.toString(), pollHeaders(options.userAgent));
    status = resp.status;
    bodyText = resp.body;
  }

  if (status === 404) return null; // Cursor returns 404 while waiting.
  if (status === 202) return null; // Some builds use 202 Accepted.
  if (status < 200 || status >= 300) {
    throw new Error(`cursor auth/poll failed: HTTP ${status} ${bodyText.slice(0, 200)}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!parsed.accessToken && !parsed.apiKey) return null;
  return {
    accessToken: parsed.accessToken || parsed.apiKey,
    refreshToken: parsed.refreshToken,
    authId: parsed.authId,
    apiKey: parsed.apiKey,
  };
}

function isTransientNetworkError(err: unknown): boolean {
  // Cursor's HTTP/2 server occasionally resets idle streams or returns
  // ENETDOWN-ish blips between polls. We treat those as "still pending"
  // and keep polling instead of aborting the whole login flow.
  const code = (err as { code?: string })?.code;
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "EPIPE" ||
    code === "ENETUNREACH" ||
    code === "ERR_HTTP2_STREAM_CANCEL" ||
    code === "ERR_HTTP2_INVALID_STREAM" ||
    code === "ERR_HTTP2_GOAWAY_SESSION"
  ) {
    return true;
  }
  const msg = (err as Error)?.message || String(err);
  return (
    msg.includes("ECONNRESET") ||
    msg.includes("pending stream has been canceled") ||
    msg.includes("HTTP/2 request timed out") ||
    msg.includes("GOAWAY") ||
    msg.includes("socket hang up")
  );
}

export async function pollCursorAuth(
  uuid: string,
  verifier: string,
  options: CursorBrowserLoginOptions = {},
): Promise<CursorPollResponse> {
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const backoff = options.pollBackoff ?? DEFAULT_POLL_BACKOFF;
  const maxInterval = options.pollMaxIntervalMs ?? DEFAULT_POLL_MAX_INTERVAL_MS;
  const deadline = Date.now() + (options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
  let current = interval;
  let consecutiveErrors = 0;
  while (true) {
    if (Date.now() > deadline) {
      throw new Error(
        "cursor browser login timed out before the user confirmed in the browser",
      );
    }
    try {
      const result = await pollCursorAuthOnce(uuid, verifier, options);
      consecutiveErrors = 0;
      if (result) return result;
    } catch (err) {
      if (!isTransientNetworkError(err)) throw err;
      consecutiveErrors += 1;
      if (consecutiveErrors > 30) {
        throw new Error(
          `cursor auth/poll repeatedly failed: ${(err as Error).message}`,
        );
      }
    }
    await sleep(current, options.signal);
    current = Math.min(maxInterval, Math.round(current * backoff));
  }
}

function emailFromAuthId(authId: string | undefined, accessToken?: string): string {
  // authId is usually `provider|user_xxxx`. We don't get the email back from
  // poll(), so we derive a stable placeholder unless an id_token tells us
  // otherwise. Token storage uses the email as the file suffix.
  if (accessToken) {
    try {
      const claims = decodeJwtPayload(accessToken) as { email?: string; sub?: string };
      if (typeof claims.email === "string" && claims.email.length > 0) {
        return claims.email;
      }
      if (typeof claims.sub === "string") {
        return `${claims.sub.replace(/[^a-zA-Z0-9_-]/g, "_")}@cursor.local`;
      }
    } catch {
      /* ignore */
    }
  }
  if (!authId) return "unknown@cursor.local";
  const tail = authId.includes("|") ? authId.split("|").slice(-1)[0] : authId;
  return `${tail.replace(/[^a-zA-Z0-9_-]/g, "_")}@cursor.local`;
}

/**
 * Thrown by `pollResultToTokenData` when Cursor's `auth/poll` only returned
 * an access token (or an `apiKey`-style session) without a refresh token.
 * We refuse to persist such a token because the cursor provider would
 * otherwise call `/oauth/token` with the access token as the refresh
 * credential the next time the access token nears expiry — that fails
 * server-side and pushes the account into a permanent auth-failure state.
 */
export class CursorBrowserLoginMissingRefreshTokenError extends Error {
  constructor() {
    super(
      "Cursor browser login completed but did not return a refresh token. " +
        "This usually means the deep-link confirmed in API-key (PAT) mode. " +
        "Re-run the login (`dsh-api-proxy --login --provider=cursor`) and make sure " +
        "you click the regular Cursor login button, or fall back to importing " +
        "the local desktop login with --cursor-import-local.",
    );
    this.name = "CursorBrowserLoginMissingRefreshTokenError";
  }
}

export function pollResultToTokenData(
  result: CursorPollResponse,
  pkce: CursorPkceParams,
): TokenData {
  // Cursor's `auth/poll` may legitimately return only `accessToken` (or an
  // `apiKey` value) without `refreshToken` — for example when the user
  // confirms a PAT-style session. In that case persisting the access token
  // as the refresh token is *worse* than failing: the account would silently
  // enter auth failure ~1 hour later when the cursor provider tries to
  // refresh. Fail loudly here so the operator can fix it at login time.
  if (!result.refreshToken) {
    throw new CursorBrowserLoginMissingRefreshTokenError();
  }

  // The accessToken from `auth/poll` is the same JWT we'd get back from a
  // proper `oauth/token` exchange; reuse the existing decoder so expiry and
  // plan type stay consistent with the storage path.
  let expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();
  try {
    const claims = decodeJwtPayload(result.accessToken) as { exp?: number };
    if (typeof claims.exp === "number") {
      expiresAt = new Date(claims.exp * 1000).toISOString();
    }
  } catch {
    /* opaque token — keep fallback expiry */
  }
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    email: emailFromAuthId(result.authId, result.accessToken),
    expiresAt,
    accountUuid: pkce.uuid,
    provider: "cursor",
    cursorClientId: CURSOR_CLIENT_ID,
    cursorClientVersion: DEFAULT_CURSOR_CLIENT_VERSION,
  };
}

export interface CursorBrowserLoginResult {
  pkce: CursorPkceParams;
  loginUrl: string;
  poll: CursorPollResponse;
  token: TokenData;
}

export async function runCursorBrowserLogin(
  options: CursorBrowserLoginOptions = {},
): Promise<CursorBrowserLoginResult> {
  const pkce = generateCursorPkce();
  const loginUrl = buildCursorLoginUrl(pkce, options.loginBaseUrl);
  if (options.onLoginUrl) await options.onLoginUrl(loginUrl);
  const poll = await pollCursorAuth(pkce.uuid, pkce.verifier, options);
  return { pkce, loginUrl, poll, token: pollResultToTokenData(poll, pkce) };
}
