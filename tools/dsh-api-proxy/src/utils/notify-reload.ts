import { Config } from "../config";

/**
 * Normalize the configured bind address to a connectable client target for
 * outbound notify-reload. `0.0.0.0` and `::` are listening-only wildcards;
 * macOS + recent Linux silently map them to loopback for outgoing connects,
 * but Windows + strict environments reject them. IPv6 literals also need
 * URL bracketing.
 *
 * @internal — exported for unit tests.
 */
export function normalizeNotifyHost(configured: string | undefined): string {
  const h = (configured || "").trim();
  if (!h || h === "0.0.0.0") return "127.0.0.1";
  if (h === "::" || h === "[::]" || h === "0:0:0:0:0:0:0:0") return "[::1]";
  // Bare IPv6 literal (e.g. "::1", "fe80::1") — bracket it for URL form.
  if (h.includes(":") && !h.startsWith("[")) return `[${h}]`;
  return h;
}

/**
 * Notify a running dsh-api-proxy server (if any) that a freshly persisted token is
 * on disk and should be reloaded. Best-effort: any failure degrades to a clear
 * console message and never throws — `--login` should always exit 0 once the
 * token is saved.
 *
 * Distinct outcomes:
 *   - 200 OK              → log "Notified..." (info)
 *   - 401 / 403           → warn "API key mismatch" (actionable)
 *   - ECONNREFUSED / ETC. → log "no server detected" (info)
 *   - other               → warn generic
 */
export async function notifyServerReload(config: Config): Promise<void> {
  const host = normalizeNotifyHost(config.host);
  const port = config.port;
  // Set preserves insertion order; pick the first configured key.
  const apiKey = Array.from(config["api-keys"])[0];
  if (!apiKey) return; // loadConfig always seeds at least one key
  const url = `http://${host}:${port}/admin/reload`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(1500),
    });
  } catch (err: any) {
    const cause = err?.cause;
    const code = cause?.code || err?.code || err?.name || "";
    if (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "ABORT_ERR" ||
      code === "TimeoutError"
    ) {
      console.log(
        `(no dsh-api-proxy server detected at ${host}:${port} — token saved, will be loaded next start)`,
      );
      return;
    }
    console.warn(`dsh-api-proxy server reload failed: ${err?.message || err}`);
    return;
  }

  if (resp.ok) {
    console.log("Notified running dsh-api-proxy server to reload tokens.");
    return;
  }
  if (resp.status === 401 || resp.status === 403) {
    console.warn(
      `dsh-api-proxy server is running but rejected the reload (HTTP ${resp.status}). ` +
        `The api-keys in config.yaml may differ from the running server's; ` +
        `restart the server to pick up the new token.`,
    );
    return;
  }
  console.warn(`dsh-api-proxy server reload returned HTTP ${resp.status}.`);
}
