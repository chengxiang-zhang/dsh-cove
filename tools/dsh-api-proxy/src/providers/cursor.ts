import { PKCECodes, TokenData } from "../auth/types";
import { loadAllTokens } from "../auth/token-storage";
import { refreshCursorTokensWithRetry } from "../auth/cursor/oauth";
import { AccountManager } from "../accounts/manager";
import {
  callCursorResponses,
  listCursorModels,
} from "../upstream/cursor-api";
import { Provider, UpstreamCallContext, ProviderOAuthInfo } from "./types";

const CURSOR_OAUTH: ProviderOAuthInfo = {
  callbackPort: 0,
  callbackPath: "/cursor/import-local",
};

const MODEL_RE = /^(cursor[-/:]|cr\/)/i;

export function buildCursorProvider(authDir: string): Provider {
  const manager = new AccountManager(authDir, {
    provider: "cursor",
    refresh: async (rt: string): Promise<TokenData> => {
      const previous =
        loadAllTokens(authDir, "cursor").find((t) => t.refreshToken === rt) ||
        {};
      const token = await refreshCursorTokensWithRetry(rt, previous);
      return { ...previous, ...token, provider: "cursor" };
    },
  });

  return {
    id: "cursor",
    nativeFormat: "openai-responses",
    manager,
    oauth: CURSOR_OAUTH,
    matchesModel: (model: string) => MODEL_RE.test(model),
    buildAuthUrl: (_state: string, _pkce: PKCECodes) => {
      throw new Error(
        "Cursor provider uses local Cursor login import; run --login --provider=cursor",
      );
    },
    exchangeCode: async () => {
      throw new Error("Cursor provider does not implement browser OAuth exchange");
    },
    listModels: () => listCursorModels(manager),
    callMessages: (opts: UpstreamCallContext) => {
      // Pick the SSE/JSON wire format that matches the inbound endpoint so
      // any of the three "OpenAI-compatible" client conventions can use a
      // Cursor account unchanged. Handlers route this provider for all
      // three endpoints when "Cursor exclusive" mode kicks in.
      const path = opts.request?.path || "";
      const responseFormat = path.includes("/v1/messages")
        ? "anthropic-messages"
        : path.includes("/v1/chat/completions")
          ? "openai-chat-completions"
          : "openai-responses";
      return callCursorResponses({
        body: opts.body,
        request: opts.request,
        account: opts.account,
        config: opts.config,
        signal: opts.signal,
        responseFormat,
      });
    },
  };
}
