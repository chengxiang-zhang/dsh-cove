import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { decodeJwtPayload } from "../src/utils/jwt";
import {
  saveToken,
  loadAllTokens,
  tokenToStorage,
  storageToToken,
} from "../src/auth/token-storage";
import { TokenData, TokenStorage } from "../src/auth/types";
import { AccountManager, extractUsage } from "../src/accounts/manager";
import { buildRegistry } from "../src/providers/registry";
import { generateCodexAuthURL } from "../src/auth/codex/oauth";
import { generatePKCECodes } from "../src/auth/pkce";
import {
  RefreshTokenExhaustedError,
  detectExhaustedReason,
} from "../src/auth/refresh-errors";
import { waitForCallback } from "../src/auth/callback-server";
import http from "node:http";

// ══════════════════════════════════════════════════
// utils/jwt.ts
// ══════════════════════════════════════════════════

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "RS256" })}.${enc(payload)}.signature`;
}

test("decodeJwtPayload extracts claims", () => {
  const jwt = makeJwt({
    email: "alice@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
  });
  const claims = decodeJwtPayload(jwt) as any;
  assert.equal(claims.email, "alice@example.com");
  assert.equal(
    claims["https://api.openai.com/auth"].chatgpt_account_id,
    "acct_123",
  );
});

test("decodeJwtPayload handles base64url padding", () => {
  // Two-character payload triggers padding logic
  const claims = decodeJwtPayload(makeJwt({ a: 1 })) as any;
  assert.equal(claims.a, 1);
});

test("decodeJwtPayload throws on malformed input", () => {
  assert.throws(() => decodeJwtPayload("not-a-jwt"));
});

// ══════════════════════════════════════════════════
// providers/registry — model routing
// ══════════════════════════════════════════════════

test("providerForModel routes by model name", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    const registry = buildRegistry(tmpDir);
    // Anthropic
    assert.equal(registry.forModel("claude-sonnet-5").id, "anthropic");
    assert.equal(registry.forModel("claude-fable-5").id, "anthropic");
    assert.equal(registry.forModel("claude-mythos-preview").id, "anthropic");
    assert.equal(
      registry.forModel("anthropic.claude-mythos-preview").id,
      "anthropic",
    );
    assert.equal(registry.forModel("claude-sonnet-4-6").id, "anthropic");
    assert.equal(registry.forModel("sonnet").id, "anthropic");
    assert.equal(registry.forModel("fable").id, "anthropic");
    assert.equal(registry.forModel("mythos").id, "anthropic");
    assert.equal(registry.forModel("opus").id, "anthropic");
    assert.equal(registry.forModel("claude-opus-4-7").id, "anthropic");
    // Codex — gpt-5 family + gpt-6 family + o-series + codex- prefix
    assert.equal(registry.forModel("gpt-5").id, "codex");
    assert.equal(registry.forModel("gpt-5-codex").id, "codex");
    assert.equal(registry.forModel("gpt-5.5").id, "codex");
    assert.equal(registry.forModel("gpt-5.4").id, "codex");
    assert.equal(registry.forModel("gpt-5.4-mini").id, "codex");
    assert.equal(registry.forModel("gpt-5.3-codex").id, "codex");
    assert.equal(registry.forModel("gpt-5.2").id, "codex");
    assert.equal(registry.forModel("gpt-6").id, "codex");
    assert.equal(registry.forModel("gpt-6-sol").id, "codex");
    assert.equal(registry.forModel("gpt-6-luna").id, "codex");
    assert.equal(registry.forModel("gpt-6-astra").id, "codex");
    assert.equal(registry.forModel("gpt-6.1-sol").id, "codex");
    assert.equal(registry.forModel("o3").id, "codex");
    assert.equal(registry.forModel("o4-mini").id, "codex");
    assert.equal(registry.forModel("codex-mini-latest").id, "codex");
    // Legacy OpenAI models that codex backend does NOT serve — default to anthropic.
    assert.equal(registry.forModel("gpt-3.5-turbo").id, "anthropic");
    assert.equal(registry.forModel("gpt-4").id, "anthropic");
    assert.equal(registry.forModel("gpt-4o").id, "anthropic");
    assert.equal(registry.forModel("gpt-4o-mini").id, "anthropic");
    // Unknown model defaults to anthropic for backwards compatibility.
    assert.equal(registry.forModel("unknown-model").id, "anthropic");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("registry.withAccounts filters empty providers", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    const registry = buildRegistry(tmpDir);
    for (const p of registry.all()) p.manager.load();
    assert.equal(registry.withAccounts().length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════
// auth/token-storage — provider-aware
// ══════════════════════════════════════════════════

test("token-storage round-trips anthropic tokens with claude-* filename", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    const data: TokenData = {
      accessToken: "at",
      refreshToken: "rt",
      email: "alice@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "uuid-1",
      provider: "anthropic",
    };
    saveToken(tmpDir, data);
    const files = fs.readdirSync(tmpDir);
    assert.deepEqual(files, ["claude-alice@example.com.json"]);

    const tokens = loadAllTokens(tmpDir, "anthropic");
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].email, "alice@example.com");
    assert.equal(tokens[0].provider, "anthropic");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("token-storage round-trips codex tokens with codex-* filename", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    const data: TokenData = {
      accessToken: "at",
      refreshToken: "rt",
      email: "bob@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "chatgpt-acct-1",
      provider: "codex",
      idToken: "id.jwt.token",
    };
    saveToken(tmpDir, data);
    const files = fs.readdirSync(tmpDir);
    assert.deepEqual(files, ["codex-bob@example.com.json"]);

    const tokens = loadAllTokens(tmpDir, "codex");
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].provider, "codex");
    assert.equal(tokens[0].idToken, "id.jwt.token");
    assert.equal(tokens[0].accountUuid, "chatgpt-acct-1");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadAllTokens backfills legacy claude-*.json without provider field", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    // Legacy file shape (no provider/type field — historical "type: claude")
    const legacy: TokenStorage = {
      access_token: "at",
      refresh_token: "rt",
      last_refresh: "2024-01-01T00:00:00.000Z",
      email: "old@example.com",
      type: "claude",
      expired: "2030-01-01T00:00:00.000Z",
      account_uuid: "legacy-uuid",
    };
    fs.writeFileSync(
      path.join(tmpDir, "claude-old@example.com.json"),
      JSON.stringify(legacy),
    );

    const anthropicTokens = loadAllTokens(tmpDir, "anthropic");
    assert.equal(anthropicTokens.length, 1);
    assert.equal(anthropicTokens[0].provider, "anthropic");

    // Codex filter should NOT pick up the legacy claude file.
    const codexTokens = loadAllTokens(tmpDir, "codex");
    assert.equal(codexTokens.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadAllTokens with no filter returns both providers", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    saveToken(tmpDir, {
      accessToken: "a",
      refreshToken: "b",
      email: "alice@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "u1",
      provider: "anthropic",
    });
    saveToken(tmpDir, {
      accessToken: "c",
      refreshToken: "d",
      email: "bob@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "u2",
      provider: "codex",
    });
    const all = loadAllTokens(tmpDir);
    assert.equal(all.length, 2);
    const providers = new Set(all.map((t) => t.provider));
    assert.deepEqual([...providers].sort(), ["anthropic", "codex"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("tokenToStorage maps anthropic provider to legacy 'claude' type", () => {
  const data: TokenData = {
    accessToken: "at",
    refreshToken: "rt",
    email: "x@y.z",
    expiresAt: "2030-01-01T00:00:00.000Z",
    accountUuid: "u",
    provider: "anthropic",
  };
  const stored = tokenToStorage(data);
  assert.equal(stored.type, "claude");
  // Round-trip retains provider as "anthropic".
  assert.equal(storageToToken(stored).provider, "anthropic");
});

// ══════════════════════════════════════════════════
// AccountManager — refresh lock semantics
// ══════════════════════════════════════════════════

test("refreshAccount: concurrent callers share one in-flight promise", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    let refreshCalls = 0;
    const manager = new AccountManager(tmpDir, {
      provider: "codex",
      refresh: async (rt: string): Promise<TokenData> => {
        refreshCalls++;
        // Simulate a slow upstream so concurrent callers must share the lock.
        await new Promise((r) => setTimeout(r, 50));
        return {
          accessToken: `new-access-${refreshCalls}`,
          refreshToken: `new-refresh-${refreshCalls}`,
          email: "x@y.z",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountUuid: "u",
          provider: "codex",
        };
      },
    });

    manager.addAccount({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      email: "x@y.z",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
    });

    // Fire 5 concurrent refreshes
    const results = await Promise.all(
      Array.from({ length: 5 }, () => manager.refreshAccount("x@y.z")),
    );

    assert.equal(refreshCalls, 1, "refresh fn should be invoked exactly once");
    assert.deepEqual(results, [true, true, true, true, true]);
    // Persisted token must reflect the single refresh result.
    const reloaded = loadAllTokens(tmpDir, "codex");
    assert.equal(reloaded[0].accessToken, "new-access-1");
    assert.equal(reloaded[0].refreshToken, "new-refresh-1");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("refreshAccount: subsequent refresh after completion calls fn again", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    let refreshCalls = 0;
    const manager = new AccountManager(tmpDir, {
      provider: "codex",
      refresh: async (): Promise<TokenData> => {
        refreshCalls++;
        return {
          accessToken: `at-${refreshCalls}`,
          refreshToken: `rt-${refreshCalls}`,
          email: "x@y.z",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountUuid: "u",
          provider: "codex",
        };
      },
    });
    manager.addAccount({
      accessToken: "a",
      refreshToken: "b",
      email: "x@y.z",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
    });

    await manager.refreshAccount("x@y.z");
    await manager.refreshAccount("x@y.z");
    assert.equal(refreshCalls, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════
// Account routing & no-account handling
// ══════════════════════════════════════════════════

test("getNextAccount returns null when no accounts loaded", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    const registry = buildRegistry(tmpDir);
    for (const p of registry.all()) p.manager.load();
    const codex = registry.get("codex");
    const result = codex.manager.getNextAccount();
    assert.equal(result.account, null);
    if (result.account === null) {
      assert.equal(result.failureKind, null);
      assert.equal(result.retryAfterMs, null);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════
// Codex OAuth URL — verify required params
// ══════════════════════════════════════════════════

test("generateCodexAuthURL includes verified codex-cli params", () => {
  const pkce = generatePKCECodes();
  const url = generateCodexAuthURL("state-xyz", pkce);
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://auth.openai.com");
  assert.equal(parsed.pathname, "/oauth/authorize");
  const q = parsed.searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(q.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(
    q.get("scope"),
    "openid profile email offline_access api.connectors.read api.connectors.invoke",
  );
  assert.equal(q.get("code_challenge"), pkce.codeChallenge);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("id_token_add_organizations"), "true");
  assert.equal(q.get("codex_cli_simplified_flow"), "true");
  assert.equal(q.get("originator"), "codex_cli_rs");
  assert.equal(q.get("state"), "state-xyz");
});

// ══════════════════════════════════════════════════
// refresh-errors — terminal failure signals
// ══════════════════════════════════════════════════

test("detectExhaustedReason recognises documented codes", () => {
  assert.equal(
    detectExhaustedReason(
      JSON.stringify({ error: { code: "refresh_token_reused" } }),
    ),
    "reused",
  );
  assert.equal(
    detectExhaustedReason(
      JSON.stringify({ error: { code: "refresh_token_expired" } }),
    ),
    "expired",
  );
  assert.equal(
    detectExhaustedReason(
      JSON.stringify({ error: "refresh_token_invalidated" }),
    ),
    "invalidated",
  );
  assert.equal(
    detectExhaustedReason(JSON.stringify({ code: "refresh_token_reused" })),
    "reused",
  );
  // Non-terminal codes / parse failures return null.
  assert.equal(
    detectExhaustedReason(JSON.stringify({ error: { code: "rate_limited" } })),
    null,
  );
  assert.equal(detectExhaustedReason(""), null);
  assert.equal(detectExhaustedReason("not json"), null);
});

test("performRefresh: RefreshTokenExhaustedError → terminal cooldown + clear message", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    const manager = new AccountManager(tmpDir, {
      provider: "codex",
      refresh: async (): Promise<TokenData> => {
        throw new RefreshTokenExhaustedError("reused", 401, "");
      },
    });
    manager.addAccount({
      accessToken: "a",
      refreshToken: "b",
      email: "x@y.z",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
    });

    const ok = await manager.refreshAccount("x@y.z");
    assert.equal(ok, false);
    const snap = manager.getSnapshots()[0];
    assert.equal(snap.available, false, "account must be in cooldown");
    assert.match(snap.lastError ?? "", /reused/);
    assert.match(snap.lastError ?? "", /--login --provider=codex/);
    // Cooldown must be much longer than the default auth backoff (10 min).
    assert.ok(
      snap.cooldownUntil - Date.now() > 60 * 60 * 1000,
      "needs reauth → long cooldown",
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════
// Q1 — per-provider refresh policy
// ══════════════════════════════════════════════════

test("refresh policy 'since-last-refresh' skips fresh accounts even near expiry", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    let refreshCalls = 0;
    const manager = new AccountManager(tmpDir, {
      provider: "codex",
      refresh: async () => {
        refreshCalls++;
        return {
          accessToken: "new",
          refreshToken: "new",
          email: "x@y.z",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountUuid: "u",
          provider: "codex",
        };
      },
      refreshPolicy: { kind: "since-last-refresh", maxAgeMs: 8 * 86_400_000 },
    });
    // Token expires in 5 minutes (would trigger expires-lead default), but the
    // codex policy should NOT refresh because last_refresh is "now".
    manager.addAccount({
      accessToken: "a",
      refreshToken: "b",
      email: "x@y.z",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
      lastRefreshAt: new Date().toISOString(),
    });
    // Force a refresh sweep by triggering startAutoRefresh's initial pass.
    // Use private refreshAll via the public refreshAccount path is not the same;
    // instead directly invoke the sweep behaviour by simulating the timer's
    // call: easiest is to call refreshAccount only when shouldRefresh is true.
    // Here we emulate the sweep manually:
    const proto: any = manager.constructor.prototype;
    const should = proto.shouldRefresh.call(
      manager,
      (manager as any).accounts.get("x@y.z"),
      Date.now(),
    );
    assert.equal(should, false, "fresh account must not be refreshed");
    assert.equal(refreshCalls, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("refresh policy 'since-last-refresh' triggers when stale", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    // Write the token file directly with an old last_refresh, then load — this
    // is how a real restart sees a stale account. addAccount() always stamps
    // "now" so we can't use it to test the stale path.
    saveToken(tmpDir, {
      accessToken: "a",
      refreshToken: "b",
      email: "x@y.z",
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
      lastRefreshAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
    });
    const manager = new AccountManager(tmpDir, {
      provider: "codex",
      refresh: async () => ({}) as any,
      refreshPolicy: { kind: "since-last-refresh", maxAgeMs: 8 * 86_400_000 },
    });
    manager.load();
    const proto: any = manager.constructor.prototype;
    const should = proto.shouldRefresh.call(
      manager,
      (manager as any).accounts.get("x@y.z"),
      Date.now(),
    );
    assert.equal(should, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════
// B2 — extractUsage handles both shapes
// ══════════════════════════════════════════════════

test("extractUsage parses Anthropic Messages JSON shape", () => {
  const u = extractUsage({
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 7,
    },
  });
  assert.equal(u.inputTokens, 10);
  assert.equal(u.outputTokens, 20);
  assert.equal(u.cacheCreationInputTokens, 3);
  assert.equal(u.cacheReadInputTokens, 7);
  assert.equal(u.reasoningOutputTokens, 0);
});

test("extractUsage parses OpenAI Responses JSON shape", () => {
  const u = extractUsage({
    response: {
      usage: {
        input_tokens: 28,
        output_tokens: 5,
        total_tokens: 33,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    },
  });
  assert.equal(u.inputTokens, 28);
  assert.equal(u.outputTokens, 5);
  assert.equal(u.cacheCreationInputTokens, 0); // codex has no equivalent
  assert.equal(u.cacheReadInputTokens, 4);
  assert.equal(u.reasoningOutputTokens, 2);
});

test("extractUsage returns zeros when usage missing", () => {
  const u = extractUsage({});
  assert.equal(u.inputTokens, 0);
  assert.equal(u.outputTokens, 0);
  assert.equal(u.reasoningOutputTokens, 0);
});

// ══════════════════════════════════════════════════
// N1 — plan_type extraction
// ══════════════════════════════════════════════════

test("plan_type round-trips through token storage", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    saveToken(tmpDir, {
      accessToken: "a",
      refreshToken: "b",
      email: "x@y.z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "u",
      provider: "codex",
      planType: "pro",
    });
    const tokens = loadAllTokens(tmpDir, "codex");
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].planType, "pro");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════
// callback-server — success page served inline
// ══════════════════════════════════════════════════

async function getOnce(url: string): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      })
      .on("error", reject);
  });
}

test("waitForCallback serves success HTML inline (no 302 to closed server)", async () => {
  // Pick a deterministic free-ish port. Tests run serially, so collisions are
  // unlikely; if hit, the OS will surface EADDRINUSE which the test catches.
  const port = 54546;
  const callbackPromise = waitForCallback({
    port,
    callbackPath: "/auth/callback",
    timeoutMs: 5_000,
  });
  // Small delay so the server is listening before we hit it.
  await new Promise((r) => setTimeout(r, 50));

  const resp = await getOnce(
    `http://127.0.0.1:${port}/auth/callback?code=abc&state=xyz`,
  );

  // Critical: 200, NOT 302 — there is no follow-up server to redirect to.
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.location, undefined);
  assert.match(resp.body, /Login Successful/);

  const result = await callbackPromise;
  assert.equal(result.code, "abc");
  assert.equal(result.state, "xyz");
});

