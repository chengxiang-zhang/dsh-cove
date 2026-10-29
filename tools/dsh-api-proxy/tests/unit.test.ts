import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

import { extractApiKey, hashApiKey, timeout } from "../src/utils/common";
import { combineAbortSignals } from "../src/utils/abort";
import { classifyFailure, proxyWithRetry } from "../src/utils/http";
import { handleStreamingResponse } from "../src/upstream/streaming";
import {
  resolveModel,
  openaiToAnthropic,
  anthropicToOpenai,
  createStreamState,
  anthropicSSEToChat,
  responsesToAnthropic,
  anthropicToResponses,
  makeResponsesState,
  anthropicSSEToResponses,
} from "../src/upstream/translator";
import { loadConfig, isDebugLevel, resolveAuthDir } from "../src/config";
import { UsageData } from "../src/accounts/manager";

// ══════════════════════════════════════════════════
// utils/common.ts
// ══════════════════════════════════════════════════

test("extractApiKey extracts Bearer token", () => {
  assert.equal(
    extractApiKey({ authorization: "Bearer sk-test-123" }),
    "sk-test-123",
  );
});

test("extractApiKey extracts x-api-key header", () => {
  assert.equal(extractApiKey({ "x-api-key": "sk-test-456" }), "sk-test-456");
});

test("extractApiKey prefers Bearer over x-api-key", () => {
  assert.equal(
    extractApiKey({
      authorization: "Bearer sk-bearer",
      "x-api-key": "sk-xapi",
    }),
    "sk-bearer",
  );
});

test("extractApiKey returns empty string when no key", () => {
  assert.equal(extractApiKey({}), "");
});

test("extractApiKey handles x-api-key as array", () => {
  assert.equal(
    extractApiKey({ "x-api-key": ["sk-first", "sk-second"] }),
    "sk-first",
  );
});

test("hashApiKey returns consistent sha256 hex", () => {
  const hash1 = hashApiKey("test-key");
  const hash2 = hashApiKey("test-key");
  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
  assert.match(hash1, /^[a-f0-9]{64}$/);
});

test("hashApiKey returns different hashes for different keys", () => {
  assert.notEqual(hashApiKey("key-a"), hashApiKey("key-b"));
});

test("timeout resolves after delay", async () => {
  const start = Date.now();
  await timeout(50);
  assert.ok(Date.now() - start >= 45);
});

test("combineAbortSignals aborts when any input signal aborts", async () => {
  const first = new AbortController();
  const second = new AbortController();
  const combined = combineAbortSignals([first.signal, second.signal]);

  assert.equal(combined.aborted, false);
  second.abort(new Error("client disconnected"));

  assert.equal(combined.aborted, true);
  assert.match(String(combined.reason), /client disconnected/);
});

// ══════════════════════════════════════════════════
// utils/http.ts
// ══════════════════════════════════════════════════

test("classifyFailure maps status codes correctly", () => {
  assert.equal(classifyFailure(429), "rate_limit");
  assert.equal(classifyFailure(401), "auth");
  assert.equal(classifyFailure(403), "forbidden");
  assert.equal(classifyFailure(500), "server");
  assert.equal(classifyFailure(502), "server");
  assert.equal(classifyFailure(503), "server");
  assert.equal(classifyFailure(418), "server");
});

function makeMockResponse(): any {
  const resp = new EventEmitter() as any;
  resp.headers = {};
  resp.chunks = [];
  resp.locals = {};
  resp.headersSent = false;
  resp.destroyed = false;
  resp.setHeader = (key: string, value: string) => {
    resp.headers[key.toLowerCase()] = value;
    return resp;
  };
  resp.status = (code: number) => {
    resp.statusCode = code;
    return resp;
  };
  resp.json = (body: any) => {
    resp.body = body;
    resp.headersSent = true;
    return resp;
  };
  resp.flushHeaders = () => {
    resp.headersSent = true;
  };
  resp.write = (chunk: Uint8Array | string) => {
    resp.chunks.push(chunk);
    return true;
  };
  resp.end = () => {
    resp.ended = true;
    resp.headersSent = true;
    return resp;
  };
  return resp;
}

