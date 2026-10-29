import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cursorTokenFromStorage,
  importCursorTokenFromLocalStorage,
  CURSOR_CLIENT_ID,
} from "../src/auth/cursor/storage";
import { refreshCursorTokens } from "../src/auth/cursor/oauth";
import {
  __buildCursorHeaders,
  __resolveCursorModel,
  __setCursorTransport,
  callCursorResponses,
  createCursorStreamingDecoder,
  decodeCursorResponse,
  decodeCursorText,
  encodeCursorAgentRequest,
  extractCursorModelIds,
  normalizeCursorResponsesBody,
} from "../src/upstream/cursor-api";
import { saveToken, loadAllTokens } from "../src/auth/token-storage";
import { buildRegistry } from "../src/providers/registry";
import { Config } from "../src/config";
import {
  buildCursorLoginUrl,
  CursorBrowserLoginMissingRefreshTokenError,
  generateCursorPkce,
  pollCursorAuthOnce,
  pollResultToTokenData,
  runCursorBrowserLogin,
} from "../src/auth/cursor/browser-oauth";
import { RefreshTokenExhaustedError } from "../src/auth/refresh-errors";

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "RS256" })}.${enc(payload)}.signature`;
}

function makeConfig(): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": "/tmp/dsh-api-proxy-test",
    "api-keys": new Set(["test-key"]),
    "body-limit": "200mb",
    cloaking: {
      "cli-version": "2.1.88",
      entrypoint: "cli",
      cursor: {
        "client-version": "cli-test",
        "config-version": "config-test",
      },
    },
    timeouts: {
      "messages-ms": 120000,
      "stream-messages-ms": 600000,
      "count-tokens-ms": 30000,
    },
    debug: "off",
  };
}

function connectJsonFrame(value: unknown): Uint8Array {
  const payload = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 2; // Connect-RPC end-of-stream marker; carries JSON metadata only.
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function encodeVarint(value: number): Buffer {
  const out: number[] = [];
  let n = value >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function encodeLengthDelim(field: number, payload: Buffer): Buffer {
  const tag = encodeVarint((field << 3) | 2);
  const length = encodeVarint(payload.length);
  return Buffer.concat([tag, length, payload]);
}

function connectProtoTextFrame(text: string, outerField = 2): Uint8Array {
  // Mirrors Cursor's StreamUnifiedChatResponseWithTools envelope: an outer
  // wrapper at field=outerField holds StreamUnifiedChatResponse, whose text
  // field is at 1. We default to field 2 because that is what api2.cursor.sh
  // returned in our reverse-engineering captures.
  const inner = encodeLengthDelim(1, Buffer.from(text, "utf8"));
  const outer = encodeLengthDelim(outerField, inner);
  const frame = Buffer.alloc(5 + outer.length);
  frame[0] = 0;
  frame.writeUInt32BE(outer.length, 1);
  outer.copy(frame, 5);
  return frame;
}

function connectProtoReasoningFrame(text: string): Uint8Array {
  // Mirrors a reasoning delta: outer field=2 wraps an inner message that
  // holds the reasoning string at field=25 → field=1.
  const reasoningInner = encodeLengthDelim(1, Buffer.from(text, "utf8"));
  const reasoningWrap = encodeLengthDelim(25, reasoningInner);
  const outer = encodeLengthDelim(2, reasoningWrap);
  const frame = Buffer.alloc(5 + outer.length);
  frame[0] = 0;
  frame.writeUInt32BE(outer.length, 1);
  outer.copy(frame, 5);
  return frame;
}

function withMockedFetch(
  mock: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): () => void {
  const originalFetch = global.fetch;
  global.fetch = mock as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
}

test("cursor local storage import maps tokens and metadata", () => {
  const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const token = cursorTokenFromStorage({
    "cursorAuth/accessToken": accessToken,
    "cursorAuth/refreshToken": "refresh",
    "cursorAuth/cachedEmail": "cursor@example.com",
    "storage.serviceMachineId": "machine-id",
    "cursorAuth/stripeMembershipType": "pro",
  });

  assert.equal(token.provider, "cursor");
  assert.equal(token.email, "cursor@example.com");
  assert.equal(token.accountUuid, "machine-id");
  assert.equal(token.cursorServiceMachineId, "machine-id");
  assert.equal(token.cursorClientId, CURSOR_CLIENT_ID);
  assert.equal(token.cursorMembershipType, "pro");
});

test("cursor import can read JSON storage snapshots", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-cursor-"));
  try {
    const storagePath = path.join(tmpDir, "cursor-state.json");
    fs.writeFileSync(
      storagePath,
      JSON.stringify({
        "cursorAuth/accessToken": makeJwt({
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        "cursorAuth/refreshToken": "refresh",
        "cursorAuth/cachedEmail": "cursor@example.com",
        "storage.serviceMachineId": "machine-id",
      }),
    );
    const token = importCursorTokenFromLocalStorage(storagePath);
    assert.equal(token.email, "cursor@example.com");
    assert.equal(token.cursorServiceMachineId, "machine-id");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cursor tokens round-trip through dsh-api-proxy token storage", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-cursor-"));
  try {
    saveToken(tmpDir, {
      accessToken: "access",
      refreshToken: "refresh",
      email: "cursor@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "machine-id",
      provider: "cursor",
      cursorServiceMachineId: "machine-id",
      cursorClientVersion: "cli-test",
      cursorConfigVersion: "config-test",
      cursorClientId: CURSOR_CLIENT_ID,
      cursorMembershipType: "pro",
    });
    assert.deepEqual(fs.readdirSync(tmpDir), ["cursor-cursor@example.com.json"]);
    const loaded = loadAllTokens(tmpDir, "cursor");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].provider, "cursor");
    assert.equal(loaded[0].cursorServiceMachineId, "machine-id");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("registry routes explicit cursor prefixes regardless of which providers are logged in", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-cursor-"));
  try {
    const registry = buildRegistry(tmpDir);
    assert.equal(registry.forModel("cursor-premium").id, "cursor");
    assert.equal(registry.forModel("cr/composer").id, "cursor");
    // No accounts loaded yet → multi-provider fallback to anthropic.
    assert.equal(registry.forModel("unknown-model").id, "anthropic");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("registry exclusive-cursor mode: bare model names route to cursor when only cursor has accounts", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-cursor-only-"));
  try {
    saveToken(tmpDir, {
      accessToken: "access",
      refreshToken: "refresh",
      email: "cursor-only@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "machine-id",
      provider: "cursor",
      cursorServiceMachineId: "machine-id",
      cursorClientVersion: "cli-test",
      cursorClientId: CURSOR_CLIENT_ID,
    });
    const registry = buildRegistry(tmpDir);
    for (const p of registry.all()) p.manager.load();
    // Anthropic-shaped names → cursor (no prefix needed).
    assert.equal(registry.forModel("claude-sonnet-4-5").id, "cursor");
    assert.equal(registry.forModel("claude-opus-4-5").id, "cursor");
    assert.equal(registry.forModel("opus").id, "cursor");
    // OpenAI-shaped names → cursor.
    assert.equal(registry.forModel("gpt-5.5").id, "cursor");
    assert.equal(registry.forModel("o3").id, "cursor");
    // Truly unknown identifiers → cursor (we'll ask Cursor's Auto router).
    assert.equal(registry.forModel("totally-unknown-model").id, "cursor");
    // Explicit prefixes still work.
    assert.equal(registry.forModel("cursor-composer-2").id, "cursor");
    assert.equal(registry.forModel("cr/default").id, "cursor");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("registry preserves multi-provider routing when more than one provider has accounts", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-multi-"));
  try {
    saveToken(tmpDir, {
      accessToken: "cursor-tok",
      refreshToken: "rt",
      email: "cursor@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "machine-id",
      provider: "cursor",
      cursorClientId: CURSOR_CLIENT_ID,
    });
    saveToken(tmpDir, {
      accessToken: "anthropic-tok",
      refreshToken: "rt",
      email: "anth@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "anth-uuid",
      provider: "anthropic",
    });
    const registry = buildRegistry(tmpDir);
    for (const p of registry.all()) p.manager.load();
    // claude-* must still go to anthropic when both providers exist.
    assert.equal(registry.forModel("claude-sonnet-4-5").id, "anthropic");
    // cursor-* prefix still wins.
    assert.equal(registry.forModel("cursor-composer-2").id, "cursor");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cursor refresh uses documented api2 token endpoint", async (t) => {
  const restoreFetch = withMockedFetch(async (input, init) => {
    assert.equal(String(input), "https://api2.cursor.sh/oauth/token");
    assert.equal(init?.method, "POST");
    assert.equal(
      (init?.headers as Record<string, string>)["Content-Type"],
      "application/json",
    );
    assert.deepEqual(JSON.parse(String(init?.body)), {
      grant_type: "refresh_token",
      client_id: CURSOR_CLIENT_ID,
      refresh_token: "refresh",
    });
    return new Response(
      JSON.stringify({
        access_token: makeJwt({
          exp: Math.floor(Date.now() / 1000) + 3600,
          email: "cursor@example.com",
        }),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  t.after(restoreFetch);

  const token = await refreshCursorTokens("refresh", {
    email: "cursor@example.com",
    accountUuid: "machine-id",
    cursorServiceMachineId: "machine-id",
  });
  assert.equal(token.provider, "cursor");
  assert.equal(token.email, "cursor@example.com");
  assert.equal(token.refreshToken, "refresh");
});

test("cursor request helpers build headers, frame payloads, and decode text", () => {
  const headers = __buildCursorHeaders(
    {
      token: {
        accessToken: "access",
        refreshToken: "refresh",
        email: "cursor@example.com",
        expiresAt: "2030-01-01T00:00:00.000Z",
        accountUuid: "machine-id",
        provider: "cursor",
        cursorServiceMachineId: "machine-id",
      },
      deviceId: "device",
      accountUuid: "machine-id",
      provider: "cursor",
    },
    makeConfig(),
  );
  assert.equal(headers.Authorization, "Bearer access");
  assert.equal(headers["Content-Type"], "application/connect+proto");
  assert.equal(headers["Connect-Protocol-Version"], "1");
  assert.equal(headers["x-cursor-client-version"], "cli-test");
  assert.ok(headers["x-cursor-checksum"].includes("machine-id"));

  const request = encodeCursorAgentRequest({
    model: "cursor-premium",
    input: "hello cursor",
  });
  assert.equal(request[0], 0);
  assert.ok(request.length > 5);

  assert.equal(
    decodeCursorText(connectProtoTextFrame("hello from cursor")),
    "hello from cursor",
  );
  assert.equal(normalizeCursorResponsesBody({ input: "x" }).stream, true);
});

test("__resolveCursorModel maps public Anthropic/OpenAI names to Cursor SKUs", () => {
  assert.equal(__resolveCursorModel("claude-sonnet-4-5"), "claude-4.5-sonnet");
  assert.equal(__resolveCursorModel("claude-haiku-4-5"), "claude-4.5-haiku");
  assert.equal(__resolveCursorModel("claude-opus-4-7"), "claude-opus-4-7-medium");
  assert.equal(__resolveCursorModel("opus"), "claude-opus-4-7-medium");
  assert.equal(__resolveCursorModel("sonnet"), "claude-4.6-sonnet-medium");
  assert.equal(__resolveCursorModel("haiku"), "claude-4.5-haiku");
  assert.equal(__resolveCursorModel("gpt-5.5"), "gpt-5.5-medium");
  assert.equal(__resolveCursorModel("o3"), "gpt-5.5-medium");
});

test("__resolveCursorModel strips routing prefix and passes Cursor SKUs through", () => {
  assert.equal(
    __resolveCursorModel("cursor-composer-2-fast"),
    "composer-2-fast",
  );
  assert.equal(__resolveCursorModel("cr/gpt-5.5-medium"), "gpt-5.5-medium");
  assert.equal(__resolveCursorModel("cursor:default"), "default");
  assert.equal(__resolveCursorModel(""), "default");
});

test("__resolveCursorModel honours CURSOR_MODEL_ALIASES env override", () => {
  const prev = process.env.CURSOR_MODEL_ALIASES;
  try {
    process.env.CURSOR_MODEL_ALIASES = "my-internal-name=claude-opus-4-7-max";
    assert.equal(
      __resolveCursorModel("my-internal-name"),
      "claude-opus-4-7-max",
    );
  } finally {
    if (prev === undefined) delete process.env.CURSOR_MODEL_ALIASES;
    else process.env.CURSOR_MODEL_ALIASES = prev;
  }
});

test("cursor decoder splits reasoning from final text", () => {
  const buf = Buffer.concat([
    Buffer.from(connectProtoReasoningFrame("thinking step 1\n")),
    Buffer.from(connectProtoReasoningFrame("thinking step 2")),
    Buffer.from(connectProtoTextFrame("Answer: 42")),
  ]);
  const result = decodeCursorResponse(new Uint8Array(buf));
  assert.equal(result.reasoning, "thinking step 1\nthinking step 2");
  assert.equal(result.text, "Answer: 42");
});

test("cursor decoder routes </think> tail back to text channel for composer-style models", () => {
  const buf = Buffer.concat([
    Buffer.from(connectProtoReasoningFrame("Internal reasoning here.\n</")),
    Buffer.from(connectProtoReasoningFrame("think>\nThe real answer.")),
  ]);
  const result = decodeCursorResponse(new Uint8Array(buf));
  assert.equal(result.reasoning, "Internal reasoning here.");
  assert.equal(result.text, "The real answer.");
});

test("cursor streaming decoder buffers reasoning until think-close split", () => {
  const decoder = createCursorStreamingDecoder();
  const deltas: { textDelta: string; reasoningDelta: string }[] = [];
  for (const frame of [
    connectProtoReasoningFrame("CoT begin "),
    connectProtoReasoningFrame("more CoT </"),
    connectProtoReasoningFrame("think>\nfinal "),
    connectProtoReasoningFrame("answer."),
  ]) {
    deltas.push(...decoder.feed(frame));
  }
  const reasoning = deltas.map((d) => d.reasoningDelta).join("");
  const text = deltas.map((d) => d.textDelta).join("");
  assert.equal(reasoning, "CoT begin more CoT ");
  assert.equal(text, "final answer.");
});

test("cursor streaming decoder flushes pending reasoning when text arrives without </think>", () => {
  const decoder = createCursorStreamingDecoder();
  const deltas: { textDelta: string; reasoningDelta: string }[] = [];
  deltas.push(...decoder.feed(connectProtoReasoningFrame("pondering...")));
  deltas.push(...decoder.feed(connectProtoTextFrame("Hello.")));
  const reasoning = deltas.map((d) => d.reasoningDelta).join("");
  const text = deltas.map((d) => d.textDelta).join("");
  assert.equal(reasoning, "pondering...");
  assert.equal(text, "Hello.");
});

test("extractCursorModelIds reads the structured models[] field", () => {
  const sample = {
    models: [
      { name: "default", serverModelName: "default" },
      { name: "composer-2-fast", serverModelName: "composer-2-fast" },
      {
        name: "claude-opus-4-7-medium",
        serverModelName: "claude-opus-4-7-medium",
        degradationStatus: "DEGRADATION_STATUS_UNSPECIFIED",
      },
      { name: "" },
      { somethingElse: "no-name" },
    ],
    composerModelConfig: { defaultModelName: "composer-2-fast" },
    backgroundComposerModelConfig: { defaultModelName: "composer-2-fast" },
    isRecommendedForBackgroundComposer: false,
  };
  const ids = extractCursorModelIds(sample);
  assert.deepEqual(ids, [
    "cursor-default",
    "cursor-composer-2-fast",
    "cursor-claude-opus-4-7-medium",
  ]);
  for (const id of ids) {
    assert.ok(!/isRecommended|ModelConfig|backgroundComposer/i.test(id), id);
  }
});

test("extractCursorModelIds rejects malformed payloads gracefully", () => {
  assert.deepEqual(extractCursorModelIds(null), []);
  assert.deepEqual(extractCursorModelIds("oops" as unknown), []);
  assert.deepEqual(extractCursorModelIds({}), []);
  assert.deepEqual(extractCursorModelIds({ models: "not-array" } as unknown), []);
  assert.deepEqual(
    extractCursorModelIds({ models: [{ name: "DEGRADATION_STATUS_UNSPECIFIED" }] }),
    [],
  );
});

test("extractCursorModelIds dedupes and prefers serverModelName over name", () => {
  const sample = {
    models: [
      { name: "ui-name", serverModelName: "real-server-name" },
      { name: "real-server-name" },
      { serverModelName: "real-server-name" },
    ],
  };
  assert.deepEqual(extractCursorModelIds(sample), ["cursor-real-server-name"]);
});

test("cursor browser oauth generates valid PKCE pair and login URL", () => {
  const pkce = generateCursorPkce();
  assert.match(pkce.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(pkce.challenge.length, 43); // sha256 → base64url
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]+$/);
  const url = new URL(buildCursorLoginUrl(pkce));
  assert.equal(url.hostname, "www.cursor.com");
  assert.equal(url.pathname, "/loginDeepControl");
  assert.equal(url.searchParams.get("uuid"), pkce.uuid);
  assert.equal(url.searchParams.get("challenge"), pkce.challenge);
  assert.equal(url.searchParams.get("mode"), "login");
  assert.equal(url.searchParams.get("redirectTarget"), "cli");
});

test("pollResultToTokenData refuses to persist a session without a refresh token", () => {
  const accessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: "user_42",
  });
  const pkce = generateCursorPkce();
  // No refreshToken — must fail loud, not silently store accessToken as the
  // refresh credential (which would later be sent to /oauth/token).
  assert.throws(
    () =>
      pollResultToTokenData(
        { accessToken, authId: "auth0|user_42" } as any,
        pkce,
      ),
    CursorBrowserLoginMissingRefreshTokenError,
  );
  // Same when only `apiKey` is returned (PAT-style session).
  assert.throws(
    () =>
      pollResultToTokenData(
        { accessToken, apiKey: accessToken, authId: "auth0|user_42" } as any,
        pkce,
      ),
    CursorBrowserLoginMissingRefreshTokenError,
  );
  // With a real refresh token it should succeed normally.
  const ok = pollResultToTokenData(
    {
      accessToken,
      refreshToken: "refresh-x",
      authId: "auth0|user_42",
    } as any,
    pkce,
  );
  assert.equal(ok.refreshToken, "refresh-x");
  assert.notEqual(ok.refreshToken, ok.accessToken);
});

test("refreshCursorTokens refuses empty or access-token-shaped refresh credentials", async () => {
  // No fetch should happen — the guard short-circuits before the network.
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("fetch must not be called");
  });
  try {
    const { refreshCursorTokens } = await import("../src/auth/cursor/oauth");
    await assert.rejects(
      refreshCursorTokens("", { accessToken: "anything" }),
      RefreshTokenExhaustedError,
    );
    await assert.rejects(
      refreshCursorTokens("same-as-access", { accessToken: "same-as-access" }),
      RefreshTokenExhaustedError,
    );
  } finally {
    restoreFetch();
  }
});

test("cursor browser oauth poll returns null while pending and TokenData on success", async () => {
  let pending = await pollCursorAuthOnce("u", "v", {
    fetchImpl: (async () =>
      new Response("", { status: 404 })) as unknown as typeof fetch,
  });
  assert.equal(pending, null);

  const accessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "browser@cursor.com",
  });
  const ok = await pollCursorAuthOnce("u", "v", {
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          accessToken,
          refreshToken: "refresh-x",
          authId: "auth0|user_42",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch,
  });
  assert.ok(ok);
  assert.equal(ok!.accessToken, accessToken);
  assert.equal(ok!.refreshToken, "refresh-x");

  const pkce = generateCursorPkce();
  const token = pollResultToTokenData(ok!, pkce);
  assert.equal(token.provider, "cursor");
  assert.equal(token.email, "browser@cursor.com");
  assert.equal(token.refreshToken, "refresh-x");
  assert.equal(token.accountUuid, pkce.uuid);
});

test("runCursorBrowserLogin invokes onLoginUrl then completes when poll succeeds", async () => {
  const accessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "test@cursor.com",
  });
  let calls = 0;
  let receivedUrl = "";
  const result = await runCursorBrowserLogin({
    pollIntervalMs: 5,
    pollMaxIntervalMs: 5,
    onLoginUrl: (u) => {
      receivedUrl = u;
    },
    fetchImpl: (async () => {
      calls += 1;
      if (calls < 3) return new Response("", { status: 404 });
      return new Response(
        JSON.stringify({ accessToken, refreshToken: "rt", authId: "x|user" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  });
  assert.match(receivedUrl, /loginDeepControl/);
  assert.equal(result.token.accessToken, accessToken);
  assert.equal(result.token.email, "test@cursor.com");
  assert.equal(calls, 3);
});

test("callCursorResponses aborts a stalled body stream after stream-messages-ms", async (t) => {
  // Reproduces the P2: Cursor edge sends headers but never sends data and
  // never closes the HTTP/2 stream. Without the withTimeoutSignal wrapper
  // around options.signal, the body ReadableStream would hang forever and
  // the client request would never resolve.
  let cancelCalled = false;
  __setCursorTransport(async (_url, _headers, _body, _timeoutMs, signal) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // The transport mock listens on the abort signal so it behaves like
        // the real http2Post: when the caller-supplied timeout fires, it
        // errors the body stream — letting the consumer's reader.read()
        // throw so the express handler can clean up.
        signal?.addEventListener(
          "abort",
          () => {
            cancelCalled = true;
            try {
              controller.error(new Error("request aborted"));
            } catch {
              /* already errored */
            }
          },
          { once: true },
        );
        // Deliberately push nothing and never close — simulate a stalled
        // upstream that still holds the HTTP/2 stream open.
      },
    });
    return {
      status: 200,
      headers: { "content-type": "application/connect+proto" },
      body: stream,
    };
  });
  t.after(() => __setCursorTransport(null));

  // AbortSignal.timeout() inside withTimeoutSignal uses an *unreffed* timer
  // so Node exits the event loop early in unit tests where there is no
  // other I/O. Production code is fine because the HTTP server's listening
  // socket keeps the loop alive — for this test we pin it manually.
  const keepalive = setInterval(() => {}, 5000);
  t.after(() => clearInterval(keepalive));

  const cfg = makeConfig();
  // 200ms total stream budget — long enough to demonstrate the timer fires
  // and short enough to keep the test fast.
  cfg.timeouts["stream-messages-ms"] = 200;

  const account = {
    token: {
      accessToken: "a",
      refreshToken: "r",
      email: "x@cursor.com",
      accountUuid: "uuid",
      provider: "cursor" as const,
      cursorServiceMachineId: "m",
      cursorClientVersion: "cli-test",
    },
  } as any;

  const start = Date.now();
  const upstream = await callCursorResponses({
    body: { model: "cursor-default", input: "hi", stream: true },
    account,
    config: cfg,
  });
  // Drain the SSE body — without the timeout fix this never resolves and
  // the test framework would kill the run after the global timeout.
  const reader = upstream.body!.getReader();
  let drained = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) drained += new TextDecoder().decode(value);
    }
  } catch {
    /* expected: controller.error on timeout */
  }
  const elapsed = Date.now() - start;
  assert.ok(
    cancelCalled,
    "transport abort signal should fire when stream-messages-ms expires",
  );
  assert.ok(
    elapsed < 2000,
    `request should have aborted within ~stream-messages-ms (got ${elapsed}ms). ` +
      "The body stream is not bounded by the configured stream timeout.",
  );
});
