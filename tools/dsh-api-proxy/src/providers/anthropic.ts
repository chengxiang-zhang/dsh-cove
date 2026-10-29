import { PKCECodes, TokenData } from "../auth/types";
import {
  generateAuthURL,
  exchangeCodeForTokens,
  refreshTokensWithRetry,
} from "../auth/oauth";
import { AccountManager } from "../accounts/manager";
import {
  callAnthropicMessages,
  callAnthropicCountTokens,
} from "../upstream/anthropic-api";
import { applyCloaking } from "../upstream/cloaking";
import {
  Provider,
  UpstreamCallContext,
  CloakingContext,
  ProviderOAuthInfo,
} from "./types";

const ANTHROPIC_OAUTH: ProviderOAuthInfo = {
  callbackPort: 54545,
  callbackPath: "/callback",
};

const MODEL_RE = /^(?:claude-|anthropic\.claude-|bedrock\/anthropic\.claude-)/i;

const ADVERTISED_MODELS = [
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-mythos-preview",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "mythos",
];

export function buildAnthropicProvider(authDir: string): Provider {
  const manager = new AccountManager(authDir, {
    provider: "anthropic",
    refresh: async (rt: string): Promise<TokenData> => {
      const token = await refreshTokensWithRetry(rt);
      return { ...token, provider: "anthropic" };
    },
  });

  return {
    id: "anthropic",
    nativeFormat: "anthropic-messages",
    manager,
    oauth: ANTHROPIC_OAUTH,
    matchesModel: (model: string) => MODEL_RE.test(model),
    buildAuthUrl: (state: string, pkce: PKCECodes) =>
      generateAuthURL(state, pkce),
    exchangeCode: async (code, returnedState, expectedState, pkce) => {
      const token = await exchangeCodeForTokens(
        code,
        returnedState,
        expectedState,
        pkce,
      );
      return { ...token, provider: "anthropic" };
    },
    listModels: async () =>
      ADVERTISED_MODELS.map((id) => ({ id, owned_by: "anthropic" })),
    callMessages: (opts: UpstreamCallContext) => callAnthropicMessages(opts),
    callCountTokens: (opts: UpstreamCallContext) =>
      callAnthropicCountTokens({
        request: opts.request,
        account: opts.account,
        config: opts.config,
        signal: opts.signal,
      }),
    applyCloaking: (opts: CloakingContext) => applyCloaking(opts),
  };
}
