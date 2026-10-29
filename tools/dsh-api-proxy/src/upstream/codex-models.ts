import { AccountManager } from "../accounts/manager";

const BASE_URL = "https://chatgpt.com/backend-api";
const MODELS_PATH = "/codex/models";
const CACHE_TTL_MS = 5 * 60 * 1000; // matches codex-rs/models-manager DEFAULT_MODEL_CACHE_TTL
// Must be a semver like the official CLI (`codex --version` → 0.162.0).
// Non-semver values (e.g. "dsh-api-proxy/1.0.0") get 400 Invalid client_version format.
const DEFAULT_CLIENT_VERSION = "0.162.0";

// Static fallback used when no account is loaded or the upstream /codex/models
// call fails. Prefer the live list from ChatGPT when available. Keep in sync
// with the model set exposed at DEFAULT_CLIENT_VERSION (2026-10-09 live probe:
// 10 models at 0.162.0, incl. the gpt-6 family that 0.147.0 hides).
const FALLBACK_MODELS = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-reserve",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "codex-auto-review",
];

interface UpstreamModel {
  slug: string;
  display_name?: string;
  visibility?: string;
}

interface ModelsResponse {
  models: UpstreamModel[];
}

interface CacheEntry {
  fetchedAt: number;
  etag: string | null;
  models: UpstreamModel[];
  clientVersion: string;
}

let cache: CacheEntry | null = null;

async function fetchUpstream(
  manager: AccountManager,
  clientVersion: string,
): Promise<{ models: UpstreamModel[]; etag: string | null } | null> {
  const result = manager.getNextAccount();
  if (!result.account) return null;
  const account = result.account;

  // Match openai/codex ModelsClient:
  //   GET {base}/models?client_version=<CARGO_PKG_VERSION>
  // plus ChatGPT auth headers + version header from create_openai_provider.
  const url = `${BASE_URL}${MODELS_PATH}?client_version=${encodeURIComponent(clientVersion)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${account.token.accessToken}`,
    Accept: "application/json",
    "User-Agent": `codex_cli_rs/${clientVersion} (linux; x86_64)`,
    originator: "codex_cli_rs",
    version: clientVersion,
  };
  if (account.chatgptAccountId) {
    headers["ChatGPT-Account-ID"] = account.chatgptAccountId;
  }
  if (cache?.etag && cache.clientVersion === clientVersion) {
    headers["If-None-Match"] = cache.etag;
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    const cause = err?.cause;
    const detail = cause
      ? `${cause.code || cause.name || "error"}: ${cause.message || String(cause)}`
      : err?.message || String(err);
    console.error(`[codex] /codex/models fetch failed: ${detail}`);
    return null;
  }

  // 304 Not Modified — cache is still valid.
  if (resp.status === 304 && cache) {
    return { models: cache.models, etag: cache.etag };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(
      `[codex] /codex/models returned ${resp.status}: ${text.slice(0, 200)}`,
    );
    return null;
  }

  let parsed: ModelsResponse;
  try {
    parsed = (await resp.json()) as ModelsResponse;
  } catch (err: any) {
    console.error(`[codex] /codex/models JSON parse failed: ${err.message}`);
    return null;
  }
  if (!Array.isArray(parsed.models)) {
    console.error("[codex] /codex/models response missing 'models' array");
    return null;
  }
  const etag = resp.headers.get("etag");
  return { models: parsed.models, etag };
}

export async function listCodexModels(
  manager: AccountManager,
  clientVersion: string = DEFAULT_CLIENT_VERSION,
): Promise<Array<{ id: string; owned_by: string }>> {
  // Cache hit within TTL — return immediately.
  if (
    cache &&
    cache.clientVersion === clientVersion &&
    Date.now() - cache.fetchedAt < CACHE_TTL_MS
  ) {
    return cache.models.map((m) => ({ id: m.slug, owned_by: "openai" }));
  }

  const fresh = await fetchUpstream(manager, clientVersion);
  if (fresh) {
    cache = {
      fetchedAt: Date.now(),
      etag: fresh.etag,
      models: fresh.models,
      clientVersion,
    };
    return fresh.models.map((m) => ({ id: m.slug, owned_by: "openai" }));
  }

  // Stale-while-error: prefer slightly-stale cache over fallback if we have one.
  if (cache) {
    return cache.models.map((m) => ({ id: m.slug, owned_by: "openai" }));
  }

  return FALLBACK_MODELS.map((id) => ({ id, owned_by: "openai" }));
}

/** @internal — test hook to reset the module-level cache between cases. */
export function __resetCodexModelsCache(): void {
  cache = null;
}