test("handleStreamingResponse does not complete when client disconnects", async () => {
  const encoder = new TextEncoder();
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: message_delta\ndata: {"usage":{"output_tokens":1}}\n\n',
          ),
        );
      },
      cancel() {
        /* expected when the client disconnects */
      },
    }),
  );
  const resp = makeMockResponse();
  resp.write = (chunk: Uint8Array | string) => {
    resp.chunks.push(chunk);
    resp.emit("close");
    return true;
  };

  const result = await handleStreamingResponse(upstream, resp);

  assert.equal(result.clientDisconnected, true);
  assert.equal(result.completed, false);
});

test("handleStreamingResponse flushes the final un-terminated SSE event through onEvent", async () => {
  // Regression cover for: "transformed streaming still drops an
  // unterminated final event". When the upstream closes the stream
  // without a trailing newline after the last `data:` line, the
  // transformer (e.g. responsesSSEToChat) must still receive that
  // final event so it can emit the [DONE]/finish_reason chunk and so
  // usage tracking lands. Previously `handleStreamingResponse` did an
  // `if (done) break;` which silently dropped the leftover line.
  const encoder = new TextEncoder();
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n',
          ),
        );
        // Final event has NO trailing \n\n on purpose.
        controller.enqueue(
          encoder.encode(
            'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":3}}}',
          ),
        );
        controller.close();
      },
    }),
  );

  const resp = makeMockResponse();
  const observed: Array<{ event: string; data: any }> = [];
  const result = await handleStreamingResponse(upstream, resp, {
    onEvent: (event, data) => {
      observed.push({ event, data });
      // Emit the equivalent of a finish chunk on completed.
      if (event === "response.completed") {
        return ["data: [DONE]\n\n"];
      }
      return [];
    },
  });

  // The completed event must reach the transformer.
  assert.ok(
    observed.some((e) => e.event === "response.completed"),
    "response.completed must be observed even without trailing newline",
  );
  // [DONE] chunk must have been written to the client.
  const written = resp.chunks.map((c: any) => String(c)).join("");
  assert.match(written, /data: \[DONE\]/);
  // Usage must have been extracted from the final completed event.
  assert.equal(result.completed, true);
  assert.equal(result.usage.inputTokens, 7);
  assert.equal(result.usage.outputTokens, 3);
});

test("handleStreamingResponse extracts usage from final un-terminated event in pass-through mode", async () => {
  // Pass-through (no onEvent) writes raw bytes immediately so the
  // client always sees them, but `extractUsageFromSSE` also needs to
  // run on the final un-terminated event so the upstream's reported
  // usage lands in result.usage. Without the flush fix, the final
  // line stayed in `buffer` and usage was zero.
  const encoder = new TextEncoder();
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: message_delta\ndata: {"usage":{"input_tokens":11,"output_tokens":5}}',
          ),
        );
        controller.close();
      },
    }),
  );
  const resp = makeMockResponse();
  const result = await handleStreamingResponse(upstream, resp);
  assert.equal(result.completed, true);
  assert.equal(result.usage.inputTokens, 11);
  assert.equal(result.usage.outputTokens, 5);
});

test("proxyWithRetry stops retry backoff when client disconnects", async () => {
  const resp = makeMockResponse();
  const account: any = {
    token: { email: "x@y.z" },
  };
  let upstreamCalls = 0;
  const manager: any = {
    provider: "anthropic",
    getNextAccount: () => ({ account }),
    recordAttempt: () => {},
    recordFailure: () => {},
    refreshAccount: async () => false,
  };

  const proxyPromise = proxyWithRetry(
    "TestProxy",
    resp,
    {
      debug: "off",
    } as any,
    {
      manager,
      maxRetries: 2,
      upstream: async () => {
        upstreamCalls++;
        return new Response("temporarily unavailable", { status: 500 });
      },
      success: async () => {},
    },
  );

  setTimeout(() => resp.emit("close"), 10);
  await proxyPromise;

  assert.equal(upstreamCalls, 1);
  assert.equal(resp.body, undefined);
});

test("proxyWithRetry does not write terminal error after client disconnects", async () => {
  const resp = makeMockResponse();
  const account: any = { token: { email: "x@y.z" } };
  const manager: any = {
    provider: "anthropic",
    getNextAccount: () => ({ account }),
    recordAttempt: () => {},
    recordFailure: () => {},
    refreshAccount: async () => false,
  };

  let writes = 0;
  resp.setHeader = (key: string, value: string) => {
    writes++;
    resp.headers[key.toLowerCase()] = value;
    return resp;
  };
  const origJson = resp.json;
  resp.json = (body: any) => {
    writes++;
    return origJson.call(resp, body);
  };

  const proxyPromise = proxyWithRetry(
    "TestProxy",
    resp,
    { debug: "off" } as any,
    {
      manager,
      maxRetries: 1,
      upstream: async () => {
        // Client disconnects right as the upstream resolves; the catch in
        // upstream.text() path may swallow read errors, but the terminal
        // error response must NOT be written either way.
        resp.emit("close");
        return new Response("server boom", {
          status: 500,
          headers: { "retry-after": "1" },
        });
      },
      success: async () => {},
    },
  );
  await proxyPromise;

  assert.equal(writes, 0, "no headers/body should be written after disconnect");
  assert.equal(resp.body, undefined);
});

