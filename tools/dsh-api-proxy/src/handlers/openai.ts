import { Request, Response as ExpressResponse } from "express";
import { Config, isDebugLevel } from "../config";
import { extractUsage } from "../accounts/manager";
import { ProviderRegistry } from "../providers/registry";
import { proxyWithRetry } from "../utils/http";
import { tagStatsModel, tagStatsUsage } from "../stats/recorder";
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
} from "../upstream/translator";
import { handleStreamingResponse, readSseEvents } from "../upstream/streaming";
import {
  callCodexResponses,
  normalizeCodexCompactBody,
  normalizeCodexResponsesBody,
} from "../upstream/codex-api";
import { normalizeCursorResponsesBody } from "../upstream/cursor-api";
import {
  chatToResponsesRequest,
  responsesToChatCompletion,
  responsesSSEToChat,
  makeResponsesToChatState,
  drainCodexResponsesSse,
} from "../upstream/responses-translator";

function openaiErrorBody(status: number, body: string): any {
  try {
    const parsed = JSON.parse(body);
    // Codex backend uses { detail: "..." }; Anthropic uses { error: {...} };
    // OpenAI itself uses { error: { message, type, code } }.
    const msg =
      parsed?.error?.message ||
      (typeof parsed?.detail === "string" ? parsed.detail : null) ||
      parsed?.error?.error?.message ||
      "Upstream request failed";
    const type = parsed?.error?.type || "upstream_error";
    return { error: { message: msg, type } };
  } catch {
    return {
      error: { message: "Upstream request failed", type: "upstream_error" },
    };
  }
}

function internalError(resp: ExpressResponse): void {
  if (!resp.headersSent) {
    resp.status(500).json({ error: { message: "Internal server error" } });
  } else if (!resp.writableEnded) {
    resp.end();
  }
}

/**
 * Codex-specific path for /v1/chat/completions. Translates the incoming
 * Chat Completions body into a Responses body, applies codex's required
 * defaults (`stream:true`, `store:false`, `instructions`), forwards to
 * the codex backend, then converts the Responses SSE / JSON response
 * back to Chat Completions wire format.
 */
async function proxyCodexChatCompletions(args: {
  req: Request;
  resp: ExpressResponse;
  config: Config;
  provider: ReturnType<ProviderRegistry["forModel"]>;
  body: any;
  model: string;
  stream: boolean;
}): Promise<void> {
  const { req, resp, config, provider, body, model, stream } = args;
  const responsesBody = normalizeCodexResponsesBody(
    chatToResponsesRequest(body),
  );
  // codex's ChatGPT-account backend rejects a couple of public-Responses
  // fields. Strip them here — they are not load-bearing and the backend
  // applies its own caps from the user's ChatGPT plan.
  delete responsesBody.max_output_tokens;
  delete responsesBody.parallel_tool_calls;
  // Codex requires stream:true upstream. For non-streaming clients we
  // drive a streaming upstream and aggregate locally before responding.
  responsesBody.stream = true;

  if (isDebugLevel(config.debug, "verbose")) {
    console.log("[DEBUG] Translated Chat->Responses body for codex:");
    console.log(JSON.stringify(responsesBody, null, 2));
  }

  await proxyWithRetry("ChatCompletions(codex)", resp, config, {
    manager: provider.manager,
    upstream: (account, signal) =>
      provider.callMessages({
        body: responsesBody,
        request: req,
        account,
        config,
        signal,
      }),
    success: async (upstream, account) => {
      if (stream) {
        const includeUsage = body.stream_options?.include_usage !== false;
        const state = makeResponsesToChatState(model);
        const result = await handleStreamingResponse(upstream, resp, {
          onEvent: (event, data, usage) =>
            responsesSSEToChat(
              event,
              data,
              state,
              includeUsage ? usage : undefined,
            ),
        });
        if (result.completed) {
          provider.manager.recordSuccess(account.token.email, result.usage);
        } else if (!result.clientDisconnected) {
          provider.manager.recordFailure(
            account.token.email,
            "network",
            "stream terminated before completion",
          );
        }
        return;
      }

      // Non-streaming: collect the upstream Responses SSE and reassemble
      // into a single chat.completion JSON. We rely on the shared
      // drain helper so the trailing-buffer/decoder-flush bug stays
      // fixed in lockstep with the messages and responses paths.
      const drained = await drainCodexResponsesSse(upstream);
      const { textOut, reasoningOut, toolCalls, upstreamError, status, usage } =
        drained;

      if (upstreamError && !textOut && !reasoningOut && toolCalls.size === 0) {
        if (!resp.headersSent) {
          resp.status(502).json({
            error: { message: upstreamError, type: "upstream_error" },
          });
        }
        provider.manager.recordFailure(
          account.token.email,
          "server",
          upstreamError,
        );
        return;
      }

      const fauxResponses = {
        status,
        output: [
          ...(reasoningOut
            ? [
                {
                  type: "reasoning",
                  summary: [{ type: "summary_text", text: reasoningOut }],
                },
              ]
            : []),
          ...(textOut
            ? [
                {
                  type: "message",
                  content: [{ type: "output_text", text: textOut }],
                },
              ]
            : []),
          ...Array.from(toolCalls.values()).map((tc) => ({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: tc.args || "{}",
          })),
        ],
        usage,
      };
      const completion = responsesToChatCompletion(fauxResponses, model);
      const codexChatUsage = {
        inputTokens: usage?.input_tokens || 0,
        outputTokens: usage?.output_tokens || 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: usage?.input_tokens_details?.cached_tokens || 0,
        reasoningOutputTokens:
          usage?.output_tokens_details?.reasoning_tokens || 0,
      };
      provider.manager.recordSuccess(account.token.email, codexChatUsage);
      tagStatsUsage(resp, codexChatUsage);
      resp.json(completion);
    },
    errorAdapter: openaiErrorBody,
  });
}