// ══════════════════════════════════════════════════
// codex-api.normalizeCodexResponsesBody
// ══════════════════════════════════════════════════

import {
  normalizeCodexCompactBody,
  normalizeCodexResponsesBody,
} from "../src/upstream/codex-api";

test("normalizeCodexResponsesBody fills missing required fields", () => {
  const out = normalizeCodexResponsesBody({
    model: "gpt-5.3-codex",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  });
  assert.equal(out.stream, true);
  assert.equal(out.store, false);
  assert.equal(out.instructions, "");
  // Untouched fields preserved
  assert.equal(out.model, "gpt-5.3-codex");
  assert.ok(Array.isArray(out.input));
});

test("normalizeCodexResponsesBody preserves explicit values", () => {
  const out = normalizeCodexResponsesBody({
    model: "gpt-5.5",
    input: [],
    stream: false,
    store: true,
    instructions: "custom prompt",
  });
  // Explicit choices pass through — even contradictory ones (the upstream
  // will reject; we don't second-guess intent).
  assert.equal(out.stream, false);
  assert.equal(out.store, true);
  assert.equal(out.instructions, "custom prompt");
});

test("normalizeCodexResponsesBody handles empty/non-object input safely", () => {
  assert.equal(normalizeCodexResponsesBody(null), null);
  assert.equal(normalizeCodexResponsesBody(undefined), undefined);
  assert.equal(
    normalizeCodexResponsesBody("not an object" as any),
    "not an object",
  );
});