test("proxyWithRetry tags stats failure kind for upstream server errors", async () => {
  const resp = makeMockResponse();
  resp.locals.stats = {};
  const account: any = { token: { email: "x@y.z" } };
  const manager: any = {
    provider: "anthropic",
    getNextAccount: () => ({ account }),
    recordAttempt: () => {},
    recordFailure: () => {},
    refreshAccount: async () => false,
  };

  await proxyWithRetry("TestProxy", resp, { debug: "off" } as any, {
    manager,
    maxRetries: 1,
    upstream: async () => new Response("server boom", { status: 500 }),
    success: async () => {},
  });

  assert.equal(resp.locals.stats.accountEmail, "x@y.z");
  assert.equal(resp.locals.stats.provider, "anthropic");
  assert.equal(resp.locals.stats.failureKind, "server");
});

// ══════════════════════════════════════════════════
// config.ts
// ══════════════════════════════════════════════════

test("isDebugLevel returns correct values", () => {
  assert.equal(isDebugLevel("off", "errors"), false);
  assert.equal(isDebugLevel("errors", "errors"), true);
  assert.equal(isDebugLevel("errors", "verbose"), false);
  assert.equal(isDebugLevel("verbose", "errors"), true);
  assert.equal(isDebugLevel("verbose", "verbose"), true);
});

test("resolveAuthDir expands tilde", () => {
  const result = resolveAuthDir("~/.dsh-api-proxy");
  assert.ok(!result.startsWith("~"));
  assert.ok(result.endsWith(".dsh-api-proxy"));
});

test("resolveAuthDir resolves relative paths", () => {
  const result = resolveAuthDir("./data");
  assert.ok(path.isAbsolute(result));
});

test("loadConfig uses defaults when file missing", () => {
  const config = loadConfig("/tmp/nonexistent-config-" + Date.now() + ".yaml");
  assert.equal(config.port, 8317);
  assert.equal(config["body-limit"], "200mb");
  assert.equal(config.debug, "off");
  assert.ok(config["api-keys"] instanceof Set);
  assert.ok(config["api-keys"].size > 0); // auto-generated
});

test("loadConfig normalizes debug mode", () => {
  const configPath = path.join(
    os.tmpdir(),
    `dsh-api-proxy-debug-test-${Date.now()}.yaml`,
  );
  fs.writeFileSync(configPath, 'api-keys:\n  - "sk-test"\ndebug: true\n');
  try {
    const config = loadConfig(configPath);
    assert.equal(config.debug, "errors"); // true → "errors"
  } finally {
    fs.unlinkSync(configPath);
  }
});

// ══════════════════════════════════════════════════
// translator.ts — model resolution
// ══════════════════════════════════════════════════

test("resolveModel maps aliases", () => {
  assert.equal(resolveModel("opus"), "claude-opus-4-7");
  assert.equal(resolveModel("sonnet"), "claude-sonnet-5");
  assert.equal(resolveModel("haiku"), "claude-haiku-4-5-20251001");
  assert.equal(resolveModel("fable"), "claude-fable-5");
  assert.equal(resolveModel("mythos"), "claude-mythos-preview");
});

test("resolveModel passes through unknown models", () => {
  assert.equal(resolveModel("gpt-4o"), "gpt-4o");
  assert.equal(resolveModel("claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(resolveModel("claude-fable-5"), "claude-fable-5");
  assert.equal(resolveModel("claude-mythos-preview"), "claude-mythos-preview");
  assert.equal(
    resolveModel("anthropic.claude-mythos-preview"),
    "claude-mythos-preview",
  );
  assert.equal(resolveModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(resolveModel("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(resolveModel("claude-opus-4-7"), "claude-opus-4-7");
  assert.equal(resolveModel("claude-opus-4-6"), "claude-opus-4-6");
});

// ══════════════════════════════════════════════════
// translator.ts — OpenAI Chat → Anthropic
// ══════════════════════════════════════════════════

test("openaiToAnthropic translates basic request", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  });
  assert.equal(result.model, "claude-sonnet-5");
  assert.equal(result.stream, false);
  assert.equal(result.max_tokens, 8192);
  assert.deepEqual(result.messages, [{ role: "user", content: "hello" }]);
});

test("openaiToAnthropic uses max_completion_tokens over max_tokens", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    max_tokens: 100,
    max_completion_tokens: 500,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.max_tokens, 500);
});

