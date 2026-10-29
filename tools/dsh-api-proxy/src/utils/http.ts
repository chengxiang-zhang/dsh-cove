import { Response as ExpressResponse } from "express";
import {
  AccountFailureKind,
  AccountManager,
  AccountResult,
  AvailableAccount,
} from "../accounts/manager";
import { ProviderId } from "../auth/types";
import { Config, isDebugLevel } from "../config";

export const MAX_RETRIES = 3;
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export function classifyFailure(status: number): AccountFailureKind {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "server";
}

const FAILURE_RESPONSES: Record<
  AccountFailureKind,
  { status: number; message: string }
> = {
  rate_limit: {
    status: 429,
    message: "Rate limited on the configured account",
  },
  auth: {
    status: 503,
    message: "Configured account requires re-authentication",
  },
  forbidden: { status: 503, message: "Configured account is forbidden" },
  server: { status: 503, message: "Upstream server temporarily unavailable" },
  network: { status: 503, message: "Upstream network temporarily unavailable" },
};

function statsContext(resp: ExpressResponse): any {
  return (resp.locals as any)?.stats;
}

function tagStatsFailure(
  resp: ExpressResponse,
  failureKind: string | null,
  provider?: ProviderId,
): void {
  const ctx = statsContext(resp);
  if (!ctx) return;
  ctx.failureKind = failureKind;
  if (provider) ctx.provider = provider;
}

export function accountUnavailable(
  resp: ExpressResponse,
  result: Extract<AccountResult, { account: null }>,
  provider: ProviderId,
): void {
  const { failureKind, retryAfterMs } = result;
  tagStatsFailure(resp, failureKind || "no_account", provider);

  // No accounts at all for this provider.
  if (!failureKind) {
    resp.status(503).json({
      error: {
        message: `No ${provider} accounts loaded. Run: dsh-api-proxy --login --provider=${provider}`,
        type: "no_account_for_provider",
        provider,
      },
    });
    return;
  }

  const { status, message } = FAILURE_RESPONSES[failureKind];
  if (retryAfterMs && retryAfterMs > 0) {
    resp.setHeader(
      "Retry-After",
      Math.max(1, Math.ceil(retryAfterMs / 1000)).toString(),
    );
  }
  resp.status(status).json({ error: { message } });
}

