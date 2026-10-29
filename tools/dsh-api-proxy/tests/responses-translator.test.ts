import test from "node:test";
import assert from "node:assert/strict";

import {
  chatToResponsesRequest,
  anthropicToResponsesRequest,
  responsesToChatCompletion,
  responsesToAnthropicMessage,
  responsesSSEToChat,
  responsesSSEToAnthropic,
  makeResponsesToChatState,
  makeResponsesToAnthropicState,
  drainCodexResponsesSse,
} from "../src/upstream/responses-translator";
import { readSseEvents } from "../src/upstream/streaming";

/**
 * Build a `Response` whose body is a `ReadableStream` that yields each
 * supplied byte chunk in order. This lets us simulate exactly how the
 * upstream chunks arrive — important for the drain tests below where
 * the bug only manifests when the final chunk lands without a
 * trailing `\n`.
 */
function makeStreamingResponse(chunks: (string | Uint8Array)[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

// ───────────────── chatToResponsesRequest ─────────────────

test("chatToResponsesRequest: lifts system messages to instructions", () => {
  const out = chatToResponsesRequest({
    model: "gpt-5.5-medium",
    messages: [
      { role: "system", content: "Be terse." },
      { role: "developer", content: "Tone: concise." },
      { role: "user", content: "hi" },
    ],
    temperature: 0.5,
    max_completion_tokens: 100,
  });
  assert.equal(out.model, "gpt-5.5-medium");
  assert.equal(out.instructions, "Be terse.\n\nTone: concise.");
  assert.equal(out.input.length, 1);
  assert.equal(out.input[0].role, "user");
  assert.equal(out.input[0].content, "hi");
  assert.equal(out.temperature, 0.5);
  assert.equal(out.max_output_tokens, 100);
});

test("chatToResponsesRequest: converts assistant tool_calls to function_call items", () => {
  const out = chatToResponsesRequest({
    model: "gpt-5.5-medium",
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SF"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      },
    ],
  });
  // user message + function_call + function_call_output
  assert.equal(out.input.length, 3);
  assert.equal(out.input[1].type, "function_call");
  assert.equal(out.input[1].name, "get_weather");
  assert.equal(out.input[1].call_id, "call_1");
  assert.equal(out.input[2].type, "function_call_output");
  assert.equal(out.input[2].call_id, "call_1");
  assert.equal(out.input[2].output, "sunny");
  // tool shape: Chat -> Responses (no nested .function)
  assert.equal(out.tools[0].type, "function");
  assert.equal(out.tools[0].name, "get_weather");
  assert.deepEqual(out.tools[0].parameters, {
    type: "object",
    properties: { city: { type: "string" } },
  });
});

test("chatToResponsesRequest: maps response_format json_schema and reasoning_effort", () => {
  const out = chatToResponsesRequest({
    model: "gpt-5.5-medium",
    messages: [{ role: "user", content: "x" }],
    reasoning_effort: "high",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "Out",
        strict: true,
        schema: { type: "object", properties: { y: { type: "string" } } },
      },
    },
  });
  assert.deepEqual(out.reasoning, { effort: "high" });
  assert.equal(out.text.format.type, "json_schema");
  assert.equal(out.text.format.name, "Out");
  assert.equal(out.text.format.strict, true);
});

// ───────────────── anthropicToResponsesRequest ─────────────────