test("openaiToAnthropic translates temperature and top_p", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    temperature: 0.5,
    top_p: 0.9,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.temperature, 0.5);
  assert.equal(result.top_p, 0.9);
});

test("openaiToAnthropic translates stop sequences", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    stop: ["END", "STOP"],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(result.stop_sequences, ["END", "STOP"]);
});

test("openaiToAnthropic translates single stop string", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    stop: "END",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(result.stop_sequences, ["END"]);
});

test("openaiToAnthropic translates system messages", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ],
  });
  assert.deepEqual(result.system, [{ type: "text", text: "You are helpful." }]);
  assert.equal(result.messages.length, 1);
});

test("openaiToAnthropic translates reasoning_effort to thinking", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    reasoning_effort: "high",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.thinking.type, "enabled");
  assert.equal(result.thinking.budget_tokens, 24576);
});

test("openaiToAnthropic translates tools", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });
  assert.equal(result.tools[0].name, "get_weather");
  assert.equal(result.tools[0].description, "Get weather");
  assert.ok(result.tools[0].input_schema);
});

test("openaiToAnthropic translates tool_choice", () => {
  const auto = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "auto",
  });
  assert.deepEqual(auto.tool_choice, { type: "auto" });

  const required = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "required",
  });
  assert.deepEqual(required.tool_choice, { type: "any" });
});

test("openaiToAnthropic translates parallel_tool_calls", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "auto",
    parallel_tool_calls: false,
  });
  assert.equal(result.tool_choice.disable_parallel_tool_use, true);
});

test("openaiToAnthropic translates response_format json_schema", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "test",
        schema: { type: "object", properties: { name: { type: "string" } } },
      },
    },
  });
  assert.equal(result.output_config.format.type, "json_schema");
  assert.equal(result.output_config.format.name, "test");
});

test("openaiToAnthropic translates tool role messages", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"NYC"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '{"temp":72}',
      },
    ],
  });
  // assistant message with tool_use
  assert.equal(result.messages[1].role, "assistant");
  assert.equal(result.messages[1].content[0].type, "tool_use");
  // tool result
  assert.equal(result.messages[2].role, "user");
  assert.equal(result.messages[2].content[0].type, "tool_result");
  assert.equal(result.messages[2].content[0].tool_use_id, "call_1");
});

test("openaiToAnthropic tolerates malformed assistant tool arguments", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_bad",
            type: "function",
            function: { name: "broken_args", arguments: "{not json" },
          },
        ],
      },
    ],
  });

  assert.equal(result.messages[0].content[0].type, "tool_use");
  assert.equal(result.messages[0].content[0].name, "broken_args");
  assert.deepEqual(result.messages[0].content[0].input, {});
});

// ══════════════════════════════════════════════════
// translator.ts — Anthropic → OpenAI Chat
// ══════════════════════════════════════════════════

test("anthropicToOpenai translates basic response", () => {
  const result = anthropicToOpenai(
    {
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    "claude-sonnet-4-6",
  );
  assert.equal(result.object, "chat.completion");
  assert.equal(result.choices[0].message.content, "Hello!");
  assert.equal(result.choices[0].message.role, "assistant");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.usage.prompt_tokens, 10);
  assert.equal(result.usage.completion_tokens, 5);
  assert.equal(result.usage.total_tokens, 15);
});

test("anthropicToOpenai maps stop reasons correctly", () => {
  const endTurn = anthropicToOpenai(
    { content: [], stop_reason: "end_turn", usage: {} },
    "sonnet",
  );
  assert.equal(endTurn.choices[0].finish_reason, "stop");

  const maxTokens = anthropicToOpenai(
    { content: [], stop_reason: "max_tokens", usage: {} },
    "sonnet",
  );
  assert.equal(maxTokens.choices[0].finish_reason, "length");

  const toolUse = anthropicToOpenai(
    { content: [], stop_reason: "tool_use", usage: {} },
    "sonnet",
  );
  assert.equal(toolUse.choices[0].finish_reason, "tool_calls");
});

