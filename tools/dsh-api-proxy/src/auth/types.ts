export type ProviderId = "anthropic" | "codex" | "cursor";

export interface PKCECodes {
  codeVerifier: string;
  codeChallenge: string;
}

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: string; // ISO 8601
  accountUuid: string; // anthropic: data.account.uuid; codex: chatgpt_account_id
  provider?: ProviderId; // missing on legacy files → treated as "anthropic"
  idToken?: string; // codex only
  /** ISO 8601 of last successful refresh (or initial token issuance). */
  lastRefreshAt?: string;
  /** Codex only — raw chatgpt_plan_type claim from id_token (free/plus/pro/…). */
  planType?: string;
  /** Cursor only — stable machine id read from Cursor's local storage. */
  cursorServiceMachineId?: string;
  /** Cursor only — client version accepted by Cursor's internal API. */
  cursorClientVersion?: string;
  /** Cursor only — config version header value. */
  cursorConfigVersion?: string;
  /** Cursor only — OAuth client id used for refresh. */
  cursorClientId?: string;
  /** Cursor only — membership tier from Cursor local storage. */
  cursorMembershipType?: string;
}

export interface TokenStorage {
  access_token: string;
  refresh_token: string;
  last_refresh: string;
  email: string;
  type: ProviderId | "claude"; // "claude" retained for legacy files
  expired: string; // ISO 8601
  account_uuid?: string;
  id_token?: string;
  plan_type?: string;
  cursor_service_machine_id?: string;
  cursor_client_version?: string;
  cursor_config_version?: string;
  cursor_client_id?: string;
  cursor_membership_type?: string;
}
