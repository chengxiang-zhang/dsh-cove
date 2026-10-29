import { TokenData } from "../types";
import { decodeJwtPayload } from "../../utils/jwt";
import { RefreshTokenExhaustedError } from "../refresh-errors";
import {
  CURSOR_CLIENT_ID,
  DEFAULT_CURSOR_CLIENT_VERSION,
} from "./storage";

const TOKEN_URL = "https://api2.cursor.sh/oauth/token";

function expiryFromJwt(accessToken: string): string {
  try {
    const claims = decodeJwtPayload(accessToken) as { exp?: number };
    if (claims.exp) return new Date(claims.exp * 1000).toISOString();
  } catch {
    // Keep a short fallback because Cursor access tokens are expected to be JWTs.
  }
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function emailFromJwt(accessToken: string): string | undefined {
  try {
    const claims = decodeJwtPayload(accessToken) as {
      email?: string;
      sub?: string;
    };
    return claims.email || claims.sub;
  } catch {
    return undefined;
  }
}

interface CursorRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  shouldLogout?: boolean;
}

export async function refreshCursorTokens(
  refreshToken: string,
  previous: Partial<TokenData> = {},
): Promise<TokenData> {
  // Defensive guard: refuse to call /oauth/token with an empty or obviously
  // wrong credential. Without this an account where the refresh token is
  // missing (e.g. legacy browser-login files written before the
  // missing-refresh-token check) would burn its remaining cooldown budget
  // on doomed requests, and Cursor's auth backend treats repeated bad
  // refresh attempts as suspicious behaviour.
  if (!refreshToken || refreshToken === previous.accessToken) {
    throw new RefreshTokenExhaustedError(
      "invalidated",
      0,
      "no refresh token stored for this account — re-run --login --provider=cursor",
    );
  }
  const clientId =
    previous.cursorClientId || process.env.CURSOR_CLIENT_ID || CURSOR_CLIENT_ID;

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Cursor token refresh failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as CursorRefreshResponse;
  if (data.shouldLogout || !data.access_token) {
    throw new Error("Cursor refresh token is no longer valid; re-login in Cursor");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    email: previous.email || emailFromJwt(data.access_token) || "unknown",
    expiresAt: expiryFromJwt(data.access_token),
    accountUuid:
      previous.accountUuid || previous.cursorServiceMachineId || "cursor",
    provider: "cursor",
    idToken: data.id_token || previous.idToken,
    lastRefreshAt: new Date().toISOString(),
    cursorServiceMachineId: previous.cursorServiceMachineId,
    cursorClientVersion:
      previous.cursorClientVersion || DEFAULT_CURSOR_CLIENT_VERSION,
    cursorConfigVersion: previous.cursorConfigVersion,
    cursorClientId: clientId,
    cursorMembershipType: previous.cursorMembershipType,
  };
}

export async function refreshCursorTokensWithRetry(
  refreshToken: string,
  previous: Partial<TokenData> = {},
  maxRetries = 3,
): Promise<TokenData> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await refreshCursorTokens(refreshToken, previous);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastErr;
}