test("anthropicToOpenai translates tool_use blocks", () => {
  const result = anthropicToOpenai(
    {
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "get_weather",
          input: { city: "NYC" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    "sonnet",
  );
  assert.equal(result.choices[0].message.tool_calls.length, 1);
  assert.equal(result.choices[0].message.tool_calls[0].id, "call_1");
  assert.equal(
    result.choices[0].message.tool_calls[0].function.name,
    "get_weather",
  );
  assert.equal(
    result.choices[0].message.tool_calls[0].function.arguments,
    '{"city":"NYC"}',
  );
});

test("anthropicToOpenai includes usage details", () => {
  const result = anthropicToOpenai(
    {
      content: [],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 30,
      },
    },
    "sonnet",
  );
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 30);
  assert.equal(result.usage.completion_tokens_details.reasoning_tokens, 0);
});

// ══════════════════════════════════════════════════
// translator.ts — Chat SSE streaming
// ══════════════════════════════════════════════════

function parseChatSSE(chunk: string): any {
  const json = chunk.replace(/^data: /, "").trim();
  return JSON.parse(json);
}

test("anthropicSSEToChat handles message_start", () => {
  const state = createStreamState("sonnet", false);
  const chunks = anthropicSSEToChat(
    "message_start",
    { message: { usage: { input_tokens: 10 } } },
    state,
  );
  assert.equal(chunks.length, 1);
  const parsed = parseChatSSE(chunks[0]);
  assert.equal(parsed.choices[0].delta.role, "assistant");
});

test("anthropicSSEToChat handles text_delta", () => {
  const state = createStreamState("sonnet", false);
  const chunks = anthropicSSEToChat(
    "content_block_delta",
    { delta: { type: "text_delta", text: "Hello" } },
    state,
  );
  assert.equal(chunks.length, 1);
  const parsed = parseChatSSE(chunks[0]);
  assert.equal(parsed.choices[0].delta.content, "Hello");
});

test("anthropicSSEToChat handles thinking_delta", () => {
  const state = createStreamState("sonnet", false);
  const chunks = anthropicSSEToChat(
    "content_block_delta",
    { delta: { type: "thinking_delta", thinking: "Let me think..." } },
    state,
  );
  const parsed = parseChatSSE(chunks[0]);
  assert.equal(parsed.choices[0].delta.reasoning_content, "Let me think...");
});

test("anthropicSSEToChat handles message_stop with usage", () => {
  const state = createStreamState("sonnet", true);
  const usage: UsageData = {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 2,
  };
  const chunks = anthropicSSEToChat("message_stop", {}, state, usage);
  assert.equal(chunks.length, 2); // usage chunk + [DONE]
  const usageChunk = parseChatSSE(chunks[0]);
  assert.deepEqual(usageChunk.choices, []);
  assert.equal(usageChunk.usage.prompt_tokens, 10);
  assert.equal(usageChunk.usage.completion_tokens, 5);
  assert.equal(usageChunk.usage.prompt_tokens_details.cached_tokens, 2);
  assert.equal(chunks[1], "data: [DONE]\n\n");
});

test("anthropicSSEToChat skips usage when includeUsage is false", () => {
  const state = createStreamState("sonnet", false);
  const usage: UsageData = {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  const chunks = anthropicSSEToChat("message_stop", {}, state, usage);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "data: [DONE]\n\n");
});

test("anthropicSSEToChat handles tool_use streaming", () => {
  const state = createStreamState("sonnet", false);

  // tool block start
  const startChunks = anthropicSSEToChat(
    "content_block_start",
    {
      content_block: { type: "tool_use", id: "call_1", name: "get_weather" },
      index: 1,
    },
    state,
  );
  assert.equal(startChunks.length, 1);
  const startParsed = parseChatSSE(startChunks[0]);
  assert.equal(startParsed.choices[0].delta.tool_calls[0].id, "call_1");
  assert.equal(startParsed.choices[0].delta.tool_calls[0].index, 0);

  // tool delta
  const deltaChunks = anthropicSSEToChat(
    "content_block_delta",
    { delta: { type: "input_json_delta", partial_json: '{"city"' }, index: 1 },
    state,
  );
  assert.equal(deltaChunks.length, 1);
  const deltaParsed = parseChatSSE(deltaChunks[0]);
  assert.equal(
    deltaParsed.choices[0].delta.tool_calls[0].function.arguments,
    '{"city"',
  );
  assert.equal(deltaParsed.choices[0].delta.tool_calls[0].index, 0);
});