test("anthropicToResponsesRequest: maps system, max_tokens, thinking", () => {
  const out = anthropicToResponsesRequest({
    model: "claude-sonnet-4-5",
    system: "You are precise.",
    max_tokens: 256,
    temperature: 0.7,
    thinking: { type: "enabled", budget_tokens: 8000 },
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.instructions, "You are precise.");
  assert.equal(out.max_output_tokens, 256);
  assert.equal(out.temperature, 0.7);
  // 8000 budget → "medium" effort
  assert.deepEqual(out.reasoning, { effort: "medium" });
  assert.equal(out.input[0].role, "user");
});

test("anthropicToResponsesRequest: converts tool_use / tool_result blocks", () => {
  const out = anthropicToResponsesRequest({
    model: "claude-sonnet-4-5",
    max_tokens: 256,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling get_weather." },
          {
            type: "tool_use",
            id: "tool_1",
            name: "get_weather",
            input: { city: "SF" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "sunny",
          },
        ],
      },
    ],
    tools: [
      {
        name: "get_weather",
        description: "weather",
        input_schema: { type: "object" },
      },
    ],
  });
  // assistant text + function_call + function_call_output
  assert.equal(out.input[0].role, "assistant");
  assert.equal(out.input[1].type, "function_call");
  assert.equal(out.input[1].name, "get_weather");
  assert.equal(out.input[1].arguments, '{"city":"SF"}');
  assert.equal(out.input[2].type, "function_call_output");
  assert.equal(out.input[2].call_id, "tool_1");
  assert.equal(out.input[2].output, "sunny");
  assert.equal(out.tools[0].name, "get_weather");
  assert.equal(out.tools[0].type, "function");
});

test("anthropicToResponsesRequest: array system → instructions joined", () => {
  const out = anthropicToResponsesRequest({
    model: "claude-sonnet-4-5",
    max_tokens: 100,
    system: [
      { type: "text", text: "Part one." },
      { type: "text", text: "Part two." },
    ],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.instructions, "Part one.\n\nPart two.");
});

// ───────────────── responsesToChatCompletion (non-stream) ─────────────────

test("responsesToChatCompletion: assembles text + reasoning + tool calls", () => {
  const completion = responsesToChatCompletion(
    {
      status: "completed",
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Thinking..." }],
        },
        {
          type: "message",
          content: [
            { type: "output_text", text: "Hello, " },
            { type: "output_text", text: "world!" },
          ],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "do_thing",
          arguments: '{"x":1}',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    "gpt-5.5-medium",
  );
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.model, "gpt-5.5-medium");
  assert.equal(completion.choices[0].message.content, "Hello, world!");
  assert.equal(completion.choices[0].message.reasoning_content, "Thinking...");
  assert.equal(
    completion.choices[0].message.tool_calls[0].function.name,
    "do_thing",
  );
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  assert.equal(completion.usage.prompt_tokens, 10);
  assert.equal(completion.usage.completion_tokens, 5);
  assert.equal(completion.usage.total_tokens, 15);
});

test("responsesToChatCompletion: incomplete status maps to length finish_reason", () => {
  const completion = responsesToChatCompletion(
    {
      status: "incomplete",
      output: [
        { type: "message", content: [{ type: "output_text", text: "trun" }] },
      ],
    },
    "gpt-5.5-medium",
  );
  assert.equal(completion.choices[0].finish_reason, "length");
});

// ───────────────── responsesToAnthropicMessage (non-stream) ─────────────────

test("responsesToAnthropicMessage: emits thinking + text + tool_use blocks in order", () => {
  const msg = responsesToAnthropicMessage(
    {
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "T" }] },
        { type: "message", content: [{ type: "output_text", text: "Hi" }] },
        {
          type: "function_call",
          call_id: "call_1",
          name: "f",
          arguments: '{"k":"v"}',
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    },
    "claude-sonnet-4-5",
  );
  assert.equal(msg.role, "assistant");
  assert.equal(msg.model, "claude-sonnet-4-5");
  assert.equal(msg.content.length, 3);
  assert.equal(msg.content[0].type, "thinking");
  assert.equal(msg.content[1].type, "text");
  assert.equal(msg.content[2].type, "tool_use");
  assert.deepEqual(msg.content[2].input, { k: "v" });
  assert.equal(msg.stop_reason, "tool_use");
  assert.equal(msg.usage.input_tokens, 3);
  assert.equal(msg.usage.output_tokens, 2);
});

// ───────────────── responsesSSEToChat (streaming) ─────────────────