export interface ProxyOptions {
  manager: AccountManager;
  upstream: (
    account: AvailableAccount,
    signal: AbortSignal,
  ) => Promise<Response>;
  success: (upstream: Response, account: AvailableAccount) => Promise<void>;
  /**
   * Optional translator from upstream error body to client-format error body.
   * Required when the inbound and outbound formats differ (e.g. OpenAI Chat
   * client hitting Anthropic upstream) so we don't leak provider-shaped errors.
   */
  errorAdapter?: (status: number, body: string) => any;
  maxRetries?: number;
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function proxyWithRetry(
  tag: string,
  resp: ExpressResponse,
  config: Config,
  options: ProxyOptions,
): Promise<void> {
  const { manager } = options;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  let lastStatus = 500;
  let lastErrBody = "";
  let lastRetryAfter: string | null = null;
  const refreshedAccounts = new Set<string>();

  const requestController = new AbortController();
  const abortRequest = () => {
    if (!requestController.signal.aborted) {
      requestController.abort(new Error("client disconnected"));
    }
  };
  resp.on("close", abortRequest);

  try {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const result = manager.getNextAccount();
      if (!result.account) {
        return accountUnavailable(resp, result, manager.provider);
      }
      const account = result.account;
      manager.recordAttempt(account.token.email);
      // Surface upstream account attribution to the per-request stats slot
      // (set by server.ts requireApiKey middleware). Done here so failure
      // paths and abandoned requests still get an account label, not just
      // success calls.
      const statsCtx = (resp.locals as any)?.stats;
      if (statsCtx) {
        statsCtx.accountEmail = account.token.email;
        statsCtx.provider = manager.provider;
      }

      let upstream: Response;
      try {
        upstream = await options.upstream(account, requestController.signal);
      } catch (err: any) {
        if (requestController.signal.aborted) return;
        tagStatsFailure(resp, "network", manager.provider);
        manager.recordFailure(account.token.email, "network", err.message);
        if (isDebugLevel(config.debug, "errors")) {
          console.error(
            `${tag} attempt ${attempt + 1} network failure: ${err.message}`,
          );
        }
        if (attempt < maxRetries - 1) {
          const shouldContinue = await waitForRetry(
            (attempt + 1) * 1000,
            requestController.signal,
          );
          if (!shouldContinue) return;
          continue;
        }
        resp.status(502).json({ error: { message: "Upstream network error" } });
        return;
      }

      if (upstream.ok) {
        tagStatsFailure(resp, null, manager.provider);
        try {
          await options.success(upstream, account);
        } catch (err: any) {
          if (requestController.signal.aborted || resp.destroyed) return;
          tagStatsFailure(resp, "handler_error", manager.provider);
          const message = err?.message || String(err);
          if (isDebugLevel(config.debug, "errors")) {
            console.error(`${tag} success handler failed: ${message}`);
          }
          if (!resp.headersSent) {
            resp
              .status(500)
              .json({ error: { message: "Internal server error" } });
          } else if (!resp.writableEnded) {
            resp.end();
          }
        }
        return;
      }

      lastStatus = upstream.status;
      tagStatsFailure(
        resp,
        lastStatus >= 400 && lastStatus < 500
          ? lastStatus === 401 || lastStatus === 403 || lastStatus === 429
            ? classifyFailure(lastStatus)
            : "client_error"
          : classifyFailure(lastStatus),
        manager.provider,
      );
      lastRetryAfter = upstream.headers.get("retry-after");
      try {
        lastErrBody = await upstream.text();
        if (isDebugLevel(config.debug, "errors")) {
          console.error(
            `${tag} attempt ${attempt + 1} failed (${lastStatus}): ${lastErrBody}`,
          );
        }
      } catch {
        /* ignore */
      }

      if (lastStatus === 401) {
        // Only refresh once per account per proxy attempt. A second 401 after a
        // successful refresh usually means the cause isn't the access token (bad
        // header, account state, server-side issue) — refreshing again would
        // burn a freshly rotated refresh token for nothing, and on Codex this
        // races with the documented refresh_token_reused failure mode
        // (openai/codex#10332).
        if (!refreshedAccounts.has(account.token.email)) {
          refreshedAccounts.add(account.token.email);
          const refreshed = await manager.refreshAccount(account.token.email);
          if (refreshed) {
            attempt--;
            continue;
          }
        }
      } else if (
        lastStatus === 403 ||
        lastStatus === 429 ||
        lastStatus >= 500
      ) {
        // Account-level failures: cooldown, may retry on another account.
        manager.recordFailure(account.token.email, classifyFailure(lastStatus));
      }
      // Other 4xx (400, 404, 422, …) are client request errors — the account is
      // healthy, the request body is bad. Do NOT cool down the account, and do
      // NOT retry; surface the upstream error to the client immediately.

      if (!RETRYABLE_STATUSES.has(lastStatus)) break;
      if (attempt < maxRetries - 1) {
        const shouldContinue = await waitForRetry(
          (attempt + 1) * 1000,
          requestController.signal,
        );
        if (!shouldContinue) return;
      }
    }
  } finally {
    resp.off("close", abortRequest);
  }

  // Client already gone — don't try to write the terminal error response.
  if (
    requestController.signal.aborted ||
    resp.destroyed ||
    resp.writableEnded
  ) {
    return;
  }

  // Forward upstream Retry-After verbatim — most useful on 429.
  if (lastRetryAfter) resp.setHeader("Retry-After", lastRetryAfter);

  // Translate upstream error body if an adapter is provided. This prevents
  // provider-shaped errors (e.g. Anthropic JSON, Codex JSON) leaking into a
  // client expecting OpenAI Chat error shape.
  const adapter = options.errorAdapter;
  if (adapter) {
    try {
      const translated = adapter(lastStatus, lastErrBody);
      resp.status(lastStatus).json(translated);
      return;
    } catch {
      // fall through to default handling
    }
  }

  try {
    const parsed = lastErrBody ? JSON.parse(lastErrBody) : null;
    if (parsed && typeof parsed === "object") {
      resp.status(lastStatus).json(parsed);
    } else {
      resp
        .status(lastStatus)
        .json({ error: { message: "Upstream request failed" } });
    }
  } catch {
    resp
      .status(lastStatus)
      .json({ error: { message: "Upstream request failed" } });
  }
}
