import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { TokenData } from "../types";
import { decodeJwtPayload } from "../../utils/jwt";

export const CURSOR_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
export const DEFAULT_CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";

const CURSOR_KEYS = [
  "cursorAuth/accessToken",
  "cursorAuth/refreshToken",
  "cursorAuth/cachedEmail",
  "cursorAuth/stripeMembershipType",
  "cursorAuth/stripeSubscriptionStatus",
  "storage.serviceMachineId",
  "cursorAuth/clientId",
  "cursorAuth/clientVersion",
  "cursorAuth/configVersion",
];

type CursorStorageMap = Record<string, string>;

export function defaultCursorStoragePath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    );
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(home, "AppData/Roaming"),
      "Cursor/User/globalStorage/state.vscdb",
    );
  }
  return path.join(home, ".config/Cursor/User/globalStorage/state.vscdb");
}

function coerceStorageValue(value: unknown): string {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object" && "value" in parsed) {
        return String((parsed as { value: unknown }).value ?? "");
      }
    } catch {
      // Plain strings are common in state.vscdb.
    }
    return value;
  }
  if (value == null) return "";
  return String(value);
}

function readJsonStorage(storagePath: string): CursorStorageMap {
  const parsed = JSON.parse(fs.readFileSync(storagePath, "utf-8"));
  const out: CursorStorageMap = {};
  for (const key of CURSOR_KEYS) {
    if (parsed[key] !== undefined) out[key] = coerceStorageValue(parsed[key]);
  }
  return out;
}

function readSqliteStorage(storagePath: string): CursorStorageMap {
  const out: CursorStorageMap = {};
  let lastError: any = null;
  const quotedKeys = CURSOR_KEYS.map((key) => `'${key.replace(/'/g, "''")}'`).join(
    ",",
  );
  for (const table of ["ItemTable", "cursorDiskKV"]) {
    const select = `SELECT key, value FROM ${table} WHERE key IN (${quotedKeys});`;
    try {
      const output = execFileSync("sqlite3", ["-json", storagePath, select], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      });
      const rows = JSON.parse(output || "[]") as Array<{
        key?: string;
        value?: unknown;
      }>;
      for (const row of rows) {
        if (!row.key || !CURSOR_KEYS.includes(row.key)) continue;
        out[row.key] = coerceStorageValue(row.value);
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (!Object.keys(out).length && lastError) {
    throw new Error(
      `Failed to read Cursor SQLite storage with sqlite3: ${lastError?.message || String(lastError)}`,
    );
  }
  return out;
}

export function readCursorLocalStorage(storagePath?: string): CursorStorageMap {
  const resolved = storagePath || defaultCursorStoragePath();
  if (!fs.existsSync(resolved)) {
    throw new Error(`Cursor storage not found: ${resolved}`);
  }
  if (resolved.endsWith(".json")) return readJsonStorage(resolved);
  return readSqliteStorage(resolved);
}

function expiryFromJwt(accessToken: string): string {
  try {
    const claims = decodeJwtPayload(accessToken) as { exp?: number };
    if (claims.exp) return new Date(claims.exp * 1000).toISOString();
  } catch {
    // Cursor access tokens are JWTs in current builds; fall back conservatively.
  }
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

export function cursorTokenFromStorage(
  storage: CursorStorageMap,
  overrides: Partial<TokenData> = {},
): TokenData {
  const accessToken = storage["cursorAuth/accessToken"];
  const refreshToken = storage["cursorAuth/refreshToken"];
  if (!accessToken || !refreshToken) {
    throw new Error(
      "Cursor local storage is missing cursorAuth/accessToken or cursorAuth/refreshToken",
    );
  }

  const email = storage["cursorAuth/cachedEmail"] || overrides.email || "unknown";
  const serviceMachineId =
    storage["storage.serviceMachineId"] ||
    overrides.cursorServiceMachineId ||
    uuidv4();

  return {
    accessToken,
    refreshToken,
    email,
    expiresAt: expiryFromJwt(accessToken),
    accountUuid: serviceMachineId,
    provider: "cursor",
    cursorServiceMachineId: serviceMachineId,
    cursorClientVersion:
      storage["cursorAuth/clientVersion"] ||
      overrides.cursorClientVersion ||
      DEFAULT_CURSOR_CLIENT_VERSION,
    cursorConfigVersion:
      storage["cursorAuth/configVersion"] ||
      overrides.cursorConfigVersion ||
      uuidv4(),
    cursorClientId:
      storage["cursorAuth/clientId"] ||
      overrides.cursorClientId ||
      CURSOR_CLIENT_ID,
    cursorMembershipType:
      storage["cursorAuth/stripeMembershipType"] ||
      overrides.cursorMembershipType,
  };
}

export function importCursorTokenFromLocalStorage(
  storagePath?: string,
): TokenData {
  return cursorTokenFromStorage(readCursorLocalStorage(storagePath));
}