test("responsesSSEToChat: response.completed with usage emits prompt_tokens before [DONE]", () => {
  const state = makeResponsesToChatState("gpt-5.5-medium");
  const usage = {
    inputTokens: 42,
    outputTokens: 7,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 3,
    reasoningOutputTokens: 2,
  };
  const chunks = [
    ...responsesSSEToChat("response.output_text.delta", { delta: "OK" }, state),
    ...responsesSSEToChat(
      "response.completed",
      { response: { status: "completed" } },
      state,
      usage,
    ),
  ];
  const all = chunks.join("");
  assert.match(all, /"prompt_tokens":42/);
  assert.match(all, /"completion_tokens":7/);
  assert.match(all, /"total_tokens":49/);
  assert.match(all, /"cached_tokens":3/);
  assert.match(all, /"reasoning_tokens":2/);
  const usageIdx = all.indexOf('"prompt_tokens":42');
  const doneIdx = all.indexOf("data: [DONE]");
  assert.ok(usageIdx >= 0 && doneIdx > usageIdx);
  // usage chunk has empty choices array (OpenAI stream_options shape)
  const usageChunk = chunks.find((c) => c.includes('"prompt_tokens":42'));
  assert.ok(usageChunk);
  assert.match(usageChunk!, /"choices":\[\]/);
});

test("responsesSSEToChat: response.completed without usage stays compatible", () => {
  const state = makeResponsesToChatState("gpt-5.5-medium");
  const chunks = responsesSSEToChat(
    "response.completed",
    { response: { status: "completed" } },
    state,
  );
  const all = chunks.join("");
  assert.match(all, /"finish_reason":"stop"/);
  assert.match(all, /data: \[DONE\]/);
  assert.doesNotMatch(all, /"prompt_tokens"/);
});

