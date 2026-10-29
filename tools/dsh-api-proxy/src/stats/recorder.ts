import { ProviderId } from "../auth/types";
import { UsageData } from "../accounts/manager";
import { StatsAppender, replayStatsEvents, statsFilePath } from "./storage";

/**
 * One row in the JSONL stats log. Keep field names short — the file grows
 * one line per request and disk space matters more than self-documentation
 * here. `version` lets us evolve the schema without a manual migration:
 * loaders are free to skip lines whose version they don't understand.
 */
export interface StatsEvent {
  v: 1;
  ts: string;
  apiKeyHash: string;
  ip: string;
  ua: string;
  endpoint: string;
  model: string | null;
  provider: ProviderId | null;
  accountEmail: string | null;
  status: "success" | "failure";
  failureKind: string | null;
  statusCode: number;
  latencyMs: number;
  usage: UsageData | null;
}

interface BaseBucket {
  requests: number;
  successes: number;
  failures: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalReasoningOutputTokens: number;
  totalLatencyMs: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ClientBucket extends BaseBucket {
  apiKeyShort: string;
  lastIp: string;
  lastUa: string;
}

export interface AccountBucket extends BaseBucket {
  provider: ProviderId;
  email: string;
}

export interface ApiBucket extends BaseBucket {
  endpoint: string;
  model: string;
  provider: ProviderId | null;
}

export interface StatsSnapshot {
  byClient: Record<string, ClientBucket>;
  byAccount: Record<string, AccountBucket>;
  byApi: Record<string, ApiBucket>;
  totals: BaseBucket;
}

function emptyBucket(now: string): BaseBucket {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationInputTokens: 0,
    totalCacheReadInputTokens: 0,
    totalReasoningOutputTokens: 0,
    totalLatencyMs: 0,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

function applyBaseDelta(b: BaseBucket, ev: StatsEvent): void {
  if (b.requests === 0) {
    b.firstSeenAt = ev.ts;
  }
  b.requests++;
  if (ev.status === "success") b.successes++;
  else b.failures++;
  b.totalLatencyMs += ev.latencyMs;
  if (ev.usage) {
    b.totalInputTokens += ev.usage.inputTokens;
    b.totalOutputTokens += ev.usage.outputTokens;
    b.totalCacheCreationInputTokens += ev.usage.cacheCreationInputTokens;
    b.totalCacheReadInputTokens += ev.usage.cacheReadInputTokens;
    b.totalReasoningOutputTokens += ev.usage.reasoningOutputTokens;
  }
  b.lastSeenAt = ev.ts;
}

/**
 * Three independent aggregate views — keyed by client (API key hash),
 * upstream account (provider + email), and API surface (endpoint + model
 * + provider). Each request increments exactly one bucket per view, so
 * memory usage is O(unique clients + unique accounts + unique
 * endpoint*model). No cross-products.
 */
export class StatsRecorder {
  private byClient = new Map<string, ClientBucket>();
  private byAccount = new Map<string, AccountBucket>();
  private byApi = new Map<string, ApiBucket>();
  private totals: BaseBucket = emptyBucket(new Date().toISOString());

  private appender: StatsAppender | null = null;
  private enabled = false;

  /**
   * Replay JSONL into the in-memory aggregate, then open the append
   * stream. Replay errors are non-fatal — operators can always delete
   * the file to reset, and we'd rather start fresh than fail to boot.
   */
  start(authDir: string): void {
    const filePath = statsFilePath(authDir);
    try {
      const result = replayStatsEvents(filePath, (ev) => this.applyEvent(ev));
      if (result.lines > 0) {
        console.log(
          `[stats] replayed ${result.lines} event(s) (${result.skipped} skipped) from ${filePath}`,
        );
      }
    } catch (err: any) {
      console.error("[stats] replay failed:", err?.message);
    }
    this.appender = new StatsAppender(filePath);
    this.appender.open();
    this.enabled = true;
  }

  async stop(): Promise<void> {
    this.enabled = false;
    if (this.appender) {
      await this.appender.close();
      this.appender = null;
    }
  }

  /**
   * Hot path called from the response-finish middleware. Aggregate first
   * (synchronous, cheap), then enqueue an append on the write stream so
   * the request response isn't blocked on fsync.
   */
  record(input: Omit<StatsEvent, "v" | "ts">): void {
    if (!this.enabled) return;
    const event: StatsEvent = {
      v: 1,
      ts: new Date().toISOString(),
      ...input,
    };
    this.applyEvent(event);
    if (this.appender) {
      try {
        this.appender.append(event);
      } catch (err: any) {
        console.error("[stats] append failed:", err?.message);
      }
    }
  }

  getSnapshot(): StatsSnapshot {
    return {
      byClient: Object.fromEntries(this.byClient),
      byAccount: Object.fromEntries(this.byAccount),
      byApi: Object.fromEntries(this.byApi),
      totals: { ...this.totals },
    };
  }

  /** Reset all in-memory aggregates. Doesn't touch the JSONL on disk. */
  reset(): void {
    this.byClient.clear();
    this.byAccount.clear();
    this.byApi.clear();
    this.totals = emptyBucket(new Date().toISOString());
  }

  /** Test/replay-only entry point — does NOT touch the disk. */
  applyEvent(ev: StatsEvent): void {
    applyBaseDelta(this.totals, ev);

    const clientKey = ev.apiKeyHash;
    let cb = this.byClient.get(clientKey);
    if (!cb) {
      cb = {
        ...emptyBucket(ev.ts),
        apiKeyShort: ev.apiKeyHash.slice(0, 12),
        lastIp: ev.ip,
        lastUa: ev.ua,
      };
      this.byClient.set(clientKey, cb);
    }
    cb.lastIp = ev.ip || cb.lastIp;
    cb.lastUa = ev.ua || cb.lastUa;
    applyBaseDelta(cb, ev);

    if (ev.provider && ev.accountEmail) {
      const accKey = `${ev.provider}:${ev.accountEmail}`;
      let ab = this.byAccount.get(accKey);
      if (!ab) {
        ab = {
          ...emptyBucket(ev.ts),
          provider: ev.provider,
          email: ev.accountEmail,
        };
        this.byAccount.set(accKey, ab);
      }
      applyBaseDelta(ab, ev);
    }

    const apiModel = ev.model || "unknown";
    const apiProvider = ev.provider || null;
    const apiKey = `${ev.endpoint}|${apiModel}|${apiProvider ?? "unknown"}`;
    let pb = this.byApi.get(apiKey);
    if (!pb) {
      pb = {
        ...emptyBucket(ev.ts),
        endpoint: ev.endpoint,
        model: apiModel,
        provider: apiProvider,
      };
      this.byApi.set(apiKey, pb);
    }
    applyBaseDelta(pb, ev);
  }
}

/**
 * Helpers for handlers to attach upstream-specific context to the per-
 * request stats slot on `res.locals`. The server's finish-middleware
 * reads these at response time. Both helpers no-op if stats is disabled
 * (res.locals.stats unset), so handlers don't need to branch on config.
 */
type ResLike = { locals: { stats?: any } };

export function tagStatsModel(
  res: ResLike,
  model: string,
  provider: ProviderId,
): void {
  if (!res.locals.stats) return;
  res.locals.stats.model = model;
  res.locals.stats.provider = provider;
}

export function tagStatsUsage(res: ResLike, usage: UsageData): void {
  if (!res.locals.stats) return;
  res.locals.stats.usage = usage;
}
