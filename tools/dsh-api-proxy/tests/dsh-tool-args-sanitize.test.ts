import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeDshToolArguments } from "../src/upstream/dsh-tool-args-sanitize";
import {
  drainCodexResponsesSse,
  makeResponsesToChatState,
  responsesSSEToChat,
  responsesToChatCompletion,
} from "../src/upstream/responses-translator";

// ───────────────── sanitizeDshToolArguments ─────────────────

test("sanitize: drops workspace-write sandbox_permissions + justification", () => {
  const out = sanitizeDshToolArguments(
    "write",
    JSON.stringify({
      path: "a.ts",
      contents: "x",
      sandbox_permissions: "workspace-write",
      justification: "need write",
    }),
  );
  assert.deepEqual(JSON.parse(out), { path: "a.ts", contents: "x" });
});

test("sanitize: drops both fields when justification is empty/blank", () => {
  const empty = sanitizeDshToolArguments(
    "bash",
    JSON.stringify({
      command: "ls",
      sandbox_permissions: "danger-full-access",
      justification: "",
    }),
  );
  assert.deepEqual(JSON.parse(empty), { command: "ls" });

  const blank = sanitizeDshToolArguments(
    "bash",
    JSON.stringify({
      command: "ls",
      justification: "   ",
    }),
  );
  assert.deepEqual(JSON.parse(blank), { command: "ls" });
});

test("sanitize: drops danger-full-access even with non-empty justification", () => {
  const out = sanitizeDshToolArguments(
    "bash",
    JSON.stringify({
      command: "rm -rf /",
      sandbox_permissions: "danger-full-access",
      justification: "Need unrestricted shell for system cleanup.",
    }),
  );
  assert.deepEqual(JSON.parse(out), { command: "rm -rf /" });
});

test("sanitize: update_goal non-edit drops max_goal_rounds and empty objective", () => {
  const out = sanitizeDshToolArguments(
    "update_goal",
    JSON.stringify({
      action: "complete",
      goal_id: "g1",
      max_goal_rounds: 5,
      objective: "",
    }),
  );
  assert.deepEqual(JSON.parse(out), {
    action: "complete",
    goal_id: "g1",
  });
});

test("sanitize: update_goal edit keeps max_goal_rounds", () => {
  const raw = JSON.stringify({
    action: "edit",
    goal_id: "g1",
    max_goal_rounds: 5,
    objective: "ship it",
  });
  assert.equal(sanitizeDshToolArguments("update_goal", raw), raw);
});

test("sanitize: parse failure returns original string", () => {
  const bad = '{"path":';
  assert.equal(sanitizeDshToolArguments("write", bad), bad);
});

// ───────────────── wired into responsesToChatCompletion ─────────────────

test("responsesToChatCompletion: sanitizes function_call arguments", () => {
  const completion = responsesToChatCompletion(
    {
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "write",
          arguments: JSON.stringify({
            path: "f.ts",
            contents: "hi",
            sandbox_permissions: "workspace-write",
            justification: "write file",
          }),
        },
      ],
    },
    "gpt-5.6-sol",
  );
  const args = JSON.parse(
    completion.choices[0].message.tool_calls[0].function.arguments,
  );
  assert.deepEqual(args, { path: "f.ts", contents: "hi" });
});

// ───────────────── streaming Chat buffers then sanitizes once ─────────────────