test("normalizeCodexCompactBody keeps compact schema and drops request-scoped fields", () => {
  const out = normalizeCodexCompactBody({
    model: "gpt-5.5",
    input: [{ role: "user", content: "compact me" }],
    instructions: "compact",
    tools: [{ type: "function", name: "shell" }],
    parallel_tool_calls: true,
    reasoning: { effort: "high" },
    text: { verbosity: "low" },
    previous_response_id: "resp_123",
    stream: true,
    store: true,
    prompt_cache_key: "cache-key",
    client_metadata: { source: "codex" },
  });

  assert.equal(out.model, "gpt-5.5");
  assert.ok(Array.isArray(out.input));
  assert.equal(out.instructions, "compact");
  assert.ok(Array.isArray(out.tools));
  assert.equal(out.parallel_tool_calls, true);
  assert.equal(out.reasoning.effort, "high");
  assert.equal(out.text.verbosity, "low");
  assert.equal(out.previous_response_id, "resp_123");
  assert.equal(out.stream, undefined);
  assert.equal(out.store, undefined);
  assert.equal(out.prompt_cache_key, undefined);
  assert.equal(out.client_metadata, undefined);
});

// ══════════════════════════════════════════════════
// codex-api buildHeaders — protocol-required + parity headers
// ══════════════════════════════════════════════════