test("responsesSSEToChat: emits role primer, text deltas, finish + [DONE]", () => {
  const state = makeResponsesToChatState("gpt-5.5-medium");
  const chunks: string[] = [];
  chunks.push(
    ...responsesSSEToChat(
      "response.created",
      { type: "response.created" },
      state,
    ),
  );
  chunks.push(
    ...responsesSSEToChat("response.output_text.delta", { delta: "Hi" }, state),
  );
  chunks.push(
    ...responsesSSEToChat("response.output_text.delta", { delta: "!" }, state),
  );
  chunks.push(
    ...responsesSSEToChat(
      "response.completed",
      { response: { status: "completed" } },
      state,
    ),
  );

  const all = chunks.join("");
  // role primer
  assert.match(all, /"role":"assistant"/);
  // content deltas
  assert.match(all, /"content":"Hi"/);
  assert.match(all, /"content":"!"/);
  // finish_reason + DONE sentinel
  assert.match(all, /"finish_reason":"stop"/);
  assert.match(all, /data: \[DONE\]/);
  // every line should reference the same chatcmpl id
  const ids = [...all.matchAll(/"id":"(chatcmpl-[a-f0-9]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(ids.length >= 3);
  assert.equal(new Set(ids).size, 1);
});

test("responsesSSEToChat: routes reasoning deltas to reasoning_content", () => {
  const state = makeResponsesToChatState("gpt-5.5-medium-thinking");
  const chunks = [
    ...responsesSSEToChat(
      "response.reasoning_summary_text.delta",
      { delta: "Considering options..." },
      state,
    ),
    ...responsesSSEToChat(
      "response.completed",
      { response: { status: "completed" } },
      state,
    ),
  ];
  const all = chunks.join("");
  assert.match(all, /"reasoning_content":"Considering options\.\.\."/);
});

test("responsesSSEToChat: buffers tool_call arg deltas and emits once on completed", () => {
  const state = makeResponsesToChatState("gpt-5.5-medium");
  const mid = [
    ...responsesSSEToChat(
      "response.output_item.added",
      {
        item: { type: "function_call", call_id: "call_1", name: "do_thing" },
      },
      state,
    ),
    ...responsesSSEToChat(
      "response.function_call_arguments.delta",
      { item_id: "call_1", delta: '{"k":' },
      state,
    ),
    ...responsesSSEToChat(
      "response.function_call_arguments.delta",
      { item_id: "call_1", delta: '"v"}' },
      state,
    ),
  ];
  // Fragments stay buffered — only the name/id primer is visible mid-stream.
  assert.match(mid.join(""), /"name":"do_thing"/);
  assert.equal(mid.filter((c) => /"arguments":"\{/.test(c)).length, 0);

  const all = [
    ...mid,
    ...responsesSSEToChat(
      "response.completed",
      { response: { status: "completed" } },
      state,
    ),
  ].join("");
  // Full JSON is emitted once (completed fallback) so DSH can sanitize.
  assert.match(all, /"arguments":"\{\\"k\\":\\"v\\"\}"/);
  assert.match(all, /"finish_reason":"tool_calls"/);
});

test("responsesSSEToChat: tool_call arg deltas resolve when item_id differs from call_id (real codex shape)", () => {
  // Codex's real wire format: `output_item.added` carries BOTH
  // `item.id` (`fc_…`) and `item.call_id` (`call_…`). Subsequent
  // `function_call_arguments.delta` events reference the item via
  // `item_id` which equals `item.id`, NOT `item.call_id`. The
  // translator must register the tool slot under both keys; before
  // the dual-key fix it only stored `call_id`, so all argument
  // deltas were silently dropped — clients got the function name
  // but no arguments.
  //
  // Arguments are now buffered and flushed once (on done/completed)
  // so DSH receives a single sanitized JSON blob.
  const state = makeResponsesToChatState("gpt-5.5-medium");
  const chunks = [
    ...responsesSSEToChat(
      "response.output_item.added",
      {
        item: {
          id: "fc_abc",
          call_id: "call_xyz",
          type: "function_call",
          name: "get_weather",
        },
      },
      state,
    ),
    ...responsesSSEToChat(
      "response.function_call_arguments.delta",
      { item_id: "fc_abc", delta: '{"city":"' },
      state,
    ),
    ...responsesSSEToChat(
      "response.function_call_arguments.delta",
      { item_id: "fc_abc", delta: 'Tokyo"}' },
      state,
    ),
    ...responsesSSEToChat(
      "response.completed",
      { response: { status: "completed" } },
      state,
    ),
  ];
  const all = chunks.join("");
  // The init chunk uses the public-facing call_id — clients see this id.
  assert.match(all, /"id":"call_xyz"/);
  // Buffered fragments resolve via item_id→call_id and flush as one blob.
  assert.match(all, /"arguments":"\{\\"city\\":\\"Tokyo\\"\}"/);
  assert.match(all, /"finish_reason":"tool_calls"/);
});
test("responsesSSEToAnthropic: tool_use input_json_delta resolves when item_id differs from call_id (real codex shape)", () => {
  const state = makeResponsesToAnthropicState("claude-sonnet-4-5");
  const out = [
    ...responsesSSEToAnthropic("response.created", {}, state),
    ...responsesSSEToAnthropic(
      "response.output_item.added",
      {
        item: {
          id: "fc_abc",
          call_id: "call_xyz",
          type: "function_call",
          name: "get_weather",
        },
      },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.function_call_arguments.delta",
      { item_id: "fc_abc", delta: '{"city":"Tokyo"}' },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.completed",
      { response: { status: "completed" } },
      state,
    ),
  ];
  const all = out.join("");
  assert.match(
    all,
    /"content_block":\{"type":"tool_use","id":"call_xyz","name":"get_weather"/,
  );
  assert.match(
    all,
    /"type":"input_json_delta","partial_json":"\{\\"city\\":\\"Tokyo\\"\}"/,
  );
  assert.match(all, /"stop_reason":"tool_use"/);
});

// ───────────────── responsesSSEToAnthropic (streaming) ─────────────────

test("responsesSSEToAnthropic: emits message_start → text block → message_stop", () => {
  const state = makeResponsesToAnthropicState("claude-sonnet-4-5");
  const out = [
    ...responsesSSEToAnthropic("response.created", {}, state),
    ...responsesSSEToAnthropic(
      "response.output_text.delta",
      { delta: "Hello" },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.output_text.delta",
      { delta: " world" },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.completed",
      {
        response: {
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      },
      state,
    ),
  ];
  const all = out.join("");
  // event ordering & shape
  assert.match(all, /event: message_start/);
  assert.match(all, /"model":"claude-sonnet-4-5"/);
  assert.match(all, /"type":"text_delta","text":"Hello"/);
  assert.match(all, /"type":"text_delta","text":" world"/);
  assert.match(all, /event: content_block_stop/);
  assert.match(all, /"stop_reason":"end_turn"/);
  assert.match(all, /event: message_stop/);
});

test("responsesSSEToAnthropic: thinking block opens at index 0, text at index 1, never overlap", () => {
  const state = makeResponsesToAnthropicState("claude-sonnet-4-5");
  const out = [
    ...responsesSSEToAnthropic("response.created", {}, state),
    ...responsesSSEToAnthropic(
      "response.reasoning_summary_text.delta",
      { delta: "Thinking..." },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.output_text.delta",
      { delta: "Done." },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.completed",
      { response: { status: "completed" } },
      state,
    ),
  ];
  const all = out.join("");
  // thinking block must appear and have index 0
  assert.match(all, /"content_block":\{"type":"thinking"[^}]*\}/);
  assert.match(all, /"index":0[^}]*"thinking_delta"/);
  // text block must appear at index 1 and the thinking block must be
  // closed before any text delta is emitted
  const idxThinkingClose = all.indexOf('"content_block_stop","index":0');
  const idxTextStart = all.indexOf('"content_block_start","index":1');
  const idxTextDelta = all.indexOf("text_delta");
  assert.ok(idxThinkingClose > 0 && idxTextStart > idxThinkingClose);
  assert.ok(idxTextDelta > idxTextStart);
});

test("responsesSSEToAnthropic: tool calls become tool_use blocks with input_json_delta", () => {
  const state = makeResponsesToAnthropicState("claude-sonnet-4-5");
  const out = [
    ...responsesSSEToAnthropic("response.created", {}, state),
    ...responsesSSEToAnthropic(
      "response.output_item.added",
      {
        item: { type: "function_call", call_id: "call_1", name: "f" },
      },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.function_call_arguments.delta",
      { item_id: "call_1", delta: '{"x":1}' },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.completed",
      { response: { status: "completed" } },
      state,
    ),
  ];
  const all = out.join("");
  assert.match(
    all,
    /"content_block":\{"type":"tool_use","id":"call_1","name":"f"/,
  );
  assert.match(all, /"type":"input_json_delta","partial_json":"\{\\"x\\":1\}"/);
  // tool_use must set stop_reason=tool_use in the final message_delta
  assert.match(all, /"stop_reason":"tool_use"/);
});

// ───────────────── readSseEvents (shared drain helper) ─────────────────

test("readSseEvents: emits each event/data pair in order", async () => {
  const resp = makeStreamingResponse([
    'event: a\ndata: {"x":1}\n\n',
    'event: b\ndata: {"y":2}\n\n',
  ]);
  const events: Array<{ event: string; data: any }> = [];
  for await (const ev of readSseEvents(resp)) events.push(ev);
  assert.deepEqual(events, [
    { event: "a", data: { x: 1 } },
    { event: "b", data: { y: 2 } },
  ]);
});

test("readSseEvents: stitches lines split across chunk boundaries", async () => {
  const resp = makeStreamingResponse([
    "event: a\nda",
    'ta: {"x":1}\n\nevent: b\n',
    'data: {"y":2}\n\n',
  ]);
  const events: Array<{ event: string; data: any }> = [];
  for await (const ev of readSseEvents(resp)) events.push(ev);
  assert.deepEqual(events, [
    { event: "a", data: { x: 1 } },
    { event: "b", data: { y: 2 } },
  ]);
});

test("readSseEvents: flushes the final un-terminated line on stream close", async () => {
  // Crucially: no trailing \n on the last data: line. Previous hand-rolled
  // drains in handlers would silently drop this final event.
  const resp = makeStreamingResponse([
    'event: response.completed\ndata: {"response":{"status":"completed"}}',
  ]);
  const events: Array<{ event: string; data: any }> = [];
  for await (const ev of readSseEvents(resp)) events.push(ev);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "response.completed");
  assert.deepEqual(events[0].data, { response: { status: "completed" } });
});

test("readSseEvents: handles \\r\\n line endings transparently", async () => {
  const resp = makeStreamingResponse(['event: a\r\ndata: {"x":1}\r\n\r\n']);
  const events: Array<{ event: string; data: any }> = [];
  for await (const ev of readSseEvents(resp)) events.push(ev);
  assert.deepEqual(events, [{ event: "a", data: { x: 1 } }]);
});

test("readSseEvents: tolerates unparseable JSON by yielding data:null", async () => {
  const resp = makeStreamingResponse([
    "event: a\ndata: not-json\n\n",
    'event: b\ndata: {"y":2}\n\n',
  ]);
  const events: Array<{ event: string; data: any }> = [];
  for await (const ev of readSseEvents(resp)) events.push(ev);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "a");
  assert.equal(events[0].data, null);
  assert.deepEqual(events[1], { event: "b", data: { y: 2 } });
});

// ───────────────── drainCodexResponsesSse ─────────────────

test("drainCodexResponsesSse: captures completed response verbatim", async () => {
  const completed = {
    id: "resp_x",
    object: "response",
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: "hi" }] },
    ],
    usage: { input_tokens: 3, output_tokens: 1 },
  };
  const resp = makeStreamingResponse([
    'event: response.created\ndata: {"response":{"id":"resp_x"}}\n\n',
    'event: response.output_text.delta\ndata: {"delta":"h"}\n\n',
    'event: response.output_text.delta\ndata: {"delta":"i"}\n\n',
    `event: response.completed\ndata: ${JSON.stringify({ response: completed })}\n\n`,
  ]);
  const drained = await drainCodexResponsesSse(resp);
  assert.equal(drained.textOut, "hi");
  assert.equal(drained.completedResponse?.id, "resp_x");
  assert.deepEqual(drained.usage, { input_tokens: 3, output_tokens: 1 });
  assert.equal(drained.upstreamError, null);
  assert.equal(drained.status, "completed");
});