test("responsesSSEToChat: buffers arg deltas and emits sanitized JSON once on output_item.done", () => {
  const state = makeResponsesToChatState("gpt-5.6-sol");
  const chunks = [
    ...responsesSSEToChat(
      "response.output_item.added",
      {
        item: {
          id: "fc_1",
          call_id: "call_1",
          type: "function_call",
          name: "write",
        },
      },
      state,
    ),
    ...responsesSSEToChat(
      "response.function_call_arguments.delta",
      {
        item_id: "fc_1",
        delta: '{"path":"a.ts","contents":"x","sandbox_permissions":',
      },
      state,
    ),
    ...responsesSSEToChat(
      "response.function_call_arguments.delta",
      {
        item_id: "fc_1",
        delta: '"workspace-write","justification":"need it"}',
      },
      state,
    ),
  ];
  // Deltas must not leak dirty fragments to the client.
  assert.equal(
    chunks.filter(
      (c) => c.includes('"arguments":') && !c.includes('"arguments":""'),
    ).length,
    0,
  );

  const doneChunks = responsesSSEToChat(
    "response.output_item.done",
    {
      item: {
        id: "fc_1",
        call_id: "call_1",
        type: "function_call",
        name: "write",
        arguments: JSON.stringify({
          path: "a.ts",
          contents: "x",
          sandbox_permissions: "workspace-write",
          justification: "need it",
        }),
      },
    },
    state,
  );
  const all = doneChunks.join("");
  assert.match(all, /"arguments":"/);
  const match = all.match(/"arguments":"((?:\\.|[^"\\])*)"/);
  assert.ok(match);
  const parsed = JSON.parse(JSON.parse(`"${match![1]}"`));
  assert.deepEqual(parsed, { path: "a.ts", contents: "x" });

  // completed should not re-emit arguments
  const completed = responsesSSEToChat(
    "response.completed",
    { response: { status: "completed" } },
    state,
  ).join("");
  assert.doesNotMatch(completed, /"arguments":"\{/);
  assert.match(completed, /"finish_reason":"tool_calls"/);
});

test("responsesSSEToChat: completed fallback flushes buffered sanitized args", () => {
  const state = makeResponsesToChatState("gpt-5.6-sol");
  responsesSSEToChat(
    "response.output_item.added",
    {
      item: { type: "function_call", call_id: "call_1", name: "update_goal" },
    },
    state,
  );
  responsesSSEToChat(
    "response.function_call_arguments.delta",
    {
      item_id: "call_1",
      delta: JSON.stringify({
        action: "complete",
        goal_id: "g1",
        max_goal_rounds: 3,
        objective: "",
      }),
    },
    state,
  );
  const all = responsesSSEToChat(
    "response.completed",
    { response: { status: "completed" } },
    state,
  ).join("");
  const match = all.match(/"arguments":"((?:\\.|[^"\\])*)"/);
  assert.ok(match, "expected sanitized arguments on completed flush");
  const parsed = JSON.parse(JSON.parse(`"${match![1]}"`));
  assert.deepEqual(parsed, { action: "complete", goal_id: "g1" });
});

// ───────────────── drainCodexResponsesSse sanitizes ─────────────────

function makeStreamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i++]));
        } else {
          controller.close();
        }
      },
    }),
  );
}

test("drainCodexResponsesSse: sanitizes toolCalls and outputItems arguments", async () => {
  const dirty = JSON.stringify({
    path: "f.ts",
    contents: "x",
    sandbox_permissions: "workspace-write",
    justification: "write",
  });
  const resp = makeStreamingResponse([
    'event: response.output_item.added\ndata: {"item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"write"}}\n\n',
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ item_id: "fc_1", delta: dirty })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({
      item: {
        id: "fc_1",
        call_id: "call_1",
        type: "function_call",
        name: "write",
        arguments: dirty,
      },
    })}\n\n`,
    'event: response.completed\ndata: {"response":{"status":"completed","output":[]}}\n\n',
  ]);
  const drained = await drainCodexResponsesSse(resp);
  const tc = drained.toolCalls.get("call_1");
  assert.ok(tc);
  assert.deepEqual(JSON.parse(tc!.args), { path: "f.ts", contents: "x" });
  assert.equal(drained.outputItems.length, 1);
  assert.deepEqual(JSON.parse(drained.outputItems[0].arguments), {
    path: "f.ts",
    contents: "x",
  });
});