import { __buildCodexHeaders } from "../src/upstream/codex-api";
import type { Config } from "../src/config";
import type { AvailableAccount } from "../src/accounts/manager";

function makeCodexConfig(
  overrides: Partial<Config["cloaking"]["codex"]> = {},
): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": "/tmp",
    "api-keys": new Set(["k"]),
    "body-limit": "1mb",
    cloaking: {
      "cli-version": "2.1.88",
      entrypoint: "cli",
      codex: { ...overrides },
    },
    timeouts: {
      "messages-ms": 1000,
      "stream-messages-ms": 1000,
      "count-tokens-ms": 1000,
    },
    debug: "off",
  };
}

function makeAvailableAccount(): AvailableAccount {
  return {
    token: {
      accessToken: "at",
      refreshToken: "rt",
      email: "x@y.z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "acct-uuid",
      provider: "codex",
    },
    deviceId: "dev",
    accountUuid: "acct-uuid",
    provider: "codex",
    chatgptAccountId: "acct-uuid",
  };
}

test("codex headers include `version` (parity with official CLI provider header)", () => {
  const headers = __buildCodexHeaders(
    makeAvailableAccount(),
    /*stream*/ true,
    makeCodexConfig({ "cli-version": "0.41.0" }),
  );
  // Required-by-codex-CLI provider header (model-provider-info/src/lib.rs:324).
  // Value tracks our configured cli-version so it stays in sync with User-Agent.
  assert.equal(headers.version, "0.41.0");
  // Authoring sanity-check: the value must not equal the auth bearer.
  assert.notEqual(headers.version, headers.Authorization);
});

