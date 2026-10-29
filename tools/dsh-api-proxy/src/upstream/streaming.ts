import { Response as ExpressResponse } from "express";
import { UsageData } from "../accounts/manager";

/**
 * Read an upstream Response as a stream of SSE `(event, data)` pairs.
 *
 * Why this exists: the previous hand-rolled drain loops in handlers
 * (codex chat / codex messages / cursor chat aggregation) all had the
 * same subtle bug — `reader.read()` returning `done` would `break`
 * immediately, without:
 *   1. flushing the `TextDecoder` (multi-byte chars at a chunk boundary
 *      could be silently dropped), and
 *   2. processing any line still sitting in `buf` because the upstream's
 *      final SSE event didn't end with a trailing `\n` (some servers
 *      send `event:…\ndata:{…}` with no terminator before connection
 *      close — the last `data:` line would be lost, including
 *      `response.completed`/usage payloads).
 *
 * Centralising the reader here means the four call sites (codex chat,
 * codex messages, cursor chat, codex /v1/responses non-stream
 * aggregation) cannot drift from each other and cannot reintroduce the
 * leftover-buffer bug.
 *
 * Implementation notes:
 *   - Lines are split on `\n` and trimmed of an optional trailing `\r`
 *     so `\r\n` line endings work transparently.
 *   - A blank line resets the current `event:` (per the SSE spec a
 *     dispatch boundary), even though most providers re-state the event
 *     on every record.
 *   - `data:` payloads are JSON-parsed best-effort; on parse failure
 *     the consumer still gets `data: null` so it can decide what to do
 *     with the raw line.
 *   - The final flush calls `decoder.decode()` with no args so any
 *     buffered byte fragments are surfaced before the leftover-line
 *     scan.
 */
export async function* readSseEvents(
  upstream: Response,
): AsyncGenerator<{ event: string; data: any }> {
  const reader = upstream.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let finished = false;

  while (!finished) {
    const r = await reader.read();
    if (r.done) {
      buf += decoder.decode();
      finished = true;
    } else {
      buf += decoder.decode(r.value, { stream: true });
    }
    const lines = buf.split("\n");
    // Hold the trailing partial line back unless this is the final
    // flush, in which case any leftover (un-terminated) line is
    // consumed too.
    buf = finished ? "" : (lines.pop() ?? "");
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line) {
        event = "";
        continue;
      }
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let parsed: any = null;
        try {
          parsed = JSON.parse(payload);
        } catch {
          /* leave parsed as null; pass-through for callers that want raw */
        }
        yield { event, data: parsed };
      }
    }
  }
}

export type SSEEventHandler = (
  event: string,
  data: any,
  usage: UsageData,
) => string[];

export interface StreamOptions {
  onEvent?: SSEEventHandler;
}

export interface StreamResult {
  completed: boolean;
  clientDisconnected: boolean;
  usage: UsageData;
}

function extractUsageFromSSE(event: string, data: any, usage: UsageData): void {
  // Anthropic Messages stream — usage arrives on message_delta.
  if (event === "message_delta") {
    const u = data?.usage;
    if (!u) return;
    usage.inputTokens = u.input_tokens || 0;
    usage.outputTokens = u.output_tokens || 0;
    usage.cacheCreationInputTokens = u.cache_creation_input_tokens || 0;
    usage.cacheReadInputTokens = u.cache_read_input_tokens || 0;
    return;
  }
  // OpenAI Responses stream — usage arrives on response.completed under
  // response.usage (matches codex-rs/codex-api/src/sse/responses.rs).
  if (event === "response.completed") {
    const u = data?.response?.usage;
    if (!u) return;
    usage.inputTokens = u.input_tokens || 0;
    usage.outputTokens = u.output_tokens || 0;
    usage.cacheReadInputTokens = u.input_tokens_details?.cached_tokens || 0;
    usage.reasoningOutputTokens =
      u.output_tokens_details?.reasoning_tokens || 0;
    // Codex has no cache_creation analog; leave at default.
    return;
  }
}

export async function handleStreamingResponse(
  upstream: Response,
  resp: ExpressResponse,
  options?: StreamOptions,
): Promise<StreamResult> {
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningOutputTokens: 0,
  };

  resp.setHeader("Content-Type", "text/event-stream");
  resp.setHeader("Cache-Control", "no-cache");
  resp.setHeader("Connection", "keep-alive");
  resp.setHeader("X-Accel-Buffering", "no");
  resp.flushHeaders();

  const reader = upstream.body?.getReader();
  if (!reader) {
    resp.end();
    return { completed: true, clientDisconnected: false, usage };
  }

  const decoder = new TextDecoder();

  let buffer = "";
  let currentEvent = "";
  let clientDisconnected = false;
  let completed = false;

  const onClose = () => {
    clientDisconnected = true;
    reader.cancel().catch(() => {});
  };
  resp.on("close", onClose);

  try {
    // The `finished` flag lets us run the loop body one final time with
    // an empty chunk after `reader.read()` returns `done`. That final
    // iteration:
    //   1. flushes the TextDecoder (any pending multi-byte bytes), and
    //   2. consumes the leftover line in `buffer` even if the upstream
    //      closed without a trailing newline.
    // The previous `if (done) break;` shortcut silently dropped the
    // final SSE event in that case — for the `onEvent` transform path
    // (codex chat/messages stream) this meant clients never received
    // the `response.completed`-derived finish chunk / [DONE] /
    // message_stop, and account usage was never recorded. For the
    // raw pass-through path the bytes still reached the client (they
    // were written before parsing) but `extractUsageFromSSE` was
    // skipped, undercounting tokens.
    let finished = false;
    while (!clientDisconnected && !finished) {
      const { done, value } = await reader.read();

      if (done) {
        buffer += decoder.decode();
        finished = true;
      } else {
        if (!options?.onEvent) {
          resp.write(value);
        }
        buffer += decoder.decode(value, { stream: true });
      }

      const lines = buffer.split("\n");
      // On the final flush, consume every line — including the
      // un-terminated trailing one. While streaming, hold the
      // partial line back until its terminator arrives.
      buffer = finished ? "" : (lines.pop() ?? "");

      for (const raw of lines) {
        if (clientDisconnected) break;
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            const data = JSON.parse(payload);
            extractUsageFromSSE(currentEvent, data, usage);
            if (options?.onEvent) {
              const chunks = options.onEvent(currentEvent, data, usage);
              for (const c of chunks) {
                if (!clientDisconnected) resp.write(c);
              }
            }
          } catch {
            /* ignore parse errors */
          }
        }
      }
    }
    completed = !clientDisconnected;
  } catch (err) {
    if (!clientDisconnected) console.error("Stream error:", err);
  } finally {
    resp.off("close", onClose);
    if (!clientDisconnected) {
      resp.end();
    }
  }

  // Surface stream-extracted usage to the per-request stats slot (set
  // by server.ts requireApiKey middleware). Skipped on disconnect so a
  // half-streamed reply doesn't get attributed.
  if (completed) {
    const ctx = (resp.locals as any)?.stats;
    if (ctx) ctx.usage = usage;
  }

  return { completed, clientDisconnected, usage };
}