test("anthropicSSEToChat returns empty for unknown events", () => {
  const state = createStreamState("sonnet", false);
  assert.deepEqual(anthropicSSEToChat("ping", {}, state), []);
  assert.deepEqual(anthropicSSEToChat("unknown_event", {}, state), []);
});

// ══════════════════════════════════════════════════
// translator.ts — Responses API
// ══════════════════════════════════════════════════

test("responsesToAnthropic translates basic request", () => {
  const result = responsesToAnthropic({
    model: "sonnet",
    input: [{ role: "user", content: "hello" }],
    stream: false,
  });
  assert.equal(result.model, "claude-sonnet-5");
  assert.equal(result.stream, false);
  assert.deepEqual(result.messages, [{ role: "user", content: "hello" }]);
});

test("responsesToAnthropic translates temperature and top_p", () => {
  const result = responsesToAnthropic({
    model: "sonnet",
    input: [{ role: "user", content: "hi" }],
    temperature: 0.7,
    top_p: 0.8,
  });
  assert.equal(result.temperature, 0.7);
  assert.equal(result.top_p, 0.8);
});

test("responsesToAnthropic translates instructions to system", () => {
  const result = responsesToAnthropic({
    model: "sonnet",
    instructions: "Be helpful",
    input: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(result.system, [{ type: "text", text: "Be helpful" }]);
});

test("responsesToAnthropic translates reasoning with summary", () => {
  const result = responsesToAnthropic({
    model: "sonnet",
    input: [{ role: "user", content: "hi" }],
    reasoning: { effort: "high", summary: "concise" },
  });
  assert.equal(result.thinking.type, "enabled");
  assert.equal(result.thinking.budget_tokens, 24576);
  assert.equal(result.thinking.display, "summarized");
});

test("anthropicToResponses translates basic response", () => {
  const result = anthropicToResponses(
    {
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    "claude-sonnet-4-6",
  );
  assert.equal(result.object, "response");
  assert.equal(result.status, "completed");
  assert.equal(result.output[0].type, "message");
  assert.equal(result.output[0].content[0].type, "output_text");
  assert.equal(result.output[0].content[0].text, "Hello!");
  assert.equal(result.output_text, "Hello!");
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 5);
});

test("anthropicToResponses sets incomplete status on max_tokens", () => {
  const result = anthropicToResponses(
    {
      content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens",
      usage: {},
    },
    "sonnet",
  );
  assert.equal(result.status, "incomplete");
});

test("anthropicToResponses includes usage details", () => {
  const result = anthropicToResponses(
    {
      content: [],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
      },
    },
    "sonnet",
  );
  assert.equal(result.usage.input_tokens_details.cached_tokens, 20);
  assert.equal(result.usage.output_tokens_details.reasoning_tokens, 0);
});

// ══════════════════════════════════════════════════
// translator.ts — Responses SSE streaming
// ══════════════════════════════════════════════════

test("anthropicSSEToResponses handles message_start", () => {
  const state = makeResponsesState();
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  const events = anthropicSSEToResponses(
    "message_start",
    {},
    state,
    "sonnet",
    usage,
  );
  assert.equal(events.length, 2);
  assert.ok(events[0].includes("response.created"));
  assert.ok(events[1].includes("response.in_progress"));
});

test("anthropicSSEToResponses handles text streaming", () => {
  const state = makeResponsesState();
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  // text block start
  const startEvents = anthropicSSEToResponses(
    "content_block_start",
    { content_block: { type: "text", text: "" }, index: 0 },
    state,
    "sonnet",
    usage,
  );
  assert.ok(startEvents.some((e) => e.includes("response.output_item.added")));
  assert.ok(startEvents.some((e) => e.includes("response.content_part.added")));

  // text delta
  const deltaEvents = anthropicSSEToResponses(
    "content_block_delta",
    { delta: { type: "text_delta", text: "Hello" }, index: 0 },
    state,
    "sonnet",
    usage,
  );
  assert.ok(deltaEvents.some((e) => e.includes("response.output_text.delta")));
  assert.ok(deltaEvents.some((e) => e.includes('"Hello"')));

  // text block stop
  const stopEvents = anthropicSSEToResponses(
    "content_block_stop",
    { index: 0 },
    state,
    "sonnet",
    usage,
  );
  assert.ok(stopEvents.some((e) => e.includes("response.output_text.done")));
  assert.ok(stopEvents.some((e) => e.includes("response.output_item.done")));
});

test("anthropicSSEToResponses handles message_stop with usage", () => {
  const state = makeResponsesState();
  const usage: UsageData = {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 10,
  };
  const events = anthropicSSEToResponses(
    "message_stop",
    {},
    state,
    "sonnet",
    usage,
  );
  assert.ok(events.some((e) => e.includes("response.completed")));
  assert.ok(events.some((e) => e.includes("response.done")));
  assert.ok(events.some((e) => e.includes('"input_tokens":100')));
});

test("anthropicSSEToResponses returns empty for unknown events", () => {
  const state = makeResponsesState();
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  assert.deepEqual(
    anthropicSSEToResponses("ping", {}, state, "sonnet", usage),
    [],
  );
});

// ══════════════════════════════════════════════════
// stats/recorder.ts
// ══════════════════════════════════════════════════

import { StatsRecorder, StatsEvent } from "../src/stats/recorder";
import { replayStatsEvents, statsFilePath } from "../src/stats/storage";
import { createServer } from "../src/server";

function makeStatsEvent(over: Partial<StatsEvent> = {}): StatsEvent {
  return {
    v: 1,
    ts: "2026-05-09T12:00:00.000Z",
    apiKeyHash: "a".repeat(64),
    ip: "127.0.0.1",
    ua: "test-ua",
    endpoint: "POST /v1/chat/completions",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    accountEmail: "alice@example.com",
    status: "success",
    failureKind: null,
    statusCode: 200,
    latencyMs: 250,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    ...over,
  };
}

test("StatsRecorder aggregates across all three views", () => {
  const recorder = new StatsRecorder();
  recorder.applyEvent(makeStatsEvent());
  recorder.applyEvent(makeStatsEvent({ ts: "2026-05-09T12:00:01.000Z" }));
  recorder.applyEvent(
    makeStatsEvent({
      ts: "2026-05-09T12:00:02.000Z",
      status: "failure",
      statusCode: 502,
      usage: null,
    }),
  );
  const snapshot = recorder.getSnapshot();
  assert.equal(snapshot.totals.requests, 3);
  assert.equal(snapshot.totals.successes, 2);
  assert.equal(snapshot.totals.failures, 1);
  assert.equal(snapshot.totals.totalInputTokens, 20);
  assert.equal(snapshot.totals.totalOutputTokens, 10);
  assert.equal(snapshot.totals.firstSeenAt, "2026-05-09T12:00:00.000Z");

  const clientKey = "a".repeat(64);
  assert.equal(snapshot.byClient[clientKey].requests, 3);
  assert.equal(snapshot.byClient[clientKey].apiKeyShort, "a".repeat(12));

  const accKey = "anthropic:alice@example.com";
  assert.equal(snapshot.byAccount[accKey].requests, 3);
  assert.equal(snapshot.byAccount[accKey].provider, "anthropic");

  const apiKey = "POST /v1/chat/completions|claude-sonnet-4-6|anthropic";
  assert.equal(snapshot.byApi[apiKey].requests, 3);
});

test("StatsRecorder splits buckets by client / account / api key", () => {
  const recorder = new StatsRecorder();
  recorder.applyEvent(makeStatsEvent());
  recorder.applyEvent(
    makeStatsEvent({
      apiKeyHash: "b".repeat(64),
      accountEmail: "bob@example.com",
      endpoint: "POST /v1/messages",
      model: "claude-opus-4-7",
    }),
  );
  const snapshot = recorder.getSnapshot();
  assert.equal(Object.keys(snapshot.byClient).length, 2);
  assert.equal(Object.keys(snapshot.byAccount).length, 2);
  assert.equal(Object.keys(snapshot.byApi).length, 2);
});

test("StatsRecorder skips byAccount when provider/email missing", () => {
  const recorder = new StatsRecorder();
  recorder.applyEvent(
    makeStatsEvent({ accountEmail: null, provider: null, usage: null }),
  );
  const snapshot = recorder.getSnapshot();
  assert.equal(Object.keys(snapshot.byAccount).length, 0);
  assert.equal(Object.keys(snapshot.byClient).length, 1);
  assert.equal(
    snapshot.byApi["POST /v1/chat/completions|claude-sonnet-4-6|unknown"]
      .requests,
    1,
  );
  assert.equal(snapshot.totals.requests, 1);
});

test("createServer stats endpoint records mounted route prefix", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-stats-"));
  const recorder = new StatsRecorder();
  recorder.start(tmp);
  const app = createServer(
    {
      host: "",
      port: 0,
      "auth-dir": tmp,
      "api-keys": new Set(["sk-test"]),
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: true },
      debug: "off",
    } as any,
    {} as any,
    recorder,
  );
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const headers = { Authorization: "Bearer sk-test" };
    await fetch(`http://127.0.0.1:${port}/admin/stats`, { headers });
    const second = await fetch(`http://127.0.0.1:${port}/admin/stats`, {
      headers,
    });
    const body = await second.json();
    assert.equal(body.byApi["GET /admin/stats|unknown|unknown"].requests, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await recorder.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("createServer stats records client disconnects on close", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-stats-"));
  const recorder = new StatsRecorder();
  recorder.start(tmp);
  const app = createServer(
    {
      host: "",
      port: 0,
      "auth-dir": tmp,
      "api-keys": new Set(["sk-test"]),
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: true },
      debug: "off",
    } as any,
    {} as any,
    recorder,
  );
  let resolveReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  app.get("/v1/hang", (_req, res) => {
    if (res.locals.stats) res.locals.stats.model = "hang";
    resolveReached();
    // Intentionally never write a response; the client abort below should
    // hit the stats close-path rather than finish-path.
  });

  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${port}/v1/hang`, {
      headers: { Authorization: "Bearer sk-test" },
      signal: controller.signal,
    }).catch(() => null);
    await reached;
    controller.abort();
    await request;
    await timeout(25);

    const snap = recorder.getSnapshot();
    assert.equal(snap.totals.requests, 1);
    assert.equal(snap.totals.failures, 1);
    assert.equal(snap.byApi["GET /v1/hang|hang|unknown"].failures, 1);

    await recorder.stop();
    const event = JSON.parse(fs.readFileSync(statsFilePath(tmp), "utf-8"));
    assert.equal(event.status, "failure");
    assert.equal(event.statusCode, 499);
    assert.equal(event.failureKind, "client_disconnect");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await recorder.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("StatsRecorder persists to JSONL and replays on restart", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-stats-"));
  try {
    const recorder = new StatsRecorder();
    recorder.start(tmp);
    recorder.record({
      apiKeyHash: "a".repeat(64),
      ip: "127.0.0.1",
      ua: "test-ua",
      endpoint: "POST /v1/chat/completions",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      accountEmail: "alice@example.com",
      status: "success",
      failureKind: null,
      statusCode: 200,
      latencyMs: 100,
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        reasoningOutputTokens: 0,
      },
    });
    await recorder.stop();

    // Verify the JSONL was written.
    const content = fs.readFileSync(statsFilePath(tmp), "utf-8").trim();
    assert.equal(content.split("\n").length, 1);
    const parsed = JSON.parse(content);
    assert.equal(parsed.endpoint, "POST /v1/chat/completions");
    assert.equal(parsed.usage.inputTokens, 7);

    // Replay into a fresh recorder.
    const recovered = new StatsRecorder();
    recovered.start(tmp);
    const snap = recovered.getSnapshot();
    assert.equal(snap.totals.requests, 1);
    assert.equal(snap.totals.totalInputTokens, 7);
    await recovered.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("replayStatsEvents skips corrupted lines", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-stats-"));
  try {
    const file = path.join(tmp, "stats.jsonl");
    const valid = JSON.stringify(makeStatsEvent());
    fs.writeFileSync(
      file,
      `${valid}\n{not-json}\n{"endpoint":"x"}\n${valid}\n`,
    );
    let applied = 0;
    const result = replayStatsEvents(file, () => {
      applied++;
    });
    assert.equal(applied, 2);
    assert.equal(result.lines, 4);
    assert.equal(result.skipped, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("StatsRecorder replay ignores partial schema rows without polluting aggregates", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-api-proxy-stats-"));
  try {
    fs.writeFileSync(statsFilePath(tmp), '{"endpoint":"x"}\n');
    const recorder = new StatsRecorder();
    recorder.start(tmp);
    const snap = recorder.getSnapshot();
    assert.equal(snap.totals.requests, 0);
    assert.deepEqual(snap.byClient, {});
    await recorder.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