test("codex headers include the always-protocol-required set", () => {
  const headers = __buildCodexHeaders(
    makeAvailableAccount(),
    /*stream*/ true,
    makeCodexConfig(),
  );
  assert.equal(headers.Authorization, "Bearer at");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers.Accept, "text/event-stream");
  assert.equal(headers.originator, "codex_cli_rs");
  assert.equal(headers["ChatGPT-Account-ID"], "acct-uuid");
  assert.match(headers["User-Agent"], /codex_cli_rs\/\S+/);
  assert.ok(typeof headers.version === "string" && headers.version.length > 0);
});

test("codex headers omit OpenAI-Beta unless configured, omit Account-ID if missing", () => {
  // No openai-beta in config, no chatgptAccountId on the account.
  const acct = makeAvailableAccount();
  acct.chatgptAccountId = undefined;
  const headers = __buildCodexHeaders(
    acct,
    /*stream*/ false,
    makeCodexConfig(),
  );
  assert.equal(headers["OpenAI-Beta"], undefined);
  assert.equal(headers["ChatGPT-Account-ID"], undefined);
  assert.equal(headers.Accept, "application/json");
});

// ══════════════════════════════════════════════════
// AccountManager.reload — token-rotation race fix
// ══════════════════════════════════════════════════

import { ReloadStats } from "../src/accounts/manager";