/**
 * Codex-specific path for /v1/responses (the public OpenAI Responses API
 * format codex itself speaks natively). Even though the request shape is
 * upstream-native, the codex/ChatGPT-account backend rejects a couple of
 * public Responses fields (`max_output_tokens`, `parallel_tool_calls`)
 * and refuses non-streaming requests outright. To keep the public
 * `/v1/responses` contract honest we apply the same sanitize-and-force-
 * stream-upstream pattern used for `/v1/chat/completions` and
 * `/v1/messages`, then either pass the SSE through or — for clients
 * that asked for `stream:false` — drain the stream locally and re-emit
 * the captured `response.completed` payload as a single JSON body.
 */
async function proxyCodexResponses(args: {
  req: Request;
  resp: ExpressResponse;
  config: Config;
  provider: ReturnType<ProviderRegistry["forModel"]>;
  body: any;
  model: string;
  stream: boolean;
}): Promise<void> {
  const { req, resp, config, provider, body, model, stream } = args;
  const responsesBody = normalizeCodexResponsesBody(body);
  delete responsesBody.max_output_tokens;
  delete responsesBody.parallel_tool_calls;
  // Force the upstream to stream regardless of the client's request — the
  // backend doesn't support stream:false, and we drain locally below if
  // the client wants a single JSON body.
  responsesBody.stream = true;

  if (isDebugLevel(config.debug, "verbose")) {
    console.log("[DEBUG] Sanitised /v1/responses body for codex:");
    console.log(JSON.stringify(responsesBody, null, 2));
  }

  await proxyWithRetry("Responses(codex)", resp, config, {
    manager: provider.manager,
    upstream: (account, signal) =>
      provider.callMessages({
        body: responsesBody,
        request: req,
        account,
        config,
        signal,
      }),
    success: async (upstream, account) => {
      if (stream) {
        const result = await handleStreamingResponse(upstream, resp);
        if (result.completed) {
          provider.manager.recordSuccess(account.token.email, result.usage);
        } else if (!result.clientDisconnected) {
          provider.manager.recordFailure(
            account.token.email,
            "network",
            "stream terminated before completion",
          );
        }
        return;
      }

      // Non-streaming: drain the SSE and reconstruct the final
      // Responses JSON. The `response.completed` event from codex
      // gives us almost the whole envelope (id/status/usage/etc.)
      // but its `output` field is always `[]` — codex emits the
      // actual items via separate `response.output_item.done` events
      // during the stream. We collect those in `outputItems` and
      // splice them into the completed response here.
      const drained = await drainCodexResponsesSse(upstream);
      const {
        completedResponse,
        outputItems,
        upstreamError,
        usage,
        textOut,
        reasoningOut,
        toolCalls,
      } = drained;

      if (upstreamError && !completedResponse) {
        if (!resp.headersSent) {
          resp.status(502).json({
            error: { message: upstreamError, type: "upstream_error" },
          });
        }
        provider.manager.recordFailure(
          account.token.email,
          "server",
          upstreamError,
        );
        return;
      }

      let responseBody: any;
      if (completedResponse) {
        // Splice the streamed output items into the completed envelope.
        // Defensive: if upstream ever starts populating `output`
        // itself, prefer their version; otherwise use the items we
        // collected.
        responseBody = {
          ...completedResponse,
          output:
            Array.isArray(completedResponse.output) &&
            completedResponse.output.length > 0
              ? completedResponse.output
              : outputItems,
        };
      } else {
        // Fallback: upstream sent deltas but no `response.completed`.
        // Build the minimum viable Responses payload from the deltas
        // so the client gets something useful instead of `null`.
        responseBody = {
          id: `resp_${Date.now().toString(36)}`,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "incomplete",
          model,
          output:
            outputItems.length > 0
              ? outputItems
              : [
                  ...(reasoningOut
                    ? [
                        {
                          type: "reasoning",
                          summary: [
                            { type: "summary_text", text: reasoningOut },
                          ],
                        },
                      ]
                    : []),
                  ...(textOut
                    ? [
                        {
                          type: "message",
                          content: [{ type: "output_text", text: textOut }],
                        },
                      ]
                    : []),
                  ...Array.from(toolCalls.values()).map((tc) => ({
                    type: "function_call",
                    call_id: tc.id,
                    name: tc.name,
                    arguments: tc.args || "{}",
                  })),
                ],
          usage,
        };
      }

      const codexRespUsage = {
        inputTokens: usage?.input_tokens || 0,
        outputTokens: usage?.output_tokens || 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: usage?.input_tokens_details?.cached_tokens || 0,
        reasoningOutputTokens:
          usage?.output_tokens_details?.reasoning_tokens || 0,
      };
      provider.manager.recordSuccess(account.token.email, codexRespUsage);
      tagStatsUsage(resp, codexRespUsage);
      resp.json(responseBody);
    },
    errorAdapter: openaiErrorBody,
  });
}

