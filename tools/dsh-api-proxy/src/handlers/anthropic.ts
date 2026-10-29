import { Request, Response as ExpressResponse } from "express";
import { Config, isDebugLevel } from "../config";
import { extractUsage } from "../accounts/manager";
import { ProviderRegistry } from "../providers/registry";
import { proxyWithRetry } from "../utils/http";
import { resolveModel } from "../upstream/translator";
import { handleStreamingResponse } from "../upstream/streaming";
import { normalizeCodexResponsesBody } from "../upstream/codex-api";
import { tagStatsModel, tagStatsUsage } from "../stats/recorder";
import {
  anthropicToResponsesRequest,
  responsesToAnthropicMessage,
  responsesSSEToAnthropic,
  makeResponsesToAnthropicState,
  drainCodexResponsesSse,
} from "../upstream/responses-translator";

function internalError(resp: ExpressResponse): void {
  if (!resp.headersSent) {
    resp.status(500).json({ error: { message: "Internal server error" } });
  } else if (!resp.writableEnded) {
    resp.end();
  }
}

/**
 * Codex-specific path for /v1/messages. Translates the Anthropic Messages
 * request into a Responses request, applies codex's required defaults
 * (`stream:true`, `store:false`, `instructions`), forwards to the codex
 * backend, and converts the streaming / non-streaming Responses response
 * back into Anthropic Messages SSE / JSON.
 */
async function proxyCodexMessages(args: {
  req: Request;
  resp: ExpressResponse;
  config: Config;
  provider: ReturnType<ProviderRegistry["forModel"]>;
  body: any;
  model: string;
}): Promise<void> {
  const { req, resp, config, provider, body, model } = args;
  const stream = !!body.stream;
  const responsesBody = normalizeCodexResponsesBody(
    anthropicToResponsesRequest(body),
  );
  // codex's ChatGPT-account backend rejects `max_output_tokens` even
  // though the public OpenAI Responses API accepts it. Anthropic Messages
  // requires `max_tokens` so the translator always emits this field —
  // strip it here. Same applies to a couple of other fields the
  // ChatGPT-codex backend doesn't support.
  delete responsesBody.max_output_tokens;
  delete responsesBody.parallel_tool_calls;
  // codex requires stream:true upstream — we aggregate locally for
  // non-streaming clients.
  responsesBody.stream = true;

  if (isDebugLevel(config.debug, "verbose")) {
    console.log("[DEBUG] Translated Anthropic->Responses body for codex:");
    console.log(JSON.stringify(responsesBody, null, 2));
  }

  await proxyWithRetry("Messages(codex)", resp, config, {
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
        const state = makeResponsesToAnthropicState(model);
        const result = await handleStreamingResponse(upstream, resp, {
          onEvent: (event, data) => responsesSSEToAnthropic(event, data, state),
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

      // Non-streaming: drain the upstream Responses SSE stream into a
      // single faux Responses payload, then convert to Anthropic Messages
      // JSON. Uses the shared drain helper so trailing-line / decoder
      // flush handling stays in sync with the chat completions and
      // responses paths.
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
      const anthropicJson = responsesToAnthropicMessage(fauxResponses, model);
      const codexMsgUsage = {
        inputTokens: usage?.input_tokens || 0,
        outputTokens: usage?.output_tokens || 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: usage?.input_tokens_details?.cached_tokens || 0,
        reasoningOutputTokens:
          usage?.output_tokens_details?.reasoning_tokens || 0,
      };
      provider.manager.recordSuccess(account.token.email, codexMsgUsage);
      tagStatsUsage(resp, codexMsgUsage);
      resp.json(anthropicJson);
    },
  });
}

// POST /v1/messages — Anthropic native format passthrough
export function createMessagesHandler(
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

      if (isDebugLevel(config.debug, "verbose")) {
        console.log("[DEBUG] Incoming /v1/messages body:");
        console.log(JSON.stringify(body, null, 2));
      }

      const model = resolveModel(body.model || "claude-sonnet-4-6");
      const provider = registry.forModel(model);
      tagStatsModel(resp, model, provider.id);

      // Codex's upstream is the OpenAI Responses API; route /v1/messages
      // through a dedicated translator path that converts Anthropic
      // Messages requests into Responses requests and the streaming /
      // non-streaming Responses replies back into Anthropic Messages
      // wire format.
      if (provider.id === "codex") {
        await proxyCodexMessages({ req, resp, config, provider, body, model });
        return;
      }

      // Cursor speaks OpenAI Responses natively, but its callMessages will
      // re-encode the SSE stream as Anthropic Messages when invoked through
      // /v1/messages.
      if (
        provider.nativeFormat === "openai-responses" &&
        provider.id !== "cursor"
      ) {
        resp.status(400).json({
          error: {
            message: `This model is served by the ${provider.id} provider, which does not support /v1/messages.`,
            type: "unsupported_endpoint_for_provider",
            provider: provider.id,
          },
        });
        return;
      }

      // Cursor only ever streams; force `stream:true` so the upstream call is
      // routed through our SSE adapter even when the client asked for a
      // non-streaming response. We still respond with SSE in that case
      // because converting Cursor's protobuf reply to Anthropic non-stream
      // JSON is a separate adapter we haven't written yet.
      const stream = provider.id === "cursor" ? true : !!body.stream;

      await proxyWithRetry("Messages", resp, config, {
        manager: provider.manager,
        upstream: (account, signal) => {
          const cloaked =
            provider.applyCloaking?.({
              request: req,
              account,
              config,
            }) ?? body;
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
          } else {
            const anthropicResp = await upstream.json();
            const usage = extractUsage(anthropicResp);
            provider.manager.recordSuccess(account.token.email, usage);
            tagStatsUsage(resp, usage);
            resp.json(anthropicResp);
          }
        },
      });
    } catch (err: any) {
      console.error("Messages handler error:", err.message);
      internalError(resp);
    }
  };
}

// POST /v1/messages/count_tokens — passthrough
export function createCountTokensHandler(
  config: Config,
  registry: ProviderRegistry,
) {
  return async (req: Request, resp: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      const model = resolveModel(body?.model || "claude-sonnet-4-6");
      const provider = registry.forModel(model);
      tagStatsModel(resp, model, provider.id);

      if (!provider.callCountTokens) {
        resp.status(501).json({
          error: {
            message: `count_tokens is not supported for the ${provider.id} provider.`,
            type: "unsupported_endpoint_for_provider",
            provider: provider.id,
          },
        });
        return;
      }

      const callCountTokens = provider.callCountTokens.bind(provider);
      await proxyWithRetry("CountTokens", resp, config, {
        manager: provider.manager,
        upstream: (account, signal) =>
          callCountTokens({ request: req, account, config, signal }),
        success: async (upstream, account) => {
          provider.manager.recordSuccess(account.token.email);
          const data = await upstream.json();
          resp.json(data);
        },
      });
    } catch (err: any) {
      console.error("Count tokens error:", err.message);
      internalError(resp);
    }
  };
}
