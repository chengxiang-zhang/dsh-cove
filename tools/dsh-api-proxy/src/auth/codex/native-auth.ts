/**
 * Native Codex CLI auth file adapter.
 *
 * Source of truth: ~/.codex/auth.json (written by `codex login` / official CLI).
 * dsh-api-proxy reads this file instead of maintaining a parallel token under
 * ~/.dsh-api-proxy/codex-*.json, so we do not compete with the CLI for refresh
 * token rotation (openai/codex#10332 refresh_token_reused).
 */

import fs from "fs";
import path from "path";
import { TokenData } from "../types";
import { decodeJwtPayload } from "../../utils/jwt";

export interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

function expandHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return path.resolve(p);
}

export function resolveCodexAuthFile(filePath?: string): string {
  return expandHome(filePath || "~/.codex/auth.json");
}

function planTypeFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const claims = decodeJwtPayload(idToken) as any;
    const auth = claims["https://api.openai.com/auth"] || {};
    return auth.chatgpt_plan_type || claims.chatgpt_plan_type || undefined;
  } catch {
    return undefined;
  }
}

function emailFromIdToken(idToken: string | undefined): string {
  if (!idToken) return "codex-native";
  try {
    const claims = decodeJwtPayload(idToken) as any;
    return (claims.email as string) || "codex-native";
  } catch {
    return "codex-native";
  }
}

function expiresAtFromAccessToken(accessToken: string): string {
  try {
    const claims = decodeJwtPayload(accessToken) as { exp?: number };
    if (claims.exp) {
      return new Date(claims.exp * 1000).toISOString();
    }
  } catch {
    /* ignore */
  }
  // Fallback: 1h from now (matches OpenAI default access-token TTL).
  return new Date(Date.now() + 3600 * 1000).toISOString();
}

/**
 * Load ChatGPT-mode credentials from a Codex CLI auth.json.
 * Returns null when the file is missing, unreadable, or not ChatGPT auth.
 */
export function loadTokenFromCodexAuthFile(
  filePath: string,
): TokenData | null {
  const resolved = expandHome(filePath);
  if (!fs.existsSync(resolved)) return null;
  let raw: CodexAuthFile;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, "utf-8")) as CodexAuthFile;
  } catch (err: any) {
    console.error(
      `[codex] failed to parse native auth file ${resolved}: ${err.message}`,
    );
    return null;
  }

  const tokens = raw.tokens;
  if (!tokens?.access_token || !tokens?.refresh_token) {
    return null;
  }
  // API-key-only mode is not the ChatGPT subscription path we proxy.
  if (raw.auth_mode && raw.auth_mode !== "chatgpt") {
    console.error(
      `[codex] native auth file auth_mode=${raw.auth_mode}; expected chatgpt`,
    );
    return null;
  }

  const idToken = tokens.id_token;
  const accountId = tokens.account_id || "";
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    email: emailFromIdToken(idToken),
    expiresAt: expiresAtFromAccessToken(tokens.access_token),
    accountUuid: accountId,
    provider: "codex",
    idToken,
    lastRefreshAt: raw.last_refresh,
    planType: planTypeFromIdToken(idToken),
  };
}

/**
 * Write refreshed tokens back into the Codex CLI auth.json shape, preserving
 * unrelated fields (auth_mode, OPENAI_API_KEY, …).
 */
export function saveTokenToCodexAuthFile(
  filePath: string,
  token: TokenData,
): void {
  const resolved = expandHome(filePath);
  let existing: CodexAuthFile = {};
  if (fs.existsSync(resolved)) {
    try {
      existing = JSON.parse(fs.readFileSync(resolved, "utf-8")) as CodexAuthFile;
    } catch {
      existing = {};
    }
  }

  const next: CodexAuthFile = {
    ...existing,
    auth_mode: existing.auth_mode || "chatgpt",
    tokens: {
      ...(existing.tokens || {}),
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      id_token: token.idToken || existing.tokens?.id_token,
      account_id: token.accountUuid || existing.tokens?.account_id,
    },
    last_refresh: token.lastRefreshAt || new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  // Atomic replace so concurrent Codex CLI readers never see a partial write.
  const tmp = `${resolved}.dsh-api-proxy.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, resolved);
}
