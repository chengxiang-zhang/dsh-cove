import { PKCECodes, TokenData } from "../types";
import { decodeJwtPayload } from "../../utils/jwt";
import { timeout } from "../../utils/common";
import {
  RefreshTokenExhaustedError,
  detectExhaustedReason,
} from "../refresh-errors";

// All values verified against openai/codex source (codex-rs/login/src/server.rs
// and codex-rs/login/src/auth/manager.rs).
const ISSUER = "https://auth.openai.com";
const AUTH_URL = `${ISSUER}/oauth/authorize`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_CALLBACK_PORT = 1455;
export const CODEX_CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://localhost:${CODEX_CALLBACK_PORT}${CODEX_CALLBACK_PATH}`;
const SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
const ORIGINATOR = "codex_cli_rs";

export function generateCodexAuthURL(state: string, pkce: PKCECodes): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: ORIGINATOR,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface CodexIdClaims {
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
    user_id?: string;
    organization_id?: string;
  };
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
}

function extractIdentity(idToken: string): {
  email: string;
  chatgptAccountId: string;
  planType?: string;
} {
  const claims = decodeJwtPayload(idToken) as CodexIdClaims;
  const auth = claims["https://api.openai.com/auth"] || {};
  const email = (claims.email as string) || "unknown";
  const chatgptAccountId =
    auth.chatgpt_account_id || claims.chatgpt_account_id || "";
  const planType =
    auth.chatgpt_plan_type || claims.chatgpt_plan_type || undefined;
  return { email, chatgptAccountId, planType };
}

interface CodexTokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in?: number;
}

function tokenFromResponse(data: CodexTokenResponse): TokenData {
  // OpenAI access tokens are JWTs; expiry comes from `expires_in` (seconds).
  // Default to 1 hour if absent.
  const expiresIn = data.expires_in ?? 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const { email, chatgptAccountId, planType } = extractIdentity(data.id_token);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    email,
    expiresAt,
    accountUuid: chatgptAccountId,
    provider: "codex",
    planType,
    idToken: data.id_token,
  };
}

export async function exchangeCodexCode(
  code: string,
  returnedState: string,
  expectedState: string,
  pkce: PKCECodes,
): Promise<TokenData> {
  if (returnedState !== expectedState) {
    throw new Error("OAuth state mismatch — possible CSRF attack");
  }

  // Initial code exchange uses application/x-www-form-urlencoded
  // (matches codex-rs/login/src/server.rs exchange_code_for_tokens).
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `http://localhost:${CODEX_CALLBACK_PORT}${CODEX_CALLBACK_PATH}`,
    client_id: CODEX_CLIENT_ID,
    code_verifier: pkce.codeVerifier,
  });

  let resp: Response;
  try {
    resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err: any) {
    // undici's "fetch failed" hides the real cause — surface it.
    const cause = err?.cause;
    const detail = cause
      ? `${cause.code || cause.name || "error"}: ${cause.message || String(cause)}`
      : err?.message || String(err);
    throw new Error(`Codex token exchange network error: ${detail}`);
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Codex token exchange failed (${resp.status}): ${text}`);
  }

  return tokenFromResponse((await resp.json()) as CodexTokenResponse);
}

export async function refreshCodexTokens(
  refreshToken: string,
): Promise<TokenData> {
  // Refresh uses application/json body
  // (matches codex-rs/login/src/auth/manager.rs request_chatgpt_token_refresh).
  let resp: Response;
  try {
    resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
  } catch (err: any) {
    const cause = err?.cause;
    const detail = cause
      ? `${cause.code || cause.name || "error"}: ${cause.message || String(cause)}`
      : err?.message || String(err);
    throw new Error(`Codex token refresh network error: ${detail}`);
  }

  if (!resp.ok) {
    const text = await resp.text();
    const reason = detectExhaustedReason(text);
    if (reason) {
      throw new RefreshTokenExhaustedError(reason, resp.status, text);
    }
    throw new Error(`Codex token refresh failed (${resp.status}): ${text}`);
  }

  return tokenFromResponse((await resp.json()) as CodexTokenResponse);
}

export async function refreshCodexTokensWithRetry(
  refreshToken: string,
  maxRetries = 3,
): Promise<TokenData> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await refreshCodexTokens(refreshToken);
    } catch (err) {
      // Terminal failure — refresh token is permanently unusable. Do NOT
      // retry; the second attempt would invalidate it further (the backend
      // detects reuse and may revoke the entire account).
      if (err instanceof RefreshTokenExhaustedError) throw err;
      lastErr = err;
      if (attempt >= maxRetries) break;
      await timeout(attempt * 1000);
    }
  }
  throw lastErr;
}
