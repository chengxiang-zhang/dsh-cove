import { PKCECodes, TokenData } from "../auth/types";
import { AccountManager } from "../accounts/manager";
import {
  generateCodexAuthURL,
  exchangeCodexCode,
  refreshCodexTokensWithRetry,
  CODEX_CALLBACK_PATH,
  CODEX_CALLBACK_PORT,
} from "../auth/codex/oauth";
import {
  loadTokenFromCodexAuthFile,
  resolveCodexAuthFile,
  saveTokenToCodexAuthFile,
} from "../auth/codex/native-auth";
import { callCodexResponses } from "../upstream/codex-api";
import { listCodexModels } from "../upstream/codex-models";
import { Provider, UpstreamCallContext, ProviderOAuthInfo } from "./types";

const CODEX_OAUTH: ProviderOAuthInfo = {
  callbackPort: CODEX_CALLBACK_PORT,
  callbackPath: CODEX_CALLBACK_PATH,
};

// gpt-5*/gpt-6*, o\d* (o3, o4-mini), codex-* — but NOT legacy gpt-3/gpt-4*
// which the codex backend doesn't serve.
const MODEL_RE = /^(gpt-(5|6)(\.|-)|gpt-(5|6)$|o\d|codex-)/i;

export interface CodexProviderOptions {
  /**
   * Path to Codex CLI auth.json. When set, dsh-api-proxy uses it as the sole
   * ChatGPT token source (read + write-back on emergency refresh).
   */
  authFile?: string;
  /** client_version / version header — should match local `codex --version`. */
  clientVersion?: string;
}

export function buildCodexProvider(
  authDir: string,
  options: CodexProviderOptions = {},
): Provider {
  const authFile = options.authFile
    ? resolveCodexAuthFile(options.authFile)
    : null;
  const clientVersion = options.clientVersion || "0.162.0";

  const manager = new AccountManager(authDir, {
    provider: "codex",
    refresh: async (rt: string): Promise<TokenData> => {
      const token = await refreshCodexTokensWithRetry(rt);
      return { ...token, provider: "codex" };
    },
    // Mirrors codex-rs/login/src/auth/manager.rs TOKEN_REFRESH_INTERVAL = 8 days.
    // Native mode disables proactive refresh entirely; this policy only matters
    // if proactiveRefresh is re-enabled.
    refreshPolicy: { kind: "since-last-refresh", maxAgeMs: 8 * 86_400_000 },
    ...(authFile
      ? {
          loadTokens: () => {
            const token = loadTokenFromCodexAuthFile(authFile);
            return token ? [token] : [];
          },
          persistToken: (token: TokenData) =>
            saveTokenToCodexAuthFile(authFile, token),
          syncBeforeSelect: true,
          proactiveRefresh: false,
        }
      : {}),
  });

  if (authFile) {
    console.log(`[codex] native auth file: ${authFile}`);
  }

  return {
    id: "codex",
    nativeFormat: "openai-responses",
    manager,
    oauth: CODEX_OAUTH,
    matchesModel: (model: string) => MODEL_RE.test(model),
    buildAuthUrl: (state: string, pkce: PKCECodes) =>
      generateCodexAuthURL(state, pkce),
    exchangeCode: async (code, returnedState, expectedState, pkce) => {
      const token = await exchangeCodexCode(
        code,
        returnedState,
        expectedState,
        pkce,
      );
      return { ...token, provider: "codex" };
    },
    listModels: () => listCodexModels(manager, clientVersion),
    callMessages: (opts: UpstreamCallContext) =>
      callCodexResponses({
        body: opts.body,
        request: opts.request,
        account: opts.account,
        config: opts.config,
        signal: opts.signal,
      }),
    // No callCountTokens — codex backend has no equivalent endpoint.
    // No applyCloaking — protocol headers live in codex-api.ts; identity
    // injection is intentionally NOT done here.
  };
}