test("drainCodexResponsesSse: captures the final response.completed even without trailing newline", async () => {
  // This is the exact regression the shared drain helper was added to
  // prevent: a small upstream where the very last `data:` line has no
  // terminator before connection close. The previous loops would drop
  // the completed event, leaving the chat/messages aggregators with
  // textOut/usage but no completedResponse.
  const completed = {
    id: "resp_short",
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: "ok" }] },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const resp = makeStreamingResponse([
    'event: response.output_text.delta\ndata: {"delta":"ok"}\n\n',
    `event: response.completed\ndata: ${JSON.stringify({ response: completed })}`,
  ]);
  const drained = await drainCodexResponsesSse(resp);
  assert.equal(drained.textOut, "ok");
  assert.equal(drained.completedResponse?.id, "resp_short");
  assert.equal(drained.completedResponse?.status, "completed");
});

test("drainCodexResponsesSse: aggregates reasoning and tool-call deltas", async () => {
  const resp = makeStreamingResponse([
    'event: response.reasoning_summary_text.delta\ndata: {"delta":"think "}\n\n',
    'event: response.reasoning_summary_text.delta\ndata: {"delta":"more"}\n\n',
    'event: response.output_item.added\ndata: {"item":{"type":"function_call","call_id":"c1","name":"do_thing"}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"item_id":"c1","delta":"{\\"a\\":"}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"item_id":"c1","delta":"1}"}\n\n',
    'event: response.completed\ndata: {"response":{"status":"completed"}}\n\n',
  ]);
  const drained = await drainCodexResponsesSse(resp);
  assert.equal(drained.reasoningOut, "think more");
  const tc = drained.toolCalls.get("c1");
  assert.ok(tc);
  assert.equal(tc!.name, "do_thing");
  assert.equal(tc!.args, '{"a":1}');
});

