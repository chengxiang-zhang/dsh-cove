import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadTokenFromCodexAuthFile,
  saveTokenToCodexAuthFile,
} from "../src/auth/codex/native-auth";
import { TokenData } from "../src/auth/types";

function tmpAuthFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-codex-"));
  return path.join(dir, "auth.json");
}

test("native-auth round-trips Codex CLI auth.json", () => {
  const file = tmpAuthFile();
  const initial = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      // Minimal unsigned JWT-shaped blobs (header.payload.sig)
      id_token:
        "eyJhbGciOiJub25lIn0." +
        Buffer.from(
          JSON.stringify({
            email: "alice@example.com",
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct-1",
              chatgpt_plan_type: "pro",
            },
          }),
        ).toString("base64url") +
        ".x",
      access_token:
        "eyJhbGciOiJub25lIn0." +
        Buffer.from(
          JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        ).toString("base64url") +
        ".x",
      refresh_token: "rt.initial",
      account_id: "acct-1",
    },
    last_refresh: "2026-01-01T00:00:00.000Z",
  };
  fs.writeFileSync(file, JSON.stringify(initial, null, 2));

  const loaded = loadTokenFromCodexAuthFile(file);
  assert.ok(loaded);
  assert.equal(loaded!.email, "alice@example.com");
  assert.equal(loaded!.accountUuid, "acct-1");
  assert.equal(loaded!.planType, "pro");
  assert.equal(loaded!.refreshToken, "rt.initial");
  assert.equal(loaded!.provider, "codex");

  const updated: TokenData = {
    ...loaded!,
    accessToken: loaded!.accessToken,
    refreshToken: "rt.rotated",
    lastRefreshAt: "2026-09-01T00:00:00.000Z",
  };
  saveTokenToCodexAuthFile(file, updated);

  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(raw.auth_mode, "chatgpt");
  assert.equal(raw.tokens.refresh_token, "rt.rotated");
  assert.equal(raw.tokens.account_id, "acct-1");
  assert.equal(raw.last_refresh, "2026-09-01T00:00:00.000Z");

  const reloaded = loadTokenFromCodexAuthFile(file);
  assert.equal(reloaded!.refreshToken, "rt.rotated");
});

test("native-auth returns null for missing file", () => {
  assert.equal(
    loadTokenFromCodexAuthFile("/tmp/dsh-api-proxy-does-not-exist-auth.json"),
    null,
  );
});
