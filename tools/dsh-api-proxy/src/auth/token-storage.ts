import fs from "fs";
import path from "path";
import { ProviderId, TokenData, TokenStorage } from "./types";
import { decodeJwtPayload } from "../utils/jwt";

// Filename prefix on disk for each provider. "claude" is kept for the
// anthropic provider so existing token files keep loading.
const FILENAME_PREFIX: Record<ProviderId, string> = {
  anthropic: "claude",
  codex: "codex",
  cursor: "cursor",
};

function normaliseProvider(type: TokenStorage["type"] | undefined): ProviderId {
  if (type === "cursor") return "cursor";
  if (type === "codex") return "codex";
  return "anthropic"; // "claude" or missing → anthropic (legacy files)
}

/**
 * Extract chatgpt_plan_type from an id_token JWT. Used as a fallback when the
 * persisted token file pre-dates N1 (no plan_type column) — saves the user
 * from having to re-login just to populate the field.
 */
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

export function tokenToStorage(data: TokenData): TokenStorage {
  const provider: ProviderId = data.provider ?? "anthropic";
  return {
    access_token: data.accessToken,
    refresh_token: data.refreshToken,
    last_refresh: data.lastRefreshAt ?? new Date().toISOString(),
    email: data.email,
    type: provider === "anthropic" ? "claude" : provider,
    expired: data.expiresAt,
    account_uuid: data.accountUuid,
    id_token: data.idToken,
    plan_type: data.planType,
    cursor_service_machine_id: data.cursorServiceMachineId,
    cursor_client_version: data.cursorClientVersion,
    cursor_config_version: data.cursorConfigVersion,
    cursor_client_id: data.cursorClientId,
    cursor_membership_type: data.cursorMembershipType,
  };
}

export function storageToToken(storage: TokenStorage): TokenData {
  const provider = normaliseProvider(storage.type);
  return {
    accessToken: storage.access_token,
    refreshToken: storage.refresh_token,
    email: storage.email,
    expiresAt: storage.expired,
    accountUuid: storage.account_uuid || "",
    provider,
    idToken: storage.id_token,
    lastRefreshAt: storage.last_refresh,
    planType: storage.plan_type ?? planTypeFromIdToken(storage.id_token),
    cursorServiceMachineId: storage.cursor_service_machine_id,
    cursorClientVersion: storage.cursor_client_version,
    cursorConfigVersion: storage.cursor_config_version,
    cursorClientId: storage.cursor_client_id,
    cursorMembershipType: storage.cursor_membership_type,
  };
}

export function saveToken(authDir: string, data: TokenData): void {
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const sanitized = data.email
    .replace(/[^a-zA-Z0-9@._-]/g, "_")
    .replace(/\.\./g, "_");
  const prefix = FILENAME_PREFIX[data.provider ?? "anthropic"];
  const filename = `${prefix}-${sanitized}.json`;
  const filePath = path.join(authDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(tokenToStorage(data), null, 2), {
    mode: 0o600,
  });
}

export function loadAllTokens(
  authDir: string,
  provider?: ProviderId,
): TokenData[] {
  if (!fs.existsSync(authDir)) return [];
  const allFiles = fs.readdirSync(authDir);
  const matchPrefix = provider ? FILENAME_PREFIX[provider] : null;
  const files = allFiles.filter((f) => {
    if (!f.endsWith(".json")) return false;
    if (matchPrefix) return f.startsWith(`${matchPrefix}-`);
    return (
      f.startsWith("claude-") ||
      f.startsWith("codex-") ||
      f.startsWith("cursor-")
    );
  });
  const tokens: TokenData[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(authDir, file), "utf-8");
      const storage = JSON.parse(raw) as TokenStorage;
      const token = storageToToken(storage);
      if (provider && token.provider !== provider) continue;
      tokens.push(token);
    } catch {
      console.error(`Failed to load token file: ${file}`);
    }
  }
  return tokens;
}