test("drainCodexResponsesSse: tool-call args resolve when item_id differs from call_id (real codex shape)", async () => {
  // Real codex sends `output_item.added` with both an internal
  // `fc_…` (`item.id`) and the public `call_…` (`item.call_id`).
  // Subsequent argument deltas reference the item by `item_id` =
  // `item.id`. Before the dual-keying fix the drain helper would
  // index toolCalls by `call_id` and fail to find the entry on
  // every delta — so chat / messages non-stream aggregation
  // returned tool_calls with empty `arguments`.
  const resp = makeStreamingResponse([
    'event: response.output_item.added\ndata: {"item":{"id":"fc_abc","call_id":"call_xyz","type":"function_call","name":"get_weather"}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"item_id":"fc_abc","delta":"{\\"city\\":\\""}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"item_id":"fc_abc","delta":"Tokyo\\"}"}\n\n',
    'event: response.output_item.done\ndata: {"item":{"id":"fc_abc","call_id":"call_xyz","type":"function_call","name":"get_weather","arguments":"{\\"city\\":\\"Tokyo\\"}"}}\n\n',
    'event: response.completed\ndata: {"response":{"status":"completed"}}\n\n',
  ]);
  const drained = await drainCodexResponsesSse(resp);
  // toolCalls is keyed by the public call_id only.
  assert.equal(drained.toolCalls.size, 1);
  const tc = drained.toolCalls.get("call_xyz");
  assert.ok(tc, "tool call should be registered under call_xyz");
  assert.equal(tc!.name, "get_weather");
  assert.equal(tc!.args, '{"city":"Tokyo"}');
  // outputItems carries the complete done items for the
  // /v1/responses non-stream path.
  assert.equal(drained.outputItems.length, 1);
  assert.equal(drained.outputItems[0].arguments, '{"city":"Tokyo"}');
});