function makeCodexManagerWithFakeRefresh(authDir: string) {
  return new AccountManager(authDir, {
    provider: "codex",
    refresh: async () => ({}) as any,
  });
}

test("reload upserts an existing account: replaces accessToken, clears cooldown, preserves stats", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    saveToken(tmpDir, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      email: "x@y.z",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
    });
    const manager = makeCodexManagerWithFakeRefresh(tmpDir);
    manager.load();
    // Simulate operational history: requests + a forced cooldown
    manager.recordAttempt("x@y.z");
    manager.recordSuccess("x@y.z", {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
    });
    manager.recordFailure("x@y.z", "rate_limit", "forced");
    const before = manager.getSnapshots()[0];
    assert.equal(before.available, false);
    assert.equal(before.totalSuccesses, 1);
    assert.equal(before.totalInputTokens, 10);

    // Disk now has a new token (simulating --login re-auth).
    saveToken(tmpDir, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      email: "x@y.z",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
    });

    const stats: ReloadStats = await manager.reload();
    assert.deepEqual(stats.added, []);
    assert.deepEqual(stats.updated, ["x@y.z"]);
    assert.deepEqual(stats.unchanged, []);

    const after = manager.getSnapshots()[0];
    // Cooldown + lastError cleared
    assert.equal(after.available, true);
    assert.equal(after.cooldownUntil, 0);
    assert.equal(after.lastError, null);
    assert.equal(after.failureCount, 0);
    // Stats preserved
    assert.equal(after.totalSuccesses, 1);
    assert.equal(after.totalRequests, 1);
    assert.equal(after.totalInputTokens, 10);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reload picks up a newly created token file as 'added'", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    const manager = makeCodexManagerWithFakeRefresh(tmpDir);
    manager.load();
    assert.equal(manager.accountCount, 0);

    saveToken(tmpDir, {
      accessToken: "a",
      refreshToken: "b",
      email: "new@example.com",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
    });

    const stats = await manager.reload();
    assert.deepEqual(stats.added, ["new@example.com"]);
    assert.equal(manager.accountCount, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reload is a no-op when nothing changed (everything goes to unchanged)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    saveToken(tmpDir, {
      accessToken: "same",
      refreshToken: "rt",
      email: "x@y.z",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
    });
    const manager = makeCodexManagerWithFakeRefresh(tmpDir);
    manager.load();
    const stats = await manager.reload();
    assert.deepEqual(stats.added, []);
    assert.deepEqual(stats.updated, []);
    assert.deepEqual(stats.unchanged, ["x@y.z"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reload waits for in-flight refresh before reconciling (no clobber race)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    let refreshDoneAt = 0;
    let reloadDoneAt = 0;
    const manager = new AccountManager(tmpDir, {
      provider: "codex",
      refresh: async (): Promise<TokenData> => {
        await new Promise((r) => setTimeout(r, 80));
        refreshDoneAt = Date.now();
        return {
          accessToken: "refreshed",
          refreshToken: "refreshed-rt",
          email: "x@y.z",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountUuid: "u",
          provider: "codex",
        };
      },
    });
    manager.addAccount({
      accessToken: "old",
      refreshToken: "old-rt",
      email: "x@y.z",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
    });

    // Fire refresh + reload concurrently. Reload must wait for refresh to
    // complete; otherwise the refresh's post-await `acct.token = newToken`
    // would overwrite the reconciled state.
    const refreshP = manager.refreshAccount("x@y.z");
    const reloadP = manager.reload().then((s) => {
      reloadDoneAt = Date.now();
      return s;
    });
    await refreshP;
    await reloadP;

    assert.ok(
      reloadDoneAt >= refreshDoneAt,
      `reload (${reloadDoneAt}) finished before refresh (${refreshDoneAt})`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reload deduplicates concurrent calls (single disk read)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    saveToken(tmpDir, {
      accessToken: "a",
      refreshToken: "b",
      email: "x@y.z",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
    });
    const manager = makeCodexManagerWithFakeRefresh(tmpDir);
    manager.load();

    // Three concurrent reloads should share the same in-flight promise.
    const p1 = manager.reload();
    const p2 = manager.reload();
    const p3 = manager.reload();
    assert.strictEqual(p1, p2);
    assert.strictEqual(p2, p3);
    const [s1, s2, s3] = await Promise.all([p1, p2, p3]);
    assert.deepEqual(s1, s2);
    assert.deepEqual(s2, s3);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reload does NOT remove accounts whose disk file was deleted", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    saveToken(tmpDir, {
      accessToken: "a",
      refreshToken: "b",
      email: "ghost@example.com",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
    });
    const manager = makeCodexManagerWithFakeRefresh(tmpDir);
    manager.load();
    assert.equal(manager.accountCount, 1);

    // Delete the on-disk file.
    fs.unlinkSync(path.join(tmpDir, "codex-ghost@example.com.json"));

    const stats = await manager.reload();
    // No "removed" channel — silently kept.
    assert.deepEqual(stats.added, []);
    assert.deepEqual(stats.updated, []);
    assert.deepEqual(stats.unchanged, []);
    // In-memory account is preserved.
    assert.equal(manager.accountCount, 1);
    assert.equal(manager.getSnapshots()[0].email, "ghost@example.com");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════
// notifyServerReload — best-effort --login → server signal
// ══════════════════════════════════════════════════

import { notifyServerReload } from "../src/utils/notify-reload";
import type { Config as Config2 } from "../src/config";

function makeNotifyConfig(): Config2 {
  return {
    host: "127.0.0.1",
    port: 18399,
    "auth-dir": "/tmp",
    "api-keys": new Set(["sk-test"]),
    "body-limit": "1mb",
    cloaking: { "cli-version": "2.1.88", entrypoint: "cli" },
    timeouts: {
      "messages-ms": 1000,
      "stream-messages-ms": 1000,
      "count-tokens-ms": 1000,
    },
    debug: "off",
  };
}

function withFetchStub(
  stub: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

function captureLogs(): {
  logs: string[];
  warns: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: any[]) => logs.push(args.join(" "));
  console.warn = (...args: any[]) => warns.push(args.join(" "));
  return {
    logs,
    warns,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
    },
  };
}

test("notifyServerReload posts to /admin/reload with the first api-key as Bearer", async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  const restoreFetch = withFetchStub(async (input, init) => {
    seen = { url: String(input), init };
    return new Response(
      JSON.stringify({ reloaded: {}, generated_at: "now" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  const cap = captureLogs();
  try {
    await notifyServerReload(makeNotifyConfig());
  } finally {
    cap.restore();
    restoreFetch();
  }
  assert.ok(seen);
  assert.equal(seen!.url, "http://127.0.0.1:18399/admin/reload");
  assert.equal(seen!.init?.method, "POST");
  assert.equal(
    (seen!.init?.headers as Record<string, string>)?.Authorization,
    "Bearer sk-test",
  );
  assert.ok(cap.logs.some((l) => l.includes("Notified running dsh-api-proxy server")));
  assert.equal(cap.warns.length, 0);
});

test("notifyServerReload silently info-logs on ECONNREFUSED (server not running)", async () => {
  const restoreFetch = withFetchStub(async () => {
    const err: any = new TypeError("fetch failed");
    err.cause = { code: "ECONNREFUSED", message: "connect ECONNREFUSED" };
    throw err;
  });
  const cap = captureLogs();
  try {
    await notifyServerReload(makeNotifyConfig());
  } finally {
    cap.restore();
    restoreFetch();
  }
  // Info-level log, no warn — server not running is the common case.
  assert.equal(cap.warns.length, 0);
  assert.ok(cap.logs.some((l) => l.includes("no dsh-api-proxy server detected")));
});

test("notifyServerReload warns on 401 (api-key mismatch)", async () => {
  const restoreFetch = withFetchStub(async () => {
    return new Response("unauthorized", { status: 401 });
  });
  const cap = captureLogs();
  try {
    await notifyServerReload(makeNotifyConfig());
  } finally {
    cap.restore();
    restoreFetch();
  }
  assert.equal(cap.logs.length, 0);
  assert.ok(
    cap.warns.some(
      (w) =>
        w.includes("rejected the reload (HTTP 401)") &&
        w.includes("api-keys in config.yaml may differ"),
    ),
  );
});

test("notifyServerReload silently info-logs on AbortSignal timeout", async () => {
  const restoreFetch = withFetchStub(async () => {
    const err: any = new Error("aborted");
    err.name = "TimeoutError";
    throw err;
  });
  const cap = captureLogs();
  try {
    await notifyServerReload(makeNotifyConfig());
  } finally {
    cap.restore();
    restoreFetch();
  }
  assert.equal(cap.warns.length, 0);
  assert.ok(cap.logs.some((l) => l.includes("no dsh-api-proxy server detected")));
});

test("notifyServerReload warns on unexpected non-OK status", async () => {
  const restoreFetch = withFetchStub(async () => {
    return new Response("oops", { status: 500 });
  });
  const cap = captureLogs();
  try {
    await notifyServerReload(makeNotifyConfig());
  } finally {
    cap.restore();
    restoreFetch();
  }
  assert.ok(cap.warns.some((w) => w.includes("HTTP 500")));
});

// ══════════════════════════════════════════════════
// Hardening: reload checks refreshToken; notify normalizes bind-all hosts
// ══════════════════════════════════════════════════

import { normalizeNotifyHost } from "../src/utils/notify-reload";

test("reload classifies 'same accessToken + rotated refreshToken' as updated (defensive)", async () => {
  // The race we're fixing is specifically about a stale refresh_token in
  // memory while disk has a rotated one. OAuth doesn't forbid the server
  // returning the same access_token + a new refresh_token, so reload's
  // diff cannot rely on accessToken alone.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-"));
  try {
    saveToken(tmpDir, {
      accessToken: "same-access",
      refreshToken: "old-refresh",
      email: "x@y.z",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
    });
    const manager = new AccountManager(tmpDir, {
      provider: "codex",
      refresh: async () => ({}) as any,
    });
    manager.load();

    // Disk now has same access but rotated refresh.
    saveToken(tmpDir, {
      accessToken: "same-access",
      refreshToken: "new-rotated-refresh",
      email: "x@y.z",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: "u",
      provider: "codex",
    });

    const stats = await manager.reload();
    assert.deepEqual(stats.updated, ["x@y.z"]);
    assert.deepEqual(stats.unchanged, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("normalizeNotifyHost: empty / 0.0.0.0 → 127.0.0.1", () => {
  assert.equal(normalizeNotifyHost(""), "127.0.0.1");
  assert.equal(normalizeNotifyHost(undefined), "127.0.0.1");
  assert.equal(normalizeNotifyHost("0.0.0.0"), "127.0.0.1");
  assert.equal(normalizeNotifyHost("  "), "127.0.0.1"); // whitespace
});

test("normalizeNotifyHost: IPv6 wildcard variants → [::1]", () => {
  assert.equal(normalizeNotifyHost("::"), "[::1]");
  assert.equal(normalizeNotifyHost("[::]"), "[::1]");
  assert.equal(normalizeNotifyHost("0:0:0:0:0:0:0:0"), "[::1]");
});

test("normalizeNotifyHost: bare IPv6 literal gets bracketed", () => {
  assert.equal(normalizeNotifyHost("::1"), "[::1]");
  assert.equal(normalizeNotifyHost("fe80::1"), "[fe80::1]");
  // Already bracketed → leave alone.
  assert.equal(normalizeNotifyHost("[::1]"), "[::1]");
  assert.equal(normalizeNotifyHost("[fe80::1]"), "[fe80::1]");
});

test("normalizeNotifyHost: IPv4 / hostname pass through unchanged", () => {
  assert.equal(normalizeNotifyHost("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeNotifyHost("192.168.1.5"), "192.168.1.5");
  assert.equal(normalizeNotifyHost("localhost"), "localhost");
  assert.equal(normalizeNotifyHost("dsh-api-proxy.local"), "dsh-api-proxy.local");
});
