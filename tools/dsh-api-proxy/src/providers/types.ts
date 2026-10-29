import { Request } from "express";
import { ProviderId, PKCECodes, TokenData } from "../auth/types";
import { AccountManager, AvailableAccount } from "../accounts/manager";
import { Config } from "../config";

export type { ProviderId };

export type NativeFormat = "anthropic-messages" | "openai-responses";

export interface UpstreamCallContext {
  body?: any;
  request: Request;
  account: AvailableAccount;
  config: Config;
  structured?: boolean;
  signal?: AbortSignal;
}

export interface CloakingContext {
  body?: any;
  request: Request;
  account: AvailableAccount;
  config: Config;
}

export interface ProviderOAuthInfo {
  callbackPort: number;
  callbackPath: string;
}

export interface Provider {
  id: ProviderId;
  /** Body format the provider's outbound API expects. */
  nativeFormat: NativeFormat;
  /** True if this provider should serve `model`. */
  matchesModel(model: string): boolean;
  /** Account pool for this provider. */
  manager: AccountManager;
  oauth: ProviderOAuthInfo;
  buildAuthUrl(state: string, pkce: PKCECodes): string;
  exchangeCode(
    code: string,
    returnedState: string,
    expectedState: string,
    pkce: PKCECodes,
  ): Promise<TokenData>;
  /** Models advertised on /v1/models when this provider has accounts. */
  listModels(): Promise<Array<{ id: string; owned_by: string }>>;
  /** Anthropic-Messages → upstream call. */
  callMessages(opts: UpstreamCallContext): Promise<Response>;
  /** Optional — undefined for codex (no count_tokens analog). */
  callCountTokens?(opts: UpstreamCallContext): Promise<Response>;
  /**
   * Optional pre-flight body mutation. Anthropic uses it to inject Claude
   * Code CLI cloaking. Codex deliberately has no cloaking.
   */
  applyCloaking?(opts: CloakingContext): any;
}