test("responsesSSEToAnthropic: a single tool block emits exactly one content_block_stop even with split fc_/call_ ids", () => {
  // Regression cover: an earlier dual-keyed map iteration would
  // emit `content_block_stop` twice for a single tool call when
  // codex used different `item.id` (`fc_…`) and `item.call_id`
  // (`call_…`) values.
  const state = makeResponsesToAnthropicState("claude-sonnet-4-5");
  const out = [
    ...responsesSSEToAnthropic("response.created", {}, state),
    ...responsesSSEToAnthropic(
      "response.output_item.added",
      {
        item: {
          id: "fc_abc",
          call_id: "call_xyz",
          type: "function_call",
          name: "do_thing",
        },
      },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.function_call_arguments.delta",
      { item_id: "fc_abc", delta: '{"k":1}' },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.completed",
      { response: { status: "completed" } },
      state,
    ),
  ];
  const all = out.join("");
  // Count content_block_stop events for the tool block (index 0
  // since it's the first block opened in this stream).
  const stops = all.match(/"type":"content_block_stop","index":0/g);
  assert.equal(
    stops?.length,
    1,
    `expected exactly one content_block_stop for the tool block, saw ${stops?.length}`,
  );
});

test("drainCodexResponsesSse: surfaces response.failed errors", async () => {
  const resp = makeStreamingResponse([
    'event: response.failed\ndata: {"response":{"error":{"message":"boom"}}}\n\n',
  ]);
  const drained = await drainCodexResponsesSse(resp);
  assert.equal(drained.upstreamError, "boom");
  assert.equal(drained.completedResponse, null);
});