/**
 * Cursor-specific path for /v1/chat/completions. Cursor's upstream is
 * stream-only, so for `stream:false` we drive the same streaming SSE
 * the provider emits, then collect the deltas into a single
 * `chat.completion` JSON. For `stream:true` we forward the SSE
 * verbatim.
 */
async function proxyCursorChatCompletions(args: {
  req: Request;
  resp: ExpressResponse;
  config: Config;
  provider: ReturnType<ProviderRegistry["forModel"]>;
  body: any;
  model: string;
  stream: boolean;
}): Promise<void> {
  const { req, resp, config, provider, body, model, stream } = args;
  // Always ask the upstream for a stream — Cursor only supports streaming.
  // For non-streaming clients we re-aggregate below before responding.
  const upstreamBody = { ...body, stream: true };

  await proxyWithRetry("ChatCompletions(cursor)", resp, config, {
    manager: provider.manager,
    upstream: (account, signal) => {
      const cloaked =
        provider.applyCloaking?.({
          body: upstreamBody,
          request: req,
          account,
          config,
        }) ?? upstreamBody;
      return provider.callMessages({
        body: cloaked,
        request: req,
        account,
        config,
        signal,
      });
    },
    success: async (upstream, account) => {
      if (stream) {
        // Pass-through: cursor provider already emits Chat Completions SSE
        // (responseFormat=openai-chat-completions, selected via req.path).
        const result = await handleStreamingResponse(upstream, resp);
        if (result.completed) {
          provider.manager.recordSuccess(account.token.email, result.usage);
        } else if (!result.clientDisconnected) {
          provider.manager.recordFailure(
            account.token.email,
            "network",
            "stream terminated before completion",
          );
        }
        return;
      }

      // Non-streaming: drain the SSE chunks the provider produced and
      // build a single chat.completion JSON. Uses readSseEvents so the
      // trailing-buffer flush bug stays fixed in lockstep with the
      // codex aggregation paths.
      let aggregatedText = "";
      let aggregatedReasoning = "";
      let upstreamError: { message: string; type?: string } | null = null;
      for await (const { data } of readSseEvents(upstream)) {
        if (!data) continue;
        if (data.error) {
          upstreamError = data.error;
          continue;
        }
        const delta = data.choices?.[0]?.delta;
        if (delta) {
          if (typeof delta.content === "string")
            aggregatedText += delta.content;
          if (typeof delta.reasoning_content === "string")
            aggregatedReasoning += delta.reasoning_content;
        }
      }

      if (upstreamError && !aggregatedText && !aggregatedReasoning) {
        if (!resp.headersSent) {
          resp.status(502).json({
            error: {
              message: upstreamError.message,
              type: upstreamError.type || "upstream_error",
            },
          });
        }
        provider.manager.recordFailure(
          account.token.email,
          "server",
          upstreamError.message,
        );
        return;
      }

      const message: Record<string, unknown> = {
        role: "assistant",
        content: aggregatedText,
      };
      if (aggregatedReasoning) message.reasoning_content = aggregatedReasoning;
      const completion = {
        id: `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: "stop", logprobs: null }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      };
      const cursorChatUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        reasoningOutputTokens: 0,
      };
      provider.manager.recordSuccess(account.token.email, cursorChatUsage);
      tagStatsUsage(resp, cursorChatUsage);
      resp.json(completion);
    },
    errorAdapter: openaiErrorBody,
  });
}

// POST /v1/chat/completions — OpenAI Chat Completions format
export function createChatCompletionsHandler(
  config: Config,
  registry: ProviderRegistry,
) {
  return async (req: Request, resp: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (
        !body.messages ||
        !Array.isArray(body.messages) ||
        body.messages.length === 0
      ) {
        resp.status(400).json({
          error: {
            message: "messages is required and must be a non-empty array",
          },
        });
        return;
      }

      const stream = !!body.stream;
      const model = resolveModel(body.model || "claude-sonnet-4-6");
      const provider = registry.forModel(model);
      tagStatsModel(resp, model, provider.id);

      // Cursor's wire protocol is closer to the OpenAI Responses API than to
      // Anthropic Messages, so for Cursor we skip the OpenAI->Anthropic
      // translation and ask the Cursor provider to emit Chat Completions
      // SSE / JSON natively (responseFormat is selected by `req.path`).
      // Cursor's chat upstream is also stream-only, so for non-streaming
      // requests we let the provider stream internally and aggregate the
      // pieces here before responding with a single chat.completion JSON.
      if (provider.id === "cursor") {
        await proxyCursorChatCompletions({
          req,
          resp,
          config,
          provider,
          body,
          model,
          stream,
        });
        return;
      }

      // Codex's upstream is the OpenAI Responses API. Translate the
      // incoming Chat Completions request into a Responses request, hit
      // the codex backend, then translate the Responses response (stream
      // or non-stream) back into Chat Completions wire format.
      if (provider.id === "codex") {
        await proxyCodexChatCompletions({
          req,
          resp,
          config,
          provider,
          body,
          model,
          stream,
        });
        return;
      }

      const structured =
        body.response_format?.type === "json_object" ||
        body.response_format?.type === "json_schema";
      const translatedBody = openaiToAnthropic(body);

      if (isDebugLevel(config.debug, "verbose")) {
        console.log(
          "[DEBUG] Translated OpenAI->Anthropic body (before cloaking):",
        );
        console.log(JSON.stringify(translatedBody, null, 2));
      }

      await proxyWithRetry("ChatCompletions", resp, config, {
        manager: provider.manager,
        upstream: (account, signal) => {
          const cloaked =
            provider.applyCloaking?.({
              body: translatedBody,
              request: req,
              account,
              config,
            }) ?? translatedBody;
          return provider.callMessages({
            body: cloaked,
            request: req,
            account,
            config,
            signal,
            structured,
          });
        },
        success: async (upstream, account) => {
          if (stream) {
            const includeUsage = body.stream_options?.include_usage !== false;
            const state = createStreamState(model, includeUsage);
            const result = await handleStreamingResponse(upstream, resp, {
              onEvent: (event, data, usage) =>
                anthropicSSEToChat(event, data, state, usage),
            });
            if (result.completed) {
              provider.manager.recordSuccess(account.token.email, result.usage);
            } else if (!result.clientDisconnected) {
              provider.manager.recordFailure(
                account.token.email,
                "network",
                "stream terminated before completion",
              );
            }
          } else {
            const anthropicResp = await upstream.json();
            const usage = extractUsage(anthropicResp);
            provider.manager.recordSuccess(account.token.email, usage);
            tagStatsUsage(resp, usage);
            resp.json(anthropicToOpenai(anthropicResp, model));
          }
        },
        errorAdapter: openaiErrorBody,
      });
    } catch (err: any) {
      console.error("Handler error:", err.message);
      internalError(resp);
    }
  };
}

// POST /v1/responses — OpenAI Responses API format
export function createResponsesHandler(
  config: Config,
  registry: ProviderRegistry,
) {
  return async (req: Request, resp: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (!body.input && !body.messages) {
        resp.status(400).json({ error: { message: "input is required" } });
        return;
      }

      const model = resolveModel(body.model || "claude-sonnet-4-6");
      const provider = registry.forModel(model);
      tagStatsModel(resp, model, provider.id);

      // The client-requested streaming intent is captured BEFORE we
      // normalize the upstream body — codex/cursor each force
      // `stream:true` upstream regardless, but the client's original
      // intent decides whether we forward SSE or aggregate locally.
      const clientWantsStream = !!body.stream;

      if (provider.nativeFormat === "openai-responses") {
        if (provider.id === "codex") {
          await proxyCodexResponses({
            req,
            resp,
            config,
            provider,
            body,
            model,
            stream: clientWantsStream,
          });
          return;
        }

        // Cursor: normalizeCursorResponsesBody forces stream:true and
        // cursor's transport only emits SSE. We deliberately keep the
        // legacy "always stream the response back to the client"
        // behaviour here — converting cursor's openai-responses SSE
        // into a single Responses JSON for non-stream clients would
        // need a dedicated aggregator and isn't required by any caller
        // today (Cursor accounts in the wild call /v1/messages or
        // /v1/chat/completions).
        const normalizedBody = normalizeCursorResponsesBody(body);
        await proxyWithRetry("Responses", resp, config, {
          manager: provider.manager,
          upstream: (account, signal) =>
            provider.callMessages({
              body: normalizedBody,
              request: req,
              account,
              config,
              signal,
            }),
          success: async (upstream, account) => {
            const result = await handleStreamingResponse(upstream, resp);
            if (result.completed) {
              provider.manager.recordSuccess(account.token.email, result.usage);
            } else if (!result.clientDisconnected) {
              provider.manager.recordFailure(
                account.token.email,
                "network",
                "stream terminated before completion",
              );
            }
          },
          errorAdapter: openaiErrorBody,
        });
        return;
      }

      // Anthropic path: translate Responses → Anthropic Messages, then back.
      const structured =
        body.text?.format?.type === "json_object" ||
        body.text?.format?.type === "json_schema";
      const translatedBody = responsesToAnthropic(body);

      await proxyWithRetry("Responses", resp, config, {
        manager: provider.manager,
        upstream: (account, signal) => {
          const cloaked =
            provider.applyCloaking?.({
              body: translatedBody,
              request: req,
              account,
              config,
            }) ?? translatedBody;
          return provider.callMessages({
            body: cloaked,
            request: req,
            account,
            config,
            signal,
            structured,
          });
        },
        success: async (upstream, account) => {
          if (clientWantsStream) {
            const state = makeResponsesState();
            const streamResp = await handleStreamingResponse(upstream, resp, {
              onEvent: (event, data, usage) =>
                anthropicSSEToResponses(event, data, state, model, usage),
            });
            if (streamResp.completed) {
              provider.manager.recordSuccess(
                account.token.email,
                streamResp.usage,
              );
            } else if (!streamResp.clientDisconnected) {
              provider.manager.recordFailure(
                account.token.email,
                "network",
                "stream terminated before completion",
              );
            }
          } else {
            const anthropicResp = await upstream.json();
            const usage = extractUsage(anthropicResp);
            provider.manager.recordSuccess(account.token.email, usage);
            tagStatsUsage(resp, usage);
            resp.json(anthropicToResponses(anthropicResp, model));
          }
        },
        errorAdapter: openaiErrorBody,
      });
    } catch (err: any) {
      console.error("Responses handler error:", err.message);
      internalError(resp);
    }
  };
}

// POST /v1/responses/compact — OpenAI Responses standalone compaction.
// Codex's ChatGPT-account backend exposes the same operation at
// /backend-api/codex/responses/compact, so this handler is also used by
// backend-compatible aliases in server.ts.
export function createResponsesCompactHandler(
  config: Config,
  registry: ProviderRegistry,
) {
  return async (req: Request, resp: ExpressResponse): Promise<void> => {
    try {
      const body = req.body || {};
      const model = resolveModel(body.model || "gpt-5-codex");
      const provider = registry.forModel(model);
      tagStatsModel(resp, model, provider.id);

      if (provider.id !== "codex") {
        resp.status(400).json({
          error: {
            message: `responses/compact is only supported for the codex provider, got ${provider.id}`,
            type: "unsupported_endpoint",
          },
        });
        return;
      }

      const compactBody = normalizeCodexCompactBody(body);

      if (isDebugLevel(config.debug, "verbose")) {
        console.log("[DEBUG] Forwarding /responses/compact body for codex:");
        console.log(JSON.stringify(compactBody, null, 2));
      }

      await proxyWithRetry("ResponsesCompact(codex)", resp, config, {
        manager: provider.manager,
        upstream: (account, signal) =>
          callCodexResponses({
            body: compactBody,
            request: req,
            account,
            config,
            signal,
            path: "/codex/responses/compact",
          }),
        success: async (upstream, account) => {
          let usage: any = null;
          let streamUsage: any = null;
          const contentType = upstream.headers.get("content-type") || "";

          if (contentType.includes("text/event-stream")) {
            const result = await handleStreamingResponse(upstream, resp);
            streamUsage = result.usage;
          } else {
            const text = await upstream.text();
            try {
              usage = JSON.parse(text)?.usage ?? null;
            } catch {
              /* best-effort stats only */
            }
            if (contentType) resp.setHeader("Content-Type", contentType);
            resp.status(upstream.status).send(text);
          }

          const codexCompactUsage = {
            inputTokens: usage?.input_tokens || streamUsage?.inputTokens || 0,
            outputTokens:
              usage?.output_tokens || streamUsage?.outputTokens || 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens:
              usage?.input_tokens_details?.cached_tokens ||
              streamUsage?.cacheReadInputTokens ||
              0,
            reasoningOutputTokens:
              usage?.output_tokens_details?.reasoning_tokens ||
              streamUsage?.reasoningOutputTokens ||
              0,
          };
          provider.manager.recordSuccess(
            account.token.email,
            codexCompactUsage,
          );
          tagStatsUsage(resp, codexCompactUsage);
        },
        errorAdapter: openaiErrorBody,
      });
    } catch (err: any) {
      console.error("Responses compact error:", err.message);
      internalError(resp);
    }
  };
}
